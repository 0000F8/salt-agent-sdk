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
const amend = (body, o = {}) => sdk.encodeDeviceMessage({ v: 1, id: o.id ?? "a" + Math.random(), seq: 1, op: "amend", session: "sess-1", ...(o.re ? { re: o.re } : {}), ...(o.exp === null ? {} : { exp: o.exp ?? Date.now() + 30000 }) }, body);

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
  assert.throws(() => sdk.amendCommandBody("x".repeat(501), "T1"), (e) => e.code === "bad_args" && /over 500/.test(e.message));
  assert.deepEqual(sdk.amendCommandBody("x".repeat(500), "T1"), { id: "T1", say: "x".repeat(500) });
  assert.equal(sdk.AMEND_MAX_PER_TASK, 20);
  assert.equal(sdk.normalizeAmend({ say: "😀".repeat(600) }).say, "😀".repeat(500), "clipped by code points");
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

test("client: amendTask posts amend with re, exp and body {id, say}, uses no seq, refuses an empty or over-long say", async () => {
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
  assert.ok(Math.abs(sent[0].header.exp - (Date.now() + sdk.COMMAND_TTL_MS)) < 2000, "exp is now + the command TTL");
  await assert.rejects(c.amendTask("T1", "  "), (e) => e.code === "bad_args");
  await assert.rejects(c.amendTask("T1", "x".repeat(501)), (e) => e.code === "bad_args");
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

// ---- review fixes ----------------------------------------------------------------------------

const frame = (id, say, o = {}) => sdk.encodeDeviceMessage({ v: 1, id, seq: 1, op: "amend", session: "sess-1", exp: o.exp ?? Date.now() + 30000 }, { id: o.task ?? "T1", say });

async function runningTask(extra = {}, audits = [], caps = CAPS) {
  const t = transport();
  const started = deferred();
  const go = deferred();
  const seen = [];
  const dh = mkHost(handlers(async (_a, ctx) => (started.resolve(), await go.promise, seen.push(ctx.amends()), result)), t, caps, audits);
  const run = dh.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
  await started.promise;
  return { dh, t, go, run, seen, audits };
}

test("review 1: a task waiting for the device-wide lock (another session running) keeps its amend and applies it at start", async () => {
  const lock = new sdk.DeviceLock();
  const aStarted = deferred();
  const aGo = deferred();
  const seen = [];
  const audits = [];
  const mkL = (h, sid, aud) => sdk.createDeviceHost({ sessionId: sid, agentId: "ag", readers: READERS, caps: CAPS }, h, transport(), { onAudit: (a) => aud.push(a) }, { deviceLock: lock });
  const A = mkL(handlers(async () => (aStarted.resolve(), await aGo.promise, result)), "sess-1", []);
  const B = mkL(handlers(async (_a, ctx) => (seen.push(ctx.amends()), result)), "sess-2", audits);
  const enc = (id, op, body, o = {}) => sdk.encodeDeviceMessage({ v: 1, id, seq: 1, op, session: "sess-2", exp: Date.now() + 30000, ...o }, body);
  const ra = A.handleCommand(cmd(1, "task", { goal: "a" }, { id: "TA" }));
  await aStarted.promise;
  const rb = B.handleCommand(enc("TB", "task", { goal: "b" }));
  await new Promise((r) => setTimeout(r, 40));
  await B.handleCommand(enc("AB", "amend", { id: "TB", say: "change of plan" }));
  aGo.resolve();
  await ra;
  await rb;
  assert.deepEqual(seen, [["change of plan"]]);
  assert.equal(audits.find((a) => a.op === "amend").decision, "ran");
  assert.equal(audits.find((a) => a.op === "amend").text, "change of plan", "the host's audit carries the text");
});

test("review 2: an amend needs exp; a stale or far-future exp, a repeated id, a mandate past its expiry are all dropped (and applied once otherwise)", async () => {
  const audits = [];
  const { dh, go, run, seen } = await runningTask({}, audits);
  await dh.handleCommand(frame("n1", "no exp", { exp: undefined }).replace(/ exp=\d+/, ""));
  await dh.handleCommand(frame("old", "stale", { exp: Date.now() - 3600_000 }));
  await dh.handleCommand(frame("far", "far ahead", { exp: Date.now() + 3600_000 }));
  const good = frame("A1", "once");
  await dh.handleCommand(good);
  await dh.handleCommand(good); // a replayed frame
  go.resolve();
  await run;
  assert.deepEqual(seen, [["once"]]);
  const reasons = audits.filter((a) => a.op === "amend" && a.decision === "refused").map((a) => a.reason);
  assert.deepEqual(reasons, ["exp is required", "expired", "exp is further ahead than a command may live", "repeated id"]);

  const t2 = transport();
  const s2 = deferred();
  const g2 = deferred();
  const seen2 = [];
  const dh2 = sdk.createDeviceHost(
    { sessionId: "sess-1", agentId: "ag", readers: READERS, caps: CAPS, expiresAt: new Date(Date.now() + 150).toISOString() },
    handlers(async (_a, ctx) => (s2.resolve(), await g2.promise, seen2.push(ctx.amends()), result)),
    t2,
    {},
    { deviceLock: new sdk.DeviceLock() }
  );
  const r2 = dh2.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
  await s2.promise;
  await new Promise((r) => setTimeout(r, 250));
  await dh2.handleCommand(frame("late", "after expiry"));
  g2.resolve();
  await r2;
  assert.deepEqual(seen2, [[]], "an amend after the mandate's expiry is not applied");
});

test("review 2: amends are rate limited, and a task takes at most AMEND_MAX_PER_TASK in total with a plain line in its progress stream", async () => {
  const audits = [];
  const { dh, t, go, run, seen } = await runningTask({}, audits);
  let n = 0;
  // two a second at most: the third inside the same second is refused
  for (let i = 0; i < 3; i++) await dh.handleCommand(frame(`r${n++}`, `say ${i}`));
  assert.equal(audits.filter((a) => a.reason === "too many amends at once").length, 1);
  // go through the total cap, spacing the amends past the rate window
  let applied = 2;
  while (applied < sdk.AMEND_MAX_PER_TASK) {
    await new Promise((r) => setTimeout(r, 1010));
    for (let i = 0; i < 2 && applied < sdk.AMEND_MAX_PER_TASK; i++, applied++) await dh.handleCommand(frame(`r${n++}`, `say ${applied}`));
  }
  await new Promise((r) => setTimeout(r, 1010));
  await dh.handleCommand(frame(`r${n++}`, "one too many"));
  go.resolve();
  await run;
  assert.equal(seen[0].length, sdk.AMEND_MAX_PER_TASK);
  assert.ok(!seen[0].includes("one too many"));
  assert.ok(audits.some((a) => a.reason === "amend cap per task"));
  assert.ok(t.results.some((m) => m.header.op === "progress" && /already been changed 20 times/.test(m.body.line)));
}, { timeout: 60000 });

test("review 7: an amend that arrives as the task ends is audited and reported in the progress stream, not silently lost", async () => {
  const t = transport();
  const audits = [];
  let dhRef;
  const dh = mkHost(
    handlers(async () => {
      await dhRef.handleCommand(frame("late1", "too late for this one")); // the handler never drains it
      return result;
    }),
    t,
    CAPS,
    audits
  );
  dhRef = dh;
  await dh.handleCommand(cmd(1, "task", { goal: "g" }, { id: "T1" }));
  assert.ok(audits.some((a) => a.op === "amend" && a.reason === "task over" && a.text === "too late for this one"));
  const ops = t.results.map((m) => m.header.op);
  assert.equal(ops.at(-1), "task_result");
  assert.ok(t.results.some((m) => m.header.op === "progress" && /^Not applied: the task finished before it could take a change/.test(m.body.line)));
});

test("review 7: a queued task that is refused before it starts drops its inbox (a retry with the same id does not inherit it)", async () => {
  const t = transport();
  const blockStarted = deferred();
  const release = deferred();
  const h = handlers(async (_a, ctx) => ((h.got = ctx.amends()), result));
  h.observe = async () => (blockStarted.resolve(), await release.promise, { obs: "o", width: 1, height: 1, scale: 1, format: "png", image_b64: "AA" });
  const dh = mkHost(h, t);
  const first = dh.handleCommand(cmd(1, "observe", { target: "screen" }, { id: "O1" }));
  await blockStarted.promise;
  const bad = dh.handleCommand(cmd(9, "task", { goal: "g" }, { id: "T9" })); // out_of_order: refused at start
  await tick();
  await dh.handleCommand(frame("stale1", "stale", { task: "T9" }));
  release.resolve();
  await first;
  await bad;
  await dh.handleCommand(cmd(2, "task", { goal: "g" }, { id: "T9" })); // the retry, same id
  assert.deepEqual(h.got, []);
});

test("review 3 (host side): the audit line for a running amend carries the text, clipped by code points", async () => {
  const audits = [];
  const { dh, go, run } = await runningTask({}, audits);
  await dh.handleCommand(frame("c1", "😀".repeat(700)));
  go.resolve();
  await run;
  const ran = audits.find((a) => a.op === "amend" && a.decision === "ran");
  assert.equal([...ran.text].length, 500);
});

test("review 6: a send that fails on a stale reader re-reads the session and retries once; cancel and amend skip a keyless reader", async () => {
  const posts = [];
  let fetched = 0;
  const sess = (ids) => ({ id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: { ids, open: false } } });
  const t = {
    async openSession() { return sess(["d", "ghost"]); },
    async fetchSession() { fetched += 1; return sess(["d"]); },
    async stopSession() {},
    async postCommand(p, readers) {
      posts.push({ op: sdk.decodeDeviceMessage(p).header.op, ids: readers.readerIds, lenient: readers.lenient });
      if (readers.readerIds.includes("ghost") && !readers.lenient) throw new sdk.DeviceLaneReaderError("lane reader ghost has no public key; not sending");
    },
  };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  await c.open();
  await c.amendTask("T1", "still goes"); // out of band: lenient, no refresh needed
  assert.deepEqual(posts[0], { op: "amend", ids: ["d", "ghost"], lenient: true });
  assert.equal(fetched, 0);
  // a content-bearing send fails on the ghost, the session is re-read, the retry uses the fresh ids
  c.settings().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetched, 1);
  assert.deepEqual(posts.slice(1).map((p) => p.ids), [["d", "ghost"], ["d"]]);
});

