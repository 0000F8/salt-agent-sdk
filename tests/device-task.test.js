// Device task (op `task`, capability `device.task`): hand the computer ONE whole task.
// Host: the handler seam, progress throttle, lease, cancel, budget, pause, allow-listed result.
// Client: session.task(), progress order, timeout and abort send `cancel` with `re`.
// Fakes only; the host and client are also wired to each other in-process for the round trips.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const READERS = { chatId: "chat-1", publicKeys: ["-----PUB-----"] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CAPS = {
  "device.task": { mode: "auto" },
  "device.observe": { mode: "auto" },
  "device.act": { mode: "auto" },
};

const noop = async () => undefined;
function baseHandlers(task) {
  const calls = [];
  const h = {
    calls,
    observe: async () => ({ obs: "o", width: 1, height: 1, scale: 1, format: "png", image_b64: "AA" }),
    click: async (a) => void calls.push(["click", a]),
    type: noop,
    key: noop,
    scroll: noop,
    submit: noop,
    focusApp: noop,
    listApps: async () => ({ apps: [] }),
    readFile: async () => ({ path: "/x", size: 1, content_b64: "AA" }),
    writeFile: noop,
  };
  if (task) h.task = task;
  return h;
}

function transport() {
  const t = {
    results: [],
    stamps: [],
    beats: [],
    counts: [],
    stops: [],
    async postResult(p) {
      t.results.push(sdk.decodeDeviceMessage(p));
      t.stamps.push(Date.now());
    },
    async beat(sid, r) {
      t.beats.push(r);
    },
    async reportCounts(sid, c, r) {
      t.counts.push([c, r]);
    },
    async stop(sid, reason) {
      t.stops.push(reason);
    },
    async pause() {},
    async resume() {},
  };
  return t;
}

function mkHost(handlers, t, extra = {}, options = {}) {
  return sdk.createDeviceHost(
    { sessionId: "sess-1", agentId: "ag", readers: READERS, caps: CAPS, ...extra },
    handlers,
    t,
    extra.callbacks ?? {},
    { deviceLock: new sdk.DeviceLock(), ...options }
  );
}

function cmd(seq, op, body, o = {}) {
  return sdk.encodeDeviceMessage(
    { v: 1, id: o.id ?? `c${seq}`, seq, op, session: "sess-1", ...(o.re ? { re: o.re } : {}), exp: Date.now() + 30000 },
    body
  );
}

const ok = (over = {}) => ({
  task_id: "t_abc123",
  status: "done",
  summary: "Done.",
  checked: { ok: true, what: "the page title says saltapp.ai" },
  steps: [{ n: 1, kind: "command", line: "open https://saltapp.ai", ok: true }],
  commands: 1,
  duration_ms: 1200,
  ...over,
});

const ops = (t) => t.results.map((m) => m.header.op);

// ------------------------------------------------------------------ protocol

test("protocol: task is a mutating op under device.task, counted as `task`; progress and task_result are result ops", () => {
  assert.equal(sdk.CAPABILITY_FOR_OP.task, "device.task");
  assert.ok(sdk.AGENT_OPS.includes("task"));
  assert.ok(sdk.MUTATING_OPS.includes("task"));
  assert.equal(sdk.countClassForOp("task"), "task");
  for (const c of ["task", "command", "look"]) assert.ok(sdk.DEVICE_COUNT_CLASSES.includes(c));
  assert.ok(sdk.DEVICE_RESULT_OPS.includes("progress"));
  assert.ok(sdk.DEVICE_RESULT_OPS.includes("task_result"));
  assert.equal(sdk.PROGRESS_MIN_INTERVAL_MS, 2000);
  assert.equal(sdk.TASK_DEVICE_GRACE_MS, 15000);
  assert.equal(sdk.TASK_CLIENT_GRACE_MS, 30000);
});

test("protocol: parseTaskArgs fills defaults, clamps the numbers, drops unknown keys, refuses bad goals", () => {
  assert.deepEqual(sdk.parseTaskArgs({ goal: "open the page", extra: 1 }), { goal: "open the page", max_steps: 30, timeout_s: 180 });
  const clamped = sdk.parseTaskArgs({ goal: "g", done_when: "it is open", max_steps: 500, timeout_s: 1 });
  assert.equal(clamped.max_steps, 60);
  assert.equal(clamped.timeout_s, 10);
  assert.equal(clamped.done_when, "it is open");
  assert.equal(sdk.parseTaskArgs({ goal: "g", max_steps: 0, timeout_s: 9999 }).max_steps, 1);
  assert.equal(sdk.parseTaskArgs({ goal: "g", timeout_s: 9999 }).timeout_s, 600);
  for (const bad of [undefined, null, "x", {}, { goal: "" }, { goal: "   " }, { goal: 5 }, { goal: "x".repeat(2001) }, { goal: "g", done_when: "x".repeat(501) }, { goal: "g", done_when: 4 }, { goal: "g", max_steps: 1.5 }, { goal: "g", timeout_s: "30" }]) {
    assert.throws(() => sdk.parseTaskArgs(bad), (e) => e instanceof sdk.DeviceProtocolError && e.code === "bad_args", JSON.stringify(bad));
  }
  assert.equal(sdk.parseTaskArgs({ goal: "x".repeat(2000) }).goal.length, 2000);
});

