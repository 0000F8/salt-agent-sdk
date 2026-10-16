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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-reply-link-"));
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
    async postMessage(apiKey, chatId, message, senderMessage, delegations, mentions, opts) {
      posted.push({ chatId, message, senderMessage, delegations, mentions, opts });
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
async function replyTo(t, { members, sender, text = "hello", handler, messageId = "m-77" }) {
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
    onMessage: handler,
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
        message_id: messageId,
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
const members = [human(ADA_ID, "ada"), bot(AGENT_ID, "helper")];

test("ctx.reply links the message it answers by default", async (t) => {
  const { posted } = await replyTo(t, { members, sender: human(ADA_ID, "ada"), handler: (ctx) => ctx.reply("hi") });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].opts.replyTo, "m-77");
});

test("{ replyTo: null } opts out for that reply only", async (t) => {
  const { posted } = await replyTo(t, {
    members,
    sender: human(ADA_ID, "ada"),
    handler: async (ctx) => {
      await ctx.reply("unlinked", { replyTo: null });
      await ctx.reply("linked");
    },
  });
  assert.equal(posted.length, 2);
  assert.equal(posted[0].opts.replyTo, undefined);
  assert.equal(posted[1].opts.replyTo, "m-77");
});

test("{ replyTo: id } links a different message", async (t) => {
  const { posted } = await replyTo(t, {
    members,
    sender: human(ADA_ID, "ada"),
    handler: (ctx) => ctx.reply("about the other one", { replyTo: "m-12" }),
  });
  assert.equal(posted[0].opts.replyTo, "m-12");
});

test("client.postMessage sends reply_to_message_id only when asked, and postPlainMessage accepts it", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = sdk.createSaltClient({ host: "http://salt.test", fetchImpl });
  await client.postMessage("k", "c1", "x", "y");
  await client.postMessage("k", "c1", "x", "y", undefined, undefined, { replyTo: "m-5" });
  await client.postPlainMessage("k", "c1", "plain", { replyTo: "m-6" });
  assert.equal("reply_to_message_id" in calls[0], false);
  assert.equal(calls[1].reply_to_message_id, "m-5");
  assert.equal(calls[2].reply_to_message_id, "m-6");
});
