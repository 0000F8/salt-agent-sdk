// app_action (contract 2026-09-28, §1/§3/§7): fires once, to the
// installation's OWN agent, whenever a reader calls `salt.ask` from inside
// an app's sandboxed iframe. Plaintext, like card_interaction/invoice_paid,
// but -- unlike those two -- salt-api names no owner_id/seller_id anywhere
// IN the body, so X-Salt-Agent-Id is the only way this SDK resolves which
// hosted identity it's for (same shape as the mandate rail events in
// mandate-events.test.js). Covered here: full ctx shape, reply() really
// encrypting for the chat (webhook transport, chat-opened.test.js style),
// a personal ("Your apps", chat_id null) installation's reply() failing
// soft instead of posting anywhere, no-matching-identity and
// handler-failure fall through cleanly (mandate-events.test.js style,
// dispatched directly), and the same event resolving identically over the
// socket transport (work-cancel.test.js style).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const openpgp = require("openpgp");
const { WebSocketServer } = require("ws");

const sdk = require("../dist/index.js");
const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };

function tempStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "identities.json");
}

function signedPost(port, body, agentId, secret) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Salt-Agent-Id": agentId, "X-Salt-Signature": `t=${t},v1=${v1}` },
    body: raw,
  });
}

async function decryptWith(armoredMessage, armoredPrivateKey, passphrase) {
  const decryptionKey = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey }),
    passphrase,
  });
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage }),
    decryptionKeys: [decryptionKey],
  });
  return data;
}

function appActionBody(overrides = {}) {
  return {
    type: "app_action",
    installation_id: "inst-1",
    app: { id: "app-1", name: "Notes", version: 3 },
    chat_id: "chat-1",
    text: "add milk to the list",
    data: { source: "button" },
    state_version: 5,
    user: { id: "human-1", username: "dan", display_name: "Dan", account_type: "User", time_zone: "UTC", agent_nickname: null, agent_directives: [] },
    ...overrides,
  };
}

// --- Webhook transport: full HTTP + HMAC + real PGP reply -------------------

test("webhook: app_action reaches onAppAction with the full ctx shape, and reply() really encrypts for every chat member", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const memberKeys = await sdk.generateKeypair("member-pass");
  const AGENT_ID = "00000000-0000-0000-0000-00000000a001";
  const MEMBER_ID = "00000000-0000-0000-0000-00000000b002";

  const store = sdk.createIdentityStore(tempStore("salt-app-action-"));
  store.register({ saltAppId: AGENT_ID, username: "notes-agent", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const posted = [];
  const members = [
    { id: MEMBER_ID, username: "dan", display_name: "Dan", account_type: "User", public_key: memberKeys.publicKey },
    { id: AGENT_ID, username: "notes-agent", display_name: "Notes", account_type: "Agent", public_key: agentKeys.publicKey },
  ];
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
    },
    async getChatMembers() {
      return members;
    },
    async postMessage(apiKey, chatId, message, senderMessage, delegations) {
      posted.push({ apiKey, chatId, message, senderMessage, delegations });
    },
    async signalTyping() {},
    trackEvent() {},
  };

  const seen = [];
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "agent-pass",
    logger: silent,
    async onAppAction(ctx) {
      seen.push(ctx);
      await ctx.reply("Added milk.");
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const body = appActionBody({ user: { ...appActionBody().user, id: MEMBER_ID } });
  const res = await signedPost(port, body, AGENT_ID, "secret-agent");
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(seen.length, 1);
  const ctx = seen[0];
  assert.equal(ctx.identity.saltAppId, AGENT_ID);
  assert.equal(ctx.installationId, "inst-1");
  assert.deepStrictEqual(ctx.app, { id: "app-1", name: "Notes", version: 3 });
  assert.equal(ctx.chatId, "chat-1");
  assert.equal(ctx.text, "add milk to the list");
  assert.deepStrictEqual(ctx.data, { source: "button" });
  assert.equal(ctx.stateVersion, 5);
  assert.equal(ctx.sender.id, MEMBER_ID);
  assert.equal(typeof ctx.reply, "function");

  assert.equal(posted.length, 1, "reply() posted exactly one message");
  const plaintext = await decryptWith(posted[0].message, memberKeys.privateKey, "member-pass");
  assert.match(plaintext, /Added milk/);
});

