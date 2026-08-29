// Ids are opaque strings now, not integers. Nothing in this SDK checked that,
// which is how `parseInt(uuid)` -> NaN survived across every guard in it: NaN
// is unequal to everything and equal to nothing, so the checks did not fail,
// they INVERTED. These tests pin the behaviours that silently flipped.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sdk = require("../dist/index.js");

const UUID_A = "9f8b7c6d-1234-4abc-8def-000000000001";
const UUID_B = "9f8b7c6d-1234-4abc-8def-000000000002";

test("sameId matches the same id whatever its casing", () => {
  assert.equal(sdk.sameId(UUID_A, UUID_A.toUpperCase()), true);
  assert.equal(sdk.sameId(UUID_A, UUID_B), false);
});

// Deliberate: a missing id is not "the same as" another missing id. Both
// callers that can pass null here are asking "is this me?", and the answer
// when there is no id must be no, not yes.
test("sameId treats absent ids as never matching", () => {
  assert.equal(sdk.sameId(null, null), false);
  assert.equal(sdk.sameId(undefined, UUID_A), false);
  assert.equal(sdk.sameId(UUID_A, null), false);
});

test("sameId compares across types rather than coercing to a number", () => {
  assert.equal(sdk.sameId(3, "3"), true, "a legacy integer id must still match its string form");
  assert.equal(sdk.sameId(UUID_A, 0), false, "parseInt used to make this pair look equal");
});

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-ids-"));
  return path.join(dir, "identities.json");
}

const identity = (id) => ({
  saltAppId: id,
  username: "agent",
  apiKey: "k",
  publicKey: "pub",
  privateKey: "priv",
});

test("an identity is found by its uuid", () => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(UUID_A));
  assert.equal(store.get(UUID_A).saltAppId, UUID_A);
  assert.equal(store.get(UUID_B), undefined);
});

// Every typed-event handler resolves the acting identity through this lookup.
// It used to run the id through parseInt first, so all four -- card
// interaction, invoice paid, and both hand-off events -- missed every time.
test("an identity is found whatever the casing of the id looked up", () => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(UUID_A));
  assert.equal(store.get(UUID_A.toUpperCase()).saltAppId, UUID_A);
});

test("registering the same id twice does not create a second identity", () => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(UUID_A));
  store.register({ ...identity(UUID_A.toUpperCase()), username: "renamed" });
  assert.equal(store.all().length, 1);
  assert.equal(store.get(UUID_A).username, "renamed");
});

test("an identity survives a restart of the process", () => {
  const file = tempStore();
  sdk.createIdentityStore(file).register(identity(UUID_A));
  assert.equal(sdk.createIdentityStore(file).get(UUID_A).saltAppId, UUID_A);
});

// The reply an agent is waiting on. A false negative here does not error --
// it restarts the whole prompt cycle, so the agent answers its own question.
test("a delegation resolves for the agent it is waiting on", async () => {
  const waiting = sdk.register(UUID_A, UUID_B, 5000);
  assert.equal(sdk.hasPending(UUID_A), true);
  assert.equal(sdk.resolveIfPending(UUID_A, UUID_B, "the answer"), true);
  assert.equal(await waiting, "the answer");
});

test("a delegation does not resolve for a different sender", () => {
  const waiting = sdk.register(UUID_B, UUID_A, 5000);
  assert.equal(sdk.resolveIfPending(UUID_B, "someone-else", "wrong"), false);
  sdk.cancel(UUID_B);
  waiting.catch(() => {});
});

test("a delegation resolves whatever the casing of the ids", async () => {
  const chat = "aaaaaaaa-0000-4000-8000-00000000000f";
  const waiting = sdk.register(chat, UUID_A, 5000);
  assert.equal(sdk.resolveIfPending(chat.toUpperCase(), UUID_A.toUpperCase(), "ok"), true);
  assert.equal(await waiting, "ok");
});

test("config reads a uuid app id without mangling it", () => {
  const config = sdk.loadSaltAgentConfig({
    HOST: "https://example.test",
    SALT_API_KEY: "k",
    SALT_APP_ID: UUID_A,
    MEDIATOR_AGENT_ID: UUID_B,
    CONCIERGE_AGENT_ID: UUID_A,
  });
  assert.equal(config.saltAppId, UUID_A);
  assert.equal(config.mediatorAgentId, UUID_B);
  assert.equal(config.conciergeAgentId, UUID_A);
  assert.equal(config.globalAgentId, UUID_A, "the deprecated alias must resolve to the same agent");
});

// This check was `Number.isNaN(saltAppId)`, which can never be true of a
// string -- so the one value nothing else works without stopped being
// reported as missing.
test("config still reports a missing app id", () => {
  const missing = sdk.validateSaltAgentConfig(
    sdk.loadSaltAgentConfig({ HOST: "https://example.test", SALT_API_KEY: "k" })
  );
  assert.ok(missing.includes("SALT_APP_ID"));
});

// These schemas are handed to models as tool definitions, and re-exported by
// salt-mcp as MCP tool schemas. An id declared "integer" makes the call fail
// validation before it ever runs.
test("no tool schema declares an id as an integer", () => {
  const actions = sdk.createActions({ client: {}, pgp: {} });
  const offenders = [];
  for (const definition of actions.definitions) {
    for (const [name, spec] of Object.entries(definition.schema?.properties || {})) {
      if (!/(^id$|_id$)/.test(name)) continue;
      if (JSON.stringify(spec).includes('"integer"')) offenders.push(`${definition.name}.${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});
