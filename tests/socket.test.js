// K2 socket mode's client half (socket.ts): createSocketClient stays
// connected to a real Action Cable-shaped websocket (AgentUpdatesChannel)
// and feeds each envelope through the SAME createDispatcher webhook.ts's
// Express route uses. Verified here against an in-process fake Action
// Cable server (built on `ws`'s own WebSocketServer -- never a real
// salt-api) plus a mocked `fetch` for the backfill/ack HTTP calls: cursor
// advance only from replay_done/backfill/ack (never a live frame), a
// single coalesced ack, zero HTTP requests while idle, reconnect-with-
// backoff, `more: true` backfill paging, and a plaintext (open-room)
// envelope.
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

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-socket-"));
  return path.join(dir, "identities.json");
}

function signHeaders(agentId, secret, rawBody) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return { "X-Salt-Agent-Id": agentId, "X-Salt-Signature": `t=${t},v1=${v1}` };
}

/** One AgentUpdate row, wire-shaped exactly like a channel envelope frame's
 *  `message` (or a GET /api/v1/agent/updates row -- identical shape). */
function updateRow(id, agentId, secret, event, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return { id, delivery_id: `d-${id}`, event, headers: signHeaders(agentId, secret, body), body, created_at: new Date().toISOString() };
}

function baseIdentitiesAndClient(agentId, secret) {
  const store = { get: () => undefined, all: () => [], register() {}, reassignId: () => undefined };
  const client = {
    async getWebhookSecret(apiKey) {
      return apiKey === "the-key" ? secret : undefined;
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

async function encryptForPublicKey(text, publicKeyArmored) {
  return openpgp.encrypt({ message: await openpgp.createMessage({ text }), encryptionKeys: await openpgp.readKey({ armoredKey: publicKeyArmored }) });
}

async function waitFor(predicate, timeoutMs = 2000, intervalMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A jsonResponse-shaped mock fetch return value, matching the shape
 *  socket.ts's backfill/ack calls expect from `fetch`. */
function jsonResponse(body, opts = {}) {
  const headerMap = new Map(Object.entries(opts.headers || {}));
  return {
    ok: opts.status === undefined || (opts.status >= 200 && opts.status < 300),
    status: opts.status ?? 200,
    headers: { get: (name) => headerMap.get(name) ?? null },
    json: async () => body,
  };
}

/**
 * A minimal in-process Action Cable server: sends {type:"welcome"} on
 * connect, and calls `onSubscribe(ws, identifier, connectionIndex)` when a
 * client sends {command:"subscribe", identifier}. The test drives every
 * subsequent frame (confirm_subscription, envelopes, replay_done, pings)
 * itself via `ws.send(...)`, so each test controls timing exactly.
 */
function startCableServer({ onSubscribe, onConnection } = {}) {
  const wss = new WebSocketServer({ port: 0, path: "/cable" });
  const connections = [];
  wss.on("connection", (ws) => {
    const index = connections.length;
    connections.push(ws);
    if (onConnection) onConnection(ws, index);
    ws.send(JSON.stringify({ type: "welcome" }));
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.command === "subscribe" && onSubscribe) {
        onSubscribe(ws, JSON.parse(msg.identifier), index);
      }
    });
  });
  return {
    wss,
    connections,
    port: () => wss.address().port,
    // wss.close() only stops accepting NEW connections and waits for
    // existing ones to close on their own -- it does not terminate them.
    // Force every tracked connection closed first (a no-op on one already
    // closed) so this resolves promptly regardless of whether the SDK
    // client under test has been stopped yet.
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

/** Wraps MemoryCursorStore, recording every value ever persisted so a test
 *  can assert WHEN a cursor was (or wasn't) written, not just its current value. */
function trackingCursorStore() {
  const inner = sdk.MemoryCursorStore();
  const puts = [];
  return {
    puts,
    async get(agentId) {
      return inner.get(agentId);
    },
    async put(agentId, cursor) {
      puts.push(cursor);
      return inner.put(agentId, cursor);
    },
  };
}

// --- Core push behaviour -----------------------------------------------------

test("replays the backlog in order, dispatches a live envelope once caught up, acks exactly once per batch, persists the cursor only from replay_done, and makes no HTTP request while idle", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-ws1");
  const AGENT_ID = "ws-1";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const armored1 = await encryptForPublicKey("hi 1", agentKeys.publicKey);
  const armored2 = await encryptForPublicKey("hi 2", agentKeys.publicKey);
  const armored3 = await encryptForPublicKey("hi 3 (live)", agentKeys.publicKey);
  const msgBody = (n, armored) => ({
    chat: { id: `chat-${n}` },
    message: { chat_id: `chat-${n}`, message_id: `m-${n}`, message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  });

  const row1 = updateRow(101, AGENT_ID, "secret-agent", "message", msgBody(1, armored1));
  const row2 = updateRow(102, AGENT_ID, "secret-agent", "message", msgBody(2, armored2));
  const row3 = updateRow(103, AGENT_ID, "secret-agent", "message", msgBody(3, armored3));

  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  let serverSocket;
  let capturedIdentifier;
  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      serverSocket = ws;
      capturedIdentifier = identifier;
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, row1);
      sendFrame(ws, identifier, row2);
      // replay_done deliberately NOT sent yet -- the test drives it below
      // so it can assert the cursor hasn't moved from the envelopes alone.
    },
  });
  t.after(() => cable.close());

  const cursorStore = trackingCursorStore();
  const received = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-ws1",
    logger: silent,
    cursorStore,
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => received.length >= 2);
  assert.deepStrictEqual(received, ["hi 1", "hi 2"], "both replayed envelopes dispatched, in order");
  assert.deepStrictEqual(cursorStore.puts, [], "the cursor must not be persisted from individual replay envelope frames");
  assert.strictEqual(fetchCalls.length, 0, "no HTTP request yet -- nothing has been acked or backfilled");

  sendFrame(serverSocket, capturedIdentifier, { type: "replay_done", cursor: 102 });
  await waitFor(() => fetchCalls.length >= 1);
  assert.strictEqual(fetchCalls.length, 1, "exactly one ack request after the replay batch");
  assert.match(fetchCalls[0], /after=102/);
  assert.match(fetchCalls[0], /limit=1/);
  assert.match(fetchCalls[0], /timeout=0/);
  await waitFor(() => cursorStore.puts.length >= 1);
  // replay_done persists 102 directly, and the ack it triggers echoes the
  // same value back from its own response -- both are legitimate
  // poll-shaped persistence points (never a live frame's own id).
  assert.ok(cursorStore.puts.every((c) => c === 102), `every persisted cursor should be 102, saw ${JSON.stringify(cursorStore.puts)}`);

  const ackCountAfterReplay = fetchCalls.length;
  sendFrame(serverSocket, capturedIdentifier, row3);
  await waitFor(() => received.length >= 3);
  assert.deepStrictEqual(received, ["hi 1", "hi 2", "hi 3 (live)"]);
  await waitFor(() => fetchCalls.length > ackCountAfterReplay);
  assert.strictEqual(fetchCalls.length, ackCountAfterReplay + 1, "exactly one MORE ack request for the live frame");
  assert.match(fetchCalls[fetchCalls.length - 1], /after=103/);

  // Idle: nothing pending, no timer anywhere in this file -- 3s of silence
  // must produce zero further HTTP calls.
  const countBeforeIdle = fetchCalls.length;
  await new Promise((r) => setTimeout(r, 3000));
  assert.strictEqual(fetchCalls.length, countBeforeIdle, "no HTTP request must be made while idle");
});

