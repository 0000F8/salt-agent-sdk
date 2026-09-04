// Hosted identities are looked up by Salt id on every webhook, but the store
// held whatever id was current at registration. When salt-api moved to uuids
// the ids on disk stayed integers, every lookup missed, and every message to
// those agents was rejected as "no signing key" -- with health still green.
// These tests pin the repair: the stored id is a hint, the API is the truth.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");

const sdk = require("../dist/index.js");

// An integer id, exactly as create-concierge.js wrote it to the store.
const OLD_ID = 5;
const NEW_ID = "00000000-0000-0000-0000-000000000005";
const OTHER_OLD_ID = 3;
const OTHER_NEW_ID = "00000000-0000-0000-0000-000000000003";
const CURRENT_ID = "00000000-0000-0000-0000-000000000002";

const silent = { info() {}, error() {} };

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-reconcile-"));
  return path.join(dir, "identities.json");
}

const identity = (id, extra = {}) => ({
  saltAppId: id,
  username: `agent-${id}`,
  apiKey: `key-${id}`,
  publicKey: "pub",
  privateKey: "priv",
  ...extra,
});

// Stands in for salt-api: which agent does each api key belong to? An unknown
// key is rejected the way a revoked one is (401), not answered with a guess.
function fakeApi(agentByApiKey) {
  const calls = [];
  const whoAmI = async (apiKey) => {
    calls.push(apiKey);
    if (!(apiKey in agentByApiKey)) {
      throw new sdk.SaltApiError("GET", "/api/v1/agents/webhook_secret", 401, { error: "unauthorized" });
    }
    return { agent_id: agentByApiKey[apiKey], webhook_secret: `secret-${apiKey}` };
  };
  return {
    calls,
    whoAmI,
    getWebhookSecret: async (apiKey) => (await whoAmI(apiKey)).webhook_secret,
  };
}

test("reassignId moves an identity to its new id, and the move survives a restart", () => {
  const file = tempStore();
  const store = sdk.createIdentityStore(file);
  store.register(identity(OLD_ID));

  const moved = store.reassignId(OLD_ID, NEW_ID);
  assert.equal(moved.saltAppId, NEW_ID);
  assert.equal(store.get(NEW_ID).saltAppId, NEW_ID);
  assert.equal(store.get(OLD_ID), undefined);
  assert.equal(store.all().length, 1);
  assert.equal(store.get(NEW_ID).privateKey, "priv", "the key material rides along");

  assert.equal(sdk.createIdentityStore(file).get(NEW_ID).saltAppId, NEW_ID);
});

test("reassignId onto an id that is already registered leaves one identity, the registered one", () => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(NEW_ID, { username: "fresh-from-env" }));
  store.register(identity("5", { username: "stale-on-disk" }));

  const survivor = store.reassignId("5", NEW_ID);
  assert.equal(store.all().length, 1);
  assert.equal(survivor.username, "fresh-from-env");
  assert.equal(store.get(NEW_ID).username, "fresh-from-env");
});

test("reassignId of an id nothing is registered under changes nothing", () => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(OLD_ID));
  assert.equal(store.reassignId("nobody", NEW_ID), undefined);
  assert.equal(store.all().length, 1);
  assert.equal(store.get(OLD_ID).saltAppId, OLD_ID);
});

test("reassignId to the same id is a no-op", () => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(NEW_ID));
  assert.equal(store.reassignId(NEW_ID, NEW_ID.toUpperCase()).saltAppId, NEW_ID);
  assert.equal(store.all().length, 1);
});

