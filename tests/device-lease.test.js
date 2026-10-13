// Lease reporting, beat-while-paused, the explicit `person` pause reason, and
// the API's real delivery / HTTP shapes (devlock API 9333694).
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const READERS = { chatId: "c", publicKeys: ["k"] };
const CAPS = { "device.act": { mode: "auto" }, "device.observe": { mode: "auto" } };
const noop = async () => undefined;
const H = { observe: async () => ({ obs: "o", width: 1, height: 1, scale: 1, format: "png", image_b64: "AA" }), click: noop, type: noop, key: noop, scroll: noop, focusApp: noop, listApps: async () => ({ apps: [] }), readFile: noop, writeFile: noop };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mk() {
  const t = { beats: [], counts: [], results: [], async postResult(p) { t.results.push(p); }, async beat(s, r) { t.beats.push(r); }, async reportCounts(s, c, r) { t.counts.push([c, r]); }, async stop() {}, async pause() {}, async resume() {} };
  const dh = sdk.createDeviceHost({ sessionId: "s", agentId: "a", readers: READERS, caps: CAPS }, H, t, {}, { beatIntervalMs: 10, deviceLock: new sdk.DeviceLock() });
  return { t, dh };
}
const cmd = (seq, op, body) => sdk.encodeDeviceMessage({ v: 1, id: `c${seq}`, seq, op, session: "s", exp: Date.now() + 30000 }, body);

test("host: beats carry last_command_at/last_seq only after a command ran; counts carry last_seq", async () => {
  const { t, dh } = mk();
  dh.start();
  await sleep(35);
  assert.equal(t.beats[0], undefined);
  await dh.handleCommand(cmd(1, "click", { x: 1, y: 1 }));
  await sleep(35);
  const last = t.beats[t.beats.length - 1];
  assert.equal(last.last_seq, 1);
  assert.ok(!Number.isNaN(Date.parse(last.last_command_at)));
  assert.equal(t.counts[0][1].last_seq, 1);
  await dh.stop();
});

test("host: keeps beating while paused", async () => {
  const { t, dh } = mk();
  dh.start();
  await dh.pause("person");
  const n = t.beats.length;
  await sleep(45);
  assert.ok(t.beats.length > n + 1);
  await dh.stop();
});

test("http host transport: beat/counts bodies and the person pause reason", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([init.method, url, init.body && JSON.parse(init.body)]); return { status: 200, text: async () => "{}" }; };
  const t = sdk.httpDeviceHostTransport({ host: "https://x", apiKey: "k", fetchImpl });
  await t.beat("s1", { last_command_at: "2026-10-08T00:00:00Z", last_seq: 3 });
  await t.reportCounts("s1", { click: 1 }, { last_seq: 3 });
  await t.pause("s1", "person");
  assert.deepEqual(calls[0], ["POST", "https://x/api/v1/device_sessions/s1/beat", { last_command_at: "2026-10-08T00:00:00Z", last_seq: 3 }]);
  assert.deepEqual(calls[1][2], { counts: { click: 1 }, last_seq: 3 });
  assert.deepEqual(calls[2][2], { reason: "person" });
});

test("http agent transport: 202 queued, 201 bare, 409 session_live, reattach, 409 session_ended", async () => {
  const q = [
    { status: 202, body: { session: { id: "s", status: "queued", position: 2 } } },
    { status: 201, body: { id: "s", status: "requested" } },
    { status: 409, body: { error: "x", code: "session_live", session_id: "s9" } },
    { status: 200, body: { session: { id: "s", status: "active" }, last_seq: 4 } },
    { status: 409, body: { code: "session_ended", end_reason: "agent_idle" } },
  ];
  const fetchImpl = async () => { const r = q.shift(); return { status: r.status, text: async () => JSON.stringify(r.body) }; };
  const t = sdk.httpDeviceAgentTransport({ host: "https://x", apiKey: "k", fetchImpl });
  assert.deepEqual(await t.openSession("d"), { id: "s", status: "queued", position: 2 });
  assert.equal((await t.openSession("d")).status, "requested");
  await assert.rejects(t.openSession("d"), (e) => e instanceof sdk.DeviceSessionLiveError && e.sessionId === "s9");
  assert.equal((await t.reattachSession("s")).last_seq, 4);
  await assert.rejects(t.reattachSession("s"), /agent_idle/);
});