test("protocol: normalizeProgress keeps step/of/line/waiting only, cuts the line, refuses a body without step and line", () => {
  assert.deepEqual(sdk.normalizeProgress({ step: 2, of: 5, line: "x".repeat(300), waiting: true, secret: "no" }), { step: 2, of: 5, line: "x".repeat(140), waiting: true });
  assert.deepEqual(sdk.normalizeProgress({ step: 0, line: "start", of: 0, waiting: "yes" }), { step: 0, line: "start" });
  for (const bad of [null, "x", { step: "1", line: "a" }, { step: 1.5, line: "a" }, { step: -1, line: "a" }, { step: 1 }, { line: "a" }]) {
    assert.equal(sdk.normalizeProgress(bad), null, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------------ host

test("host: a task runs the handler, posts progress then ONE task_result with the same re, and reports counts", async () => {
  const seen = [];
  const t = transport();
  const h = baseHandlers(async (args, ctx) => {
    seen.push(args);
    ctx.progress({ step: 1, of: 3, line: "Opening the page" });
    ctx.spend("command");
    ctx.spend("look");
    return ok();
  });
  const dh = mkHost(h, t);
  assert.equal(await dh.handleCommand(cmd(1, "task", { goal: "Open saltapp.ai", done_when: "title says Salt" }, { id: "T1" })), true);
  assert.deepEqual(ops(t), ["progress", "task_result"]);
  assert.ok(t.results.every((m) => m.header.re === "T1" && m.header.session === "sess-1"));
  assert.deepEqual(seen[0], { goal: "Open saltapp.ai", done_when: "title says Salt", max_steps: 30, timeout_s: 180 });
  assert.deepEqual(t.results[0].body, { step: 1, of: 3, line: "Opening the page" });
  assert.equal(t.results[1].body.status, "done");
  assert.equal(t.results[1].body.task_id, "t_abc123");
  await tick();
  const merged = {};
  for (const [c] of t.counts) for (const [k, v] of Object.entries(c)) merged[k] = (merged[k] ?? 0) + v;
  assert.deepEqual(merged, { command: 1, look: 1, task: 1 });
  assert.equal(dh.actionsSpent(), 2); // the steps are charged; the task itself is counted, not charged
});

test("host: no task handler answers unsupported, and nothing is charged", async () => {
  const t = transport();
  const dh = mkHost(baseHandlers(), t);
  await dh.handleCommand(cmd(1, "task", { goal: "x" }, { id: "T1" }));
  assert.equal(t.results.length, 1);
  assert.equal(t.results[0].header.op, "error");
  assert.equal(t.results[0].body.code, "unsupported");
  assert.equal(dh.actionsSpent(), 0);
});

test("host: no device.task in the grant is out_of_scope; bad args are bad_args and never reach the handler", async () => {
  let ran = 0;
  const t = transport();
  const h = baseHandlers(async () => (ran++, ok()));
  const noGrant = mkHost(h, t, { caps: { "device.act": { mode: "auto" } } });
  await noGrant.handleCommand(cmd(1, "task", { goal: "x" }));
  assert.equal(t.results[0].body.code, "out_of_scope");

  const t2 = transport();
  const dh = mkHost(h, t2);
  await dh.handleCommand(cmd(1, "task", { goal: "" }));
  await dh.handleCommand(cmd(2, "task", { goal: "g", max_steps: 2.5 }));
  await dh.handleCommand(cmd(3, "task", { goal: "x".repeat(2001) }));
  assert.deepEqual(t2.results.map((m) => m.body.code), ["bad_args", "bad_args", "bad_args"]);
  assert.equal(ran, 0);
});

test("host: max_steps and timeout_s reach the handler clamped", async () => {
  const seen = [];
  const t = transport();
  const dh = mkHost(baseHandlers(async (a) => (seen.push(a), ok())), t);
  await dh.handleCommand(cmd(1, "task", { goal: "g", max_steps: 999, timeout_s: 2 }));
  assert.equal(seen[0].max_steps, 60);
  assert.equal(seen[0].timeout_s, 10);
});

test("host: the result is allow-listed field by field: extras stripped, strings and steps capped, bad rows dropped", async () => {
  const t = transport();
  const steps = [];
  for (let i = 0; i < 80; i++) steps.push({ n: i + 1, kind: "command", line: "y".repeat(300), ok: i % 2 === 0, output: "SECRET OUTPUT" });
  steps.splice(1, 0, { n: 2, kind: "shell", line: "bad kind", ok: true }, "not a row", { n: 3, kind: "look", ok: true });
  const dh = mkHost(
    baseHandlers(async () => ({
      task_id: "t_x",
      status: "done",
      summary: "s".repeat(900),
      checked: { ok: true, what: "w".repeat(400), screenshot_b64: "AAAA" },
      steps,
      commands: 7,
      duration_ms: 99,
      output: "rm -rf output that must not leave",
      screenshot_b64: "AAAA",
      __proto__x: 1,
    })),
    t
  );
  await dh.handleCommand(cmd(1, "task", { goal: "g" }));
  const b = t.results[0].body;
  assert.deepEqual(Object.keys(b).sort(), ["checked", "commands", "duration_ms", "steps", "status", "summary", "task_id"].sort());
  assert.equal(b.summary.length, 500);
  assert.deepEqual(Object.keys(b.checked).sort(), ["ok", "what"]);
  assert.equal(b.checked.what.length, 200);
  assert.equal(b.steps.length, 60);
  for (const s of b.steps) {
    assert.deepEqual(Object.keys(s).sort(), ["kind", "line", "n", "ok"]);
    assert.equal(s.line.length, 140);
    assert.ok(sdk.TASK_STEP_KINDS.includes(s.kind));
  }
  assert.equal(b.commands, 7);
  assert.ok(!JSON.stringify(b).includes("SECRET"));
  assert.ok(!JSON.stringify(b).includes("screenshot"));
});

test("host: a malformed result becomes a safe failed result; bad types fall back; unknown status reads failed", async () => {
  const t = transport();
  const dh = mkHost(
    baseHandlers(async () => ({ status: "great", summary: 5, checked: { ok: "yes", what: "x" }, steps: "no", commands: -4, duration_ms: 1.5 })),
    t
  );
  await dh.handleCommand(cmd(1, "task", { goal: "g" }));
  const b = t.results[0].body;
  assert.equal(t.results[0].header.op, "task_result");
  assert.match(b.task_id, /^t_[0-9a-f]{12}$/);
  assert.equal(b.status, "failed");
  assert.equal(b.summary, "");
  assert.equal(b.checked, null);
  assert.deepEqual(b.steps, []);
  assert.equal(b.commands, 0);
  assert.ok(Number.isInteger(b.duration_ms) && b.duration_ms >= 0);
});

test("host: progress is throttled (newest wins after the gap), allow-listed, and always ahead of the result", async () => {
  const t = transport();
  const dh = mkHost(
    baseHandlers(async (_a, ctx) => {
      ctx.progress({ step: 1, line: "one", leak: "x" });
      ctx.progress({ step: 2, line: "two" });
      ctx.progress({ step: 3, line: "three", waiting: true });
      ctx.progress({ step: "bad", line: "ignored" });
      await sleep(130);
      return ok();
    }),
    t,
    {},
    { progressMinIntervalMs: 60 }
  );
  await dh.handleCommand(cmd(1, "task", { goal: "g" }));
  assert.deepEqual(ops(t), ["progress", "progress", "task_result"]);
  assert.deepEqual(t.results[0].body, { step: 1, line: "one" });
  assert.deepEqual(t.results[1].body, { step: 3, line: "three", waiting: true });
  assert.ok(t.stamps[1] - t.stamps[0] >= 55, `progress lines only ${t.stamps[1] - t.stamps[0]} ms apart`);
});

test("host: with the default 2 s gap a burst sends the first line only, and a line still waiting when the task ends is dropped", async () => {
  const t = transport();
  const dh = mkHost(
    baseHandlers(async (_a, ctx) => {
      ctx.progress({ step: 1, line: "first" });
      ctx.progress({ step: 2, line: "second" });
      ctx.progress({ step: 3, line: "third" });
      return ok();
    }),
    t
  );
  await dh.handleCommand(cmd(1, "task", { goal: "g" }));
  assert.deepEqual(ops(t), ["progress", "task_result"]);
  assert.equal(t.results[0].body.line, "first");
  await sleep(30);
  assert.equal(t.results.length, 2); // the timer never fires a stale line after the result
});

test("host: progress after the task is over sends nothing and spend throws", async () => {
  const t = transport();
  let ctxKept;
  const dh = mkHost(baseHandlers(async (_a, ctx) => ((ctxKept = ctx), ok())), t, {}, { progressMinIntervalMs: 0 });
  await dh.handleCommand(cmd(1, "task", { goal: "g" }));
  ctxKept.progress({ step: 9, line: "late" });
  await tick();
  assert.deepEqual(ops(t), ["task_result"]);
  assert.throws(() => ctxKept.spend("command"), /over/);
});

test("host: each progress and each spend extends the lease (beats carry last_command_at while the task runs)", async () => {
  const t = transport();
  const gate = deferred();
  const dh = mkHost(
    baseHandlers(async (_a, ctx) => {
      await gate.promise;
      ctx.progress({ step: 1, line: "still going" });
      await sleep(40);
      return ok();
    }),
    t,
    {},
    { beatIntervalMs: 10, progressMinIntervalMs: 0 }
  );
  dh.start();
  const run = dh.handleCommand(cmd(1, "task", { goal: "g" }));
  await sleep(35);
  assert.ok(t.beats.length > 0);
  assert.ok(t.beats.every((b) => b && b.task_running === true && b.last_command_at === undefined), "nothing has run yet: the beat only says a task is running");
  gate.resolve();
  await sleep(30);
  const last = t.beats[t.beats.length - 1];
  assert.ok(last && !Number.isNaN(Date.parse(last.last_command_at)), "a progress line is evidence the task is alive");
  assert.equal(last.last_seq, 1);
  await run;
  await dh.stop();

  // and a spend alone does it, with the count PATCH carrying the seq
  const t2 = transport();
  const dh2 = mkHost(baseHandlers(async (_a, ctx) => (ctx.spend("command"), await sleep(35), ok())), t2, {}, { beatIntervalMs: 10 });
  dh2.start();
  await dh2.handleCommand(cmd(1, "task", { goal: "g" }));
  assert.ok(t2.beats.some((b) => b && b.last_seq === 1));
  assert.equal(t2.counts[0][1].last_seq, 1);
  await dh2.stop();
});

test("host: beats say task_running only while a task is in flight", async () => {
  const t = transport();
  const gate = deferred();
  const dh = mkHost(baseHandlers(async () => (await gate.promise, ok())), t, {}, { beatIntervalMs: 10 });
  dh.start();
  await sleep(35);
  assert.ok(t.beats.length > 0);
  assert.ok(t.beats.every((b) => b === undefined), "no task, a plain beat");
  const before = t.beats.length;
  const run = dh.handleCommand(cmd(1, "task", { goal: "g" }));
  await sleep(35);
  const during = t.beats.slice(before);
  assert.ok(during.length > 0 && during.every((b) => b && b.task_running === true), "every beat while the task runs carries it");
  gate.resolve();
  await run;
  await sleep(5);
  const after = t.beats.length;
  await sleep(35);
  assert.ok(t.beats.slice(after).every((b) => b && b.task_running === undefined), "gone when the task is over");
  await dh.stop();
});

test("host: cancel with re (or body id) aborts a running task and it ends stopped", async () => {
  for (const how of ["re", "body"]) {
    const t = transport();
    const started = deferred();
    let reason;
    const dh = mkHost(
      baseHandlers(async (_a, ctx) => {
        started.resolve();
        await new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }));
        reason = ctx.signal.reason;
        return ok({ status: "stopped", summary: "Stopped.", checked: null });
      }),
      t
    );
    const run = dh.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
    await started.promise;
    const c = how === "re" ? sdk.encodeDeviceMessage({ v: 1, id: "x1", seq: 1, op: "cancel", session: "sess-1", re: "T1" }) : sdk.encodeDeviceMessage({ v: 1, id: "x1", seq: 1, op: "cancel", session: "sess-1" }, { id: "T1" });
    assert.equal(await dh.handleCommand(c), true);
    await run;
    assert.equal(reason, "cancelled");
    assert.equal(t.results[t.results.length - 1].header.op, "task_result");
    assert.equal(t.results[t.results.length - 1].body.status, "stopped");
  }
});

test("host: a handler that throws when aborted still ends stopped, not failed; one that throws on its own is `failed`", async () => {
  const t = transport();
  const started = deferred();
  const dh = mkHost(
    baseHandlers(async (_a, ctx) => {
      started.resolve();
      await new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }));
      throw new Error("aborted");
    }),
    t
  );
  const run = dh.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
  await started.promise;
  await dh.handleCommand(sdk.encodeDeviceMessage({ v: 1, id: "x1", seq: 1, op: "cancel", session: "sess-1", re: "T1" }));
  await run;
  assert.equal(t.results[0].header.op, "task_result");
  assert.equal(t.results[0].body.status, "stopped");

  const t2 = transport();
  const dh2 = mkHost(baseHandlers(async () => { throw new Error("the model said no"); }), t2);
  await dh2.handleCommand(cmd(1, "task", { goal: "g" }));
  assert.equal(t2.results[0].header.op, "error");
  assert.equal(t2.results[0].body.code, "failed");
});