test("reconcileIdentityIds re-keys drifted identities and leaves current ones alone", async () => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(OLD_ID));
  store.register(identity(OTHER_OLD_ID));
  store.register(identity(CURRENT_ID));
  const api = fakeApi({
    [`key-${OLD_ID}`]: NEW_ID,
    [`key-${OTHER_OLD_ID}`]: OTHER_NEW_ID,
    [`key-${CURRENT_ID}`]: CURRENT_ID,
  });

  const result = await sdk.reconcileIdentityIds(store, api, silent);

  assert.equal(result.unchanged, 1);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(
    result.reassigned.map((r) => [r.from, r.to]),
    [
      [OLD_ID, NEW_ID],
      [OTHER_OLD_ID, OTHER_NEW_ID],
    ],
  );
  assert.equal(store.get(NEW_ID).apiKey, `key-${OLD_ID}`);
  assert.equal(store.get(OTHER_NEW_ID).apiKey, `key-${OTHER_OLD_ID}`);
  assert.equal(store.get(OLD_ID), undefined);
  assert.equal(store.get(OTHER_OLD_ID), undefined);
  assert.equal(store.all().length, 3);
});

// A dead key or a down API must never cost an identity: the store is the only
// copy of its private key.
test("reconcileIdentityIds leaves an identity untouched when the API cannot be asked", async () => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(OLD_ID));
  const api = fakeApi({});

  const result = await sdk.reconcileIdentityIds(store, api, silent);

  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].saltAppId, OLD_ID);
  assert.match(result.failed[0].error, /401/);
  assert.equal(store.get(OLD_ID).privateKey, "priv");
});

// The production shape after the env var was corrected but the store was not:
// boot registered the identity under its new id, the old entry stayed on disk.
test("reconcileIdentityIds folds a stale duplicate into the identity registered from env", async () => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity("2", { apiKey: "key-primary", username: "stale" }));
  store.register(identity(CURRENT_ID, { apiKey: "key-primary", username: "from-env" }));
  const api = fakeApi({ "key-primary": CURRENT_ID });

  const result = await sdk.reconcileIdentityIds(store, api, silent);

  assert.equal(result.reassigned.length, 1);
  assert.equal(store.all().length, 1);
  assert.equal(store.get(CURRENT_ID).username, "from-env");
});

function signedPost(port, body, agentId, secret) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Salt-Agent-Id": agentId,
      "X-Salt-Signature": `t=${t},v1=${v1}`,
    },
    body: raw,
  });
}

function serve(t, options) {
  const server = sdk.createWebhookServer({ pgpPassphrase: "x", logger: silent, onMessage() {}, ...options });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  return listening.address().port;
}

// The incident itself: the store still says 5, salt-api signs as ...0005.
// Before this the request was rejected as "no signing key for agent ...0005"
// and the message was gone; now the miss triggers a reconcile and the same
// request verifies.
test("a webhook signed with the id salt-api now uses is accepted once the store heals", async (t) => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(OLD_ID));
  const api = fakeApi({ [`key-${OLD_ID}`]: NEW_ID });
  const port = serve(t, { client: api, identities: store });

  const res = await signedPost(port, {}, NEW_ID, `secret-key-${OLD_ID}`);

  assert.equal(res.status, 200);
  assert.equal(store.get(NEW_ID).apiKey, `key-${OLD_ID}`, "the store now carries the id salt-api uses");
  assert.equal(store.get(OLD_ID), undefined);

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.deepEqual(health.identities.map((i) => i.salt_app_id), [NEW_ID]);

  // A miss for an agent this process does not host still fails -- and within
  // the throttle window it does not cost another round of API calls either.
  const callsAfterHeal = api.calls.length;
  const bogus = await signedPost(port, {}, "00000000-0000-0000-0000-00000000dead", "whatever");
  assert.equal(bogus.status, 401);
  assert.equal(api.calls.length, callsAfterHeal);
});

// Control for the test above: same stale store, same signed request, but the
// API cannot confirm anything -- so the request is still rejected. Acceptance
// depends on the heal, not on the check having gone soft.
test("the same webhook is still rejected when the store cannot be healed", async (t) => {
  const store = sdk.createIdentityStore(tempStore());
  store.register(identity(OLD_ID));
  const api = fakeApi({});
  const port = serve(t, { client: api, identities: store });

  const res = await signedPost(port, {}, NEW_ID, `secret-key-${OLD_ID}`);

  assert.equal(res.status, 401);
  assert.equal(store.get(OLD_ID).saltAppId, OLD_ID, "and the identity was not touched");
});
