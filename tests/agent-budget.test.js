// An agent's monthly model budget: the draft proposes it, the owner sets it (PUT admin_update, partial).
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

function clientWith(respond) {
  const fetchImpl = recordingFetch(respond);
  return { fetchImpl, client: sdk.createSaltClient({ host: "https://salt.test", fetchImpl }) };
}

test("draftAgent returns model_budget_usd and budget_basis on the draft", async () => {
  const draft = { idea: "x", name: "N", model_budget_usd: 12, budget_basis: "About three posts a day on a small model." };
  const { client } = clientWith(() => jsonResponse(200, { draft }));
  const result = await client.draftAgent("k", { idea: "x", step: "authority" });
  assert.strictEqual(result.model_budget_usd, 12);
  assert.strictEqual(result.budget_basis, "About three posts a day on a small model.");
});

test("setAgentBudget PUTs a partial update with model_budget_usd", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { id: "a1" }));
  await client.setAgentBudget("k", "a1", 25);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/agents/a1/admin_update");
  assert.strictEqual(fetchImpl.calls[0].method, "PUT");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "k");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { partial: true, model_budget_usd: 25 });

  await client.setAgentBudget("k", "a1", "7");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[1].body), { partial: true, model_budget_usd: "7" });
});

test("setAgentBudget: a refusal rejects with the server's sentence", async () => {
  const { client } = clientWith(() => jsonResponse(422, { error: "persona.model_budget_usd must be a number from 1 to 1000." }));
  await assert.rejects(client.setAgentBudget("k", "a1", 5000), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.strictEqual(err.status, 422);
    assert.ok(err.message.endsWith("from 1 to 1000."));
    return true;
  });
});

test("setAgentBudget goes through actFor too", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, {}));
  await client.actFor("principal-1").setAgentBudget("k", "a1", 10);
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], "principal-1");
});
