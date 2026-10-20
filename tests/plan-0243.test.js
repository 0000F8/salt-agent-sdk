// Let @salt run your plan (Salt 0.243.0): tunePlan, lockPlan, undoTuning, reportCount, requestAsk as "grantor",
// readPlanReport (decrypts the latest `strategy` work report from the private lane), strategy_tuned by/before.
const test = require("node:test");
const assert = require("node:assert");
const openpgp = require("openpgp");

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

test("tunePlan PATCHes snake_case strategy keys with the version", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(200, { id: "m1", version: 4, locks: [] }));
  const m = await client.tunePlan("k", "m1", { version: 3, pace: "careful", explore: 0.3, goalKind: "growth" });
  assert.equal(m.version, 4);
  const c = fetchImpl.calls[0];
  assert.equal(c.method, "PATCH");
  assert.match(c.url, /\/api\/v1\/mandates\/m1$/);
  assert.deepStrictEqual(c.body, { version: 3, strategy: { pace: "careful", explore: 0.3, goal_kind: "growth" } });
});

test("a locked key is a typed error with code plan_locked and the locked keys", async () => {
  const { client } = make(() => jsonResponse(422, { error: "You asked to keep this plan as is.", code: "plan_locked", locked: ["pace"] }));
  await assert.rejects(client.tunePlan("k", "m1", { version: 3, pace: "aggressive" }), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.equal(err.status, 422);
    assert.equal(err.code, "plan_locked");
    assert.deepStrictEqual(err.body.locked, ["pace"]);
    assert.match(err.message, /keep this plan as is/);
    return true;
  });
});

test("lockPlan sends locks (keys, all, or none) and the version", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(200, { id: "m1", version: 5, locks: ["all"] }));
  const m = await client.lockPlan("k", "m1", { version: 4, locks: ["all"] });
  assert.deepStrictEqual(m.locks, ["all"]);
  await client.lockPlan("k", "m1", { version: 5, locks: [] });
  assert.deepStrictEqual(fetchImpl.calls.map((c) => c.body), [{ version: 4, locks: ["all"] }, { version: 5, locks: [] }]);
  assert.equal(fetchImpl.calls[0].method, "PATCH");
});

test("lockPlan by a non-grantor surfaces locks_grantor_only", async () => {
  const { client } = make(() => jsonResponse(403, { error: "Only they can do that.", code: "locks_grantor_only" }));
  await assert.rejects(client.lockPlan("k", "m1", { version: 1, locks: ["pace"] }), (err) => err.code === "locks_grantor_only" && err.status === 403);
});

test("undoTuning POSTs to the tuning's undo route; superseded and already_undone are typed", async () => {
  const { fetchImpl, client } = make((url, opts, i) => (i === 0 ? jsonResponse(200, { id: "m1", version: 6 }) : jsonResponse(409, { error: "That was changed again since. Nothing was undone.", code: "tuning_superseded" })));
  await client.undoTuning("k", "m1", "t 1");
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/mandates\/m1\/tunings\/t%201\/undo$/);
  await assert.rejects(client.undoTuning("k", "m1", "t2"), (err) => err.code === "tuning_superseded" && err.status === 409);
});

test("reportCount posts metric_key, value and an optional note", async () => {
  const stored = { id: "rc1", mandate_id: "m1", metric_key: "shop_sales", value: 7, note: "Saturday market", reported_at: "2026-10-20T10:00:00Z", reported_by: { id: "u1", username: "dana" } };
  const { fetchImpl, client } = make(() => jsonResponse(201, stored));
  const out = await client.reportCount("k", "m1", { metricKey: "shop_sales", value: 7, note: "Saturday market" });
  assert.deepStrictEqual(out, stored);
  assert.deepStrictEqual(fetchImpl.calls[0].body, { metric_key: "shop_sales", value: 7, note: "Saturday market" });
  assert.match(fetchImpl.calls[0].url, /\/mandates\/m1\/reported_counts$/);
  await client.reportCount("k", "m1", { metricKey: "shop_sales", value: 0 });
  assert.deepStrictEqual(fetchImpl.calls[1].body, { metric_key: "shop_sales", value: 0 });
});

test("reportCount refusals keep their code", async () => {
  const { client } = make(() => jsonResponse(403, { error: "Only Dana reports counts for their plan.", code: "grantor_only" }));
  await assert.rejects(client.reportCount("k", "m1", { metricKey: "x", value: 1 }), (err) => err.code === "grantor_only");
});

