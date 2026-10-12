// client.teams (2026-10-12, share this group): list / mine / get / share /
// update / remove / installed against /api/v1/team_templates.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return respond(url, opts, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function setup(body = {}, status = 200) {
  const fetchImpl = recordingFetch(() => (status === 204 ? { ok: true, status, json: async () => undefined } : jsonResponse(status, body)));
  return { fetchImpl, client: sdk.createSaltClient({ host: "https://salt.test", fetchImpl }) };
}

test("teams.list sends q/limit/offset as a query string", async () => {
  const { fetchImpl, client } = setup({ teams: [], total: 0 });
  await client.teams.list("k", { q: "news desk", limit: 5, offset: 10 });
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/team_templates?q=news+desk&limit=5&offset=10");
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
});

test("teams.share posts snake_case fields", async () => {
  const { fetchImpl, client } = setup({ id: "t1", slug: "abc", left_out: 0 }, 201);
  const out = await client.teams.share("k", { groupId: "g1", name: "Desk", listed: true, coordinatorNote: "A hands to B." });
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/team_templates");
  assert.deepStrictEqual(fetchImpl.calls[0].body, { agent_group_id: "g1", name: "Desk", listed: true, coordinator_note: "A hands to B." });
  assert.strictEqual(out.slug, "abc");
});

test("teams.get, update, remove and installed hit the slug routes", async () => {
  const { fetchImpl, client } = setup({ install_count: 1, counted: true });
  await client.teams.get("k", "abc");
  await client.teams.update("k", "abc", { listed: false });
  await client.teams.installed("k", "abc");
  await client.teams.mine("k");
  assert.deepStrictEqual(
    fetchImpl.calls.map((c) => `${c.method} ${c.url.replace("https://salt.test", "")}`),
    ["GET /api/v1/team_templates/abc", "PATCH /api/v1/team_templates/abc", "POST /api/v1/team_templates/abc/installed", "GET /api/v1/team_templates/mine"]
  );
  const gone = setup({}, 204);
  await gone.client.teams.remove("k", "abc");
  assert.strictEqual(gone.fetchImpl.calls[0].method, "DELETE");
});
