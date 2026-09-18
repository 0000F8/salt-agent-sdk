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
    const headerMap = new Map(Object.entries(entry.headers || {}));
    return {
      ok: entry.status === undefined || (entry.status >= 200 && entry.status < 300),
      status: entry.status ?? 200,
      headers: { get: (name) => headerMap.get(name) ?? null },
      json: async () => entry.body,
    };
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
  // Round 3 (server-side ack): with no local cursor, the first poll omits
  // `after` entirely so salt-api's own stored ack applies -- it must NOT
  // send after=0, which is a wire distinction the server treats the same
  // way, but the client should still prefer to say nothing over a number
  // it doesn't actually have grounds for.
  assert.doesNotMatch(fetchImpl.calls[0], /after=/, "the first poll with no local cursor must omit after entirely");
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

// N4 (second security review, 2026-09-18): a bad signature is not
// necessarily forged -- salt-api rotates a signing key with no push
// notification, so the first sign of a rotation is exactly a signature
// that fails against whatever secret this process had cached.
// R1 (round 3, 2026-09-18): round 2's per-envelope evict-and-refetch (N4)
// is gone -- serve-time signing (LANES.md) means the socket path never
// sees a stale signature any more. What's left is a much narrower,
// rate-limited recheck aimed at the webhook path (a real POST, signed at
// SEND time, can still race a genuine rotation): at most one uncached
// fetch per agent per 60s, and it only replaces the cache if the fresh
// value actually verifies. This still self-heals a genuine one-off
// rotation on the socket path too (nothing routes around verifyEnvelope),
// just without round 2's per-envelope, ungated retries.
test("R1: a signature that fails against the cached secret self-heals once the fresh secret verifies it", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-n4a");
  const AGENT_ID = "sock-n4a";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const secretCalls = [];
  const client = {
    async getWebhookSecret(apiKey) {
      secretCalls.push(apiKey);
      // The first fetch primes the cache with the OLD secret; everything
      // after that returns the NEW one -- exactly what
      // GET /api/v1/agents/webhook_secret looks like across a rotation.
      return secretCalls.length === 1 ? "secret-old" : "secret-new";
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

  const armored1 = await encryptForPublicKey("priming", agentKeys.publicKey);
  const primeRow = updateRow(1, AGENT_ID, "secret-old", "message", {
    chat: { id: "chat-n4a-1" },
    message: {
      chat_id: "chat-n4a-1", message_id: "m-n4a-1", message: armored1, sender_message: armored1,
      user: { id: "human-n4a", username: "dan", account_type: "User" }, created_at: new Date().toISOString(),
    },
  });

  const armored2 = await encryptForPublicKey("post-rotation", agentKeys.publicKey);
  // Signed with the ROTATED secret while the dispatcher's cache still
  // holds "secret-old" from the priming row above.
  const rotatedRow = updateRow(2, AGENT_ID, "secret-new", "message", {
    chat: { id: "chat-n4a-2" },
    message: {
      chat_id: "chat-n4a-2", message_id: "m-n4a-2", message: armored2, sender_message: armored2,
      user: { id: "human-n4a", username: "dan", account_type: "User" }, created_at: new Date().toISOString(),
    },
  });

  // Both rows in the SAME poll response -- handleOne processes them
  // sequentially within one pollOnce call, so this doesn't need to wait
  // out the adaptive inter-poll delay to observe the second row.
  const fetchImpl = makeQueueFetch([
    { body: { updates: [primeRow, rotatedRow], cursor: 2 }, delayMs: 5 },
    { body: { updates: [], cursor: 2 }, delayMs: 30 },
  ]);

  const received = [];
  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-n4a",
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
  await new Promise((r) => setTimeout(r, 150));

  assert.deepStrictEqual(
    received,
    ["priming", "post-rotation"],
    "the post-rotation envelope must self-heal and dispatch on the FIRST attempt, no retry needed"
  );
  assert.strictEqual(secretCalls.length, 2, "exactly one priming fetch plus exactly one refetch-after-bad-signature");
});

test("R1: a signature that still fails after the bounded recheck is definitive IMMEDIATELY -- no transient retry any more", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-n4b");
  const AGENT_ID = "sock-n4b";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  // Keeps "rotating" on every single call, but never to the value the
  // envelope below was actually signed with -- simulates a signature that
  // is genuinely forged/corrupted rather than merely stale.
  let secretCalls = 0;
  const client = {
    async getWebhookSecret() {
      secretCalls++;
      return `secret-v${secretCalls}`;
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

  const armored = await encryptForPublicKey("never-delivered", agentKeys.publicKey);
  const body = {
    chat: { id: "chat-n4b" },
    message: {
      chat_id: "chat-n4b", message_id: "m-n4b", message: armored, sender_message: armored,
      user: { id: "human-n4b", username: "dan", account_type: "User" }, created_at: new Date().toISOString(),
    },
  };
  // Signed with a secret the mocked client will never actually return.
  const row = updateRow(1, AGENT_ID, "secret-bogus", "message", body);
  const fetchImpl = makeQueueFetch([{ body: { updates: [row], cursor: 1 }, delayMs: 5 }, { body: { updates: [], cursor: 1 }, delayMs: 30 }]);

  const logs = [];
  const logger = { info() {}, error: (msg) => logs.push(msg) };

  const received = [];
  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-n4b",
    logger,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    timeoutSeconds: 1,
    minBackoffMs: 10,
    maxBackoffMs: 20,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await new Promise((r) => setTimeout(r, 150));

  assert.deepStrictEqual(received, [], "a genuinely bad signature must never be dispatched, rotation or not");
  assert.ok(
    !logs.some((l) => /retrying once after a secret rotation/.test(l)),
    "round 2's transient-retry-after-rotation grace must be gone entirely"
  );
  assert.ok(
    logs.some((l) => /rejected update 1 \(message\): bad signature/.test(l)),
    "must be rejected as definitively bad on the very first (and only) attempt"
  );
  // secretCalls: 1 for the initial cache-miss fetch, 1 for the single
  // bounded recheck the bad signature triggers. Never more, however many
  // times this same row is re-served within the 60s rate-limit window.
  assert.strictEqual(secretCalls, 2, "the bounded recheck must fire at most once, not once per bad envelope");
});

// R1's explicit acceptance test: the webhook (real POST) path must not
// let a burst of forged requests turn into a burst of getWebhookSecret
// calls -- a single-flight, 60s-rate-limited recheck bounds it to at
// most one extra call regardless of how many forged POSTs arrive.
test("R1: 50 forged POSTs to the webhook path cause at most one getWebhookSecret call", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-n4c");
  const AGENT_ID = "20000000-0000-0000-0000-0000000000c1";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "the-key", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  let secretCalls = 0;
  const client = {
    async getWebhookSecret() {
      secretCalls++;
      return "secret-real"; // never matches the forged signatures below
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

  const dispatched = [];
  const server = sdk.createWebhookServer({
    client,
    identities: store,
    pgpPassphrase: "agent-pass-n4c",
    logger: silent,
    async onMessage(ctx) {
      dispatched.push(ctx);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const body = JSON.stringify({ chat: { id: "chat-n4c" }, message: { chat_id: "chat-n4c", message_id: "m-n4c" } });
  const forgedPost = () => {
    const t0 = Math.floor(Date.now() / 1000);
    return fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Salt-Agent-Id": AGENT_ID, "X-Salt-Signature": `t=${t0},v1=${"0".repeat(64)}` },
      body,
    });
  };

  // Prime the cache with ONE real request first (the still-unbounded
  // concurrent-first-miss path in secretForAgent is a separate, pre-
  // existing concern from R1's bounded recheck) so the 50 forged POSTs
  // below all hit an already-warm cache and exercise ONLY the bounded,
  // single-flight recheck this fix adds.
  const primedHeaders = signHeaders(AGENT_ID, "secret-real", body);
  const primed = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...primedHeaders },
    body,
  });
  assert.equal(primed.status, 200);
  assert.strictEqual(secretCalls, 1, "priming must cost exactly one getWebhookSecret call");

  const responses = await Promise.all(Array.from({ length: 50 }, () => forgedPost()));
  assert.ok(responses.every((r) => r.status === 401), "every forged POST must be rejected 401");
  // The cache was already warm, so none of the 50 forged requests could
  // race a cache-miss fetch -- only the bounded recheck can fire here,
  // and it's single-flight + rate-limited to at most one call.
  assert.strictEqual(secretCalls, 2, "50 forged POSTs against an already-cached secret must cause at most one ADDITIONAL getWebhookSecret call");
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
  const AGENT_ID = "sock-n2warn";
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
  const fetchImpl = makeQueueFetch([{ body: { updates: [row], cursor: 1 }, delayMs: 5 }, { body: { updates: [], cursor: 1 }, delayMs: 30 }]);

  // Constructing the client is where the directory is checked now (not
  // start()) -- neither construction nor start() may ever throw here.
  let socket;
  const received = [];
  assert.doesNotThrow(() => {
    socket = sdk.createSocketClient({
      host: "http://example.invalid",
      apiKey: "the-key",
      agentId: AGENT_ID,
      client,
      identities: store,
      pgpPassphrase: "agent-pass-n2warn",
      logger,
      fetchImpl,
      timeoutSeconds: 1,
      async onMessage(ctx) {
        received.push(ctx.text);
      },
    });
  }, "constructing the client under an unwritable default HOME must never throw");
  t.after(() => socket.stop());

  assert.doesNotThrow(() => socket.start(), "start() must never throw either");
  await new Promise((r) => setTimeout(r, 150));

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

  const { store, client } = baseIdentitiesAndClient("sock-n2b", "secret-n2b");
  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: "sock-n2b",
    client,
    identities: store,
    pgpPassphrase: "agent-pass-n2b",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl: makeQueueFetch([{ body: { updates: [], cursor: 0 }, delayMs: 5 }]),
  });
  t.after(() => socket.stop());

  assert.doesNotThrow(() => socket.start(), "the unwritable default HOME must never be touched when both stores are explicit");
});

