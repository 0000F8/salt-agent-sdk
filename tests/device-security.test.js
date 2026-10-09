// Security review fixes (2026-10-08): deadlines on the device clock, re-checks
// at dispatch, cancel on arrival, refusals are not counted, pause reporting,
// and the client ignoring deliveries that are not about its device/session.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const READERS = { chatId: "chat-1", publicKeys: ["-----PUB-----"] };
const CAPS = { "device.act": { mode: "auto" }, "device.observe": { mode: "auto" } };

function handlers(over = {}) {
  const calls = [];
  const mk = (op) => async (a) => {
    calls.push(op);
  };
  return Object.assign(
    { calls, observe: async () => ({ obs: "o", width: 1, height: 1, scale: 1, format: "png", image_b64: "AA" }), click: mk("click"), type: mk("type"), key: mk("key"), scroll: mk("scroll"), focusApp: mk("focus"), listApps: async () => ({ apps: [] }), readFile: async () => ({}), writeFile: mk("w") },
    over
  );
}
function transport(over = {}) {
  const t = { results: [], counts: [], pauses: [], resumes: [], stopped: null };
  return Object.assign(t, {
    async postResult(p) { t.results.push(sdk.decodeDeviceMessage(p)); },
    async beat() {},
    async reportCounts(_s, c, r) { t.counts.push({ c, r }); },
    async stop(_s, why) { t.stopped = why; },
    async pause(_s, r) { t.pauses.push(r); },
    async resume() { t.resumes.push(1); },
  }, over);
}
const snap = (caps = CAPS, extra = {}) => ({ sessionId: "s1", agentId: "ag", readers: READERS, caps, ...extra });
const cmd = (seq, op, body, o = {}) =>
  sdk.encodeDeviceMessage({ v: 1, id: o.id ?? `c${seq}`, seq, op, session: "s1", ...(o.noExp ? {} : { exp: o.exp ?? Date.now() + 30000 }) }, body);
const tick = () => new Promise((r) => setImmediate(r));

test("M8: exp is required; one far ahead of the TTL is refused", async () => {
  const h = handlers(), t = transport();
  const host = sdk.createDeviceHost(snap(), h, t);
  await host.handleCommand(cmd(1, "click", { x: 1, y: 1 }, { noExp: true }));
  assert.equal(t.results.at(-1).body.code, "bad_args");
  await host.handleCommand(cmd(1, "click", { x: 1, y: 1 }, { id: "far", exp: Date.now() + 3600_000 }));
  assert.equal(t.results.at(-1).body.code, "bad_args");
  assert.equal(h.calls.length, 0);
});

test("H1: ask-mode command approved after its deadline is refused expired and never runs", async () => {
  let now = 1_000_000;
  const h = handlers(), t = transport();
  const host = sdk.createDeviceHost(
    snap({ "device.act": { mode: "ask" } }), h, t,
    { requestLocalApproval: async () => { now += 31_000; return true; } },
    { now: () => now }
  );
  await host.handleCommand(sdk.encodeDeviceMessage({ v: 1, id: "a1", seq: 1, op: "click", session: "s1", exp: now + 30_000 }, { x: 1, y: 1 }));
  assert.equal(t.results.at(-1).body.code, "expired");
  assert.equal(h.calls.length, 0);
});

test("H1: a stuck approval dialog is abandoned at the deadline", async () => {
  const h = handlers(), t = transport();
  let seenTimeout;
  const host = sdk.createDeviceHost(
    snap({ "device.act": { mode: "ask" } }), h, t,
    { requestLocalApproval: (op, args, o) => { seenTimeout = o.timeoutMs; return new Promise(() => {}); } }
  );
  const p = host.handleCommand(sdk.encodeDeviceMessage({ v: 1, id: "a1", seq: 1, op: "click", session: "s1", exp: Date.now() + 80 }, { x: 1, y: 1 }));
  await p;
  assert.ok(seenTimeout <= 80);
  assert.equal(t.results.at(-1).body.code, "expired");
  assert.equal(h.calls.length, 0);
});

test("H1: a session that ended while waiting for approval never runs the command", async () => {
  const h = handlers(), t = transport();
  let hostRef;
  const host = sdk.createDeviceHost(
    snap({ "device.act": { mode: "ask" } }), h, t,
    { requestLocalApproval: async () => { await hostRef.stop("stopped_by_person"); return true; } }
  );
  hostRef = host;
  await host.handleCommand(cmd(1, "click", { x: 1, y: 1 }));
  assert.equal(h.calls.length, 0);
});

test("H1: a pause that lands while waiting for the lock refuses paused, inside the lock", async () => {
  const h = handlers(), t = transport();
  const lock = new sdk.DeviceLock();
  const host = sdk.createDeviceHost(snap(), h, t, {}, { deviceLock: lock });
  const release = await lock.acquire();
  const run = host.handleCommand(cmd(1, "click", { x: 1, y: 1 }));
  await tick();
  await host.pause("person_active");
  release();
  await run;
  assert.equal(t.results.at(-1).body.code, "paused");
  assert.equal(t.results.at(-1).body.expected_seq, 1);
  assert.equal(h.calls.length, 0);
});