test("a burst of live frames coalesces into at most one extra ack after the in-flight one resolves", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-coalesce");
  const AGENT_ID = "ws-coalesce";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const rows = [];
  for (let n = 1; n <= 5; n++) {
    const armored = await encryptForPublicKey(`burst ${n}`, agentKeys.publicKey);
    rows.push(
      updateRow(200 + n, AGENT_ID, "secret-agent", "message", {
        chat: { id: `chat-burst-${n}` },
        message: { chat_id: `chat-burst-${n}`, message_id: `m-burst-${n}`, message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
      })
    );
  }

  let ackInFlightCount = 0;
  let maxConcurrentAcks = 0;
  const ackUrls = [];
  const fetchImpl = async (url) => {
    ackUrls.push(url);
    ackInFlightCount++;
    maxConcurrentAcks = Math.max(maxConcurrentAcks, ackInFlightCount);
    await new Promise((r) => setTimeout(r, 60)); // hold the "in flight" window open
    ackInFlightCount--;
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  let serverSocket;
  let capturedIdentifier;
  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      serverSocket = ws;
      capturedIdentifier = identifier;
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 200 });
    },
  });
  t.after(() => cable.close());

  const received = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-coalesce",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => !!serverSocket);
  // replay_done here carries an empty backlog (nothing processed yet), so
  // it must NOT fire an ack on its own -- there is nothing new to report.
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(ackUrls.length, 0, "an empty replay must not trigger an ack -- nothing was processed");

  // Fire all 5 live frames back to back. The first one processed triggers
  // an ack (which the mock holds "in flight" for 60ms); the other four
  // arrive and are dispatched while that ack is still out, so they must
  // coalesce into at most one follow-up call rather than one each.
  for (const row of rows) sendFrame(serverSocket, capturedIdentifier, row);
  await waitFor(() => received.length >= 5);

  // Let every in-flight/queued ack settle.
  await waitFor(() => ackInFlightCount === 0 && ackUrls.length >= 1, 2000);
  await new Promise((r) => setTimeout(r, 150)); // give any (incorrect) extra ack a chance to show up

  assert.strictEqual(maxConcurrentAcks, 1, "never more than one ack in flight at a time");
  // One ack for the first live frame, plus at most one coalesced
  // follow-up for the rest of the burst that arrived while it was out.
  assert.ok(ackUrls.length <= 2, `expected a small, coalesced number of ack calls, saw ${ackUrls.length}`);
  assert.match(ackUrls[ackUrls.length - 1], /after=205/, "the last ack reflects the highest id processed");
});