test("host: a stop command aborts the running task at once instead of waiting for timeout_s", async () => {
  const t = transport();
  const started = deferred();
  const dh = mkHost(
    baseHandlers(async (_a, ctx) => {
      started.resolve();
      await new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }));
      return ok({ status: "stopped", summary: "Stopped.", checked: null });
    }),
    t
  );
  const run = dh.handleCommand(cmd(1, "task", { goal: "g" }));
  await started.promise;
  const stop = dh.handleCommand(cmd(2, "stop"));
  await Promise.all([run, stop]);
  assert.deepEqual(ops(t), ["task_result", "ended"]);
  assert.equal(t.stops[0], "stopped_by_agent");
});

test("host: the budget is charged per step; the step past max_actions throws the typed error, the agent hears out_of_scope, the session ends", async () => {
  const t = transport();
  let seenError;
  const dh = mkHost(
    baseHandlers(async (_a, ctx) => {
      ctx.spend("command");
      ctx.spend("act");
      try {
        ctx.spend("look");
      } catch (e) {
        seenError = e;
        throw e; // let it bubble, as the contract says
      }
      return ok();
    }),
    t,
    { budget: { maxActions: 2 } }
  );
  await dh.handleCommand(cmd(1, "task", { goal: "g" }));
  assert.ok(seenError instanceof sdk.DeviceBudgetSpentError);
  assert.ok(seenError instanceof sdk.DeviceProtocolError);
  assert.equal(seenError.code, "out_of_scope");
  assert.equal(t.results[0].header.op, "error");
  assert.equal(t.results[0].body.code, "out_of_scope");
  assert.match(t.results[0].body.message, /budget/);
  assert.equal(dh.actionsSpent(), 2);
  assert.deepEqual(t.stops, ["budget_exhausted"]);
  await tick();
  const merged = {};
  for (const [c] of t.counts) for (const [k, v] of Object.entries(c)) merged[k] = (merged[k] ?? 0) + v;
  assert.deepEqual(merged, { command: 1, click: 1 }); // act counts as a click; no `error` count, no `task` count
});

