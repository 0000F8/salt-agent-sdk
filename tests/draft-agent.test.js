// client.draftAgent (salt-api POST /api/v1/agents/draft, AGENT_MAKER_CONTRACT.md section 1): one line in, the whole
// draft back; a step rewrites only its own fields. Same recordingFetch / createSaltClient style as the others.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, body: opts?.body });
    return respond(url, opts, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const DRAFT = {
  idea: "Daily sci-fi stories that build their own world",
  name: "Driftlight",
  handle: "driftlight",
  bio: "A new chapter from the Driftlight worlds, every morning.",
  brief: "You are Driftlight, ...",
  assumptions: [{ about: "When", choice: "One chapter every morning at 8:00, your time" }],
  voice: "Warm and a little wry.",
  first_message: "Hello. Chapter one is on its way.",
  skills: {
    recommended: [{ key: "reminders", why: "Your brief: a chapter every morning at 8:00" }],
    optional: [{ key: "money", why: "Always your call, never set for you" }],
  },
  services: [{ provider: "runway", recommended: false, why: "Could make a cover image for each chapter" }],
  budget_per_day: 20,
  actions_estimate: "about 3: write, post, send to you",
};

test("draftAgent POSTs /api/v1/agents/draft with the params and returns the unwrapped draft", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { draft: DRAFT }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const draft = await client.draftAgent("k", { idea: DRAFT.idea, step: "brief" });

  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/agents/draft");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "k");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { idea: DRAFT.idea, step: "brief" });
  assert.deepStrictEqual(draft, DRAFT);
});

test("draftAgent passes the edited draft and the nudge for a later step", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { draft: DRAFT }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await client.draftAgent("k", { step: "personality", draft: DRAFT, nudge: "More playful" });

  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { step: "personality", draft: DRAFT, nudge: "More playful" });
});

test("a failed draft rejects with SaltApiError carrying the code and the sentence", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(502, { error: "Couldn't write it just now. Try again.", code: "draft_failed" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(client.draftAgent("k", { idea: "x", step: "brief" }), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.strictEqual(err.status, 502);
    assert.strictEqual(err.code, "draft_failed");
    assert.ok(err.message.endsWith("Couldn't write it just now. Try again."));
    return true;
  });
});

test("draftAgent goes through actFor too", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { draft: DRAFT }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await client.actFor("principal-1").draftAgent("k", { idea: "x", step: "brief" });
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], "principal-1");
});
