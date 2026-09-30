// Socket mode + ctx.ask (fix, 2026-09-30): a handler that does
// `await ctx.ask(...)` must not deadlock the connection. Before the fix every
// frame -- pings and the answer included -- went through one serial queue that
// the waiting handler occupied, so the answer queued behind the handler
// waiting for it, the 30s ping watchdog killed the connection, and the
// reconnect replayed chat_opened (a new question card per restart).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const { WebSocketServer } = require("ws");

const sdk = require("../dist/index.js");
const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };

const AGENT_ID = "ask-sock-1";
const SECRET = "secret-agent";

function tempStore() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "salt-socket-ask-")), "identities.json");
}
function signHeaders(rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", SECRET).update(`${t}.${rawBody}`).digest("hex");
  return { "X-Salt-Agent-Id": AGENT_ID, "X-Salt-Signature": `t=${t},v1=${v1}` };
}
function row(id, event, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return { id, delivery_id: `d-${id}`, event, headers: signHeaders(body), body, created_at: new Date().toISOString() };
}
// Open-room (plaintext) message envelope: no PGP needed, identity from the header.
const HUMAN = { id: "human-1", username: "dan", account_type: "User" };
function plainMessageRow(id, chatId, text) {
  return row(id, "message", {
    chat: { id: chatId },
    message: { chat_id: chatId, message_id: `m-${id}`, message: text, encrypted: false, user: HUMAN, created_at: new Date().toISOString() },
  });
}
function tapRow(id, chatId, cardId, actionId) {
  return row(id, "card_interaction", { type: "card_interaction", owner_id: AGENT_ID, chat_id: chatId, card_id: cardId, action_id: actionId, user: HUMAN, state: { blocks: [] } });
}
async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function startCable(onSubscribe) {
  const wss = new WebSocketServer({ port: 0, path: "/cable" });
  const connections = [];
  wss.on("connection", (ws) => {
    connections.push(ws);
    ws.send(JSON.stringify({ type: "welcome" }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.command === "subscribe") onSubscribe(ws, JSON.parse(msg.identifier), connections.length - 1);
    });
  });
  return {
    connections,
    port: () => wss.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const ws of connections) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}
const send = (ws, identifier, message) => ws.send(JSON.stringify({ identifier: JSON.stringify(identifier), message }));

// The card API answers a MESSAGE envelope -- the card id is resource_id.
function fakeClient(posted, updated) {
  return {
    async getWebhookSecret(apiKey) {
      return apiKey === "the-key" ? SECRET : undefined;
    },
    async getChatMembers() {
      return [];
    },
    async postMessage() {
      return {};
    },
    async postCard(_key, chatId, blocks) {
      posted.push({ chatId, blocks });
      const cardId = `card-${posted.length}`;
      return { chat_id: chatId, message_id: `mm-${posted.length}`, resource_type: "Card", resource_id: cardId, resource: { id: cardId, card_type: "blocks" } };
    },
    async updateCard(_key, cardId, blocks) {
      updated.push({ cardId, blocks });
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };
}

async function setup(t, { onMessage, logger = silent, pingTimeoutMs, onSubscribe } = {}) {
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: "unused", privateKey: "unused" });
  const posted = [];
  const updated = [];
  const cable = startCable(onSubscribe);
  t.after(() => cable.close());
  const acks = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client: fakeClient(posted, updated),
    identities: store,
    pgpPassphrase: "x",
    logger,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    pingTimeoutMs,
    minBackoffMs: 20,
    maxBackoffMs: 50,
    fetchImpl: async (url) => {
      acks.push(url);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ updates: [], cursor: Number(/after=(\d+)/.exec(url)?.[1] ?? 0) }) };
    },
    onMessage,
  });
  t.after(() => socket.stop());
  return { cable, socket, posted, updated, acks };
}

test("await ctx.ask inside a socket handler resolves when the person taps a button (card id read from resource_id)", async (t) => {
  const answers = [];
  let ws, id;
  const s = await setup(t, {
    async onMessage(ctx) {
      answers.push(await ctx.ask("Which city?", { options: ["Lisbon", "Porto"] }));
    },
    onSubscribe(sock, identifier) {
      ws = sock;
      id = identifier;
      sock.send(JSON.stringify({ identifier: JSON.stringify(identifier), type: "confirm_subscription" }));
      send(sock, identifier, plainMessageRow(1, "chat-a", "hello"));
      send(sock, identifier, { type: "replay_done", cursor: 1 });
    },
  });
  s.socket.start();
  await waitFor(() => s.posted.length === 1);
  const porto = s.posted[0].blocks.find((b) => b.type === "actions").elements.find((e) => e.label === "Porto");
  send(ws, id, tapRow(2, "chat-a", "card-1", porto.action_id));
  await waitFor(() => answers.length === 1);
  assert.strictEqual(answers[0].answer, "Porto");
  assert.strictEqual(answers[0].via, "button");
  await waitFor(() => s.updated.length === 1);
  assert.strictEqual(s.updated[0].cardId, "card-1", "the card is updated in place using the real card id");
});