test("host: a task that spends the last action and finishes is delivered, then the session ends budget_exhausted", async () => {
  const t = transport();
  const dh = mkHost(baseHandlers(async (_a, ctx) => (ctx.spend("command"), ok())), t, { budget: { maxActions: 1 } });
  await dh.handleCommand(cmd(1, "task", { goal: "g" }));
  assert.equal(t.results[0].header.op, "task_result");
  assert.deepEqual(t.stops, ["budget_exhausted"]);
});

test("host: a task is refused up front when the budget is already spent", async () => {
  const t = transport();
  let ran = 0;
  const dh = mkHost(baseHandlers(async () => (ran++, ok())), t, { budget: { maxActions: 0 } });
  await dh.handleCommand(cmd(1, "task", { goal: "g" }));
  assert.equal(ran, 0);
  assert.equal(t.results[0].body.code, "out_of_scope");
});

test("host: a task holds the device-wide lock for the whole run; another host's click waits", async () => {
  const lock = new sdk.DeviceLock();
  const gate = deferred();
  const t1 = transport();
  const t2 = transport();
  const started = deferred();
  const h1 = baseHandlers(async () => (started.resolve(), await gate.promise, ok()));
  const h2 = baseHandlers();
  const a = sdk.createDeviceHost({ sessionId: "sess-1", agentId: "ag", readers: READERS, caps: CAPS }, h1, t1, {}, { deviceLock: lock });
  const b = sdk.createDeviceHost({ sessionId: "sess-2", agentId: "ag2", readers: READERS, caps: CAPS }, h2, t2, {}, { deviceLock: lock });
  const runA = a.handleCommand(cmd(1, "task", { goal: "g" }));
  await started.promise;
  const runB = b.handleCommand(sdk.encodeDeviceMessage({ v: 1, id: "b1", seq: 1, op: "click", session: "sess-2", exp: Date.now() + 30000 }, { x: 1, y: 1 }));
  await sleep(30);
  assert.equal(h2.calls.length, 0, "the click must not run while the task holds the machine");
  gate.resolve();
  await Promise.all([runA, runB]);
  assert.equal(h2.calls.length, 1);
});