test('requestAsk as "grantor" sends as and no where, and resolves with as', async () => {
  const { fetchImpl, client } = make(() => jsonResponse(202, { status: "asked", exercise_id: "ex-9", expires_at: "2026-10-21T00:00:00Z", as: "grantor" }));
  const res = await client.requestAsk("k", "m1", { capability: "profile.post", words: "We open Saturday.", about: undefined, as: "grantor", idempotencyKey: "i1" });
  assert.deepStrictEqual(res, { asked: true, exerciseId: "ex-9", expiresAt: "2026-10-21T00:00:00Z", as: "grantor" });
  assert.deepStrictEqual(fetchImpl.calls[0].body, { capability: "profile.post", as: "grantor", words: "We open Saturday." });
  assert.equal(fetchImpl.calls[0].headers["Idempotency-Key"], "i1");
  await client.requestAsk("k", "m1", { capability: "room.create", words: "Garden club", about: "For the garden", as: "grantor" });
  assert.deepStrictEqual(fetchImpl.calls[1].body, { capability: "room.create", as: "grantor", words: "Garden club", about: "For the garden" });
});

test('requestAsk as "grantor" refuses replies, media, outreach, armor before the network; a plain ask still needs where', async () => {
  const { fetchImpl, client } = make(() => jsonResponse(202, { status: "asked", exercise_id: "e" }));
  await assert.rejects(client.requestAsk("k", "m1", { capability: "outreach.request", words: "hi", as: "grantor", recipientId: "u2" }), /profile\.post and room\.create only/);
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "hi", as: "grantor", kind: "reply" }), /no replies, media/);
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "hi", as: "grantor", mediaDigest: "ab" }), /no replies, media/);
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "hi", as: "agent" }), /can only be "grantor"/);
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "hi" }), /say where it goes/);
  assert.equal(fetchImpl.calls.length, 0);
  await client.requestAsk("k", "m1", { capability: "profile.post", words: "hi", where: "Your profile" });
  assert.equal(fetchImpl.calls[0].body.where, "Your profile");
  assert.equal("as" in fetchImpl.calls[0].body, false);
});

test("server refusals of an as-grantor ask keep their code", async () => {
  const { client } = make(() => jsonResponse(422, { error: "Replies need your own approval.", code: "as_post_only" }));
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "hi", as: "grantor" }), (err) => err.code === "as_post_only");
});

// --- readPlanReport ---------------------------------------------------------

async function keypair(name) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{ name }], passphrase: "pw", format: "armored" });
  return { privateKey, publicKey };
}
async function seal(text, ...publicKeys) {
  return openpgp.encrypt({ message: await openpgp.createMessage({ text }), encryptionKeys: await Promise.all(publicKeys.map((armoredKey) => openpgp.readKey({ armoredKey }))) });
}
const STRATEGY = (over = {}) => ({ strategy_id: "s1", mandate_id: "m1", goal: "Sell 20 jars", next_check_in: "2026-10-22T09:00:00Z", progress: [{ metric: "shop_sales", actual: 7, target: 20, unit: "jars", source_label: "Reported by Dana" }], ...over });
const report = (status, json, id = "s1") => `[[SALT-WORK id=${id} status=running kind=strategy]]\nRunning the plan\nstrategy: ${JSON.stringify({ status, ...json })}`;

function laneClient({ lane, messages, sidechainStatus = 200 }) {
  const calls = [];
  return {
    calls,
    async openSidechain(apiKey, chatId, withId) {
      calls.push(["openSidechain", chatId, withId]);
      if (sidechainStatus !== 200) throw new sdk.SaltApiError("POST", "/sidechain", sidechainStatus, { error: "This is already a private lane." });
      return { session: { id: lane } };
    },
    async getChatMessages(apiKey, chatId) {
      calls.push(["getChatMessages", chatId]);
      return messages;
    },
  };
}

test("parsePlanReport reads a strategy report and nothing else", () => {
  const r = sdk.parsePlanReport(report("attempting", STRATEGY()));
  assert.equal(r.id, "s1");
  assert.equal(r.status, "attempting");
  assert.equal(r.title, "Running the plan");
  assert.equal(r.strategy.goal, "Sell 20 jars");
  assert.equal(sdk.parsePlanReport("[[SALT-WORK id=w1 status=done kind=task]]\nx\nstrategy: {\"status\":\"succeeded\"}"), null);
  assert.equal(sdk.parsePlanReport("[[SALT-WORK id=s1 status=running kind=strategy]]\nx\nstrategy: {nope"), null);
  assert.equal(sdk.parsePlanReport("[[SALT-WORK id=s1 status=running kind=strategy]]\nx"), null);
  assert.equal(sdk.parsePlanReport("hello"), null);
});

