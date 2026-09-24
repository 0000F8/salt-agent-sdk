// Mandates R2 rail events (webhook.ts): mandate_offered / mandate_activated /
// mandate_paused / mandate_revoked / approval_requested / approval_decided.
// Same shape as card_interaction/invoice_paid -- a per-recipient plaintext
// event whose recipient this SDK resolves primarily off X-Salt-Agent-Id
// (verifyEnvelope already proved the signature against that identity's own
// key). Dispatched directly here (bypassing HTTP/HMAC, like
// delivered-because.test.js does for the open-room path) since none of this
// needs PGP at all -- these events carry the mandate/exercise JSON verbatim,
// never ciphertext.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");
const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };

function identityStore(identities) {
  const byId = new Map(identities.map((i) => [String(i.saltAppId).toLowerCase(), i]));
  return {
    get: (id) => byId.get(String(id).toLowerCase()),
    all: () => Array.from(byId.values()),
    register(identity) {
      byId.set(String(identity.saltAppId).toLowerCase(), identity);
    },
    reassignId: () => undefined,
  };
}

function baseMandate(overrides = {}) {
  return {
    id: "mandate-1",
    kind: "explicit",
    status: "proposed",
    label: "Reply to messages",
    grantor: { id: "owner-1", username: "dan", display_name: "Dan", account_type: "User" },
    grantee: { id: "agent-1", username: "helper", display_name: "Helper", account_type: "Agent" },
    capabilities: [{ id: "cap-1", capability: "chat.send", selector: {}, mode: "auto", constraints: {} }],
    starts_at: "2026-09-23T00:00:00Z",
    standing: true,
    version: 1,
    ...overrides,
  };
}

function baseExercise(overrides = {}) {
  return {
    id: 42,
    mandate_id: "mandate-1",
    capability: "money.pay",
    action: "transfers#prepare",
    decision: "asked",
    summary: { amount: "5.00", currency: "ETH" },
    actor: { id: "agent-1", username: "helper", display_name: "Helper", account_type: "Agent" },
    principal: { id: "owner-1", username: "dan" },
    created_at: "2026-09-23T00:00:00Z",
    ...overrides,
  };
}

test("mandate_offered reaches onMandateOffered for the grantee (by X-Salt-Agent-Id), and ctx.accept() calls mandates.accept with that identity's own key", async () => {
  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  const acceptCalls = [];
  const client = {
    mandates: {
      async accept(apiKey, mandateId) {
        acceptCalls.push({ apiKey, mandateId });
        return { ...baseMandate(), status: "active" };
      },
    },
    trackEvent() {},
  };
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: silent,
    onMandateOffered: async (ctx) => {
      assert.strictEqual(ctx.identity.saltAppId, "agent-1");
      assert.strictEqual(ctx.mandate.id, "mandate-1");
      const accepted = await ctx.accept();
      assert.strictEqual(accepted.status, "active");
    },
  });

  await dispatcher.dispatch({ type: "mandate_offered", mandate: baseMandate() }, "agent-1");
  assert.deepStrictEqual(acceptCalls, [{ apiKey: "agent-key", mandateId: "mandate-1" }]);
});

test("mandate_offered without a matching hosted identity is dropped silently (no onMandateOffered call)", async () => {
  const client = { trackEvent() {} };
  let called = false;
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([]),
    pgpPassphrase: "x",
    logger: silent,
    onMandateOffered: async () => {
      called = true;
    },
  });
  await dispatcher.dispatch({ type: "mandate_offered", mandate: baseMandate() }, "someone-else");
  assert.strictEqual(called, false);
});

