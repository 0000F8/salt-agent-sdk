// Salt 0.244.0: getReadiness, getPlanSummary, pauseAll, resumeAll, accept with firstPostWords.
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

test("getReadiness reads the caller, a person, or a plan's grantor", async () => {
  const body = { person_id: "p1", wallets: 1, shop: false, connections: [{ service: "notion", name: "Notion" }], followers: 3, contacts: 2, email_subscribers: 0 };
  const { fetchImpl, client } = make(() => jsonResponse(200, body));
  const r = await client.getReadiness("k");
  assert.deepStrictEqual(r.connections, [{ service: "notion", name: "Notion" }]);
  await client.getReadiness("k", { personId: "p1" });
  await client.getReadiness("k", { planId: "m1" });
  assert.equal(fetchImpl.calls[0].method, "GET");
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/me\/readiness$/);
  assert.match(fetchImpl.calls[1].url, /\/api\/v1\/me\/readiness\?person_id=p1$/);
  assert.match(fetchImpl.calls[2].url, /\/api\/v1\/me\/readiness\?plan_id=m1$/);
});

test("getReadiness 404 is a typed error", async () => {
  const { client } = make(() => jsonResponse(404, { error: "Not found." }));
  await assert.rejects(client.getReadiness("k", { personId: "x" }), (err) => err instanceof sdk.SaltApiError && err.status === 404);
});

test("getPlanSummary GETs the summary", async () => {
  const body = { mandate_id: "m1", status: "active", first_check_in_at: "2026-10-21T10:00:00Z", targets: [{ metric: "followers", actual: null, measured_by: "agent" }], exercises: { count: 0, recent: [] } };
  const { fetchImpl, client } = make(() => jsonResponse(200, body));
  const s = await client.getPlanSummary("k", "m1");
  assert.equal(s.first_check_in_at, "2026-10-21T10:00:00Z");
  assert.equal(s.targets[0].measured_by, "agent");
  assert.equal(fetchImpl.calls[0].method, "GET");
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/mandates\/m1\/summary$/);
});

test("pauseAll and resumeAll send goal_id only when given", async () => {
  const { fetchImpl, client } = make((url) =>
    jsonResponse(200, url.endsWith("pause_all") ? { status: "paused", paused: ["m1"], already_paused: [], count: 1 } : { status: "active", resumed: ["m1"], still_paused: [] }));
  const p = await client.pauseAll("k");
  assert.equal(p.count, 1);
  await client.pauseAll("k", { goalId: "m1" });
  const r = await client.resumeAll("k", { goalId: "m1" });
  assert.deepStrictEqual(r.resumed, ["m1"]);
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/mandates\/pause_all$/);
  assert.equal(fetchImpl.calls[0].body, undefined);
  assert.deepStrictEqual(fetchImpl.calls[1].body, { goal_id: "m1" });
  assert.match(fetchImpl.calls[2].url, /\/api\/v1\/mandates\/resume_all$/);
  assert.deepStrictEqual(fetchImpl.calls[2].body, { goal_id: "m1" });
});

test("resumeAll by a grantee surfaces resume_grantor_only", async () => {
  const { client } = make(() => jsonResponse(403, { code: "resume_grantor_only", error: "Tap Resume on the plan to start it again." }));
  await assert.rejects(client.resumeAll("k"), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.equal(err.status, 403);
    assert.equal(err.code, "resume_grantor_only");
    assert.match(err.message, /Tap Resume/);
    return true;
  });
});

test("mandates.accept sends version and first_post_words, and none by default", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(200, { id: "m1", first_post_result: { exercise_id: 7, message_id: "x", chat_id: "c" } }));
  await client.mandates.accept("k", "m1");
  const m = await client.mandates.accept("k", "m1", { version: 2, firstPostWords: "Hello" });
  assert.equal(fetchImpl.calls[0].body, undefined);
  assert.deepStrictEqual(fetchImpl.calls[1].body, { version: 2, first_post_words: "Hello" });
  assert.match(fetchImpl.calls[1].url, /\/api\/v1\/mandates\/m1\/accept$/);
  assert.equal(m.first_post_result.chat_id, "c");
});

test("words_required is a typed 422", async () => {
  const { client } = make(() => jsonResponse(422, { code: "words_required", error: "Open the card to see the words first." }));
  await assert.rejects(client.mandates.accept("k", "m1"), (err) => err.status === 422 && err.code === "words_required");
});
