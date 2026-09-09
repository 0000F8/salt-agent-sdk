// chat_opened fires when a person (or another agent) newly opens a 1:1 with
// this identity, creates a group containing it, or adds it to one. Unlike
// card_interaction/invoice_paid it carries no owner/seller id naming which
// hosted identity it's for -- only a member list -- so these tests pin: (1)
// the identity is found by noticing itself among `members`, (2) the parsed
// context reaches onChatOpened, (3) reply() really encrypts for every member,
// and (4) a retried delivery (Salt's guarantee, not an edge case) does not
// make the handler run twice.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");

const silent = { info() {}, error() {} };

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-chat-opened-"));
  return path.join(dir, "identities.json");
}

// Stands in for salt-api: answers the signing-key lookup used to verify the
// webhook's HMAC, serves a fixed chat membership, and records every reply
// posted back.
function fakeApi(secretsByApiKey, members) {
  const posted = [];
  return {
    posted,
    async getWebhookSecret(apiKey) {
      const secret = secretsByApiKey[apiKey];
      if (!secret) throw new sdk.SaltApiError("GET", "/api/v1/agents/webhook_secret", 401, { error: "unauthorized" });
      return secret;
    },
    async getChatMembers() {
      return members;
    },
    async postMessage(apiKey, chatId, message, senderMessage, delegations) {
      posted.push({ apiKey, chatId, message, senderMessage, delegations });
    },
    async signalTyping() {},
    trackEvent() {},
  };
}

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

function serve(t, api, options) {
  const server = sdk.createWebhookServer({ client: api, pgpPassphrase: "x", logger: silent, ...options });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  return listening.address().port;
}

async function decryptWith(armoredMessage, armoredPrivateKey, passphrase) {
  const decryptionKey = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey }),
    passphrase,
  });
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage }),
    decryptionKeys: [decryptionKey],
  });
  return data;
}

test("chat_opened: identity resolved from the member list, handler gets the parsed context, reply() encrypts for every member, a retry does not double-greet", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const memberKeys = await sdk.generateKeypair("member-pass");
  const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
  const MEMBER_ID = "00000000-0000-0000-0000-0000000000b2";

  const store = sdk.createIdentityStore(tempStore());
  store.register({
    saltAppId: AGENT_ID,
    username: "concierge",
    apiKey: "key-agent",
    publicKey: agentKeys.publicKey,
    privateKey: agentKeys.privateKey,
  });

  // Every current member, including the agent's own account -- makeReply
  // must encrypt only for the OTHER one.
  const members = [
    { id: MEMBER_ID, username: "ada", display_name: "Ada", account_type: "User", public_key: memberKeys.publicKey, observer: false },
    { id: AGENT_ID, username: "concierge", display_name: "Concierge", account_type: "Agent", public_key: agentKeys.publicKey, observer: false },
  ];
  const api = fakeApi({ "key-agent": "secret-agent" }, members);

  const calls = [];
  const port = serve(t, api, {
    identities: store,
    async onChatOpened(ctx) {
      calls.push(ctx);
      await ctx.reply(`Hi, I'm ${ctx.identity.username}. Tell me what you need.`);
    },
  });

  const body = {
    type: "chat_opened",
    chat: { id: "chat-1", name: null, public: false, managed: false, open_invite: false, mode: "auto" },
    opened_by: { id: MEMBER_ID, username: "ada", display_name: "Ada", account_type: "User", public_key: memberKeys.publicKey },
    members,
    opened_at: "2026-09-08T23:59:00Z",
  };

  const res = await signedPost(port, body, AGENT_ID, "secret-agent");
  assert.equal(res.status, 200);

  // The POST is acknowledged before dispatch runs (see webhook.ts) -- give
  // the background handler a moment to finish, same as any other async
  // webhook effect this SDK fires-and-forgets.
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(calls.length, 1, "onChatOpened ran exactly once");
  const ctx = calls[0];
  assert.equal(ctx.chatId, "chat-1");
  assert.equal(ctx.identity.saltAppId, AGENT_ID);
  assert.equal(ctx.openedBy.id, MEMBER_ID);
  assert.equal(ctx.members.length, 2);
  assert.equal(ctx.openedAt, "2026-09-08T23:59:00Z");
  assert.equal(ctx.chat.mode, "auto");

  assert.equal(api.posted.length, 1, "reply() posted exactly one message");
  assert.match(api.posted[0].message, /-----BEGIN PGP MESSAGE-----/);

  const plaintext = await decryptWith(api.posted[0].message, memberKeys.privateKey, "member-pass");
  assert.match(plaintext, /Tell me what you need/);
  const ownCopy = await decryptWith(api.posted[0].senderMessage, agentKeys.privateKey, "agent-pass");
  assert.match(ownCopy, /Tell me what you need/);

  // Delivery can be retried -- the exact same payload arriving again must
  // not make the agent greet the chat a second time.
  const retry = await signedPost(port, body, AGENT_ID, "secret-agent");
  assert.equal(retry.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(calls.length, 1, "a retried delivery did not call the handler again");
  assert.equal(api.posted.length, 1, "and did not send a second greeting");
});

test("chat_opened: no hosted identity among the members is ignored, not thrown", async (t) => {
  const store = sdk.createIdentityStore(tempStore());
  const api = fakeApi({}, []);
  let called = false;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "x",
    logger: silent,
    verifySignatures: false,
    onChatOpened() {
      called = true;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "chat_opened",
      chat: { id: "chat-2" },
      opened_by: { id: "someone", username: "u", display_name: "U", account_type: "User" },
      members: [{ id: "someone", username: "u", display_name: "U", account_type: "User", public_key: "pub" }],
      opened_at: "2026-09-08T23:59:00Z",
    }),
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(called, false, "no identity this process hosts is a member, so nothing fires");
});