test("H1: cancel is processed while a long action runs; a cancel that arrives first drops the command", async () => {
  let finish;
  const h = handlers({ click: () => new Promise((r) => (finish = r)) });
  const t = transport();
  const host = sdk.createDeviceHost(snap(), h, t);
  const first = host.handleCommand(cmd(1, "click", { x: 1, y: 1 }));
  await tick();
  // the long click is running; cancel for the NEXT command arrives before it
  const cancelled = await Promise.race([
    host.handleCommand(sdk.encodeDeviceMessage({ v: 1, id: "k", seq: 1, op: "cancel", session: "s1" }, { id: "c2" })),
    new Promise((r) => setTimeout(() => r("BLOCKED"), 200)),
  ]);
  assert.equal(cancelled, true);
  const second = host.handleCommand(cmd(2, "type", { text: "x" }));
  finish();
  await first; await second;
  assert.equal(t.results.filter((r) => r.header.re === "c2").length, 0);
});

test("M4: refusals are not reported as counts; failures are, without last_seq", async () => {
  const h = handlers({ click: async () => { throw new Error("boom"); } });
  const t = transport();
  const host = sdk.createDeviceHost(snap(), h, t);
  await host.handleCommand(cmd(1, "type", { text: "x" }, {})); // type not in caps? CAPS has act -> runs
  await tick();
  t.counts.length = 0;
  await host.handleCommand(cmd(2, "read_file", { path: "/x" })); // out_of_scope: a refusal
  await tick();
  assert.deepEqual(t.counts, []);
  await host.handleCommand(cmd(3, "click", { x: 1, y: 1 })); // handler throws: an error count
  await tick();
  assert.deepEqual(t.counts.at(-1).c, { error: 1 });
  assert.equal(t.counts.at(-1).r, undefined);
});

test("L1: a handler-level paused/busy refusal reports as such, is not cached, and gives the seq back", async () => {
  let paused = true;
  const h = handlers({ click: async () => { if (paused) { const e = new Error("paused: person_active"); e.code = "paused"; e.reason = "person_active"; throw e; } } });
  const t = transport();
  const host = sdk.createDeviceHost(snap(), h, t);
  await host.handleCommand(cmd(1, "click", { x: 1, y: 1 }, { id: "p" }));
  assert.equal(t.results.at(-1).body.code, "paused");
  assert.equal(t.results.at(-1).body.reason, "person_active");
  assert.equal(t.results.at(-1).body.expected_seq, 1);
  paused = false;
  await host.handleCommand(cmd(1, "click", { x: 1, y: 1 }, { id: "p" }));
  assert.equal(t.results.at(-1).header.op, "ack");
});

test("L3: a reason change is resume-then-pause; a failed report is retried on the next beat", async () => {
  const calls = [];
  let failNext = true;
  const t = transport({
    async pause(_s, r) { calls.push("pause:" + r); if (failNext) { failNext = false; throw new Error("net"); } },
    async resume() { calls.push("resume"); },
  });
  const host = sdk.createDeviceHost(snap(), handlers(), t, {}, { beatIntervalMs: 20 });
  await host.pause("person_active"); // report fails
  assert.deepEqual(calls, ["pause:person_active"]);
  host.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(calls.slice(0, 2), ["pause:person_active", "pause:person_active"]);
  await host.pause("secure_field");
  assert.deepEqual(calls.slice(2), ["resume", "pause:secure_field"]);
  await host.stop("x");
});

test("M7: client ignores deliveries for another device and an `ended` for another session", async () => {
  const posted = [];
  const c = sdk.createDeviceClient(
    { async openSession(d) { return { id: "s-new", device_id: d, agent_id: "ag", mandate_id: "m", status: "requested" }; }, async stopSession() {}, async postCommand(p) { posted.push(p); } },
    { deviceId: "dev-1" }
  );
  const opened = c.open();
  await tick();
  c.handleDelivery("device_session", { type: "device_session_ended", session_id: "s-old", device_id: "dev-1", end_reason: "agent_idle" });
  c.handleDelivery("device_session", { type: "device_session_ended", session_id: "s-other-device", device_id: "dev-2", end_reason: "x" });
  c.handleDelivery("device_session", { type: "device_session_active", session: { id: "s-new", device_id: "dev-1", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "c", readers: ["K"] } } });
  const m = await opened;
  assert.equal(m.status, "active");
  assert.equal(m.id, "s-new");
  // once known, other sessions are ignored too
  c.handleDelivery("device_session", { type: "device_session_ended", session_id: "s-old", device_id: "dev-1", end_reason: "agent_idle" });
  assert.equal(c.session().status, "active");
});

test("H2: observing or focusing a never-allowed app (even by a longer name) is forbidden; nothing runs", async () => {
  const h = handlers(), t = transport();
  const host = sdk.createDeviceHost(
    snap({ "device.observe": { mode: "auto" }, "device.apps": { mode: "auto" } }), h, t, {},
    { neverAllowedApps: [...sdk.NEVER_ALLOWED_APPS, "systems.salt.device", "salt device"] }
  );
  const observed = [];
  h.observe = async (a) => { observed.push(a); return { obs: "o" }; };
  await host.handleCommand(cmd(1, "observe", { target: "window", app: "1Password 7 - Password Manager" }));
  assert.equal(t.results.at(-1).body.code, "forbidden");
  await host.handleCommand(cmd(2, "focus_app", { app: "Salt Device" }));
  assert.equal(t.results.at(-1).body.code, "forbidden");
  await host.handleCommand(cmd(3, "observe", { target: "window", app: "Safari" }));
  assert.equal(t.results.at(-1).header.op, "observation");
  assert.equal(observed.length, 1);
  assert.equal(h.calls.length, 0);
});