// --- Plaintext (open-room) envelopes ------------------------------------------

test("a plaintext envelope (message.encrypted === false) skips PGP entirely and reaches onMessage with ctx.encrypted === false", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-plain");
  const AGENT_ID = "ws-plain";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const body = {
    chat: { id: "chat-plain" },
    message: {
      chat_id: "chat-plain",
      message_id: "m-plain",
      message: "hello from an open room",
      encrypted: false,
      user: { id: "human-plain", username: "dan", account_type: "User" },
      created_at: new Date().toISOString(),
    },
  };
  const row = updateRow(1, AGENT_ID, "secret-agent", "message", body);

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

  const contexts = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-plain",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    async onMessage(ctx) {
      contexts.push(ctx);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => contexts.length >= 1);
  assert.strictEqual(contexts[0].text, "hello from an open room");
  assert.strictEqual(contexts[0].encrypted, false, "ctx.encrypted must be false for an open-room delivery");
});

test("a plaintext envelope with no X-Salt-Agent-Id header (and no way to resolve an identity) is ignored, never dispatched", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-plain-nohdr");
  const AGENT_ID = "ws-plain-nohdr";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const body = {
    chat: { id: "chat-plain-nohdr" },
    message: {
      chat_id: "chat-plain-nohdr",
      message_id: "m-plain-nohdr",
      message: "should never arrive",
      encrypted: false,
      user: { id: "human-plain", username: "dan", account_type: "User" },
      created_at: new Date().toISOString(),
    },
  };
  // Same envelope, but with the X-Salt-Agent-Id header stripped -- as if a
  // relay dropped it, or the delivery was somehow addressed ambiguously.
  const signed = updateRow(1, AGENT_ID, "secret-agent", "message", body);
  const row = { ...signed, headers: { "X-Salt-Signature": signed.headers["X-Salt-Signature"] } };

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

  const contexts = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-plain-nohdr",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    async onMessage(ctx) {
      contexts.push(ctx);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => fetchImpl); // no-op wait just to let the connection settle
  await new Promise((r) => setTimeout(r, 150));
  assert.deepStrictEqual(contexts, [], "a plaintext envelope with no resolvable identity must never reach onMessage");
});

// --- Backfill (replay_done.more) ----------------------------------------------