test("host: asking mode is not asked about the task as a whole; the handler sees ctx.mode and ctx.caps", async () => {
  const t = transport();
  let asked = 0;
  let seen;
  const dh = mkHost(
    baseHandlers(async (_a, ctx) => ((seen = { mode: ctx.mode, caps: ctx.caps }), ok())),
    t,
    { caps: { ...CAPS, "device.task": { mode: "ask" } }, callbacks: { requestLocalApproval: async () => (asked++, false) } }
  );
  await dh.handleCommand(cmd(1, "task", { goal: "g" }));
  assert.equal(asked, 0);
  assert.equal(t.results[0].header.op, "task_result");
  assert.equal(seen.mode, "ask");
  assert.deepEqual(Object.keys(seen.caps).sort(), ["device.act", "device.observe", "device.task"]);
  assert.ok(Object.isFrozen(seen.caps));
});

test("host: pause is visible to the task, and waitWhilePaused returns when the person resumes", async () => {
  const t = transport();
  const seen = [];
  const paused = deferred();
  const dh = mkHost(
    baseHandlers(async (_a, ctx) => {
      seen.push(ctx.paused());
      seen.push(await ctx.waitWhilePaused()); // not paused: at once
      paused.resolve();
      await sleep(10);
      seen.push(ctx.paused());
      seen.push(await ctx.waitWhilePaused());
      seen.push(ctx.paused());
      return ok();
    }),
    t
  );
  const run = dh.handleCommand(cmd(1, "task", { goal: "g" }));
  await paused.promise;
  await dh.pause("person");
  await sleep(40);
  assert.deepEqual(seen, [null, "running", "person"], "the task is waiting, not finished");
  await dh.resume();
  await run;
  assert.deepEqual(seen, [null, "running", "person", "running", null]);
});

