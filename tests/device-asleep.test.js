// Real salt-api shapes (DeviceSession#as_json_public + Chat#agent_block, docs/DEVICE_PROTOCOL.md):
// a session's `chat.readers` is {ids, open}, and a sleeping computer is `requested` with
// `delivered_at: null` (kept up to 8 hours), not `queued`.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessionJson = (extra = {}) => ({
  agent: null, intent: null, id: "s1", agent_id: "ag", device_id: "d", mandate_id: "m", chat_id: "chat-1",
  status: "requested", requested_at: "2026-11-16T10:00:00Z", started_at: null, ended_at: null, end_reason: null,
  last_beat_at: null, delivered_at: null, waits_until: "2026-11-16T18:00:00Z", needs_person: true, position: null,
  pause_reason: null, lease_expires_at: null, last_seq: 0, capabilities: {}, action_counts: {},
  chat: { id: "chat-1", readers: { ids: ["d", "p1"], open: false } },
  device_online: false, device_last_seen_at: null,
  ...extra,
});

function transport(first, extra = {}) {
  const posted = [];
  const stopped = [];
  return {
    posted, stopped,
    async openSession() { return first; },
    async stopSession(id) { stopped.push(id); },
    async postCommand(plaintext, readers) { posted.push({ plaintext, readers }); },
    ...extra,
  };
}

test("readers {ids, open:false} become readerIds, and a command posts with them", async () => {
  const t = transport(sessionJson({ status: "active", delivered_at: "2026-11-16T10:00:05Z" }));
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  await c.open();
  c.settings().catch(() => undefined);
  await sleep(5);
  assert.equal(t.posted.length, 1);
  assert.equal(t.posted[0].readers.chatId, "chat-1");
  assert.deepEqual(t.posted[0].readers.readerIds, ["d", "p1"]);
  assert.deepEqual(t.posted[0].readers.publicKeys, []);
});

test("readers {open:true} stay unknown; the old array of keys still works", async () => {
  const t = transport(sessionJson({ status: "active", chat: { id: "chat-1", readers: { open: true } } }));
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  await c.open();
  await assert.rejects(c.settings(), /lane readers unknown/);
  const t2 = transport(sessionJson({ status: "active", chat: { id: "chat-1", readers: ["KEY"] } }));
  const c2 = sdk.createDeviceClient(t2, { deviceId: "d" });
  await c2.open();
  c2.settings().catch(() => undefined);
  await sleep(5);
  assert.deepEqual(t2.posted[0].readers.publicKeys, ["KEY"]);
});

test("http transport resolves reader ids to the lane chat members' keys at send time", async () => {
  const k1 = await sdk.generateKeypair("x");
  const k2 = await sdk.generateKeypair("x");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([init.method, url, init.body && JSON.parse(init.body)]);
    const body = init.method === "GET"
      ? { session: { users: [{ id: "d", public_key: k1.publicKey }, { id: "p1", public_key: k2.publicKey }, { id: "other", public_key: "NO" }] } }
      : {};
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  const t = sdk.httpDeviceAgentTransport({ host: "https://x", apiKey: "k", fetchImpl });
  await t.postCommand("hello", { chatId: "chat-1", publicKeys: [], readerIds: ["d", "p1"] });
  assert.match(calls[0][1], /^https:\/\/x\/api\/v1\/chats\/chat-1/);
  assert.equal(calls[1][0], "POST");
  assert.equal(calls[1][2].chat_id, "chat-1");
  assert.match(calls[1][2].message, /BEGIN PGP MESSAGE/);
  // A reader with no key stops the send.
  await assert.rejects(t.postCommand("hello", { chatId: "chat-1", publicKeys: [], readerIds: ["d", "ghost"] }), /ghost has no public key/);
  assert.equal(calls.filter((c) => c[0] === "POST").length, 1);
});

test("undelivered request: approval clock does not run until device_session_received", async () => {
  const t = transport(sessionJson());
  const c = sdk.createDeviceClient(t, { deviceId: "d" }, { approvalTimeoutMs: 30, queuedTimeoutMs: 5000 });
  const states = [];
  c.onState((s) => states.push(s));
  const opened = c.open();
  let settled = false;
  opened.then(() => (settled = true), () => (settled = true));
  await sleep(80); // well past the approval timeout
  assert.equal(settled, false);
  assert.deepEqual(states[0], { state: "requested", delivered: false });
  c.handleDelivery("device_session", { ...sessionJson({ delivered_at: "2026-11-16T10:05:00Z" }), type: "device_session_received", event: "received", session_id: "s1" });
  assert.deepEqual(states[1], { state: "delivered" });
  await assert.rejects(opened, /did not approve in time/); // clock started at delivery
});

test("undelivered request then approved after a long sleep resolves", async () => {
  const t = transport(sessionJson());
  const c = sdk.createDeviceClient(t, { deviceId: "d" }, { approvalTimeoutMs: 20, queuedTimeoutMs: 5000 });
  const opened = c.open();
  await sleep(60);
  c.handleDelivery("device_session", { ...sessionJson({ status: "active", delivered_at: "2026-11-16T10:05:00Z" }), type: "device_session_active", event: "active", session_id: "s1" });
  assert.equal((await opened).status, "active");
});

test("the wait while undelivered or queued ends at queuedTimeoutMs", async () => {
  const c = sdk.createDeviceClient(transport(sessionJson()), { deviceId: "d" }, { queuedTimeoutMs: 30 });
  await assert.rejects(c.open(), /did not pick up the request in time/);
  const q = sdk.createDeviceClient(transport(sessionJson({ status: "queued", position: 2, chat: undefined })), { deviceId: "d" }, { queuedTimeoutMs: 30, approvalTimeoutMs: 5 });
  await assert.rejects(q.open(), /did not pick up the request in time/);
});

test("a server that omits delivered_at keeps the old behaviour (approval clock at once)", async () => {
  const s = sessionJson();
  delete s.delivered_at;
  const c = sdk.createDeviceClient(transport(s), { deviceId: "d" }, { approvalTimeoutMs: 20, queuedTimeoutMs: 5000 });
  await assert.rejects(c.open(), /did not approve in time/);
});

test("open({signal}) aborts the wait and withdraws the request", async () => {
  const t = transport(sessionJson());
  const c = sdk.createDeviceClient(t, { deviceId: "d" }, { queuedTimeoutMs: 5000 });
  const ac = new AbortController();
  const opened = c.open({ signal: ac.signal });
  await sleep(10);
  ac.abort();
  await assert.rejects(opened, /open aborted/);
  assert.deepEqual(t.stopped, ["s1"]);
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(c.open({ signal: pre.signal }), /open aborted/);
});
