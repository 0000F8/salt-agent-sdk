// The cancel marker (work.ts's [[SALT-WORK-CANCEL id=...]], webhook.ts's
// onWorkCancel): a person cancelling a `scheduled` work report by sending a
// whole message into the same lane the report came from. Pinned here: it
// never reaches onMessage (there's no ordinary-text reading of it, so it's
// swallowed even with no handler registered), it carries the room's chat id
// (matching work.ts's WorkTarget.chatId) apart from the lane it actually
// arrived in, and both transports (a real signed webhook POST, and a real
// in-process Action Cable push) resolve it identically since they share one
// dispatcher (createDispatcher) -- same style delivered-because.test.js uses
// for MessageContext.deliveredBecause.
const test = require("node:test");
const assert = require("node:assert");
const { createHmac } = require("node:crypto");
const { WebSocketServer } = require("ws");

const sdk = require("../dist/index.js");
const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };

// Same plaintext (open-room) identity-resolution path delivered-because.test.js
// uses: no ciphertext to trial-decrypt, so a structurally-valid AgentIdentity
// with fake key material is enough -- nothing here calls reply() or decrypts
// anything.
function baseIdentitiesAndClient(agentId, apiKey, secret) {
  const identity = { saltAppId: agentId, username: "helper", apiKey, publicKey: "fake-pub", privateKey: "fake-priv" };
  const store = {
    get: (id) => (String(id).toLowerCase() === String(agentId).toLowerCase() ? identity : undefined),
    all: () => [identity],
    register() {},
    reassignId: () => undefined,
  };
  const client = {
    async getWebhookSecret(key) {
      return key === apiKey ? secret : undefined;
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
  return { store, client };
}

function signHeaders(agentId, secret, rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return { "X-Salt-Agent-Id": agentId, "X-Salt-Signature": `t=${t},v1=${v1}` };
}

function cancelBody({ chatId, laneChatId, coachingForChatId, text = "[[SALT-WORK-CANCEL id=w_3f9a2c]]" }) {
  const arrivalChatId = laneChatId || chatId;
  const message = {
    chat_id: arrivalChatId,
    message_id: `m-${arrivalChatId}-${Math.random()}`,
    message: text,
    encrypted: false,
    user: { id: "human-1", username: "dan", account_type: "User" },
    created_at: new Date().toISOString(),
  };
  const chat = { id: arrivalChatId };
  if (coachingForChatId) chat.coaching_for_chat_id = coachingForChatId;
  return { chat, message };
}

// --- Webhook path -----------------------------------------------------------

test("webhook: an incoming cancel never reaches onMessage, and fires onWorkCancel with the room's chatId apart from the lane it arrived in", async (t) => {
  const AGENT_ID = "wcw-1";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "the-key", "secret-agent");

  let onMessageCalled = false;
  const seen = [];
  const server = sdk.createWebhookServer({
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: silent,
    async onWorkCancel(ctx) {
      seen.push(ctx);
    },
    async onMessage() {
      onMessageCalled = true;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const body = cancelBody({ chatId: "room-1", laneChatId: "lane-1", coachingForChatId: "room-1" });
  const raw = JSON.stringify(body);
  const headers = signHeaders(AGENT_ID, "secret-agent", raw);
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(onMessageCalled, false, "a cancel marker must never reach onMessage");
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].workId, "w_3f9a2c");
  assert.strictEqual(seen[0].chatId, "room-1", "chatId is the ROOM the work came from, matching WorkTarget.chatId");
  assert.strictEqual(seen[0].laneId, "lane-1", "laneId is the actual chat the cancel arrived in");
  assert.strictEqual(seen[0].sender.id, "human-1");
  assert.strictEqual(seen[0].identity.saltAppId, AGENT_ID);
});

test("webhook: laneId equals chatId when the cancel didn't arrive inside a lane (no coaching_for_chat_id)", async (t) => {
  const AGENT_ID = "wcw-2";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "the-key", "secret-agent");

  const seen = [];
  const server = sdk.createWebhookServer({
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: silent,
    async onWorkCancel(ctx) {
      seen.push(ctx);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const body = cancelBody({ chatId: "chat-only-1" });
  const raw = JSON.stringify(body);
  const headers = signHeaders(AGENT_ID, "secret-agent", raw);
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: raw });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].chatId, "chat-only-1");
  assert.strictEqual(seen[0].laneId, "chat-only-1");
});

test("webhook: a cancel with no onWorkCancel handler registered is still swallowed rather than reaching onMessage", async (t) => {
  const AGENT_ID = "wcw-3";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "the-key", "secret-agent");

  let onMessageCalled = false;
  const server = sdk.createWebhookServer({
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: silent,
    // onWorkCancel deliberately NOT registered.
    async onMessage() {
      onMessageCalled = true;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const body = cancelBody({ chatId: "lane-2" });
  const raw = JSON.stringify(body);
  const headers = signHeaders(AGENT_ID, "secret-agent", raw);
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: raw });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(onMessageCalled, false);
});

test("webhook: an ordinary message that merely mentions the marker's name is not a cancel, and reaches onMessage untouched", async (t) => {
  const AGENT_ID = "wcw-4";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "the-key", "secret-agent");

  const seenCancels = [];
  const seenMessages = [];
  const server = sdk.createWebhookServer({
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: silent,
    async onWorkCancel(ctx) {
      seenCancels.push(ctx);
    },
    async onMessage(ctx) {
      seenMessages.push(ctx.text);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const body = cancelBody({ chatId: "lane-3", text: "please cancel my reminder" });
  const raw = JSON.stringify(body);
  const headers = signHeaders(AGENT_ID, "secret-agent", raw);
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: raw });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(seenCancels.length, 0);
  assert.deepStrictEqual(seenMessages, ["please cancel my reminder"]);
});

// --- Socket path -------------------------------------------------------------

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

test("socket: a cancel resolves the same way over the push transport, since it shares one dispatcher with the webhook path", async (t) => {
  const AGENT_ID = "wcs-1";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "the-key", "secret-agent");

  const row = updateRow(1, AGENT_ID, "secret-agent", "message", cancelBody({ chatId: "room-9", laneChatId: "lane-9", coachingForChatId: "room-9" }));

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

  const seenCancels = [];
  let onMessageCalled = false;
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
    async onWorkCancel(ctx) {
      seenCancels.push(ctx);
    },
    async onMessage() {
      onMessageCalled = true;
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => seenCancels.length >= 1);

  assert.strictEqual(onMessageCalled, false);
  assert.strictEqual(seenCancels[0].workId, "w_3f9a2c");
  assert.strictEqual(seenCancels[0].chatId, "room-9");
  assert.strictEqual(seenCancels[0].laneId, "lane-9");
});
