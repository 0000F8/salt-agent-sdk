// Device-control locking (contract 2026-10-08 sections 2, 4, 5): one command in
// flight per session, a device-wide mutex for mutating ops, idempotent ids,
// expiry, cancel, pause, queue + reattach on the client. Fakes only.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const READERS = { chatId: "chat-1", publicKeys: ["-----PUB-----"] };
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function handlers(overrides = {}) {
  const calls = [];
  const mk = (op) => async (args) => {
    calls.push({ op, args });
    if (overrides[op]) return overrides[op](args);
    return undefined;
  };
  return {
    calls,
    observe: async (a) => (calls.push({ op: "observe", args: a }), overrides.observe ? overrides.observe(a) : { obs: "o", width: 1, height: 1, scale: 1, format: "png", image_b64: "AA" }),
    click: mk("click"),
    type: mk("type"),
    key: mk("key"),
    scroll: mk("scroll"),
    focusApp: mk("focusApp"),
    listApps: async () => ({ apps: [] }),
    readFile: async () => ({ path: "/x", size: 1, content_b64: "AA" }),
    writeFile: mk("writeFile"),
  };
}

function transport() {
  const results = [];
  const t = {
    results,
    paused: [],
    resumed: [],
    async postResult(p) {
      results.push(sdk.decodeDeviceMessage(p));
    },
    async beat() {},
    async reportCounts() {},
    async stop() {},
    async pause(sid, reason) {
      t.paused.push([sid, reason]);
    },
    async resume(sid) {
      t.resumed.push(sid);
    },
  };
  return t;
}

const CAPS = { "device.act": { mode: "auto" }, "device.observe": { mode: "auto" }, "device.apps": { mode: "auto" } };

function host(h, t, extra = {}, session = "sess-1", options = {}) {
  return sdk.createDeviceHost({ sessionId: session, agentId: "ag", readers: READERS, caps: CAPS, ...extra }, h, t, {}, options);
}

function cmd(seq, op, body, o = {}) {
  return sdk.encodeDeviceMessage(
    { v: 1, id: o.id ?? `c${seq}`, seq, op, session: o.session ?? "sess-1", ...(o.exp !== undefined ? { exp: o.exp } : {}) },
    body
  );
}

// ---------------------------------------------------------------- host

test("host: commands run one at a time per session, in arrival order", async () => {
  const gate = deferred();
  let running = 0;
  let maxRunning = 0;
  const h = handlers({
    type: async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running--;
    },
  });
  const t = transport();
  const dh = host(h, t, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  const p1 = dh.handleCommand(cmd(1, "type", { text: "a" }));
  const p2 = dh.handleCommand(cmd(2, "type", { text: "b" }));
  await tick();
  assert.equal(h.calls.length, 1);
  gate.resolve();
  await Promise.all([p1, p2]);
  assert.equal(h.calls.length, 2);
  assert.equal(maxRunning, 1);
  assert.deepEqual(t.results.map((r) => r.header.re), ["c1", "c2"]);
});

