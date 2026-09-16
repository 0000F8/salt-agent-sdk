// ctx.session isn't only on MessageContext: handoff_received, chat_opened,
// card_interaction and invoice_paid all load one before their handler runs,
// and every one WITH a reply() appends what got sent as an assistant turn
// and persists it -- so it's already in transcriptTail by the time the next
// onMessage call for that chat runs. card_interaction has no reply() at all
// (a card update IS the response), so it only loads; nothing it does is
// persisted.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");
const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };

function tempStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function encryptFor(text, armoredPublicKey) {
  return openpgp.encrypt({ message: await openpgp.createMessage({ text }), encryptionKeys: await openpgp.readKey({ armoredKey: armoredPublicKey }) });
}

test("a handoff_received intro appears in the session tail read by the following onMessage", async (t) => {
  const bKeys = await sdk.generateKeypair("shared-pass");
  const B_ID = "60000000-0000-0000-0000-0000000000b1";
  const ROOM_ID = "room-handoff-1";

  const store = sdk.createIdentityStore(tempStore("salt-handback-handoff-"));
  store.register({ saltAppId: B_ID, username: "incoming", apiKey: "key-b", publicKey: bKeys.publicKey, privateKey: bKeys.privateKey });

  const briefing = await encryptFor("[[SALT-HANDOFF-BRIEFING]]\nHanding off now.", bKeys.publicKey);

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-b" ? "secret-b" : undefined;
    },
    async getChatMembers() {
      return [];
    },
    async getChatMessages() {
      return [{ event_type: null, message: briefing, user: { display_name: "Outgoing" } }];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let seenTail = null;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "shared-pass",
    logger: silent,
    async onHandoffReceived(ctx) {
      await ctx.reply("Hi, I'm incoming, taking it from here.");
    },
    async onMessage(ctx) {
      seenTail = ctx.session.transcriptTail.map((turn) => [turn.role, turn.content]);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const receivedRes = await signedPost(port, { type: "handoff_received", to_agent_id: B_ID, chat_id: ROOM_ID, reason: "handing off" }, B_ID, "secret-b");
  assert.equal(receivedRes.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  const armored = await encryptFor("thanks!", bKeys.publicKey);
  const msgRes = await signedPost(
    port,
    {
      chat: { id: ROOM_ID },
      message: { chat_id: ROOM_ID, message_id: "m-1", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
    },
    B_ID,
    "secret-b"
  );
  assert.equal(msgRes.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(seenTail, "onMessage ran");
  assert.deepStrictEqual(seenTail, [["assistant", "Hi, I'm incoming, taking it from here."]]);
});

test("a chat_opened greeting is persisted into the session, read by the following onMessage", async (t) => {
  const agentKeys = await sdk.generateKeypair("shared-pass-2");
  const AGENT_ID = "60000000-0000-0000-0000-0000000000a2";
  const HUMAN_ID = "human-2";
  const CHAT_ID = "chat-opened-1";

  const store = sdk.createIdentityStore(tempStore("salt-chatopened-session-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent2", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [{ id: HUMAN_ID, username: "dan", display_name: "Dan", account_type: "User" }, { id: AGENT_ID, username: "helper", display_name: "Helper", account_type: "Agent" }];
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent2" ? "secret-agent2" : undefined;
    },
    async getChatMembers() {
      return members;
    },
    async getChatMessages() {
      return [];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let seenTail = null;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "shared-pass-2",
    logger: silent,
    async onChatOpened(ctx) {
      await ctx.reply("Hi, I'm helper. What do you need?");
    },
    async onMessage(ctx) {
      seenTail = ctx.session.transcriptTail.map((turn) => [turn.role, turn.content]);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const openedRes = await signedPost(
    port,
    { type: "chat_opened", chat: { id: CHAT_ID, mode: "auto" }, opened_by: { id: HUMAN_ID, username: "dan", account_type: "User" }, members, opened_at: new Date().toISOString() },
    AGENT_ID,
    "secret-agent2"
  );
  assert.equal(openedRes.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  const armored = await encryptFor("hi", agentKeys.publicKey);
  const msgRes = await signedPost(
    port,
    {
      chat: { id: CHAT_ID },
      message: { chat_id: CHAT_ID, message_id: "m-1", message: armored, sender_message: armored, user: { id: HUMAN_ID, username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent2"
  );
  assert.equal(msgRes.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(seenTail);
  assert.deepStrictEqual(seenTail, [["assistant", "Hi, I'm helper. What do you need?"]]);
});

test("an invoice_paid reply is persisted into the session, read by the following onMessage", async (t) => {
  const agentKeys = await sdk.generateKeypair("shared-pass-3");
  const AGENT_ID = "60000000-0000-0000-0000-0000000000a3";
  const BUYER_ID = "buyer-1";
  const CHAT_ID = "chat-invoice-1";

  const store = sdk.createIdentityStore(tempStore("salt-invoicepaid-session-"));
  store.register({ saltAppId: AGENT_ID, username: "seller", apiKey: "key-agent3", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent3" ? "secret-agent3" : undefined;
    },
    async getChatMembers() {
      return [];
    },
    async getChatMessages() {
      return [];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let seenTail = null;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "shared-pass-3",
    logger: silent,
    async onInvoicePaid(ctx) {
      await ctx.reply("Thanks for paying! Here's your download link.");
    },
    async onMessage(ctx) {
      seenTail = ctx.session.transcriptTail.map((turn) => [turn.role, turn.content]);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const paidRes = await signedPost(
    port,
    {
      type: "invoice_paid",
      seller_id: AGENT_ID,
      chat_id: CHAT_ID,
      buyer: { id: BUYER_ID, username: "dan", account_type: "User" },
      line_items: [{ name: "Widget", qty: 1 }],
      amount: "0.01",
      transfer_request_id: "tr-1",
    },
    AGENT_ID,
    "secret-agent3"
  );
  assert.equal(paidRes.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  const armored = await encryptFor("got it, thanks", agentKeys.publicKey);
  const msgRes = await signedPost(
    port,
    {
      chat: { id: CHAT_ID },
      message: { chat_id: CHAT_ID, message_id: "m-1", message: armored, sender_message: armored, user: { id: BUYER_ID, username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent3"
  );
  assert.equal(msgRes.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(seenTail);
  assert.deepStrictEqual(seenTail, [["assistant", "Thanks for paying! Here's your download link."]]);
});

test("card_interaction gets ctx.session (loaded), but nothing from it is persisted -- there is no reply() to capture", async (t) => {
  const agentKeys = await sdk.generateKeypair("shared-pass-4");
  const AGENT_ID = "60000000-0000-0000-0000-0000000000a4";
  const CHAT_ID = "chat-card-1";

  const store = sdk.createIdentityStore(tempStore("salt-cardinteraction-session-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent4", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });
  const sessionStore = sdk.MemorySessionStore();

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent4" ? "secret-agent4" : undefined;
    },
    async getChatMembers() {
      return [];
    },
    async getChatMessages() {
      return [];
    },
    trackEvent() {},
  };

  let sawSession = null;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "shared-pass-4",
    logger: silent,
    sessionStore,
    async onCardInteraction(ctx) {
      sawSession = ctx.session;
      ctx.session.note.goal = "should not survive"; // mutating it here is not saved -- "just load"
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const res = await signedPost(
    port,
    {
      type: "card_interaction",
      owner_id: AGENT_ID,
      chat_id: CHAT_ID,
      card_id: "card-1",
      action_id: "vote_a",
      user: { id: "human-1", username: "dan", account_type: "User" },
      state: { blocks: [] },
    },
    AGENT_ID,
    "secret-agent4"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(sawSession, "onCardInteraction received a session");
  assert.deepStrictEqual(sawSession.transcriptTail, []);
  assert.strictEqual(await sessionStore.get(AGENT_ID, CHAT_ID), null, "nothing was persisted from a card interaction");
});