test("client: API-shaped flat deliveries drive promotion, pause (top-level pause_reason), resume, end", async () => {
  const posted = [];
  const t = { async openSession() { return { id: "s", status: "queued", position: 3 }; }, async fetchSession() { return { id: "s", status: "active" }; }, async stopSession() {}, async postCommand(p) { posted.push(p); } };
  const c = sdk.createDeviceClient(t, { deviceId: "d" }, { approvalTimeoutMs: 1000 });
  const states = [];
  c.onState((s) => states.push(s));
  const opened = c.open();
  await sleep(5);
  c.handleDelivery("device_session", { id: "s", status: "queued", position: 1, type: "device_session_queue_moved", event: "queue_moved", session_id: "s" });
  c.handleDelivery("device_session", { id: "s", status: "requested", type: "device_session_promoted", event: "promoted", session_id: "s" });
  c.handleDelivery("device_session", { id: "s", status: "active", type: "device_session_active", event: "active", session_id: "s" });
  assert.equal((await opened).status, "active");
  c.handleDelivery("device_session", { id: "s", status: "paused", pause_reason: "person", type: "device_session_paused", event: "paused", session_id: "s" });
  assert.equal(c.pausedReason(), "person");
  c.handleDelivery("device_session", { id: "s", status: "active", type: "device_session_resumed", event: "resumed", session_id: "s" });
  assert.equal(c.pausedReason(), null);
  c.handleDelivery("device_session", { id: "s", status: "ended", end_reason: "agent_idle", type: "device_session_ended", event: "ended", session_id: "s" });
  assert.deepEqual(states.map((s) => s.state), ["queued", "queued", "requested", "active", "paused", "resumed", "ended"]);
  assert.equal(states[6].reason, "agent_idle");
});

test("intent: open({intent}) sends it on POST /devices/:id/sessions; absent means no body; the server's 422 sentence is the error", async () => {
  const calls = [];
  const q = [
    { status: 201, body: { id: "s", status: "requested", intent: "Pay the invoice" } },
    { status: 201, body: { id: "s2", status: "requested" } },
    { status: 422, body: { error: "Say what you are doing in 140 characters or fewer.", code: "intent_too_long", max: 140 } },
  ];
  const fetchImpl = async (url, init) => { calls.push({ url, body: init.body }); const r = q.shift(); return { status: r.status, text: async () => JSON.stringify(r.body) }; };
  const t = sdk.httpDeviceAgentTransport({ host: "https://x", apiKey: "k", fetchImpl });
  assert.equal((await t.openSession("d", { intent: "Pay the invoice" })).intent, "Pay the invoice");
  assert.equal(calls[0].url, "https://x/api/v1/devices/d/sessions");
  assert.deepEqual(JSON.parse(calls[0].body), { intent: "Pay the invoice" });
  await t.openSession("d");
  assert.equal(calls[1].body, undefined);
  await assert.rejects(t.openSession("d", { intent: "x".repeat(200) }), /140 characters/);
});

test("intent: device.open({intent}) hands the intent to the transport", async () => {
  const seen = [];
  const t = { async openSession(d, o) { seen.push(o); return { id: "s", device_id: d, agent_id: "a", mandate_id: "m", status: "queued", position: 1 }; }, async stopSession() {}, async postCommand() {} };
  const dc = sdk.createDeviceClient(t, { deviceId: "d" });
  await dc.open({ wait: false, intent: "Book the 9:40 train" });
  await dc.open({ wait: false }).catch(() => {});
  assert.deepEqual(seen[0], { intent: "Book the 9:40 train" });
  assert.equal(seen[1], undefined);
});