test("replay_done.more pages the backfill endpoint until it returns empty, dispatching every row in order", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-backfill");
  const AGENT_ID = "ws-backfill";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const armoredA = await encryptForPublicKey("backfill A", agentKeys.publicKey);
  const armoredB = await encryptForPublicKey("backfill B", agentKeys.publicKey);
  const bodyFor = (n, armored) => ({
    chat: { id: `chat-bf-${n}` },
    message: { chat_id: `chat-bf-${n}`, message_id: `m-bf-${n}`, message: armored, sender_message: armored, user: { id: "human-bf", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  });
  const rowA = updateRow(501, AGENT_ID, "secret-agent", "message", bodyFor("a", armoredA));
  const rowB = updateRow(502, AGENT_ID, "secret-agent", "message", bodyFor("b", armoredB));

  const backfillCalls = [];
  const ackCalls = [];
  const fetchImpl = async (url) => {
    if (/limit=1&/.test(url)) {
      ackCalls.push(url);
      const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
      return jsonResponse({ updates: [], cursor: after });
    }
    backfillCalls.push(url);
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    if (after === 500) return jsonResponse({ updates: [rowA, rowB], cursor: 502 });
    return jsonResponse({ updates: [], cursor: after }); // the page that ends backfill
  };

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 500, more: true });
    },
  });
  t.after(() => cable.close());

  const received = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-backfill",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    limit: 100,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => received.length >= 2);
  assert.deepStrictEqual(received, ["backfill A", "backfill B"]);
  assert.ok(backfillCalls.some((u) => /after=500(&|$)/.test(u)), "paged starting from the replay_done cursor");
  assert.ok(backfillCalls.some((u) => /after=502(&|$)/.test(u)), "kept paging until an empty page");
  await waitFor(() => ackCalls.length >= 1);
  assert.match(ackCalls[0], /after=502/, "the ack after backfill reflects the highest processed id");
});

test("a live frame that arrives while backfill is in progress is buffered, then dispatched in order once backfill drains", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-buffer");
  const AGENT_ID = "ws-buffer";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const armoredBf = await encryptForPublicKey("backfilled", agentKeys.publicKey);
  const armoredLive = await encryptForPublicKey("arrived live during backfill", agentKeys.publicKey);
  const rowBf = updateRow(701, AGENT_ID, "secret-agent", "message", {
    chat: { id: "chat-buf-bf" },
    message: { chat_id: "chat-buf-bf", message_id: "m-buf-bf", message: armoredBf, sender_message: armoredBf, user: { id: "human-buf", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  });
  const rowLive = updateRow(699, AGENT_ID, "secret-agent", "message", {
    // A lower id than the backfilled row, on purpose -- proves buffering
    // preserves arrival semantics rather than assuming live ids are always higher.
    chat: { id: "chat-buf-live" },
    message: { chat_id: "chat-buf-live", message_id: "m-buf-live", message: armoredLive, sender_message: armoredLive, user: { id: "human-buf", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  });

  let serverSocket;
  let capturedIdentifier;
  let liveFrameSent = false;
  const backfillCalls = [];
  const fetchImpl = async (url) => {
    if (/limit=1&/.test(url)) {
      const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
      return jsonResponse({ updates: [], cursor: after });
    }
    backfillCalls.push(url);
    if (!liveFrameSent) {
      // Send the live frame WHILE this FIRST backfill request is "in flight".
      liveFrameSent = true;
      sendFrame(serverSocket, capturedIdentifier, rowLive);
    }
    await new Promise((r) => setTimeout(r, 40));
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    if (after === 700) return jsonResponse({ updates: [rowBf], cursor: 701 });
    return jsonResponse({ updates: [], cursor: after }); // the page that ends backfill
  };

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      serverSocket = ws;
      capturedIdentifier = identifier;
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 700, more: true });
    },
  });
  t.after(() => cable.close());

  const received = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-buffer",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => received.length >= 2);
  assert.ok(backfillCalls.length >= 2, "backfill paged at least twice (the row, then the empty page that ends it)");
  // The backfilled row dispatches as part of backfillFrom's own processing
  // (as soon as its page arrives); the live frame -- even though it has a
  // LOWER id and was sent first -- was buffered because it arrived while
  // state was still "backfilling", and only drains once backfill's whole
  // pass (both pages) finishes. Buffered frames are ordered relative to
  // EACH OTHER (there's only one here), never interleaved with backfill's
  // own dispatch order.
  assert.deepStrictEqual(received, ["backfilled", "arrived live during backfill"]);
});

// --- Reconnect -----------------------------------------------------------------