// --- Retry-After -------------------------------------------------------------

test("Retry-After on a 429 from the poll endpoint overrides the exponential backoff wait (second security review, 2026-09-18)", async (t) => {
  const AGENT_ID = "sock-429";
  const { store, client } = baseIdentitiesAndClient(AGENT_ID, "secret-429");

  const fetchImpl = makeQueueFetch([
    { status: 429, headers: { "Retry-After": "2" }, body: {}, delayMs: 5 },
    { body: { updates: [], cursor: 0 }, delayMs: 5 },
  ]);

  const socket = sdk.createSocketClient({
    host: "http://example.invalid",
    apiKey: "the-key",
    agentId: AGENT_ID,
    client,
    identities: store,
    pgpPassphrase: "agent-pass-429",
    logger: silent,
    cursorStore: sdk.MemoryCursorStore(),
    dedupeStore: sdk.MemoryDedupeStore(),
    fetchImpl,
    timeoutSeconds: 1,
    minBackoffMs: 10,
    maxBackoffMs: 50,
  });
  t.after(() => socket.stop());

  socket.start();
  // The mocked Retry-After is 2s; if it were ignored in favor of the 10ms
  // exponential backoff, a second call would already have happened well
  // within this window.
  await new Promise((r) => setTimeout(r, 400));
  assert.strictEqual(fetchImpl.calls.length, 1, "must still be honouring the 2s Retry-After, not the 10ms exponential backoff");
});
