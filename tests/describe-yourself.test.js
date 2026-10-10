// describe_yourself (Salt asks an agent to write its own public description):
// dispatched like the other per-recipient plaintext events; ctx.write PATCHes
// the agent's own bio by its own api-key, trimmed to the server's max.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");
const silent = { info() {}, error() {} };
const agent = { saltAppId: "agent-1", username: "helper", apiKey: "agent-key", publicKey: "x", privateKey: "y" };
const store = (ids) => ({ get: (id) => ids.find((i) => i.saltAppId === String(id)), all: () => ids, register() {}, reassignId() {} });
const body = (over = {}) => ({
  type: "describe_yourself",
  reason: "created",
  agent: { id: "agent-1", username: "helper", display_name: "Helper", category: "writing" },
  owner_description: "Helps with writing",
  current_description: null,
  capabilities: [],
  guidance: "Write how you'd describe yourself",
  max_length: 300,
  ...over,
});

test("describe_yourself reaches onDescribeYourself and ctx.write sets bio with the agent's own key", async () => {
  const calls = [];
  const client = { async setIdentity(apiKey, claims) { calls.push({ apiKey, claims }); return {}; }, trackEvent() {} };
  const d = sdk.createDispatcher({
    client, identities: store([agent]), pgpPassphrase: "x", logger: silent,
    onDescribeYourself: async (ctx) => {
      assert.strictEqual(ctx.ownerDescription, "Helps with writing");
      assert.strictEqual(ctx.currentDescription, null);
      assert.strictEqual(ctx.maxLength, 300);
      await ctx.write("  I help   teams write\nclearly. " + "x".repeat(400));
    },
  });
  await d.dispatch(body(), "agent-1");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].apiKey, "agent-key");
  assert.ok(calls[0].claims.bio.length <= 300);
  assert.ok(calls[0].claims.bio.startsWith("I help teams write clearly."));
});

test("with no handler the event is a no-op, and an unknown identity is dropped", async () => {
  const client = { async setIdentity() { throw new Error("must not be called"); }, trackEvent() {} };
  await sdk.createDispatcher({ client, identities: store([agent]), pgpPassphrase: "x", logger: silent }).dispatch(body(), "agent-1");
  let called = false;
  await sdk.createDispatcher({ client, identities: store([]), pgpPassphrase: "x", logger: silent, onDescribeYourself: () => { called = true; } })
    .dispatch(body(), "nobody");
  assert.strictEqual(called, false);
});

test("a handler that throws is logged, not raised", async () => {
  const errs = [];
  const d = sdk.createDispatcher({ client: { trackEvent() {} }, identities: store([agent]), pgpPassphrase: "x",
    logger: { info() {}, error: (m) => errs.push(m) }, onDescribeYourself: () => { throw new Error("boom"); } });
  await d.dispatch(body(), "agent-1");
  assert.match(errs[0], /onDescribeYourself failed: boom/);
});