test("host: a pause that outlasts the task's time reads paused_out", async () => {
  const { mock } = require("node:test");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const handlerStarted = deferred();
    const t = transport();
    const dh = mkHost(
      baseHandlers(async (_a, ctx) => {
        handlerStarted.resolve();
        await Promise.resolve();
        const r = await ctx.waitWhilePaused();
        return ok({ status: r === "paused_out" ? "paused_out" : "stopped", summary: r });
      }),
      t
    );
    const run = dh.handleCommand(cmd(1, "task", { goal: "g", timeout_s: 10 }));
    await handlerStarted.promise;
    void dh.pause("person"); // takes effect synchronously
    await Promise.resolve();
    mock.timers.tick(10_000);
    await run;
    assert.equal(t.results[0].body.status, "paused_out");
    assert.equal(t.results[0].body.summary, "paused_out");
  } finally {
    mock.timers.reset();
  }
});

test("host: the session ending while a task waits on a pause reads stopped", async () => {
  const t = transport();
  const handlerStarted = deferred();
  const dh = mkHost(
    baseHandlers(async (_a, ctx) => {
      handlerStarted.resolve();
      await Promise.resolve();
      const r = await ctx.waitWhilePaused();
      return ok({ status: r === "stopped" ? "stopped" : "done", summary: r });
    }),
    t
  );
  const run = dh.handleCommand(cmd(1, "task", { goal: "g" }));
  await handlerStarted.promise;
  void dh.pause("person");
  await Promise.resolve();
  await dh.stop("stopped_by_device");
  await run;
  assert.equal(t.results[0].body.status, "stopped");
});

test("host: a handler that ignores the abort is cut off 15 s after timeout_s with a timeout result and the lock is released", async () => {
  const { mock } = require("node:test");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const lock = new sdk.DeviceLock();
    const t = transport();
    let signalReason;
    const started = deferred();
    const never = new Promise(() => undefined);
    const dh = sdk.createDeviceHost(
      { sessionId: "sess-1", agentId: "ag", readers: READERS, caps: CAPS },
      baseHandlers(async (_a, ctx) => ((signalReason = () => ctx.signal.reason), started.resolve(), await never)),
      t,
      {},
      { deviceLock: lock }
    );
    const run = dh.handleCommand(cmd(1, "task", { goal: "g", timeout_s: 10 }));
    await started.promise;
    mock.timers.tick(10_000);
    assert.equal(signalReason(), "timeout", "the handler is told at timeout_s");
    assert.equal(t.results.length, 0, "and given 15 s more");
    mock.timers.tick(15_000);
    await run;
    assert.equal(t.results[0].header.op, "task_result");
    assert.equal(t.results[0].body.status, "timeout");
    assert.equal(t.results[0].body.summary, "The task ran out of time.");
    let got = false;
    await lock.run(async () => void (got = true));
    assert.equal(got, true, "the machine is free again");
  } finally {
    mock.timers.reset();
  }
});

test("host: a repeated task id returns the stored result without running again", async () => {
  const t = transport();
  let ran = 0;
  const dh = mkHost(baseHandlers(async () => (ran++, ok())), t);
  await dh.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
  await dh.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
  assert.equal(ran, 1);
  assert.deepEqual(ops(t), ["task_result", "task_result"]);
  assert.deepEqual(t.results[0].body, t.results[1].body);
});

// ------------------------------------------------------------------ client

const ACTIVE = { id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: ["-----PUB-----"] } };

/** A client and a host wired to each other: commands go straight to the host, results straight back. */
async function wired(handlers, hostExtra = {}, hostOptions = {}, clientOptions = {}) {
  const t = {
    sent: [],
    async openSession() {
      return ACTIVE;
    },
    async stopSession() {},
    async postCommand(plaintext) {
      t.sent.push(sdk.decodeDeviceMessage(plaintext));
      void host.handleCommand(plaintext);
    },
  };
  const ht = {
    async postResult(p) {
      client.handleLaneMessage(p, "d");
    },
    async beat() {},
    async reportCounts() {},
    async stop() {},
  };
  const host = mkHost(handlers, ht, hostExtra, hostOptions);
  const client = sdk.createDeviceClient(t, { deviceId: "d" }, clientOptions);
  await client.open();
  return { client, host, t };
}