test("host: a repeated id returns the stored result without executing", async () => {
  const h = handlers();
  const t = transport();
  const dh = host(h, t, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  await dh.handleCommand(cmd(1, "observe", { target: "screen" }, { id: "same" }));
  await dh.handleCommand(cmd(1, "observe", { target: "screen" }, { id: "same" }));
  await dh.handleCommand(cmd(5, "observe", { target: "screen" }, { id: "same" })); // even with a different seq
  assert.equal(h.calls.length, 1);
  assert.equal(t.results.length, 3);
  assert.deepEqual(t.results.map((r) => r.header.op), ["observation", "observation", "observation"]);
  assert.deepEqual(t.results[2].body, t.results[0].body);
});

test("host: a failed handler is stored too, so a retry by id does not re-run it", async () => {
  const h = handlers({ click: async () => { throw new Error("boom"); } });
  const t = transport();
  const dh = host(h, t, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  await dh.handleCommand(cmd(1, "click", { x: 1, y: 1 }, { id: "k" }));
  await dh.handleCommand(cmd(1, "click", { x: 1, y: 1 }, { id: "k" }));
  assert.equal(h.calls.length, 1);
  assert.equal(t.results[1].body.code, "failed");
});

test("host: a command past its exp is refused expired and not executed", async () => {
  const h = handlers();
  const t = transport();
  const dh = host(h, t, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  await dh.handleCommand(cmd(1, "type", { text: "x" }, { exp: Date.now() - 1 }));
  assert.equal(h.calls.length, 0);
  assert.equal(t.results[0].body.code, "expired");
  assert.equal(t.results[0].body.expected_seq, 1); // seq not consumed
  await dh.handleCommand(cmd(1, "type", { text: "x" }, { id: "c1", exp: Date.now() + 10_000 }));
  assert.equal(h.calls.length, 1);
});

test("host: out_of_order carries expected_seq; the same id then runs once at the right seq", async () => {
  const h = handlers();
  const t = transport();
  const dh = host(h, t, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  await dh.handleCommand(cmd(4, "type", { text: "x" }, { id: "late" }));
  assert.equal(t.results[0].body.code, "out_of_order");
  assert.equal(t.results[0].body.expected_seq, 1);
  assert.equal(h.calls.length, 0);
  await dh.handleCommand(cmd(1, "type", { text: "x" }, { id: "late" }));
  assert.equal(h.calls.length, 1);
  assert.equal(t.results[1].header.op, "ack");
});

test("host: cancel drops a queued command and consumes no seq; a finished one keeps its result", async () => {
  const gate = deferred();
  const h = handlers({ type: async (a) => { if (a.text === "slow") await gate.promise; } });
  const t = transport();
  const dh = host(h, t, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  const p1 = dh.handleCommand(cmd(1, "type", { text: "slow" }));
  const p2 = dh.handleCommand(cmd(2, "type", { text: "dropped" }));
  await tick();
  assert.equal(await dh.handleCommand(cmd(2, "cancel", { id: "c2" }, { id: "x1" })), true);
  gate.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(h.calls.map((c) => c.args.text), ["slow"]);
  assert.deepEqual(t.results.map((r) => r.header.re), ["c1"]); // no reply for the dropped one
  // cancel of an already-done command is ignored; its result is still replayable
  await dh.handleCommand(cmd(2, "cancel", { id: "c1" }, { id: "x2" }));
  await dh.handleCommand(cmd(1, "type", { text: "slow" }, { id: "c1" }));
  assert.equal(h.calls.length, 1);
  assert.equal(t.results.length, 2);
  // seq 2 is still the next one (cancel consumed none)
  await dh.handleCommand(cmd(2, "type", { text: "next" }));
  assert.equal(h.calls.length, 2);
});

test("host: paused refuses with reason (+expected_seq), stop still works, resume reports and clears", async () => {
  const h = handlers();
  const t = transport();
  const dh = host(h, t, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  await dh.pause("person_active");
  assert.deepEqual(t.paused, [["sess-1", "person_active"]]);
  assert.equal(dh.pausedReason(), "person_active");
  await dh.handleCommand(cmd(1, "type", { text: "x" }));
  assert.equal(t.results[0].body.code, "paused");
  assert.equal(t.results[0].body.reason, "person_active");
  assert.equal(t.results[0].body.expected_seq, 1);
  assert.equal(h.calls.length, 0);
  await dh.resume();
  assert.deepEqual(t.resumed, ["sess-1"]);
  await dh.handleCommand(cmd(1, "type", { text: "x" }, { id: "again" }));
  assert.equal(h.calls.length, 1);
  await dh.pause("secure_field");
  await dh.handleCommand(cmd(2, "stop", undefined));
  assert.equal(t.results[t.results.length - 1].header.op, "ended");
});

test("host: pause() still pauses when Salt cannot be told", async () => {
  const t = transport();
  t.pause = async () => { throw new Error("offline"); };
  const dh = host(handlers(), t, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  await dh.pause("person_paused");
  assert.equal(dh.pausedReason(), "person_paused");
});

test("host: mutating ops are serialised device-wide across hosts (shared lock)", async () => {
  const gate = deferred();
  let running = 0;
  let maxRunning = 0;
  const slow = async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await gate.promise;
    running--;
  };
  const lock = new sdk.DeviceLock();
  const a = host(handlers({ click: slow }), transport(), {}, "sess-A", { deviceLock: lock });
  const b = host(handlers({ key: slow }), transport(), {}, "sess-B", { deviceLock: lock });
  const pa = a.handleCommand(cmd(1, "click", { x: 1, y: 1 }, { session: "sess-A" }));
  const pb = b.handleCommand(cmd(1, "key", { keys: ["a"] }, { session: "sess-B" }));
  await tick();
  assert.equal(running, 1);
  gate.resolve();
  await Promise.all([pa, pb]);
  assert.equal(maxRunning, 1);
});

test("host: default lock is the process-wide sharedDeviceLock; observe does not take it", async () => {
  const gate = deferred();
  let running = 0;
  let maxRunning = 0;
  const slow = async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await gate.promise;
    running--;
  };
  const a = host(handlers({ type: slow }), transport(), {}, "sess-A");
  const b = host(handlers({ scroll: slow }), transport(), {}, "sess-B");
  const o = host(handlers({ observe: slow }), transport(), {}, "sess-C");
  const ps = [
    a.handleCommand(cmd(1, "type", { text: "a" }, { session: "sess-A" })),
    b.handleCommand(cmd(1, "scroll", { x: 0, y: 0, dx: 0, dy: 1 }, { session: "sess-B" })),
  ];
  await tick();
  assert.equal(running, 1);
  const po = o.handleCommand(cmd(1, "observe", { target: "screen" }, { session: "sess-C" }));
  await tick();
  assert.equal(running, 2); // the observe ran alongside the held mutation
  gate.resolve();
  await Promise.all([...ps, po]);
  assert.ok(sdk.sharedDeviceLock instanceof sdk.DeviceLock);
});

// ---------------------------------------------------------------- client

function sessionMeta(extra = {}) {
  return { id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: ["-----PUB-----"] }, ...extra };
}

function clientTransport(overrides = {}) {
  const posted = [];
  return {
    posted,
    async openSession() {
      return sessionMeta({ status: "requested", chat: undefined });
    },
    async stopSession() {},
    async postCommand(plaintext) {
      posted.push(sdk.decodeDeviceMessage(plaintext));
    },
    ...overrides,
  };
}

async function activeClient(t, opts) {
  const c = sdk.createDeviceClient(t, { deviceId: "d" }, opts);
  const opened = c.open();
  c.handleDelivery("device_session", { type: "device_session_active", session: sessionMeta() });
  await opened;
  return c;
}

function reply(c, sent, op, body, id) {
  return c.handleLaneMessage(
    sdk.encodeDeviceMessage({ v: 1, id: id ?? "r" + sent.header.id + Math.random(), seq: sent.header.seq, op, session: "sess-1", re: sent.header.id }, body)
  );
}

test("client: concurrent callers are serialised; each command has a uuid-ish id, seq and exp", async () => {
  const t = clientTransport();
  const c = await activeClient(t);
  const before = Date.now();
  const ps = [c.type("a"), c.key(["x"]), c.type("b")];
  await tick();
  assert.equal(t.posted.length, 1);
  for (let i = 0; i < 3; i++) {
    reply(c, t.posted[i], "ack", { ok: true });
    await tick();
    await tick();
  }
  await Promise.all(ps);
  assert.deepEqual(t.posted.map((m) => m.header.seq), [1, 2, 3]);
  assert.equal(new Set(t.posted.map((m) => m.header.id)).size, 3);
  for (const m of t.posted) {
    assert.ok(m.header.exp >= before + 29_000 && m.header.exp <= Date.now() + 30_000);
  }
});

test("client: out_of_order resyncs once and resends with the SAME id", async () => {
  const t = clientTransport();
  const c = await activeClient(t);
  const p = c.type("a");
  await tick();
  reply(c, t.posted[0], "error", { code: "out_of_order", expected_seq: 5 });
  await tick();
  await tick();
  assert.equal(t.posted.length, 2);
  assert.equal(t.posted[1].header.id, t.posted[0].header.id);
  assert.equal(t.posted[1].header.seq, 5);
  reply(c, t.posted[1], "ack", { ok: true });
  await p;
  // the next command continues from the resynced seq
  const p2 = c.type("b");
  await tick();
  assert.equal(t.posted[2].header.seq, 6);
  reply(c, t.posted[2], "ack", { ok: true });
  await p2;
});

test("client: a second out_of_order is surfaced, not retried forever", async () => {
  const t = clientTransport();
  const c = await activeClient(t);
  const p = c.type("a");
  p.catch(() => {});
  await tick();
  reply(c, t.posted[0], "error", { code: "out_of_order", expected_seq: 5 });
  await tick();
  await tick();
  reply(c, t.posted[1], "error", { code: "out_of_order", expected_seq: 9 });
  await assert.rejects(p, (e) => e.code === "out_of_order");
  assert.equal(t.posted.length, 2);
});

test("client: expired is resent once with the same id and a fresh exp", async () => {
  const t = clientTransport();
  const c = await activeClient(t);
  const p = c.type("a");
  await tick();
  reply(c, t.posted[0], "error", { code: "expired", expected_seq: 1 });
  await tick();
  await tick();
  assert.equal(t.posted[1].header.id, t.posted[0].header.id);
  assert.equal(t.posted[1].header.seq, 1);
  reply(c, t.posted[1], "ack", { ok: true });
  await p;
});

test("client: on timeout it sends cancel {id}", async () => {
  const t = clientTransport();
  const c = await activeClient(t, { commandTimeoutMs: 20 });
  await assert.rejects(c.type("a"), /timed out/);
  const cancel = t.posted[t.posted.length - 1];
  assert.equal(cancel.header.op, "cancel");
  assert.deepEqual(cancel.body, { id: t.posted[0].header.id });
});

test("client: a host `paused` reply throws DevicePausedError and does not burn a seq", async () => {
  const t = clientTransport();
  const c = await activeClient(t);
  const p = c.type("a");
  p.catch(() => {});
  await tick();
  reply(c, t.posted[0], "error", { code: "paused", reason: "secure_field", expected_seq: 1 });
  await assert.rejects(p, (e) => e instanceof sdk.DevicePausedError && e.reason === "secure_field");
  const p2 = c.type("b");
  await tick();
  assert.equal(t.posted[1].header.seq, 1);
  reply(c, t.posted[1], "ack", { ok: true });
  await p2;
});

test("client: while paused (delivery) commands reject immediately without being sent; resumed clears", async () => {
  const t = clientTransport();
  const c = await activeClient(t);
  const states = [];
  c.onState((s) => states.push(s));
  c.handleDelivery("device_session", { event: "paused", session_id: "sess-1", status: "paused", pause_reason: "person_active" });
  await assert.rejects(c.click({ x: 1, y: 1 }), (e) => e instanceof sdk.DevicePausedError && e.reason === "person_active");
  assert.equal(t.posted.length, 0);
  assert.equal(c.pausedReason(), "person_active");
  c.handleDelivery("device_session", { event: "resumed", session_id: "sess-1", status: "active" });
  const p = c.type("a");
  await tick();
  assert.equal(t.posted.length, 1);
  reply(c, t.posted[0], "ack", { ok: true });
  await p;
  assert.deepEqual(states, [{ state: "paused", reason: "person_active" }, { state: "resumed" }]);
});

test("client: queued open waits on deliveries (no polling) and resolves on promotion", async () => {
  let fetches = 0;
  const t = clientTransport({
    async openSession() {
      return sessionMeta({ status: "queued", position: 2, chat: undefined });
    },
    async fetchSession() {
      fetches++;
      return sessionMeta();
    },
  });
  const c = sdk.createDeviceClient(t, { deviceId: "d" }, { approvalTimeoutMs: 20 });
  const states = [];
  c.onState((s) => states.push(s));
  let done = false;
  const opened = c.open().then((m) => ((done = true), m));
  await tick();
  await new Promise((r) => setTimeout(r, 60)); // longer than the approval timeout: queued has no clock
  assert.equal(done, false);
  c.handleDelivery("device_session", { event: "queue_moved", session_id: "sess-1", position: 1 });
  c.handleDelivery("device_session", { event: "promoted", session_id: "sess-1", status: "active", device_id: "d" });
  const meta = await opened;
  assert.equal(meta.status, "active");
  assert.equal(fetches, 1); // readers learned once, not polled
  assert.deepEqual(states.map((s) => s.state), ["queued", "queued", "active"]);
  assert.equal(states[0].position, 2);
  assert.equal(states[1].position, 1);
  // and commands now flow
  const p = c.type("a");
  await tick();
  assert.equal(t.posted.length, 1);
  reply(c, t.posted[0], "ack", { ok: true });
  await p;
});

test("client: promoted to requested starts the approval clock, then active resolves open", async () => {
  const t = clientTransport({ async openSession() { return sessionMeta({ status: "queued", position: 1, chat: undefined }); } });
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const states = [];
  c.onState((s) => states.push(s.state));
  const opened = c.open();
  await tick();
  c.handleDelivery("device_session", { event: "promoted", session_id: "sess-1", status: "requested" });
  c.handleDelivery("device_session", { type: "device_session_active", session: sessionMeta() });
  assert.equal((await opened).status, "active");
  assert.deepEqual(states, ["queued", "requested", "active"]);
});

test("client: queued then ended rejects open with the reason", async () => {
  const t = clientTransport({ async openSession() { return sessionMeta({ status: "queued", position: 1, chat: undefined }); } });
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  opened.catch(() => {});
  await tick();
  c.handleDelivery("device_session", { event: "ended", session_id: "sess-1", end_reason: "queue_expired" });
  await assert.rejects(opened, /queue_expired/);
});

test("client: open({wait:false}) returns the queued state at once", async () => {
  const t = clientTransport({ async openSession() { return sessionMeta({ status: "queued", position: 3, chat: undefined }); } });
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const states = [];
  c.onState((s) => states.push(s));
  const meta = await c.open({ wait: false });
  assert.equal(meta.status, "queued");
  assert.equal(meta.position, 3);
  assert.deepEqual(states, [{ state: "queued", position: 3 }]);
  // later promotion still arrives via onState
  c.handleDelivery("device_session", { event: "promoted", session_id: "sess-1", status: "active", session: sessionMeta() });
  assert.equal(c.session().status, "active");
  assert.equal(states[1].state, "active");
});

test("client: 409 session_live reattaches and continues at last_seq + 1", async () => {
  const reattached = [];
  const t = clientTransport({
    async openSession() {
      throw new sdk.DeviceSessionLiveError("sess-1");
    },
    async reattachSession(id) {
      reattached.push(id);
      return { session: sessionMeta(), last_seq: 7 };
    },
  });
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const meta = await c.open();
  assert.deepEqual(reattached, ["sess-1"]);
  assert.equal(meta.status, "active");
  const p = c.type("a");
  await tick();
  assert.equal(t.posted[0].header.seq, 8);
  reply(c, t.posted[0], "ack", { ok: true });
  await p;
});

test("client: reattaching a paused session comes back paused", async () => {
  const t = clientTransport({
    async openSession() {
      throw new sdk.DeviceSessionLiveError("sess-1");
    },
    async reattachSession() {
      return { session: sessionMeta({ status: "paused", pause_reason: "secure_field" }), last_seq: 2 };
    },
  });
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  await c.open();
  await assert.rejects(c.type("a"), sdk.DevicePausedError);
});

test("end to end: client against a host through a loop-back lane", async () => {
  const hh = handlers();
  const ht = transport();
  const dh = host(hh, ht, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  let c;
  const ct = clientTransport({
    async postCommand(plaintext) {
      await dh.handleCommand(plaintext);
      for (const r of ht.results.splice(0)) {
        c.handleLaneMessage(sdk.encodeDeviceMessage(r.header, r.body));
      }
    },
  });
  c = await activeClient(ct);
  await Promise.all([c.type("a"), c.key(["k"]), c.scroll({ x: 0, y: 0, dx: 0, dy: 1 })]);
  assert.deepEqual(hh.calls.map((x) => x.op), ["type", "key", "scroll"]);
  // a host that restarted its seq expectations (lost the first) resyncs transparently
  const hh2 = handlers();
  const ht2 = transport();
  const dh2 = host(hh2, ht2, {}, "sess-1", { deviceLock: new sdk.DeviceLock() });
  await dh2.handleCommand(cmd(1, "type", { text: "pre" }, { id: "pre" }));
  ht2.results.length = 0;
  let c2;
  const ct2 = clientTransport({
    async postCommand(plaintext) {
      await dh2.handleCommand(plaintext);
      for (const r of ht2.results.splice(0)) c2.handleLaneMessage(sdk.encodeDeviceMessage(r.header, r.body));
    },
  });
  c2 = await activeClient(ct2); // client believes seq 0; host expects 2
  await c2.type("b");
  assert.equal(hh2.calls.length, 2);
});
