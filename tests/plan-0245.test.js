// Salt 0.245.0: giveGoal, getGoalRequest, putWorking, decideWorking, GoalPlanError.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return respond(url, opts, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}
function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k] }, json: async () => body, text: async () => JSON.stringify(body) };
}
const make = (respond) => {
  const fetchImpl = recordingFetch(respond);
  return { fetchImpl, client: sdk.createSaltClient({ host: "https://salt.test", fetchImpl }) };
};

test("giveGoal posts the goal, optional fields and the Idempotency-Key", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(201, { id: "g1", status: "waiting", next: "Salt is making a plan." }));
  const r = await client.giveGoal("k", { goal: "Sell 10 prints", deadline: "2026-12-31", chatId: "c1", idempotencyKey: "idem-1" });
  assert.equal(r.status, "waiting");
  const c = fetchImpl.calls[0];
  assert.equal(c.method, "POST");
  assert.match(c.url, /\/api\/v1\/goals$/);
  assert.deepStrictEqual(c.body, { goal: "Sell 10 prints", deadline: "2026-12-31", chat_id: "c1" });
  assert.equal(c.headers["Idempotency-Key"], "idem-1");
  await client.giveGoal("k", { goal: "Just this" });
  assert.deepStrictEqual(fetchImpl.calls[1].body, { goal: "Just this" });
  assert.equal(fetchImpl.calls[1].headers["Idempotency-Key"], undefined);
});

test("giveGoal limits are typed errors with Retry-After", async () => {
  const { client } = make(() => jsonResponse(429, { error: "You already have 5 goals waiting for a plan. Wait for a plan, or for one to expire.", code: "too_many_waiting" }, { "Retry-After": "60" }));
  await assert.rejects(client.giveGoal("k", { goal: "x" }), (err) => err instanceof sdk.SaltApiError && err.status === 429 && err.code === "too_many_waiting" && err.retryAfterSeconds === 60);
});

test("getGoalRequest reads one request", async () => {
  const body = { id: "g1", status: "planned", goal: "Sell", deadline: null, mandate_id: "m9", created_at: "2026-10-20T10:00:00Z" };
  const { fetchImpl, client } = make(() => jsonResponse(200, body));
  const r = await client.getGoalRequest("k", "g1");
  assert.equal(r.mandate_id, "m9");
  assert.equal(fetchImpl.calls[0].method, "GET");
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/goals\/g1$/);
});

test("getGoalRequest by another person is a 404", async () => {
  const { client } = make(() => jsonResponse(404, { error: "Not found." }));
  await assert.rejects(client.getGoalRequest("k", "g1"), (err) => err instanceof sdk.SaltApiError && err.status === 404);
});

test("putWorking sends the three lists, filling the missing ones", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(200, { mandate_id: "m1", working: { testing: [], kept: [], dropped: [] }, working_at: "2026-10-20T10:00:00Z" }));
  const testing = [{ id: "t1", text: "Post at 9", since: "2026-10-19", trials: 3 }];
  await client.putWorking("k", "m1", { testing });
  const c = fetchImpl.calls[0];
  assert.equal(c.method, "PUT");
  assert.match(c.url, /\/api\/v1\/mandates\/m1\/working$/);
  assert.deepStrictEqual(c.body, { testing, kept: [], dropped: [] });
});

test("putWorking by anyone but the agent is a 403 with the code", async () => {
  const { client } = make(() => jsonResponse(403, { error: "Only the agent running this plan publishes what's working.", code: "working_grantee_only" }));
  await assert.rejects(client.putWorking("k", "m1", {}), (err) => err.status === 403 && err.code === "working_grantee_only");
});

test("decideWorking sends the entry id in the body", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(200, { mandate_id: "m1", id: "k1", decision: "keep", working: { testing: [], kept: [], dropped: [] } }));
  const r = await client.decideWorking("k", "m1", "k1", "keep");
  assert.equal(r.decision, "keep");
  const c = fetchImpl.calls[0];
  assert.equal(c.method, "POST");
  assert.match(c.url, /\/api\/v1\/mandates\/m1\/working\/decide$/);
  assert.deepStrictEqual(c.body, { id: "k1", decision: "keep" });
});

test("decideWorking on a missing entry is 422 entry_not_found", async () => {
  const { client } = make(() => jsonResponse(422, { error: "That entry isn't in what's working.", code: "entry_not_found" }));
  await assert.rejects(client.decideWorking("k", "m1", "zz", "never"), (err) => err.status === 422 && err.code === "entry_not_found");
});

test("no_capability, first_post_needs_post and source_unavailable throw GoalPlanError with sentence and next", async () => {
  const cases = [
    ["no_capability", "This plan can't post or message: you approved it yourself, so it holds no permissions.", "To have Salt run it, give Salt the goal: POST /api/v1/goals."],
    ["first_post_needs_post", "A first post needs permission to post on their profile in the plan.", undefined],
    ["source_unavailable", "They have no wallet to receive payments, so Salt can't count payments for this plan. Use a count they report.", undefined],
  ];
  for (const [code, error, next] of cases) {
    const { client } = make(() => jsonResponse(422, { error, code, ...(next ? { next } : {}) }));
    await assert.rejects(client.mandates.propose("k", { grantee_id: "a", capabilities: [] }), (err) => {
      assert.ok(err instanceof sdk.GoalPlanError);
      assert.ok(err instanceof sdk.SaltApiError);
      assert.equal(err.code, code);
      assert.equal(err.sentence, error);
      assert.equal(err.next, next);
      return true;
    });
  }
});

test("a plan read carries runner, note, working and the summary's new fields as types", async () => {
  const m = { id: "m1", runner: "self", note: "You approved this plan yourself, so your own runtime runs it.", working: null, working_at: null };
  const { client } = make(() => jsonResponse(200, m));
  const got = await client.getPlanSummary("k", "m1");
  assert.equal(got.runner, "self");
});

test("dropPlanSteps patches strategy.drop_steps with the version", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(200, { id: "m1", version: 5 }));
  await client.dropPlanSteps("k", "m1", { version: 4, steps: [1, 3] });
  const c = fetchImpl.calls[0];
  assert.equal(c.method, "PATCH");
  assert.match(c.url, /\/api\/v1\/mandates\/m1$/);
  assert.deepStrictEqual(c.body, { version: 4, strategy: { drop_steps: [1, 3] } });
});

test("dropPlanSteps refusals keep their code: plan_locked, invalid_strategy, strategy_not_editable", async () => {
  for (const [status, code] of [[422, "plan_locked"], [422, "invalid_strategy"], [422, "strategy_not_editable"]]) {
    const { client } = make(() => jsonResponse(status, { error: "No.", code }));
    await assert.rejects(client.dropPlanSteps("k", "m1", { version: 1, steps: [0] }), (err) => err instanceof sdk.SaltApiError && err.code === code);
  }
});

test("getStrategyLimits reads the public limits without a key", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(200, { live_tunable: ["explore", "goal_kind", "pace"], live_narrowable: ["drop_steps"], lock_values: ["pace", "explore", "goal_kind", "drop_steps", "all"] }));
  const r = await client.getStrategyLimits();
  assert.deepStrictEqual(r.live_narrowable, ["drop_steps"]);
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/strategies\/limits$/);
  assert.equal(fetchImpl.calls[0].headers["api-key"], undefined);
});
