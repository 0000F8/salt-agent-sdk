// registerAgent: fake server with the real shapes -- GET /api/v1/config
// answers {terms_version, privacy_version, ...}; POST /auth (root agent
// branch of Users::RegistrationsController#create_agent) answers the
// SAFE_AGENT_FIELDS user plus `api_key`, with errors as {status: {message}}.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sdk = require("../dist/index.js");

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function fakeSalt({ registerStatus = 201, registerBody } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : undefined });
    if (url.endsWith("/api/v1/config")) return jsonResponse(200, { terms_version: "2026-09-10", privacy_version: "2026-09-11", invite_required: false });
    return jsonResponse(
      registerStatus,
      registerBody ?? {
        id: "9a3f1c52-0000-4000-8000-000000000001",
        username: "stranger_bot",
        display_name: "Stranger Bot",
        account_type: "Agent",
        public_fingerprint: "ABCD",
        salt_did: "did:web:saltapp.ai:api:agents:stranger_bot",
        api_key: "raw-api-key-once",
      }
    );
  };
  fn.calls = calls;
  return fn;
}

test("registerAgent generates keys locally, sends only the public key and accepted versions, returns the api key once", async () => {
  const fetchImpl = fakeSalt();
  const result = await sdk.registerAgent({ baseUrl: "https://salt.test/", username: "stranger_bot", displayName: "Stranger Bot", listed: true, fetchImpl });

  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/config");
  const post = fetchImpl.calls[1];
  assert.strictEqual(post.url, "https://salt.test/auth/");
  assert.strictEqual(post.method, "POST");
  assert.strictEqual(post.body.account_type, "Agent");
  assert.strictEqual(post.body.username, "stranger_bot");
  assert.strictEqual(post.body.display_name, "Stranger Bot");
  assert.strictEqual(post.body.listed, true);
  assert.strictEqual(post.body.accepted_terms_version, "2026-09-10");
  assert.strictEqual(post.body.accepted_privacy_version, "2026-09-11");
  assert.match(post.body.public_key, /BEGIN PGP PUBLIC KEY BLOCK/);
  assert.ok(!("webhook" in post.body), "no webhook means socket mode");
  assert.ok(!JSON.stringify(post.body).includes("PRIVATE KEY"), "the private key never leaves the caller");

  assert.strictEqual(result.apiKey, "raw-api-key-once");
  assert.strictEqual(result.publicKey, post.body.public_key);
  assert.match(result.privateKey, /BEGIN PGP PRIVATE KEY BLOCK/);
  assert.strictEqual(result.agent.username, "stranger_bot");
  assert.ok(!("api_key" in result.agent));
  assert.strictEqual(result.identity.saltAppId, "9a3f1c52-0000-4000-8000-000000000001");
  assert.ok(result.passphrase.length > 0);
});

test("registerAgent saves into an identity store and forwards a webhook when given", async () => {
  const fetchImpl = fakeSalt();
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reg-")), "identities.json");
  const identities = sdk.createIdentityStore(storePath);
  const result = await sdk.registerAgent({ baseUrl: "https://salt.test", username: "stranger_bot", displayName: "Stranger Bot", webhook: "https://me.example/hook", identities, fetchImpl });

  assert.strictEqual(fetchImpl.calls[1].body.webhook, "https://me.example/hook");
  assert.strictEqual(identities.get(result.agent.id).apiKey, "raw-api-key-once");
  const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.strictEqual(onDisk[0].privateKey, result.privateKey);
});

test("registerAgent surfaces Salt's refusal sentence ({status:{message}}) in a SaltApiError", async () => {
  const fetchImpl = fakeSalt({ registerStatus: 422, registerBody: { status: { message: "Your account couldn't be created. Display name can't start with salt" } } });
  await assert.rejects(
    sdk.registerAgent({ baseUrl: "https://salt.test", username: "x_bot", displayName: "Salt Helper", fetchImpl }),
    (err) => {
      assert.ok(err instanceof sdk.SaltApiError);
      assert.strictEqual(err.status, 422);
      assert.match(err.message, /Display name can't start with salt/);
      return true;
    }
  );
});

test("searchContacts GETs /api/v1/search/contacts with the handle", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, headers: opts.headers });
    return jsonResponse(200, [{ id: "u1", username: "dan", display_name: "Dan", account_type: "User" }]);
  };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const found = await client.searchContacts("k", { username: "dan" });
  assert.strictEqual(calls[0].url, "https://salt.test/api/v1/search/contacts?username=dan");
  assert.strictEqual(calls[0].headers["api-key"], "k");
  assert.strictEqual(found[0].id, "u1");
});
