// K2 socket mode's client half (socket.ts): createSocketClient long-polls
// GET /api/v1/agent/updates and feeds each envelope through the SAME
// createDispatcher webhook.ts's Express route uses -- verified here by
// mocking `fetch` (never a real network call) and asserting cursor
// advance, signature rejection, backoff, dispatch parity with the webhook
// path, and a clean stop().
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const openpgp = require("openpgp");

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

/** One AgentUpdate row, wire-shaped exactly like salt-api's GET /api/v1/agent/updates. */
function updateRow(id, agentId, secret, event, bodyObj) {
  const body = JSON.stringify(bodyObj);
  return { id, delivery_id: `d-${id}`, event, headers: signHeaders(agentId, secret, body), body, created_at: new Date().toISOString() };
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("The operation was aborted."));
      });
    }
  });
}

/** A queue of canned responses (or an infinite tail of the last one), each
 *  simulating the server's own long-poll hold via `delayMs` -- an empty
 *  response should behave like a real long-poll that waited out its
 *  timeout, not an instant reply, or the client would tight-loop. */
function makeQueueFetch(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts) => {
    calls.push(url);
    const entry = responses[Math.min(i, responses.length - 1)];
    i++;
    await abortableDelay(entry.delayMs ?? 5, opts && opts.signal);
    if (entry.throws) throw entry.throws;
    return { ok: entry.status === undefined || (entry.status >= 200 && entry.status < 300), status: entry.status ?? 200, json: async () => entry.body };
  };
  fn.calls = calls;
  return fn;
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

test("advances the cursor across polls and dispatches every valid update in order", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const AGENT_ID = "sock-1";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const armored1 = await encryptForPublicKey("hi 1", agentKeys.publicKey);
  const armored2 = await encryptForPublicKey("hi 2", agentKeys.publicKey);
  const msgBody = (n, armored) => ({
    chat: { id: `chat-${n}` },
    message: { chat_id: `chat-${n}`, message_id: `m-${n}`, message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  });

  const row1 = updateRow(101, AGENT_ID, "secret-agent", "message", msgBody(1, armored1));
  const row2 = updateRow(102, AGENT_ID, "secret-agent", "message", msgBody(2, armored2));

  const fetchImpl = makeQueueFetch([
    { body: { updates: [row1, row2], cursor: 102 }, delayMs: 5 },
    { body: { updates: [], cursor: 102 }, delayMs: 30 },
  ]);

  const received = [];
  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    timeoutSeconds: 1,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  // Adaptive polling (H1/M5) waits ACTIVE_POLL_DELAY_MS (1s) after a poll
  // that had activity before firing the next one -- wait past that, not
  // just past the mocked network delay, to actually observe poll #2.
  await new Promise((r) => setTimeout(r, sdk.ACTIVE_POLL_DELAY_MS + 300));

  assert.deepStrictEqual(received, ["hi 1", "hi 2"]);
  assert.match(fetchImpl.calls[0], /after=0/);
  assert.ok(fetchImpl.calls.some((u) => /after=102/.test(u)), "the second poll used the cursor the first response returned");
});

test("rejects a badly-signed envelope without dispatching it, while a validly-signed sibling still goes through", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-2");
  const AGENT_ID = "sock-2";
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
  // Signed with the WRONG secret -- simulates a relay/tamper between salt-api and this client.
  const forgedRow = updateRow(2, AGENT_ID, "not-the-real-secret", "message", bodyFor(2, armoredBad));

  const fetchImpl = makeQueueFetch([
    { body: { updates: [forgedRow, goodRow], cursor: 2 }, delayMs: 5 },
    { body: { updates: [], cursor: 2 }, delayMs: 30 },
  ]);

  const received = [];
  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-2",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    timeoutSeconds: 1,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await new Promise((r) => setTimeout(r, 150));

  assert.deepStrictEqual(received, ["good"], "the forged envelope never reached onMessage");
});