test("reconnects with backoff after the connection drops, resubscribing with the persisted cursor", async (t) => {
  const AGENT_ID = "ws-reconnect";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");
  const fetchImpl = async (url) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  const subscribes = [];
  const cable = startCableServer({
    onSubscribe(ws, identifier, connIndex) {
      subscribes.push({ identifier, connIndex });
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 5 });
    },
  });
  t.after(() => cable.close());

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
    minBackoffMs: 20,
    maxBackoffMs: 60,
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => subscribes.length >= 1);
  assert.strictEqual(subscribes[0].identifier.after, undefined, "the first connection has no local cursor yet, so `after` is omitted");

  assert.strictEqual(cable.connections.length, 1);
  cable.connections[0].close();

  await waitFor(() => subscribes.length >= 2, 3000);
  assert.strictEqual(subscribes[1].identifier.after, 5, "the reconnect resubscribes with the cursor persisted from replay_done");
});

test("stop() terminates an open connection immediately and resolves promptly", async (t) => {
  const AGENT_ID = "ws-stop";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");
  const fetchImpl = async (url) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 0 });
    },
  });
  t.after(() => cable.close());

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
  });

  socket.start();
  await waitFor(() => cable.connections.length >= 1);
  const startedStop = Date.now();
  await socket.stop();
  assert.ok(Date.now() - startedStop < 1000, "stop() should not wait out any long timer");
});

test("start() is idempotent, and stop() then start() again resumes cleanly", async (t) => {
  const AGENT_ID = "ws-startstop";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");
  const fetchImpl = async (url) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 0 });
    },
  });
  t.after(() => cable.close());

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
  });
  t.after(() => socket.stop());

  socket.start();
  socket.start(); // no-op, doesn't spawn a second connection
  await waitFor(() => cable.connections.length >= 1);
  assert.strictEqual(cable.connections.length, 1, "a second start() must not open a second connection");

  await socket.stop();
  const connectionsAfterFirstStop = cable.connections.length;

  socket.start();
  await waitFor(() => cable.connections.length > connectionsAfterFirstStop);
  await socket.stop();
});

// --- Verification (unchanged behaviour, new transport) ------------------------

test("rejects a badly-signed envelope without dispatching it, while a validly-signed sibling still goes through", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-sig");
  const AGENT_ID = "ws-sig";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const armoredGood = await encryptForPublicKey("good", agentKeys.publicKey);
  const armoredBad = await encryptForPublicKey("forged", agentKeys.publicKey);
  const bodyFor = (n, armored) => ({
    chat: { id: `chat-sig-${n}` },
    message: { chat_id: `chat-sig-${n}`, message_id: `m-sig-${n}`, message: armored, sender_message: armored, user: { id: "human-2", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  });

  const goodRow = updateRow(1, AGENT_ID, "secret-agent", "message", bodyFor(1, armoredGood));
  const forgedRow = updateRow(2, AGENT_ID, "not-the-real-secret", "message", bodyFor(2, armoredBad));

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, forgedRow);
      sendFrame(ws, identifier, goodRow);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 2 });
    },
  });
  t.after(() => cable.close());

  const fetchImpl = async (url) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  const received = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-sig",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => received.length >= 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(received, ["good"], "the forged envelope never reached onMessage");
});

test("a duplicate delivery_id (e.g. replayed once and seen again live) is never dispatched twice", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-dedupe");
  const AGENT_ID = "ws-dedupe";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const armored = await encryptForPublicKey("hi", agentKeys.publicKey);
  const body = {
    chat: { id: "chat-dedupe" },
    message: { chat_id: "chat-dedupe", message_id: "m-dedupe", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  };
  const raw = JSON.stringify(body);
  const headers = signHeaders(AGENT_ID, "secret-agent", raw);
  const row1 = { id: 1, delivery_id: "dupe-id", event: "message", headers, body: raw, created_at: new Date().toISOString() };
  const row2 = { id: 2, delivery_id: "dupe-id", event: "message", headers, body: raw, created_at: new Date().toISOString() };

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, row1);
      sendFrame(ws, identifier, row2);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 2 });
    },
  });
  t.after(() => cable.close());

  const fetchImpl = async (url) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  const received = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-dedupe",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await waitFor(() => received.length >= 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(received, ["hi"], "the second row (same delivery_id) must be skipped, not re-dispatched");
});