test("mandate_activated / mandate_paused / mandate_revoked reach their own callbacks with {identity, mandate}", async () => {
  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  const client = { trackEvent() {} };
  const seen = [];
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: silent,
    onMandateActivated: async (ctx) => seen.push(["activated", ctx.mandate.status]),
    onMandatePaused: async (ctx) => seen.push(["paused", ctx.mandate.pause_reason]),
    onMandateRevoked: async (ctx) => seen.push(["revoked", ctx.mandate.revoke_reason]),
  });

  await dispatcher.dispatch({ type: "mandate_activated", mandate: baseMandate({ status: "active" }) }, "agent-1");
  await dispatcher.dispatch({ type: "mandate_paused", mandate: baseMandate({ status: "paused", pause_reason: "key_changed" }) }, "agent-1");
  await dispatcher.dispatch({ type: "mandate_revoked", mandate: baseMandate({ status: "revoked", revoke_reason: "no longer needed" }) }, "agent-1");

  assert.deepStrictEqual(seen, [
    ["activated", "active"],
    ["paused", "key_changed"],
    ["revoked", "no longer needed"],
  ]);
});

test("approval_requested reaches the PRINCIPAL identity (when it's an agent), and ctx.decide() calls mandates.decide", async () => {
  const principalAgent = { saltAppId: "owner-1", username: "owner-bot", apiKey: "owner-key", publicKey: "x", privateKey: "y" };
  const decideCalls = [];
  const client = {
    mandates: {
      async decide(apiKey, exerciseId, decision, note) {
        decideCalls.push({ apiKey, exerciseId, decision, note });
        return { ...baseExercise(), decision: decision === "approve" ? "approved" : "denied" };
      },
    },
    trackEvent() {},
  };
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([principalAgent]),
    pgpPassphrase: "x",
    logger: silent,
    onApprovalRequested: async (ctx) => {
      assert.strictEqual(ctx.identity.saltAppId, "owner-1");
      assert.strictEqual(ctx.exercise.id, 42);
      const decided = await ctx.decide("approve", "auto-approved by policy");
      assert.strictEqual(decided.decision, "approved");
    },
  });

  await dispatcher.dispatch({ type: "approval_requested", exercise: baseExercise() }, "owner-1");
  assert.deepStrictEqual(decideCalls, [{ apiKey: "owner-key", exerciseId: 42, decision: "approve", note: "auto-approved by policy" }]);
});

test("approval_decided reaches the DELEGATE (actor) identity, informational only -- no decide() on this ctx", async () => {
  const delegateAgent = { saltAppId: "agent-1", username: "helper", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  const client = { trackEvent() {} };
  let seen;
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([delegateAgent]),
    pgpPassphrase: "x",
    logger: silent,
    onApprovalDecided: async (ctx) => {
      seen = ctx;
    },
  });

  await dispatcher.dispatch({ type: "approval_decided", exercise: baseExercise({ decision: "approved", decided_at: "2026-09-23T01:00:00Z" }) }, "agent-1");
  assert.strictEqual(seen.identity.saltAppId, "agent-1");
  assert.strictEqual(seen.exercise.decision, "approved");
  assert.strictEqual(typeof seen.decide, "undefined");
});

test("identity resolution falls back to the payload's own party ids when no X-Salt-Agent-Id is given", async () => {
  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  const client = { trackEvent() {} };
  let called = false;
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: silent,
    onMandateOffered: async (ctx) => {
      called = true;
      assert.strictEqual(ctx.identity.saltAppId, "agent-1");
    },
  });
  await dispatcher.dispatch({ type: "mandate_offered", mandate: baseMandate() }); // no headerAgentId
  assert.strictEqual(called, true);
});

test("a handler failure is caught and logged, never thrown out of dispatch", async () => {
  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
  const client = { trackEvent() {} };
  const errors = [];
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: { info() {}, error: (msg) => errors.push(msg) },
    onMandateActivated: async () => {
      throw new Error("boom");
    },
  });
  await dispatcher.dispatch({ type: "mandate_activated", mandate: baseMandate({ status: "active" }) }, "agent-1");
  assert.ok(errors.some((m) => m.includes("onMandateActivated failed") && m.includes("boom")));
});