test("await ctx.ask inside a socket handler resolves on a typed reply while the handler is still running", async (t) => {
  const answers = [];
  let ws, id;
  const s = await setup(t, {
    async onMessage(ctx) {
      if (ctx.text !== "hello") return;
      answers.push(await ctx.ask("Which city?", { freeText: true }));
    },
    onSubscribe(sock, identifier) {
      ws = sock;
      id = identifier;
      sock.send(JSON.stringify({ identifier: JSON.stringify(identifier), type: "confirm_subscription" }));
      send(sock, identifier, plainMessageRow(1, "chat-b", "hello"));
      send(sock, identifier, { type: "replay_done", cursor: 1 });
    },
  });
  s.socket.start();
  await waitFor(() => s.posted.length === 1);
  send(ws, id, plainMessageRow(2, "chat-b", "Porto"));
  await waitFor(() => answers.length === 1);
  assert.deepStrictEqual([answers[0].answer, answers[0].via], ["Porto", "message"]);
  // The answer was consumed as the answer: it never reached onMessage as a fresh prompt,
  // and once the handler returns the ack covers both rows.
  await waitFor(() => s.acks.some((u) => /after=2/.test(u)));
});

test("Action Cable pings keep being processed while a handler is parked in ctx.ask (no dead-connection reconnect, no replayed chat_opened)", async (t) => {
  const errors = [];
  const logger = { info() {}, error: (m) => errors.push(m) };
  let opened = 0;
  let ws, id;
  const s = await setup(t, {
    logger,
    pingTimeoutMs: 300,
    async onMessage(ctx) {
      opened++;
      await ctx.ask("Still there?", { freeText: true, timeoutMs: 5000 }).catch(() => {});
    },
    onSubscribe(sock, identifier) {
      ws = sock;
      id = identifier;
      sock.send(JSON.stringify({ identifier: JSON.stringify(identifier), type: "confirm_subscription" }));
      send(sock, identifier, plainMessageRow(1, "chat-c", "hello"));
      send(sock, identifier, { type: "replay_done", cursor: 0 });
    },
  });
  s.socket.start();
  await waitFor(() => s.posted.length === 1);
  // 1.2s of pings, four times the watchdog window, while the handler waits.
  for (let i = 0; i < 12; i++) {
    ws.send(JSON.stringify({ type: "ping", message: Date.now() }));
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(s.cable.connections.length, 1, "the connection must not have been declared dead and restarted");
  assert.ok(!errors.some((e) => /no ping for/.test(e)), `watchdog fired: ${errors.join(" | ")}`);
  assert.strictEqual(opened, 1, "the first message was handled exactly once");
  assert.strictEqual(s.posted.length, 1, "exactly one question card was posted");
  send(ws, id, plainMessageRow(2, "chat-c", "yes"));
});

test("a reconnect while a handler is parked in ctx.ask does not start a second handler for the same row, and the answer still resolves it", async (t) => {
  const answers = [];
  let opened = 0;
  const conns = [];
  const s = await setup(t, {
    async onMessage(ctx) {
      opened++;
      answers.push(await ctx.ask("Which?", { freeText: true }));
    },
    onSubscribe(sock, identifier, index) {
      conns[index] = { sock, identifier };
      sock.send(JSON.stringify({ identifier: JSON.stringify(identifier), type: "confirm_subscription" }));
      // Every connection replays row 1 (the server never saw an ack for it).
      send(sock, identifier, plainMessageRow(1, "chat-d", "hello"));
      send(sock, identifier, { type: "replay_done", cursor: 0 });
    },
  });
  s.socket.start();
  await waitFor(() => s.posted.length === 1);
  s.cable.connections[0].terminate();
  await waitFor(() => conns[1]);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(opened, 1, "the replayed row must not run a second handler");
  assert.strictEqual(s.posted.length, 1, "no duplicate question card");
  send(conns[1].sock, conns[1].identifier, plainMessageRow(2, "chat-d", "Porto"));
  await waitFor(() => answers.length === 1);
  assert.strictEqual(answers[0].answer, "Porto");
});