test("a transient verification failure does not block later frames, and clamps cursor persistence so a reconnect re-delivers it", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-transient");
  const AGENT_ID = "ws-transient";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  // getWebhookSecret fails (network down) on the FIRST call only -- exactly
  // the shape a transient outage takes.
  let secretCalls = 0;
  const client = {
    async getWebhookSecret() {
      secretCalls++;
      if (secretCalls === 1) throw new Error("network down");
      return "secret-agent";
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

  const armoredBad = await encryptForPublicKey("never resolves this run", agentKeys.publicKey);
  const armoredGood = await encryptForPublicKey("goes through fine", agentKeys.publicKey);
  const rowTransient = updateRow(10, AGENT_ID, "secret-agent", "message", {
    chat: { id: "chat-transient" },
    message: { chat_id: "chat-transient", message_id: "m-transient", message: armoredBad, sender_message: armoredBad, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  });
  const rowAfter = updateRow(11, AGENT_ID, "secret-agent", "message", {
    chat: { id: "chat-after" },
    message: { chat_id: "chat-after", message_id: "m-after", message: armoredGood, sender_message: armoredGood, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  });

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, rowTransient);
      sendFrame(ws, identifier, rowAfter);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 11 });
    },
  });
  t.after(() => cable.close());

  const fetchImpl = async (url) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  const cursorStore = trackingCursorStore();
  const received = [];
  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-transient",
    logger: silent,
    cursorStore,
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  // The row AFTER the transient failure must still get dispatched -- a
  // single bad row no longer blocks the rest of the stream (unlike the
  // old poll client's per-batch halt).
  await waitFor(() => received.length >= 1);
  assert.deepStrictEqual(received, ["goes through fine"]);
  await waitFor(() => cursorStore.puts.length >= 1);
  // The persisted cursor must be clamped to stop BEFORE the failed row
  // (id 10), even though replay_done itself reported cursor 11 -- so a
  // reconnect will re-replay from there and give it another chance.
  assert.ok(cursorStore.puts.every((c) => c < 10), `cursor must never advance past the unresolved row: saw ${JSON.stringify(cursorStore.puts)}`);
});

// --- Handshake-level 429 / Retry-After ----------------------------------------

/** A server that answers the FIRST websocket upgrade attempt with a raw
 *  HTTP 429 (never upgrading), then upgrades normally on every attempt
 *  after that -- simulates Rack::Attack's blanket api-key/ip ceiling
 *  rejecting the /cable handshake itself. */
function startFlakyCableServer({ onSubscribe, retryAfterSeconds }) {
  const http = require("node:http");
  let attempt = 0;
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const connections = [];
  httpServer.on("upgrade", (req, socket, head) => {
    attempt++;
    if (attempt === 1) {
      const lines = ["HTTP/1.1 429 Too Many Requests", "Connection: close"];
      if (retryAfterSeconds !== undefined) lines.push(`Retry-After: ${retryAfterSeconds}`);
      lines.push("", "");
      socket.end(lines.join("\r\n"));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
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
  });
  httpServer.listen(0);
  return {
    connections,
    attempts: () => attempt,
    port: () => httpServer.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const ws of connections) {
          try {
            ws.terminate();
          } catch {
            // already gone
          }
        }
        // http.Server#close also just stops accepting new connections and
        // waits for existing ones to end on their own -- force any still
        // open (a socket a 429 response's `.end()` hasn't fully drained yet)
        // closed too, so this never hangs on a lingering half-closed socket.
        if (typeof httpServer.closeAllConnections === "function") httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

test("a 429 on the websocket handshake honours Retry-After, overriding the exponential backoff for that one wait", async (t) => {
  const AGENT_ID = "ws-429";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "secret-429");
  const fetchImpl = async (url) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  const cable = startFlakyCableServer({
    retryAfterSeconds: 2,
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 0 });
    },
  });
  t.after(() => cable.close());

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
    minBackoffMs: 10,
    maxBackoffMs: 50,
  });
  t.after(() => socket.stop());

  socket.start();
  // The mocked Retry-After is 2s; if it were ignored in favor of the 10ms
  // exponential backoff, a second (successful) connection would already
  // exist well within this window.
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(cable.attempts(), 1, "must still be honouring the 2s Retry-After, not the 10ms exponential backoff");
});

// --- File-based default stores (unchanged by the push rewrite) ---------------

