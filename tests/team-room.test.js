// Team helpers (TEAM_MAKER_CONTRACT.md): draft a whole team, set the lead and roles, open the room, and read
// your own teams as an agent. Same recordingFetch / createSaltClient style as the other client tests.
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

const MEMBERS = [
  { id: "a1", handle: "mara", display_name: "Mara", role: "Showrunner", lead: true },
  { id: "a2", handle: "quill", display_name: "Quill", role: "Writer", lead: false },
];
const GROUP = { id: "g1", name: "Writers' room", member_ids: ["a1", "a2"], lead_agent_id: "a1", room_chat_id: null, members: MEMBERS };

const DRAFT = {
  idea: "A writers' room for my sci-fi world",
  team_name: "Driftlight room",
  description: "Writes and keeps the Driftlight world.",
  how_they_work: "Mara decides; the others answer her.",
  lead_index: 0,
  members: [
    { role: "Showrunner", name: "Mara", handle: "mara", bio: "Runs the room.", brief: "You are Mara...", why: "Someone must decide." },
    { role: "Writer", name: "Quill", handle: "quill", bio: "Writes chapters.", brief: "You are Quill...", why: "The prose." },
  ],
  totals: { actions_per_day: null, model_budget_usd: null, budget_basis: "" },
};

test("draftTeam POSTs /api/v1/teams/draft and returns the unwrapped draft", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { draft: DRAFT }));
  const draft = await client.draftTeam("k", { idea: DRAFT.idea, step: "team" });
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/teams/draft");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "k");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { idea: DRAFT.idea, step: "team" });
  assert.deepStrictEqual(draft, DRAFT);
});

test("draftTeam passes the edited draft and nudge on a later step", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { draft: DRAFT }));
  await client.draftTeam("k", { step: "personality", draft: DRAFT, nudge: "More playful" });
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { step: "personality", draft: DRAFT, nudge: "More playful" });
});

test("a failed team draft rejects with SaltApiError carrying the code", async () => {
  const { client } = clientWith(() => jsonResponse(502, { error: "Couldn't write it just now. Try again.", code: "draft_failed" }));
  await assert.rejects(client.draftTeam("k", { idea: "x", step: "team" }), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.strictEqual(err.status, 502);
    assert.strictEqual(err.code, "draft_failed");
    return true;
  });
});

test("setTeamLead PATCHes the group with lead_agent_id, and null clears it", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, GROUP));
  const group = await client.setTeamLead("k", "g1", "a1");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/agent_groups/g1");
  assert.strictEqual(fetchImpl.calls[0].method, "PATCH");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { lead_agent_id: "a1" });
  assert.strictEqual(group.members[0].lead, true);

  await client.setTeamLead("k", "g1", null);
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[1].body), { lead_agent_id: null });
});

test("setTeamLead: a non-member lead rejects with the server's sentence", async () => {
  const { client } = clientWith(() => jsonResponse(422, { error: "The lead must be one of the team's members." }));
  await assert.rejects(client.setTeamLead("k", "g1", "zz"), (err) => err instanceof sdk.SaltApiError && err.status === 422);
});

test("setMemberRole PATCHes the membership with the role", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, GROUP));
  await client.setMemberRole("k", "g1", "a2", "Writer");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/agent_groups/g1/members/a2");
  assert.strictEqual(fetchImpl.calls[0].method, "PATCH");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { role: "Writer" });
});

test("openTeamRoom POSTs .../room and returns the chat id", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(201, { room_chat_id: "c9", created: true }));
  assert.deepStrictEqual(await client.openTeamRoom("k", "g1"), { room_chat_id: "c9", created: true });
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/agent_groups/g1/room");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
});

test("myTeams GETs /api/v1/agent/teams and unwraps the list", async () => {
  const teams = [{ id: "g1", name: "Writers' room", lead_agent_id: "a1", room_chat_id: "c9", owner_id: "u1", members: MEMBERS }];
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { teams }));
  assert.deepStrictEqual(await client.myTeams("agent-key"), teams);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/agent/teams");
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "agent-key");
});

test("the team helpers go through actFor too", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, GROUP));
  await client.actFor("principal-1").setMemberRole("k", "g1", "a2", "Writer");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], "principal-1");
});

test("draftTeam on the authority step returns member budgets and the team totals", async () => {
  const filled = {
    ...DRAFT,
    members: DRAFT.members.map((m) => ({ ...m, budget_per_day: 10, actions_estimate: "about 3", model_budget_usd: "10", budget_basis: "About 3 actions a day" })),
    totals: { actions_per_day: 20, model_budget_usd: "20", budget_basis: "About 20 actions a day across the team" },
  };
  const { client } = clientWith(() => jsonResponse(200, { draft: filled }));
  const draft = await client.draftTeam("k", { step: "authority", draft: DRAFT });
  assert.strictEqual(draft.totals.model_budget_usd, "20");
  assert.strictEqual(draft.members[0].model_budget_usd, "10");
});

test("setMemberRole with null clears the role", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, GROUP));
  await client.setMemberRole("k", "g1", "a2", null);
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { role: null });
});
