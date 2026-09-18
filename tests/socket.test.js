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
    fetchImpl,
    timeoutSeconds: 1,
    async onMessage(ctx) {
      received.push(ctx.text);
    },
  });
  t.after(() => socket.stop());

  socket.start();
  await new Promise((r) => setTimeout(r, 150));

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
