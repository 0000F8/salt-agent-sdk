// resolveIdentity prefers X-Salt-Agent-Id when it names a hosted identity
// (salt-api signs every callback for a specific RECIPIENT identity), falling
// back to trial decryption otherwise. This matters once a process hosts more
// than one identity that's a member of the SAME chat (a delegation or consult
// lane makes that possible): any member's key opens the shared
// multi-recipient ciphertext, so without the header "which one answers" is
// just whichever was tried first.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");
const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-routing-"));
  return path.join(dir, "identities.json");
}

function signedPost(port, body, agentId, secret) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Salt-Agent-Id": agentId, "X-Salt-Signature": `t=${t},v1=${v1}` },
    body: raw,
  });
}

test("X-Salt-Agent-Id resolves the named recipient even when another hosted identity's key could ALSO decrypt the same multi-recipient message", async (t) => {
  // One webhook server has ONE pgpPassphrase shared by every identity it
  // hosts (see WebhookServerOptions.pgpPassphrase) -- both keys below must
  // be generated with that same passphrase, or the server can't unlock
  // EITHER of them and every message is dropped as undecryptable.
  const aKeys = await sdk.generateKeypair("shared-pass");
  const bKeys = await sdk.generateKeypair("shared-pass");
  const A_ID = "20000000-0000-0000-0000-0000000000a1";
  const B_ID = "20000000-0000-0000-0000-0000000000b1";

  const store = sdk.createIdentityStore(tempStore());
  // A registered FIRST -- today's trial-decryption order would try it first
  // and, since the ciphertext below is encrypted for BOTH, it would "win"
  // without the header.
  store.register({ saltAppId: A_ID, username: "agent-a", apiKey: "key-a", publicKey: aKeys.publicKey, privateKey: aKeys.privateKey });
  store.register({ saltAppId: B_ID, username: "agent-b", apiKey: "key-b", publicKey: bKeys.publicKey, privateKey: bKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return { "key-a": "secret-a", "key-b": "secret-b" }[apiKey];
    },
    async getChatMembers() {
      return [];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  const resolvedBy = [];
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "shared-pass",
    logger: silent,
    async onMessage(ctx) {
      resolvedBy.push(ctx.identity.saltAppId);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const bothKeys = [await openpgp.readKey({ armoredKey: aKeys.publicKey }), await openpgp.readKey({ armoredKey: bKeys.publicKey })];
  const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: "hello" }), encryptionKeys: bothKeys });
  const body = {
    chat: { id: "chat-1" },
    message: {
      chat_id: "chat-1",
      message_id: "m-1",
      message: armored,
      sender_message: armored,
      user: { id: "someone", username: "dan", account_type: "User" },
      created_at: new Date().toISOString(),
    },
  };

  // Header names B -- B must be the one that answers, not A (registered first).
  const res = await signedPost(port, body, B_ID, "secret-b");
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(resolvedBy, [B_ID]);

  // Header names A instead, on a DIFFERENT message id -- A must win this time.
  const armored2 = await openpgp.encrypt({ message: await openpgp.createMessage({ text: "hello again" }), encryptionKeys: bothKeys });
  const body2 = { ...body, message: { ...body.message, message_id: "m-2", message: armored2, sender_message: armored2 } };
  const res2 = await signedPost(port, body2, A_ID, "secret-a");
  assert.equal(res2.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(resolvedBy, [B_ID, A_ID]);
});

test("with no header (verification off), trial decryption falls back to whichever hosted identity is tried first", async (t) => {
  const aKeys = await sdk.generateKeypair("shared-pass");
  const bKeys = await sdk.generateKeypair("shared-pass");
  const A_ID = "20000000-0000-0000-0000-0000000000a2";
  const B_ID = "20000000-0000-0000-0000-0000000000b2";

  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: A_ID, username: "agent-a", apiKey: "key-a", publicKey: aKeys.publicKey, privateKey: aKeys.privateKey });
  store.register({ saltAppId: B_ID, username: "agent-b", apiKey: "key-b", publicKey: bKeys.publicKey, privateKey: bKeys.privateKey });

  const api = {
    async getChatMembers() {
      return [];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };
  const resolvedBy = [];
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "shared-pass",
    logger: silent,
    verifySignatures: false,
    async onMessage(ctx) {
      resolvedBy.push(ctx.identity.saltAppId);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const bothKeys = [await openpgp.readKey({ armoredKey: aKeys.publicKey }), await openpgp.readKey({ armoredKey: bKeys.publicKey })];
  const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: "hello" }), encryptionKeys: bothKeys });
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat: { id: "chat-2" },
      message: {
        chat_id: "chat-2",
        message_id: "m-3",
        message: armored,
        sender_message: armored,
        user: { id: "someone", username: "dan", account_type: "User" },
        created_at: new Date().toISOString(),
      },
    }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(resolvedBy, [A_ID], "A was registered first, so it's tried first when there's no header to prefer");
});
