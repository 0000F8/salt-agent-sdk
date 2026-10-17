// Ask for what's required (0.24.0): the refusal envelope on SaltApiError, requestGrant / checkGrant,
// onGrantDecided, and the X-Salt-Client header.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");
const pkg = require("../package.json");
const silent = { info() {}, error() {} };

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

const ENVELOPE = {
  error: "You need permission to post on your profile.",
  code: "missing_capability",
  grant: { capability: "profile.post", selector: {}, mode: "auto" },
  ask: { method: "POST", path: "/api/v1/mandates", body: { grantor_id: "owner-1", capabilities: [{ capability: "profile.post", selector: {}, mode: "auto" }], label: "Post on my profile", reason: null, expires_at: null } },
};

test("SDK_VERSION matches package.json and every request carries X-Salt-Client", async () => {
  assert.strictEqual(sdk.SDK_VERSION, pkg.version);
  const fetchImpl = recordingFetch(() => jsonResponse(200, { mandates: [] }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await client.mandates.list("k");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Client"], `salt-agent-sdk/${pkg.version}`);
});

test("a refusal with the envelope exposes err.grant and err.ask; one without leaves them undefined", async () => {
  const fetchImpl = recordingFetch((url, o, i) => (i === 0 ? jsonResponse(403, ENVELOPE) : jsonResponse(403, { error: "no", code: "forbidden" })));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await assert.rejects(client.mandates.list("k"), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.strictEqual(err.code, "missing_capability");
    assert.strictEqual(err.grant.capability, "profile.post");
    assert.strictEqual(err.ask.path, "/api/v1/mandates");
    assert.strictEqual(err.ask.body.grantor_id, "owner-1");
    return true;
  });
  await assert.rejects(client.mandates.list("k"), (err) => err.grant === undefined && err.ask === undefined);
});

test("requestGrant posts the proposal; checkGrant reads /mandates/check", async () => {
  const fetchImpl = recordingFetch((url) => (url.includes("/check") ? jsonResponse(200, { allowed: true, mandate_id: "m1", mode: "auto", constraints: {} }) : jsonResponse(201, { id: "m1" })));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const before = Date.now();
  await client.requestGrant("k", {
    grantorId: "owner-1",
    capabilities: ENVELOPE.ask.body.capabilities,
    reason: "I want to post my weekly update",
    durationDays: 7,
    estimatedCost: { amount: 20, currency: "USD", period: "month" },
    resumeToken: "rt-1",
    chatId: "chat-1",
  });
  const c = fetchImpl.calls[0];
  assert.strictEqual(c.method, "POST");
  assert.ok(c.url.endsWith("/api/v1/mandates"));
  assert.strictEqual(c.body.grantor_id, "owner-1");
  assert.strictEqual(c.body.reason, "I want to post my weekly update");
  assert.deepStrictEqual(c.body.estimated_cost, { amount: 20, currency: "USD", period: "month" });
  assert.strictEqual(c.body.resume_token, "rt-1");
  assert.strictEqual(c.body.chat_id, "chat-1");
  const exp = Date.parse(c.body.expires_at);
  assert.ok(exp >= before + 7 * 86_400_000 - 1000 && exp <= Date.now() + 7 * 86_400_000 + 1000);

  const check = await client.checkGrant("k", "wake.repeat");
  assert.strictEqual(fetchImpl.calls[1].method, "GET");
  assert.ok(fetchImpl.calls[1].url.endsWith("/api/v1/mandates/check?capability=wake.repeat"));
  assert.strictEqual(check.allowed, true);
});

function agentStore() {
  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  return { get: (id) => (String(id) === "agent-1" ? agent : undefined), all: () => [agent], register() {}, reassignId() {} };
}

test("onGrantDecided fires on mandate_activated (approved) and approval_decided (approved or declined) with resumeToken", async () => {
  const seen = [];
  const dispatcher = sdk.createDispatcher({
    client: { trackEvent() {} },
    identities: agentStore(),
    pgpPassphrase: "x",
    logger: silent,
    onGrantDecided: async (ctx) => seen.push(ctx),
  });
  const mandate = {
    id: "m1", kind: "governance", status: "active",
    grantor: { id: "owner-1", username: "dan", display_name: "Dan", account_type: "User" },
    grantee: { id: "agent-1", username: "helper", display_name: "Helper", account_type: "Agent" },
    capabilities: [{ id: "c1", capability: "profile.post", selector: {}, mode: "auto", constraints: {} }],
    version: 1,
  };
  await dispatcher.dispatch({ type: "mandate_activated", mandate, reason: "weekly update", resume_token: "rt-1" }, "agent-1");
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].approved, true);
  assert.strictEqual(seen[0].resumeToken, "rt-1");
  assert.deepStrictEqual(seen[0].capabilities, ["profile.post"]);
  assert.strictEqual(seen[0].reason, "weekly update");

  const exercise = { id: 5, mandate_id: "m1", capability: "agent.spending", action: "ask", decision: "denied", summary: {}, actor: { id: "agent-1", username: "helper", display_name: "H", account_type: "Agent" }, principal: { id: "owner-1", username: "dan" }, created_at: "x" };
  await dispatcher.dispatch({ type: "approval_decided", exercise, resume_token: "rt-2", capabilities: [{ capability: "agent.spending" }] }, "agent-1");
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[1].approved, false);
  assert.strictEqual(seen[1].resumeToken, "rt-2");
  assert.deepStrictEqual(seen[1].capabilities, ["agent.spending"]);

  // The owner's side of the same mandate_activated is not a decision on its own ask.
  await dispatcher.dispatch({ type: "mandate_activated", mandate: { ...mandate, grantee: mandate.grantor } }, "agent-1");
  assert.strictEqual(seen.length, 2);
});