test("client: task() sends goal/done_when/max_steps/timeout_s, delivers progress in order, and resolves the task_result", async () => {
  const { client, t } = await wired(
    baseHandlers(async (_a, ctx) => {
      ctx.progress({ step: 1, of: 2, line: "Opening Firefox" });
      await sleep(25);
      ctx.progress({ step: 2, of: 2, line: "Checking the title", waiting: false });
      return ok();
    }),
    {},
    { progressMinIntervalMs: 10 }
  );
  const lines = [];
  const result = await client.task("Open saltapp.ai", { doneWhen: "title says Salt", maxSteps: 10, timeoutS: 60, onProgress: (p) => lines.push(p) });
  assert.deepEqual(t.sent[0].body, { goal: "Open saltapp.ai", done_when: "title says Salt", max_steps: 10, timeout_s: 60 });
  assert.equal(t.sent[0].header.op, "task");
  assert.deepEqual(lines, [
    { step: 1, of: 2, line: "Opening Firefox" },
    { step: 2, of: 2, line: "Checking the title", waiting: false },
  ]);
  assert.equal(result.status, "done");
  assert.equal(result.checked.ok, true);
  assert.equal(result.steps[0].kind, "command");
});

test("client: task() with only a goal sends only the goal; out-of-range arguments are refused before anything is sent", async () => {
  const { client, t } = await wired(baseHandlers(async () => ok()));
  await client.task("Just do it");
  assert.deepEqual(t.sent[0].body, { goal: "Just do it" });
  const before = t.sent.length;
  await assert.rejects(client.task(""), (e) => e.code === "bad_args");
  await assert.rejects(client.task("g", { maxSteps: 1.5 }), (e) => e.code === "bad_args");
  await assert.rejects(client.task("x".repeat(2001)), (e) => e.code === "bad_args");
  assert.equal(t.sent.length, before);
});

test("client: a computer without a task handler rejects with unsupported; a handler failure rejects with failed", async () => {
  const a = await wired(baseHandlers());
  await assert.rejects(a.client.task("g"), (e) => e instanceof sdk.DeviceProtocolError && e.code === "unsupported");
  const b = await wired(baseHandlers(async () => { throw new Error("model down"); }));
  await assert.rejects(b.client.task("g"), (e) => e.code === "failed" && /model down/.test(e.message));
});

test("client: the result is allow-listed again on this side; a device that adds fields or lies about types cannot widen it", async () => {
  const t = {
    posted: [],
    async openSession() {
      return ACTIVE;
    },
    async stopSession() {},
    async postCommand(p) {
      t.posted.push(sdk.decodeDeviceMessage(p));
    },
  };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  await c.open();
  const run = c.task("g");
  const sent = t.posted[0].header;
  c.handleLaneMessage(
    sdk.encodeDeviceMessage(
      { v: 1, id: "r1", seq: 1, op: "task_result", session: "sess-1", re: sent.id },
      { ...ok({ summary: "z".repeat(900) }), image_b64: "AAAA", status: "done", steps: [{ n: 1, kind: "command", line: "a", ok: true, output: "x" }] }
    )
  , "d");
  const r = await run;
  assert.equal(r.summary.length, 500);
  assert.deepEqual(Object.keys(r).sort(), ["checked", "commands", "duration_ms", "status", "steps", "summary", "task_id"]);
  assert.deepEqual(Object.keys(r.steps[0]).sort(), ["kind", "line", "n", "ok"]);
});

test("client: progress lines that arrive out of order are dropped (older seq after a newer one), extras are stripped, and a throwing callback is harmless", async () => {
  const t = {
    posted: [],
    async openSession() {
      return ACTIVE;
    },
    async stopSession() {},
    async postCommand(p) {
      t.posted.push(sdk.decodeDeviceMessage(p));
    },
  };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  await c.open();
  const got = [];
  const run = c.task("g", {
    onProgress: (p) => {
      got.push(p);
      throw new Error("callback bug");
    },
  });
  const re = t.posted[0].header.id;
  const prog = (seq, body) => sdk.encodeDeviceMessage({ v: 1, id: `p${seq}`, seq, op: "progress", session: "sess-1", re }, body);
  assert.equal(c.handleLaneMessage(prog(2, { step: 2, line: "two", secret: "x" }), "d"), true);
  assert.equal(c.handleLaneMessage(prog(1, { step: 1, line: "one" }), "d"), true); // late: consumed, not delivered
  assert.equal(c.handleLaneMessage(prog(3, { nope: true }), "d"), true); // not a progress line: consumed, not delivered
  assert.equal(c.handleLaneMessage(prog(4, { step: 3, line: "three" }), "d"), true);
  assert.deepEqual(got, [{ step: 2, line: "two" }, { step: 3, line: "three" }]);
  c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "r", seq: 5, op: "task_result", session: "sess-1", re }, ok()), "d");
  assert.equal((await run).status, "done");
  // after the result, a straggling progress line is not ours any more
  assert.equal(c.handleLaneMessage(prog(6, { step: 4, line: "late" }), "d"), false);
});