test("review 6 (http): lenient skips a keyless reader but never sends to nobody; strict still refuses", async () => {
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") return { status: 200, text: async () => JSON.stringify({ session: { users: [{ id: "d", public_key: "-----BEGIN PGP PUBLIC KEY BLOCK-----" }] } }) };
    return { status: 201, text: async () => "{}" };
  };
  const tr = sdk.httpDeviceAgentTransport({ host: "https://api.example.com", apiKey: "k", fetchImpl });
  await assert.rejects(tr.postCommand("hello", { chatId: "c", publicKeys: [], readerIds: ["d", "ghost"] }), (e) => e instanceof sdk.DeviceLaneReaderError);
  await assert.rejects(tr.postCommand("hello", { chatId: "c", publicKeys: [], readerIds: ["ghost"], lenient: true }), (e) => e instanceof sdk.DeviceLaneReaderError);
});

test("review 5/6: aborting open() while the POST is in flight rejects at once and withdraws the request when the POST returns", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const calls = [];
  const t = {
    async openSession() { await gate; return { id: "s1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "requested", delivered_at: null, chat: { id: "c", readers: { ids: ["1"], open: false } } }; },
    async stopSession(id) { calls.push(["stop", id]); },
    async withdrawSession(id) { calls.push(["withdraw", id]); },
    async postCommand() {},
  };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const ac = new AbortController();
  const p = c.open({ signal: ac.signal });
  await tick();
  ac.abort();
  await assert.rejects(p, /open aborted/); // before the POST has returned
  assert.deepEqual(calls, []);
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, [["withdraw", "s1"]]);
  assert.equal(c.session(), null);
});