test("readPlanReport opens the lane, decrypts with the agent's key and returns the newest strategy report", async () => {
  const agent = await keypair("agent");
  const person = await keypair("person");
  const other = await keypair("other");
  const messages = [
    { id: "a", message: await seal(report("attempting", STRATEGY({ goal: "old" })), agent.publicKey, person.publicKey), created_at: "2026-10-19T10:00:00Z" },
    { id: "b", message: await seal("just chatting", agent.publicKey), created_at: "2026-10-19T11:00:00Z" },
    { id: "c", message: await seal(report("attempting", STRATEGY({ goal: "newest" })), agent.publicKey, person.publicKey), created_at: "2026-10-20T10:00:00Z" },
    { id: "d", message: await seal(report("attempting", STRATEGY({ goal: "not mine" })), other.publicKey), created_at: "2026-10-20T11:00:00Z" },
    { id: "e", event_type: "joined", message: "x" },
  ];
  const client = laneClient({ lane: "lane-1", messages });
  const got = await sdk.readPlanReport(client, { apiKey: "k", privateKey: agent.privateKey }, "chat-1", { passphrase: "pw", requesterId: "u-person" });
  assert.deepStrictEqual(client.calls, [["openSidechain", "chat-1", "u-person"], ["getChatMessages", "lane-1"]]);
  assert.equal(got.strategy.goal, "newest");
  assert.equal(got.messageId, "c");
  assert.equal(got.createdAt, "2026-10-20T10:00:00Z");
  assert.equal(got.strategy.progress[0].actual, 7);
});

test("readPlanReport treats chatId as the lane when no requesterId, or when Salt says it already is one", async () => {
  const agent = await keypair("agent");
  const messages = [{ id: "a", message: await seal(report("blocked", STRATEGY()), agent.publicKey) }];
  const direct = laneClient({ lane: "unused", messages });
  assert.equal((await sdk.readPlanReport(direct, { apiKey: "k", privateKey: agent.privateKey }, "lane-9", { passphrase: "pw" })).status, "blocked");
  assert.deepStrictEqual(direct.calls, [["getChatMessages", "lane-9"]]);
  const already = laneClient({ lane: "x", messages, sidechainStatus: 422 });
  await sdk.readPlanReport(already, { apiKey: "k", privateKey: agent.privateKey }, "lane-9", { passphrase: "pw", requesterId: "u" });
  assert.deepStrictEqual(already.calls[1], ["getChatMessages", "lane-9"]);
});

test("readPlanReport filters by strategyId, reads open-room plaintext, and returns null when there is none", async () => {
  const agent = await keypair("agent");
  const messages = [
    { id: "a", message: await seal(report("attempting", STRATEGY({ strategy_id: "s1", goal: "one" })), agent.publicKey) },
    { id: "b", message: await seal(report("attempting", STRATEGY({ strategy_id: "s2", goal: "two" }), "s2"), agent.publicKey) },
  ];
  const id = { apiKey: "k", privateKey: agent.privateKey };
  assert.equal((await sdk.readPlanReport(laneClient({ lane: "l", messages }), id, "l", { passphrase: "pw", strategyId: "s1" })).strategy.goal, "one");
  assert.equal(await sdk.readPlanReport(laneClient({ lane: "l", messages }), id, "l", { passphrase: "pw", strategyId: "s3" }), null);
  const open = [{ id: "p", encrypted: false, message: report("succeeded", STRATEGY()) }];
  assert.equal((await sdk.readPlanReport(laneClient({ lane: "l", messages: open }), id, "l", { passphrase: "pw" })).status, "succeeded");
  assert.equal(await sdk.readPlanReport(laneClient({ lane: "l", messages: [] }), id, "l", { passphrase: "pw" }), null);
});

test("readPlanReport throws a sidechain failure that is not 'already a lane'", async () => {
  const agent = await keypair("agent");
  const client = laneClient({ lane: "l", messages: [], sidechainStatus: 403 });
  await assert.rejects(sdk.readPlanReport(client, { apiKey: "k", privateKey: agent.privateKey }, "c", { passphrase: "pw", requesterId: "u" }), (err) => err.status === 403);
});

// --- strategy_tuned carries who changed it ----------------------------------

test("onStrategyTuned exposes by, before and tuningId (absent on older Salt)", async () => {
  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  const identities = { get: () => agent, all: () => [agent], register() {}, reassignId: () => undefined };
  const seen = [];
  const dispatcher = sdk.createDispatcher({ client: { trackEvent() {} }, identities, pgpPassphrase: "x", logger: { info() {}, error() {} }, onStrategyTuned: (ctx) => void seen.push(ctx) });
  const base = { id: "mandate-1", type: "strategy_tuned", strategy_id: "s1", changes: { pace: "careful" }, strategy: { goal: "g" }, version: 7 };
  await dispatcher.dispatch({ ...base, by: "person", before: { pace: "balanced" }, tuning_id: "t9" }, "agent-1");
  await dispatcher.dispatch(base, "agent-1");
  assert.equal(seen[0].by, "person");
  assert.deepStrictEqual(seen[0].before, { pace: "balanced" });
  assert.equal(seen[0].tuningId, "t9");
  assert.equal(seen[1].by, undefined);
  assert.equal(seen[1].before, undefined);
  assert.equal(seen[1].tuningId, undefined);
});