test("client: no result within timeoutS + 30 s sends cancel with re = the task id (and body id), then rejects", async () => {
  const { mock } = require("node:test");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const posted = [];
    const t = {
      async openSession() {
        return ACTIVE;
      },
      async stopSession() {},
      async postCommand(p) {
        posted.push(sdk.decodeDeviceMessage(p));
      },
    };
    const c = sdk.createDeviceClient(t, { deviceId: "d" });
    await c.open();
    const run = c.task("g", { timeoutS: 20 });
    run.catch(() => undefined);
    await Promise.resolve();
    mock.timers.tick(49_999);
    await Promise.resolve();
    assert.equal(posted.length, 1, "still waiting at 49.999 s");
    mock.timers.tick(1);
    await assert.rejects(run, /timed out/);
    assert.equal(posted.length, 2);
    assert.equal(posted[1].header.op, "cancel");
    assert.equal(posted[1].header.re, posted[0].header.id);
    assert.deepEqual(posted[1].body, { id: posted[0].header.id });
  } finally {
    mock.timers.reset();
  }
});

test("client: the default wait is 180 + 30 s", async () => {
  const { mock } = require("node:test");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const posted = [];
    const t = { async openSession() { return ACTIVE; }, async stopSession() {}, async postCommand(p) { posted.push(sdk.decodeDeviceMessage(p)); } };
    const c = sdk.createDeviceClient(t, { deviceId: "d" });
    await c.open();
    const run = c.task("g");
    run.catch(() => undefined);
    await Promise.resolve();
    mock.timers.tick(209_999);
    await Promise.resolve();
    assert.equal(posted.length, 1);
    mock.timers.tick(1);
    await assert.rejects(run, /timed out/);
    assert.equal(posted[1].header.op, "cancel");
  } finally {
    mock.timers.reset();
  }
});

test("client: aborting sends cancel with re, and the device's stopped result (steps so far) resolves the call", async () => {
  const started = deferred();
  const { client, t } = await wired(
    baseHandlers(async (_a, ctx) => {
      started.resolve();
      await new Promise((r) => ctx.signal.addEventListener("abort", r, { once: true }));
      return ok({ status: "stopped", summary: "Stopped after two steps.", checked: null });
    })
  );
  const ac = new AbortController();
  const run = client.task("g", { signal: ac.signal });
  await started.promise;
  ac.abort();
  const r = await run;
  assert.equal(r.status, "stopped");
  assert.equal(r.summary, "Stopped after two steps.");
  const cancel = t.sent.find((m) => m.header.op === "cancel");
  assert.equal(cancel.header.re, t.sent[0].header.id);
});

test("client: an abort the device never answers rejects after the grace period; an already-aborted signal sends nothing", async () => {
  const { mock } = require("node:test");
  const posted = [];
  const t = { async openSession() { return ACTIVE; }, async stopSession() {}, async postCommand(p) { posted.push(sdk.decodeDeviceMessage(p)); } };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  await c.open();
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(c.task("g", { signal: pre.signal }), /aborted/);
  assert.equal(posted.length, 0);

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const ac = new AbortController();
    const run = c.task("g", { signal: ac.signal });
    run.catch(() => undefined);
    await Promise.resolve();
    ac.abort();
    await Promise.resolve();
    assert.equal(posted.filter((m) => m.header.op === "cancel").length, 1);
    mock.timers.tick(10_000);
    await assert.rejects(run, /aborted/);
  } finally {
    mock.timers.reset();
  }
});

test("client: a paused session refuses a task up front with DevicePausedError, like any command", async () => {
  const { client } = await wired(baseHandlers(async () => ok()));
  client.handleDelivery("device_session", { id: "sess-1", status: "paused", pause_reason: "person", type: "device_session_paused", event: "paused", session_id: "sess-1" });
  await assert.rejects(client.task("g"), (e) => e instanceof sdk.DevicePausedError);
});

test("round trip: a task is one command in flight; a click queued behind it waits for the result", async () => {
  const gate = deferred();
  const order = [];
  const h = baseHandlers(async () => (order.push("task start"), await gate.promise, order.push("task end"), ok()));
  h.click = async () => void order.push("click");
  const { client } = await wired(h);
  const task = client.task("g");
  const click = client.click({ x: 1, y: 1 });
  await sleep(20);
  assert.deepEqual(order, ["task start"]);
  gate.resolve();
  await Promise.all([task, click]);
  assert.deepEqual(order, ["task start", "task end", "click"]);
});
