// An agent answering in a GROUP chat addresses the person it is answering, by
// handle. Being spoken to by name is how someone tells which of several
// messages in a busy room is meant for them; an agent that answers into the
// middle of a group without naming anyone reads as talking to the room.
//
// Two limits, both pinned below. Only in a group -- in a 1:1 there is exactly
// one person it could be for and "@ada" on every line is noise. And only for a
// HUMAN -- an agent addressed by handle receives a webhook, so auto-addressing
// one invites the ping-pong the loop caps in webhook.ts exist to stop.
//
// The `mentions` ids matter as much as the text: Salt only ever sees
// ciphertext, so an "@handle" written into the body is invisible to it and
// notifies nobody by itself.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-reply-addressing-"));
  return path.join(dir, "identities.json");
}

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
    async postMessage(apiKey, chatId, message, senderMessage, delegations, mentions) {
      posted.push({ chatId, message, senderMessage, delegations, mentions });
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
  // Must match the passphrase the agent keypair below is generated with, or
  // the incoming ciphertext cannot be unlocked and the SDK correctly drops
  // it with "no known identity could decrypt this message".
  const server = sdk.createWebhookServer({ client: api, pgpPassphrase: "agent-pass", logger: silent, ...options });
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

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
const ADA_ID = "00000000-0000-0000-0000-0000000000b2";
const BOB_ID = "00000000-0000-0000-0000-0000000000c3";
const OTHER_AGENT_ID = "00000000-0000-0000-0000-0000000000d4";

// Builds a chat of `members`, delivers one message from `sender`, and returns
// whatever the agent posted back.
async function replyTo(t, { members, sender, text = "hello", answer = "sure thing" }) {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const memberKeys = await sdk.generateKeypair("member-pass");

  const store = sdk.createIdentityStore(tempStore());
  store.register({
    saltAppId: AGENT_ID,
    username: "helper",
    apiKey: "key-agent",
    publicKey: agentKeys.publicKey,
    privateKey: agentKeys.privateKey,
  });

  const withKeys = members.map((m) =>
    m.id === AGENT_ID ? { ...m, public_key: agentKeys.publicKey } : { ...m, public_key: memberKeys.publicKey }
  );

  const api = fakeApi({ "key-agent": "secret-agent" }, withKeys);
  const port = serve(t, api, {
    identities: store,
    async onMessage(ctx) {
      await ctx.reply(answer);
    },
  });

  // The incoming body is encrypted for the agent, the way Salt sends it.
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text }),
    encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }),
  });

  const res = await signedPost(
    port,
    {
      chat: { id: "chat-1", name: "Room", public: false, managed: false, open_invite: false, mode: "auto" },
      message: {
        chat_id: "chat-1",
        message_id: `m-${Math.random().toString(16).slice(2)}`,
        message: armored,
        sender_message: armored,
        message_type: "User",
        user: sender,
        created_at: new Date().toISOString(),
      },
    },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  // The POST is acknowledged before dispatch runs (see webhook.ts).
  await new Promise((r) => setTimeout(r, 500));
  return { posted: api.posted, agentKeys };
}

const human = (id, username) => ({ id, username, display_name: username, account_type: "User", observer: false });
const bot = (id, username) => ({ id, username, display_name: username, account_type: "Agent", observer: false });

test("in a group, the reply addresses the person it answers -- in the text AND in the mention ids", async (t) => {
  const { posted, agentKeys } = await replyTo(t, {
    members: [human(ADA_ID, "ada"), human(BOB_ID, "bob"), bot(AGENT_ID, "helper")],
    sender: human(ADA_ID, "ada"),
    answer: "the total is $12",
  });

  assert.equal(posted.length, 1, "one reply posted");
  const text = await decryptWith(posted[0].senderMessage, agentKeys.privateKey, "agent-pass");
  assert.equal(text, "@ada the total is $12");
  // Salt cannot read the body, so the ids are what actually notify her.
  assert.deepEqual(posted[0].mentions, [ADA_ID]);
});

test("in a 1:1 the reply is left alone -- there is only one person it could be for", async (t) => {
  const { posted, agentKeys } = await replyTo(t, {
    members: [human(ADA_ID, "ada"), bot(AGENT_ID, "helper")],
    sender: human(ADA_ID, "ada"),
    answer: "the total is $12",
  });

  const text = await decryptWith(posted[0].senderMessage, agentKeys.privateKey, "agent-pass");
  assert.equal(text, "the total is $12");
  assert.equal(posted[0].mentions, undefined);
});

test("another agent is never addressed automatically -- that is how ping-pong starts", async (t) => {
  const { posted, agentKeys } = await replyTo(t, {
    members: [human(ADA_ID, "ada"), bot(OTHER_AGENT_ID, "scribe"), bot(AGENT_ID, "helper")],
    sender: bot(OTHER_AGENT_ID, "scribe"),
    answer: "noted",
  });

  assert.equal(posted.length, 1, "the agent still answered");
  const text = await decryptWith(posted[0].senderMessage, agentKeys.privateKey, "agent-pass");
  assert.equal(text, "noted");
  assert.equal(posted[0].mentions, undefined);
});

test("an agent that addressed the person itself does not get a second handle bolted on", async (t) => {
  const { posted, agentKeys } = await replyTo(t, {
    members: [human(ADA_ID, "ada"), human(BOB_ID, "bob"), bot(AGENT_ID, "helper")],
    sender: human(ADA_ID, "ada"),
    answer: "@ada already on it",
  });

  const text = await decryptWith(posted[0].senderMessage, agentKeys.privateKey, "agent-pass");
  assert.equal(text, "@ada already on it");
});
