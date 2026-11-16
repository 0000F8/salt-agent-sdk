// Device op `amend`: change a task that is already running. Out of band like `cancel`.
// Host: inbox per task, unknown task, queued-before-start, order, 500 clip, grant, bad body.
// Client: amendTask() posts it with no seq turn; a paused session still takes it; open({signal}) withdraws.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const READERS = { chatId: "chat-1", publicKeys: ["-----PUB-----"] };
const tick = () => new Promise((r) => setImmediate(r));
const noop = async () => undefined;
function deferred() {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
}
const CAPS = { "device.task": { mode: "auto" }, "device.observe": { mode: "auto" }, "device.act": { mode: "auto" } };
const handlers = (task) => ({
  observe: async () => ({ obs: "o", width: 1, height: 1, scale: 1, format: "png", image_b64: "AA" }),
  click: noop, type: noop, key: noop, scroll: noop, submit: noop, focusApp: noop,
  listApps: async () => ({ apps: [] }),
  readFile: async () => ({ path: "/x", size: 1, content_b64: "AA" }),
  writeFile: noop,
  task,
});
const result = { task_id: "t_1", status: "done", summary: "Done.", checked: null, steps: [], commands: 0, duration_ms: 1 };
function transport() {
  const t = { results: [], async postResult(p) { t.results.push(sdk.decodeDeviceMessage(p)); }, async beat() {}, async reportCounts() {}, async stop() {}, async pause() {}, async resume() {} };
  return t;
}
function mkHost(h, t, caps = CAPS, audits = []) {
  return sdk.createDeviceHost({ sessionId: "sess-1", agentId: "ag", readers: READERS, caps }, h, t, { onAudit: (a) => audits.push(a) }, { deviceLock: new sdk.DeviceLock() });
}
const cmd = (seq, op, body, o = {}) =>
  sdk.encodeDeviceMessage({ v: 1, id: o.id ?? `c${seq}`, seq, op, session: "sess-1", ...(o.re ? { re: o.re } : {}), exp: Date.now() + 30000 }, body);
const amend = (body, o = {}) => sdk.encodeDeviceMessage({ v: 1, id: o.id ?? "a" + Math.random(), seq: 1, op: "amend", session: "sess-1", ...(o.re ? { re: o.re } : {}) }, body);

test("protocol: amend is an agent op under device.task, no count class; normalize allow-lists and clips at 500; interval is 1 s", () => {
  assert.ok(sdk.AGENT_OPS.includes("amend"));
  assert.equal(sdk.CAPABILITY_FOR_OP.amend, "device.task");
  assert.equal(sdk.countClassForOp("amend"), null);
  assert.equal(sdk.PROGRESS_MIN_INTERVAL_MS, 1000);
  assert.equal(sdk.AMEND_SAY_MAX, 500);
  assert.deepEqual(sdk.normalizeAmend({ id: "T1", say: "x".repeat(600), extra: 1 }), { id: "T1", say: "x".repeat(500) });
  assert.deepEqual(sdk.normalizeAmend({ say: "hi" }), { say: "hi" });
  for (const bad of [null, "s", [], {}, { say: 3 }, { say: "  " }, { say: "a", id: 5 }, { say: "a", id: "" }, { say: "a", id: "i".repeat(65) }]) assert.equal(sdk.normalizeAmend(bad), null);
  assert.throws(() => sdk.amendCommandBody(""), (e) => e.code === "bad_args");
  assert.deepEqual(sdk.amendCommandBody("x".repeat(501), "T1"), { id: "T1", say: "x".repeat(500) });
});

test("host: an amend reaches a running task before its next step, in order, drained once; id by body, re, or the only task", async () => {
  for (const how of ["body", "re", "only"]) {
    const t = transport();
    const started = deferred();
    const go = deferred();
    const seen = [];
    const dh = mkHost(handlers(async (_a, ctx) => {
      started.resolve();
      await go.promise;
      seen.push(ctx.amends());
      seen.push(ctx.amends());
      return result;
    }), t);
    const run = dh.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
    await started.promise;
    const mk = (say) => (how === "body" ? amend({ id: "T1", say }) : how === "re" ? amend({ say }, { re: "T1" }) : amend({ say }));
    assert.equal(await dh.handleCommand(mk("first")), true);
    assert.equal(await dh.handleCommand(mk("second")), true);
    go.resolve();
    await run;
    assert.deepEqual(seen, [["first", "second"], []]);
    assert.deepEqual(t.results.map((m) => m.header.op), ["task_result"]); // never answered
  }
});

test("host: an amend for an unknown or finished task is dropped silently, as cancel's is, and is audited", async () => {
  const t = transport();
  const audits = [];
  const dh = mkHost(handlers(async () => result), t, CAPS, audits);
  assert.equal(await dh.handleCommand(amend({ id: "nope", say: "x" })), true);
  await dh.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
  assert.equal(await dh.handleCommand(amend({ id: "T1", say: "late" })), true);
  assert.equal(await dh.handleCommand(amend({ say: "no id and none running" })), true);
  assert.deepEqual(t.results.map((m) => m.header.op), ["task_result"]);
  assert.equal(audits.filter((a) => a.op === "amend" && a.decision === "refused").length, 3);
});