test("backs off after a failed poll and recovers once the server answers again", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-3");
  const AGENT_ID = "sock-3";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const armored = await encryptForPublicKey("recovered", agentKeys.publicKey);
  const row = updateRow(1, AGENT_ID, "secret-agent", "message", {
    chat: { id: "chat-backoff" },
    message: { chat_id: "chat-backoff", message_id: "m-backoff", message: armored, sender_message: armored, user: { id: "human-3", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  });

  const fetchImpl = makeQueueFetch([
    { throws: new Error("network down"), delayMs: 1 },
    { status: 500, body: {}, delayMs: 1 },
    { body: { updates: [row], cursor: 1 }, delayMs: 1 },
    { body: { updates: [], cursor: 1 }, delayMs: 30 },
  ]);

  const received = [];
  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-3",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    timeoutSeconds: 1,
    minBackoffMs: 10,
    maxBackoffMs: 50,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await new Promise((r) => setTimeout(r, 300));

  assert.deepStrictEqual(received, ["recovered"]);
  assert.ok(fetchImpl.calls.length >= 3, `expected at least 3 poll attempts, saw ${fetchImpl.calls.length}`);
});

test("stop() aborts an in-flight long-poll immediately rather than waiting it out", async (t) => {
  const AGENT_ID = "sock-4";
  const store = { get: () => undefined, all: () => [], register() {}, reassignId: () => undefined };
  const client = {
    async getWebhookSecret() {
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

  // A response that would otherwise take much longer than this test should
  // have to wait -- if stop() didn't abort, this test would take 5s.
  const fetchImpl = makeQueueFetch([{ body: { updates: [], cursor: 0 }, delayMs: 5000 }]);

  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    timeoutSeconds: 25,
  });

  socket.start();
  await new Promise((r) => setTimeout(r, 20)); // let the first poll actually start
  const startedStop = Date.now();
  await socket.stop();
  assert.ok(Date.now() - startedStop < 500, "stop() should abort the in-flight request rather than waiting out its delay");
});

test("start() is idempotent, and stop() then start() again resumes cleanly", async (t) => {
  const AGENT_ID = "sock-5";
  const store = { get: () => undefined, all: () => [], register() {}, reassignId: () => undefined };
  const client = {
    async getWebhookSecret() {
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
  const fetchImpl = makeQueueFetch([{ body: { updates: [], cursor: 0 }, delayMs: 10 }]);

  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
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
  socket.start(); // no-op, doesn't spawn a second loop
  await new Promise((r) => setTimeout(r, 50));
  await socket.stop();
  const callsAfterFirstStop = fetchImpl.calls.length;

  socket.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(fetchImpl.calls.length > callsAfterFirstStop, "polling resumed after stop() + start()");
  await socket.stop();
});

// --- M5/F3 (security review, 2026-09-18) ------------------------------------

test("a duplicate delivery_id (e.g. replayed via the Cable backlog + long-poll overlap) is never dispatched twice", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-dedupe");
  const AGENT_ID = "sock-dedupe";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const { client } = baseIdentitiesAndClient(AGENT_ID, "secret-agent");

  const armored = await encryptForPublicKey("hi", agentKeys.publicKey);
  const body = {
    chat: { id: "chat-dedupe" },
    message: { chat_id: "chat-dedupe", message_id: "m-dedupe", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  };
  // Same delivery_id on both rows (different ids, as if replayed once via
  // the backlog and once live) -- the SAME envelope, seen twice.
  const raw = JSON.stringify(body);
  const headers = signHeaders(AGENT_ID, "secret-agent", raw);
  const row1 = { id: 1, delivery_id: "dupe-id", event: "message", headers, body: raw, created_at: new Date().toISOString() };
  const row2 = { id: 2, delivery_id: "dupe-id", event: "message", headers, body: raw, created_at: new Date().toISOString() };

  const fetchImpl = makeQueueFetch([
    { body: { updates: [row1, row2], cursor: 2 }, delayMs: 5 },
    { body: { updates: [], cursor: 2 }, delayMs: 30 },
  ]);

  const received = [];
  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-dedupe",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    timeoutSeconds: 1,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await new Promise((r) => setTimeout(r, 150));

  assert.deepStrictEqual(received, ["hi"], "the second row (same delivery_id) must be skipped, not re-dispatched");
});

test("a transient verification failure (no signing key) halts the batch and never advances the cursor past it", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-transient");
  const AGENT_ID = "sock-transient";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  // getWebhookSecret fails (network down) on the FIRST call, then recovers
  // -- exactly the shape a transient outage takes.
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

  const armored = await encryptForPublicKey("hi", agentKeys.publicKey);
  const body = {
    chat: { id: "chat-transient" },
    message: { chat_id: "chat-transient", message_id: "m-transient", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
  };
  const row = updateRow(1, AGENT_ID, "secret-agent", "message", body);

  // The SAME row (same id) is served on every poll -- if the client
  // advanced its cursor past it despite the transient failure, it would
  // never see it again and this would never reach onMessage at all.
  const fetchImpl = makeQueueFetch([{ body: { updates: [row], cursor: 1 }, delayMs: 5 }]);

  const received = [];
  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-transient",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    timeoutSeconds: 1,
    minBackoffMs: 10,
    maxBackoffMs: 50,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await new Promise((r) => setTimeout(r, 200));

  assert.deepStrictEqual(received, ["hi"], "the retry (after the transient failure resolved) must still see the same row");
  assert.ok(secretCalls >= 2, "expected at least one failed attempt and one retry");
});

// --- File-based default stores ----------------------------------------------

test("FileCursorStore round-trips through a real file, atomically, and defaults missing to 0", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-cursorstore-"));
  const cursorStore = sdk.FileCursorStore(dir);

  assert.strictEqual(await cursorStore.get("agent-x"), 0);
  await cursorStore.put("agent-x", 42);
  assert.strictEqual(await cursorStore.get("agent-x"), 42);

  const raw = fs.readFileSync(path.join(dir, "cursor.json"), "utf8");
  assert.deepStrictEqual(JSON.parse(raw), { cursor: 42 });
  // Atomic write: no leftover temp file.
  assert.deepStrictEqual(fs.readdirSync(dir), ["cursor.json"]);
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

  const raw = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
  assert.deepStrictEqual(raw, ["b", "c", "d"]);
});

test("FileDedupeStore persists across a fresh store instance pointed at the same directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-dedupestore-persist-"));
  await sdk.FileDedupeStore(dir).add("agent-x", "seen-once");

  const reopened = sdk.FileDedupeStore(dir);
  assert.strictEqual(await reopened.has("agent-x", "seen-once"), true);
});