test("FileCursorStore round-trips through a real file, atomically, and defaults missing to 0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-cursorstore-"));
  const cursorStore = sdk.FileCursorStore(dir);

  assert.strictEqual(await cursorStore.get("agent-x"), 0);
  await cursorStore.put("agent-x", 42);
  assert.strictEqual(await cursorStore.get("agent-x"), 42);

  const raw = fs.readFileSync(path.join(dir, "agent-x.cursor.json"), "utf8");
  assert.deepStrictEqual(JSON.parse(raw), { cursor: 42 });
  // Atomic write: no leftover temp file.
  assert.deepStrictEqual(fs.readdirSync(dir), ["agent-x.cursor.json"]);
});

// N9 (second security review, 2026-09-18): a directory shared by more
// than one identity used to collide on the single fixed `cursor.json` --
// one agent's cursor clobbering another's. The file is now keyed by
// agent id, so a shared directory is safe.
test("N9: FileCursorStore given a SHARED directory keeps two agents' cursors independent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-cursorstore-shared-"));
  const cursorStore = sdk.FileCursorStore(dir);

  await cursorStore.put("agent-one", 10);
  await cursorStore.put("agent-two", 999);

  assert.strictEqual(await cursorStore.get("agent-one"), 10, "agent-two's write must not clobber agent-one's cursor");
  assert.strictEqual(await cursorStore.get("agent-two"), 999);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["agent-one.cursor.json", "agent-two.cursor.json"]);
});

test("N10: FileCursorStore creates the directory 0700 and the file 0600", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "salt-cursorstore-perm-")), "nested");
  await sdk.FileCursorStore(dir).put("agent-x", 1);

  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(dir, "agent-x.cursor.json")).mode & 0o777, 0o600);
});

test("FileDedupeStore round-trips through a real file and bounds to `max` entries", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-dedupestore-"));
  const dedupeStore = sdk.FileDedupeStore(dir, 3);

  assert.strictEqual(await dedupeStore.has("agent-x", "a"), false);
  await dedupeStore.add("agent-x", "a");
  await dedupeStore.add("agent-x", "b");
  await dedupeStore.add("agent-x", "c");
  assert.strictEqual(await dedupeStore.has("agent-x", "a"), true);

  await dedupeStore.add("agent-x", "d"); // pushes "a" out (bound = 3)
  assert.strictEqual(await dedupeStore.has("agent-x", "a"), false);
  assert.strictEqual(await dedupeStore.has("agent-x", "d"), true);

  const raw = JSON.parse(fs.readFileSync(path.join(dir, "agent-x.seen.json"), "utf8"));
  assert.deepStrictEqual(raw, ["b", "c", "d"]);
});

test("FileDedupeStore persists across a fresh store instance pointed at the same directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-dedupestore-persist-"));
  await sdk.FileDedupeStore(dir).add("agent-x", "seen-once");

  const reopened = sdk.FileDedupeStore(dir);
  assert.strictEqual(await reopened.has("agent-x", "seen-once"), true);
});

test("N9: FileDedupeStore given a SHARED directory keeps two agents' dedupe sets independent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-dedupestore-shared-"));
  const dedupeStore = sdk.FileDedupeStore(dir);

  await dedupeStore.add("agent-one", "delivery-shared-id");
  assert.strictEqual(await dedupeStore.has("agent-one", "delivery-shared-id"), true);
  assert.strictEqual(
    await dedupeStore.has("agent-two", "delivery-shared-id"),
    false,
    "agent-two must not see agent-one's dedupe entry even when the delivery_id string collides"
  );
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ["agent-one.seen.json"]);
});

test("N10: FileDedupeStore creates the directory 0700 and the file 0600", async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "salt-dedupestore-perm-")), "nested");
  await sdk.FileDedupeStore(dir).add("agent-x", "a");

  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(dir, "agent-x.seen.json")).mode & 0o777, 0o600);
});

// --- N2/round 3: relaxed to a warning + in-memory fallback -----------------

