// MessageContext.deliveredBecause (webhook.ts): why THIS delivery reached
// the identity, on an open room only -- salt-api's `message.delivered_because`
// ("mention" | "reply" | "keyword" | "all"), present only alongside
// `encrypted: false`. Both transports share ONE dispatcher (createDispatcher),
// so this is verified over both createWebhookServer (a real signed POST) and
// createSocketClient (a real in-process Action Cable server) to guard against
// the two envelope shapes ever diverging. Also verified on SessionTurn: a
// cold-start rebuild from chat history (rebuildTranscriptTail) carries the
// same field on the OTHER party's turn, never on this identity's own.
const test = require("node:test");
const assert = require("node:assert");
const { createHmac } = require("node:crypto");
const { WebSocketServer } = require("ws");

const sdk = require("../dist/index.js");
const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };

// The plaintext (open-room) identity-resolution path has no ciphertext to
// trial-decrypt -- it resolves purely via identities.get(headerAgentId) (see
// webhook.ts's handleMessage), so every test here needs a store that
// actually answers that lookup. A structurally-valid AgentIdentity with
// fake key material is enough: nothing in these tests calls reply() or
// decrypts anything, so privateKey/publicKey are never actually used as PGP
// keys.
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

function openRoomBody(n, text, deliveredBecause) {
  const message = {
    chat_id: `chat-${n}`,
    message_id: `m-${n}`,
    message: text,
    encrypted: false,
    user: { id: "human-1", username: "dan", account_type: "User" },
    created_at: new Date().toISOString(),
  };
  if (deliveredBecause !== undefined) message.delivered_because = deliveredBecause;
  return { chat: { id: `chat-${n}` }, message };
}

// --- Webhook path --------------------------------------------------------------

test("webhook: ctx.deliveredBecause carries an open-room delivery's reason, and each recognised value round-trips", async (t) => {
  const AGENT_ID = "dbw-1";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "the-key", "secret-agent");

  const seen = [];
  const server = sdk.createWebhookServer({
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: silent,
    async onMessage(ctx) {
      seen.push(ctx.deliveredBecause);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  async function post(n, reason) {
    const body = openRoomBody(n, `hi ${n}`, reason);
    const raw = JSON.stringify(body);
    const headers = signHeaders(AGENT_ID, "secret-agent", raw);
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: raw,
    });
    assert.equal(res.status, 200);
  }

  for (const reason of ["mention", "reply", "keyword", "all"]) {
    await post(reason, reason);
  }
  await new Promise((r) => setTimeout(r, 150));

  assert.deepStrictEqual(seen, ["mention", "reply", "keyword", "all"]);
});

test("webhook: ctx.deliveredBecause is undefined when the field is absent (an ordinary chat) or unrecognised", async (t) => {
  const AGENT_ID = "dbw-2";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "the-key", "secret-agent");

  const seen = [];
  const server = sdk.createWebhookServer({
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: silent,
    async onMessage(ctx) {
      seen.push(ctx.deliveredBecause);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  async function post(n, reason) {
    const body = openRoomBody(n, `hi ${n}`, reason);
    const raw = JSON.stringify(body);
    const headers = signHeaders(AGENT_ID, "secret-agent", raw);
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: raw,
    });
    assert.equal(res.status, 200);
  }

  await post("absent", undefined); // no delivered_because key at all
  await post("bogus", "some-future-kind-this-sdk-version-doesnt-know"); // present but unrecognised
  await new Promise((r) => setTimeout(r, 150));

  assert.deepStrictEqual(seen, [undefined, undefined], "a missing or unrecognised reason must degrade to undefined, never throw or lie");
});

// --- Socket path -----------------------------------------------------------

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

test("socket: ctx.deliveredBecause surfaces the same way over the push transport, since it shares one dispatcher with the webhook path", async (t) => {
  const AGENT_ID = "dbs-1";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "the-key", "secret-agent");

  const rowMention = updateRow(1, AGENT_ID, "secret-agent", "message", openRoomBody("s1", "hi mention", "mention"));
  const rowNone = updateRow(2, AGENT_ID, "secret-agent", "message", openRoomBody("s2", "hi none", undefined));

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, rowMention);
      sendFrame(ws, identifier, rowNone);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 2 });
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
    async onMessage(ctx) {
      seen.push(ctx.deliveredBecause);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => seen.length >= 2);
  assert.deepStrictEqual(seen, ["mention", undefined]);
});

// --- SessionTurn / cold-start history rebuild ---------------------------------

test("session: a cold-start rebuild carries deliveredBecause on the OTHER party's turn, never on this identity's own", async (t) => {
  const AGENT_ID = "60000000-0000-0000-0000-0000000000c1";
  const identity = { saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: "fake-pub", privateKey: "fake-priv" };
  const store = {
    get: (id) => (String(id).toLowerCase() === AGENT_ID.toLowerCase() ? identity : undefined),
    all: () => [identity],
    register() {},
    reassignId: () => undefined,
  };

  const client = {
    async getWebhookSecret(apiKey) {
      return apiKey === "the-key" ? "secret-agent" : undefined;
    },
    async getChatMembers() {
      return [];
    },
    async getChatMessages() {
      return [
        {
          event_type: null,
          message: "earlier message from dan",
          encrypted: false,
          delivered_because: "keyword",
          user: { id: "human-1", username: "dan", display_name: "Dan" },
          created_at: new Date(Date.now() - 10_000).toISOString(),
        },
        {
          event_type: null,
          message: "my own earlier reply",
          encrypted: false,
          // Salt-api would never actually send delivered_because on this
          // identity's own message, but even if it did, rebuildTranscriptTail
          // must not surface it on an "assistant" turn.
          delivered_because: "all",
          user: { id: AGENT_ID, username: "helper", display_name: "Helper" },
          created_at: new Date(Date.now() - 5_000).toISOString(),
        },
      ];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let tail = null;
  const server = sdk.createWebhookServer({
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: silent,
    async onMessage(ctx) {
      tail = ctx.session.transcriptTail;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const body = openRoomBody("cold-start", "triggering message", "reply");
  const raw = JSON.stringify(body);
  const headers = signHeaders(AGENT_ID, "secret-agent", raw);
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(tail, "onMessage must have run");
  const [danTurn, ownTurn] = tail;
  assert.strictEqual(danTurn.role, "user");
  assert.strictEqual(danTurn.deliveredBecause, "keyword", "the other party's rebuilt turn carries the historic reason");
  assert.strictEqual(ownTurn.role, "assistant");
  assert.strictEqual(ownTurn.deliveredBecause, undefined, "this identity's own rebuilt turn never carries a delivered-because reason");
});