test("webhook: app_action for a chat this identity has no matching hosted key for is dropped (bad X-Salt-Agent-Id) -- no onAppAction call", async (t) => {
  const store = sdk.createIdentityStore(tempStore("salt-app-action-nomatch-"));
  let called = false;
  const server = sdk.createWebhookServer({
    client: { async getWebhookSecret() { return undefined; }, trackEvent() {} },
    identities: store,
    pgpPassphrase: "x",
    logger: silent,
    verifySignatures: false,
    onAppAction() {
      called = true;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(appActionBody()),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(called, false, "no hosted identity named by X-Salt-Agent-Id, so nothing fires");
});

// --- Direct dispatch: identity resolution, personal installs, failures ------
//
// Same style as mandate-events.test.js -- these don't need PGP at all
// (app_action's `text` rides in plaintext), so the dispatcher is exercised
// directly rather than through a real signed HTTP POST.

function identityStore(identities) {
  const byId = new Map(identities.map((i) => [String(i.saltAppId).toLowerCase(), i]));
  return {
    get: (id) => byId.get(String(id).toLowerCase()),
    all: () => Array.from(byId.values()),
    register(identity) {
      byId.set(String(identity.saltAppId).toLowerCase(), identity);
    },
    reassignId: () => undefined,
  };
}

test("dispatch: app_action for a PERSONAL installation (chat_id null) hands reply() through, but calling it fails soft and never posts", async () => {
  const agent = { saltAppId: "agent-1", username: "notes-agent", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  let postCalled = false;
  const client = {
    async getChatMembers() {
      return [];
    },
    async postMessage() {
      postCalled = true;
    },
    async signalTyping() {},
    trackEvent() {},
  };
  const errors = [];
  const seen = [];
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: { info() {}, error: (m) => errors.push(m) },
    async onAppAction(ctx) {
      seen.push(ctx);
      await ctx.reply("this has nowhere to go");
    },
  });

  await dispatcher.dispatch(appActionBody({ chat_id: null }), "agent-1");

  assert.equal(seen.length, 1);
  assert.strictEqual(seen[0].chatId, null);
  assert.equal(postCalled, false, "a personal installation's reply() must never post a message");
  assert.ok(errors.some((m) => m.includes("personal installation")));
});

test("dispatch: app_action with no matching hosted identity (bad header) is dropped silently", async () => {
  const client = { trackEvent() {} };
  let called = false;
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([]),
    pgpPassphrase: "x",
    logger: silent,
    onAppAction() {
      called = true;
    },
  });
  await dispatcher.dispatch(appActionBody(), "someone-else");
  assert.strictEqual(called, false);
});

test("dispatch: app_action with no onAppAction handler registered is a silent no-op", async () => {
  const agent = { saltAppId: "agent-1", username: "notes-agent", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  const client = { trackEvent() {} };
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: silent,
  });
  // Must not throw.
  await dispatcher.dispatch(appActionBody(), "agent-1");
});

test("dispatch: a handler failure is caught and logged, never thrown out of dispatch", async () => {
  const agent = { saltAppId: "agent-1", username: "notes-agent", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  const client = { async signalTyping() {}, trackEvent() {} };
  const errors = [];
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: { info() {}, error: (m) => errors.push(m) },
    onAppAction: async () => {
      throw new Error("boom");
    },
  });
  await dispatcher.dispatch(appActionBody(), "agent-1");
  assert.ok(errors.some((m) => m.includes("onAppAction failed") && m.includes("boom")));
});

// --- Socket transport: the same dispatcher, pushed instead of POSTed -------

function startCableServer({ onSubscribe } = {}) {
  const wss = new WebSocketServer({ port: 0, path: "/cable" });
  const connections = [];
  wss.on("connection", (ws) => {
    connections.push(ws);
    ws.send(JSON.stringify({ type: "welcome" }));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.command === "subscribe" && onSubscribe) onSubscribe(ws, JSON.parse(msg.identifier));
    });
  });
  return {
    connections,
    port: () => wss.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const ws of connections) {
          try {
            ws.terminate();
          } catch {
            // already gone
          }
        }
        wss.close(() => resolve());
      }),
  };
}

function sendFrame(ws, identifier, message) {
  ws.send(JSON.stringify({ identifier: JSON.stringify(identifier), message }));
}
function sendConfirm(ws, identifier) {
  ws.send(JSON.stringify({ identifier: JSON.stringify(identifier), type: "confirm_subscription" }));
}

function signHeaders(agentId, secret, rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return { "X-Salt-Agent-Id": agentId, "X-Salt-Signature": `t=${t},v1=${v1}` };
}

function updateRow(id, agentId, secret, event, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return { id, delivery_id: `d-${id}`, event, headers: signHeaders(agentId, secret, body), body, created_at: new Date().toISOString() };
}

function jsonResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("socket: app_action resolves the same way over the push transport, since it shares one dispatcher with the webhook path", async (t) => {
  const AGENT_ID = "wss-app-1";
  const agent = { saltAppId: AGENT_ID, username: "notes-agent", apiKey: "the-key", publicKey: "fake-pub", privateKey: "fake-priv" };
  const store = {
    get: (id) => (String(id).toLowerCase() === AGENT_ID.toLowerCase() ? agent : undefined),
    all: () => [agent],
    register() {},
    reassignId: () => undefined,
  };
  const client = {
    async getWebhookSecret(key) {
      return key === "the-key" ? "secret-agent" : undefined;
    },
    async getChatMembers() {
      return [];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  const row = updateRow(1, AGENT_ID, "secret-agent", "message", appActionBody());

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, row);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 1 });
    },
  });
  t.after(() => cable.close());

  const fetchImpl = async (url) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  const seen = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    async onAppAction(ctx) {
      seen.push(ctx);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => seen.length >= 1);

  assert.strictEqual(seen[0].installationId, "inst-1");
  assert.strictEqual(seen[0].chatId, "chat-1");
  assert.strictEqual(seen[0].text, "add milk to the list");
  assert.strictEqual(seen[0].stateVersion, 5);
});