test("host: an amend that arrives while the task is queued behind another command is kept and applied at start", async () => {
  const t = transport();
  const blockStarted = deferred();
  const release = deferred();
  const h = handlers(async (_a, ctx) => ((h.got = ctx.amends()), result));
  h.observe = async () => (blockStarted.resolve(), await release.promise, { obs: "o", width: 1, height: 1, scale: 1, format: "png", image_b64: "AA" });
  const dh = mkHost(h, t);
  const first = dh.handleCommand(cmd(1, "observe", { target: "screen" }, { id: "O1" }));
  await blockStarted.promise;
  const queued = dh.handleCommand(cmd(2, "task", { goal: "g" }, { id: "T2" }));
  await tick();
  assert.equal(await dh.handleCommand(amend({ id: "T2", say: "before start" })), true);
  release.resolve();
  await first;
  await queued;
  assert.deepEqual(h.got, ["before start"]);
});

test("host: an amend is cut to 500 characters, and a bad body is dropped", async () => {
  const t = transport();
  const started = deferred();
  const go = deferred();
  let got;
  const dh = mkHost(handlers(async (_a, ctx) => (started.resolve(), await go.promise, (got = ctx.amends()), result)), t);
  const run = dh.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
  await started.promise;
  await dh.handleCommand(amend({ id: "T1", say: "y".repeat(900) }));
  await dh.handleCommand(amend({ id: "T1", say: 7 }));
  await dh.handleCommand(amend({ id: "T1" }));
  go.resolve();
  await run;
  assert.deepEqual(got, ["y".repeat(500)]);

});

test("client: amendTask posts amend with re and body {id, say}, uses no seq, and refuses an empty say", async () => {
  const sent = [];
  const t = {
    async openSession() { return { id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: ["-----PUB-----"] } }; },
    async stopSession() {},
    async postCommand(p) { sent.push(sdk.decodeDeviceMessage(p)); },
  };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  await c.open();
  await c.amendTask("T1", "also close the tab");
  await c.amendTask(undefined, "only task");
  assert.equal(sent[0].header.op, "amend");
  assert.equal(sent[0].header.re, "T1");
  assert.deepEqual(sent[0].body, { id: "T1", say: "also close the tab" });
  assert.deepEqual(sent[1].body, { say: "only task" });
  assert.equal(sent[1].header.re, undefined);
  await assert.rejects(c.amendTask("T1", "  "), (e) => e.code === "bad_args");
  await assert.rejects(c.amendTask("T1", "x".repeat(0)));
});

test("round trip: task() onStart gives the id, amendTask reaches the running task through the host", async () => {
  const started = deferred();
  const go = deferred();
  let got;
  let host;
  const sent = [];
  const t = {
    async openSession() { return { id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: ["-----PUB-----"] } }; },
    async stopSession() {},
    async postCommand(p) { sent.push(sdk.decodeDeviceMessage(p)); void host.handleCommand(p); },
  };
  const ht = { async postResult(p) { client.handleLaneMessage(p, "d"); }, async beat() {}, async reportCounts() {}, async stop() {} };
  host = mkHost(handlers(async (_a, ctx) => (started.resolve(), await go.promise, (got = ctx.amends()), result)), ht);
  const client = sdk.createDeviceClient(t, { deviceId: "d" });
  await client.open();
  let id;
  const run = client.task("g", { onStart: (x) => (id = x) });
  await started.promise;
  assert.equal(id, sent[0].header.id);
  await client.amendTask(id, "change of plan");
  go.resolve();
  assert.equal((await run).status, "done");
  assert.deepEqual(got, ["change of plan"]);
});

test("client: aborting open() before delivery withdraws the waiting request with withdrawSession (falls back to stopSession)", async () => {
  for (const withWithdraw of [true, false]) {
    const calls = [];
    const t = {
      async openSession() { return { id: "s1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "requested", delivered_at: null, chat: { id: "chat-1", readers: ["-----PUB-----"] } }; },
      async stopSession(id) { calls.push(["stop", id]); },
      async postCommand() {},
    };
    if (withWithdraw) t.withdrawSession = async (id) => void calls.push(["withdraw", id]);
    const c = sdk.createDeviceClient(t, { deviceId: "d" });
    const ac = new AbortController();
    const p = c.open({ signal: ac.signal });
    await tick();
    ac.abort();
    await assert.rejects(p, /open aborted/);
    await tick();
    assert.deepEqual(calls, [[withWithdraw ? "withdraw" : "stop", "s1"]]);
  }
});

test("http transport: withdrawSession is DELETE /api/v1/device_sessions/:id", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => (seen.push([init.method, url]), { status: 204, text: async () => "" });
  const tr = sdk.httpDeviceAgentTransport({ host: "https://api.example.com/", apiKey: "k", fetchImpl });
  await tr.withdrawSession("s9");
  assert.deepEqual(seen, [["DELETE", "https://api.example.com/api/v1/device_sessions/s9"]]);
});