// Round 3 (2026-09-18): round 2's N2 made an unwritable default state
// directory a hard, synchronous refusal to start. That's relaxed here --
// salt-api's server-side ack (LANES.md) means a lost cursor/dedupe store
// is no longer a replay risk, just a cache, so this now warns clearly and
// falls back to in-memory stores for the run instead of ever throwing.
// Still true verbatim under the push rewrite: resolveDefaultStores is
// unchanged, only the transport that consumes cursorStore/dedupeStore is
// different.
test("round 3: an unwritable default state directory warns and falls back to in-memory stores, never throws", async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip("running as root -- permission bits on the read-only HOME would be bypassed");
    return;
  }

  const roRoot = fs.mkdtempSync(path.join(os.tmpdir(), "salt-readonly-home-"));
  fs.chmodSync(roRoot, 0o500); // read + execute only -- cannot create a subdirectory inside it
  const originalHome = process.env.HOME;
  process.env.HOME = roRoot;
  t.after(() => {
    process.env.HOME = originalHome;
    fs.chmodSync(roRoot, 0o700);
    fs.rmSync(roRoot, { recursive: true, force: true });
  });

  const agentKeys = await sdk.generateKeypair("agent-pass-n2warn");
  const AGENT_ID = "ws-n2warn";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const warnings = [];
  const logger = { info() {}, error: (msg) => warnings.push(msg) };

  const armored = await encryptForPublicKey("hi", agentKeys.publicKey);
  const body = {
    chat: { id: "chat-n2warn" },
    message: {
      chat_id: "chat-n2warn", message_id: "m-n2warn", message: armored, sender_message: armored,
      user: { id: "human-n2warn", username: "dan", account_type: "User" }, created_at: new Date().toISOString(),
    },
  };
  const row = updateRow(1, AGENT_ID, "secret-agent", "message", body);
  const fetchImpl = async (url) => {
    const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
    return jsonResponse({ updates: [], cursor: after });
  };

  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, row);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 1 });
    },
  });
  t.after(() => cable.close());

  // Constructing the client is where the directory is checked now (not
  // start()) -- neither construction nor start() may ever throw here.
  let socket;
  const received = [];
  assert.doesNotThrow(() => {
    socket = sdk.createSocketClient({
      host: `http://127.0.0.1:${cable.port()}`,
      apiKey: "the-key",
      agentId: AGENT_ID,
      client,
      identities: store,
      pgpPassphrase: "agent-pass-n2warn",
      logger,
      fetchImpl,
      async onMessage(ctx) {
        received.push(ctx.text);
      },
    });
  }, "constructing the client under an unwritable default HOME must never throw");
  t.after(() => socket.stop());

  assert.doesNotThrow(() => socket.start(), "start() must never throw either");
  await waitFor(() => received.length >= 1);

  assert.deepStrictEqual(received, ["hi"], "dispatch must still work via the in-memory fallback");
  assert.ok(
    warnings.some((w) => /WARNING/.test(w) && /in-memory/i.test(w)),
    "expected a clear warning about the fallback to in-memory stores"
  );
});

test("N2: passing BOTH cursorStore and dedupeStore explicitly opts out of the state-directory check entirely", async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip("running as root -- permission bits on the read-only HOME would be bypassed");
    return;
  }

  const roRoot = fs.mkdtempSync(path.join(os.tmpdir(), "salt-readonly-home-optout-"));
  fs.chmodSync(roRoot, 0o500);
  const originalHome = process.env.HOME;
  process.env.HOME = roRoot;
  t.after(() => {
    process.env.HOME = originalHome;
    fs.chmodSync(roRoot, 0o700);
    fs.rmSync(roRoot, { recursive: true, force: true });
  });

  const { store, client } = baseIdentitiesAndClient("ws-n2b", "secret-n2b");
  const cable = startCableServer({
    onSubscribe(ws, identifier) {
      sendConfirm(ws, identifier);
      sendFrame(ws, identifier, { type: "replay_done", cursor: 0 });
    },
  });
  t.after(() => cable.close());

  const socket = sdk.createSocketClient({
    host: `http://127.0.0.1:${cable.port()}`,
    apiKey: "the-key",
    agentId: "ws-n2b",
    client,
    identities: store,
    pgpPassphrase: "agent-pass-n2b",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl: async (url) => {
      const after = Number(/after=(\d+)/.exec(url)?.[1] ?? 0);
      return jsonResponse({ updates: [], cursor: after });
    },
  });
  t.after(() => socket.stop());

  assert.doesNotThrow(() => socket.start(), "the unwritable default HOME must never be touched when both stores are explicit");
});
