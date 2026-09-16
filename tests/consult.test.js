// Consult lanes: consult_agent (actions.ts) opens a lane off the CURRENT
// chat with a fellow member, request_floor (actions.ts) asks the asker to
// bring the consulted agent into the room, and webhook.ts is what makes both
// of those real -- a much higher reply cap for chatMeta.lane_kind ===
// "consult" than an ordinary chat, reset by a human message in the room the
// lane serves, and a floor-request message triggering an automatic hand-off
// (never reaching onMessage) for whichever identity opened the lane.
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

async function keypair(name) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{ name }], format: "armored" });
  return { privateKey, publicKey };
}
async function decryptWith(armoredPrivate, armoredMessage) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivate });
  const message = await openpgp.readMessage({ armoredMessage });
  const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey });
  return data;
}
// sdk.generateKeypair(passphrase) (unlike this file's own keypair() helper
// above) produces a passphrase-LOCKED private key, matching how a real
// hosted identity's key is generated -- decryptKey() first, same as
// chat-opened.test.js / reply-addressing.test.js.
async function decryptWithPassphrase(armoredMessage, armoredPrivateKey, passphrase) {
  const decryptionKey = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey }), passphrase });
  const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage }), decryptionKeys: [decryptionKey] });
  return data;
}

// --- actions.ts: consult_agent -------------------------------------------

test("consult_agent opens a lane off the current chat, waits for the reply, reports work, and registers the asker", async () => {
  const callerKeys = await keypair("caller");
  const targetKeys = await keypair("target");
  const requesterKeys = await keypair("requester");

  const posted = [];
  const opened = [];
  const client = {
    async getChatMembers() {
      return [
        { id: "caller-1", username: "caller", public_key: callerKeys.publicKey, account_type: "Agent" },
        { id: "target-1", username: "weather", public_key: targetKeys.publicKey, account_type: "Agent" },
        { id: "requester-1", username: "dan", public_key: requesterKeys.publicKey, account_type: "User" },
      ];
    },
    async openConsultLane(apiKey, roomId, withId) {
      opened.push({ roomId, withId });
      return {
        session: {
          id: "lane-1",
          coaching_for_chat_id: roomId,
          lane_kind: "consult",
          users: [
            { id: "caller-1", public_key: callerKeys.publicKey },
            { id: "target-1", public_key: targetKeys.publicKey },
          ],
        },
      };
    },
    async openSidechain(apiKey, chatId, withId) {
      // The requester's OWN work-report lane -- distinct from the consult lane above.
      return { session: { id: `requester-lane-${chatId}`, users: [{ id: "caller-1", public_key: callerKeys.publicKey }, { id: withId, public_key: requesterKeys.publicKey }] } };
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ chatId, message, senderMessage });
      if (chatId === "lane-1") {
        setTimeout(() => sdk.resolveIfPending("lane-1", "target-1", "It'll rain."), 5);
      }
      return {};
    },
    trackEvent() {},
  };

  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "caller-1", apiKey: "k", publicKey: callerKeys.publicKey };

  const result = await actions.execute(
    "consult_agent",
    { handle: "@weather", briefing: "Dan is asking about tomorrow.", question: "Will it rain in Lisbon tomorrow?" },
    caller,
    { depth: 0, mainChatId: "chat-1", requesterId: "requester-1" }
  );

  assert.deepStrictEqual(opened, [{ roomId: "chat-1", withId: "target-1" }]);
  assert.strictEqual(result.consulted, true);
  assert.strictEqual(result.reply, "It'll rain.");
  assert.strictEqual(result.lane_chat_id, "lane-1");
  assert.match(result.note, /separate private lane/);

  const laneMessage = posted.find((p) => p.chatId === "lane-1");
  const plaintext = await decryptWith(targetKeys.privateKey, laneMessage.message);
  assert.strictEqual(plaintext, "[[SALT-CONSULT room=chat-1]]\nDan is asking about tomorrow.\n\nWill it rain in Lisbon tomorrow?");

  // Progress went to the REQUESTER's own lane (distinct from the consult lane).
  const reportMessages = posted.filter((p) => p.chatId === "requester-lane-chat-1");
  const reports = await Promise.all(reportMessages.map((p) => decryptWith(requesterKeys.privateKey, p.message).then(sdk.parseWorkReport)));
  assert.deepStrictEqual(reports.map((r) => [r.status, r.title, r.with]), [
    ["running", "Asking @weather", "weather"],
    ["done", "@weather answered", "weather"],
  ]);

  // webhook.ts's floor-request handler looks this up by lane id.
  assert.deepStrictEqual(sdk.consultAskerFor("lane-1"), { askerId: "caller-1", roomId: "chat-1" });
});

test("consult_agent refuses a handle that isn't already a member of this chat, itself, or a non-agent", async () => {
  const callerKeys = await keypair("caller2");
  const humanKeys = await keypair("human2");
  const client = {
    async getChatMembers() {
      return [
        { id: "caller-2", username: "caller", public_key: callerKeys.publicKey, account_type: "Agent" },
        { id: "human-2", username: "dan", public_key: humanKeys.publicKey, account_type: "User" },
      ];
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "caller-2", apiKey: "k", publicKey: callerKeys.publicKey };
  const ctx = { depth: 0, mainChatId: "chat-2" };

  await assert.rejects(actions.execute("consult_agent", { handle: "ghost", question: "?" }, caller, ctx), /No chat member named @ghost/);
  await assert.rejects(actions.execute("consult_agent", { handle: "caller", question: "?" }, caller, ctx), /can't consult yourself/);
  await assert.rejects(actions.execute("consult_agent", { handle: "dan", question: "?" }, caller, ctx), /isn't an agent/);
  await assert.rejects(actions.execute("consult_agent", { handle: "weather", question: "" }, caller, ctx), /both required/);
});

// --- actions.ts: request_floor --------------------------------------------

test("request_floor posts the marker into the current consult lane, and refuses outside one", async () => {
  const callerKeys = await keypair("caller3");
  const otherKeys = await keypair("other3");
  const posted = [];
  const client = {
    async getChatMembers() {
      return [
        { id: "caller-3", username: "caller", public_key: callerKeys.publicKey, account_type: "Agent" },
        { id: "other-3", username: "asker", public_key: otherKeys.publicKey, account_type: "Agent" },
      ];
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ chatId, message, senderMessage });
      return {};
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "caller-3", apiKey: "k", publicKey: callerKeys.publicKey };

  await assert.rejects(
    actions.execute("request_floor", { reason: "faster this way" }, caller, { depth: 0, mainChatId: "lane-3" }),
    /only available inside a consult lane/
  );

  const result = await actions.execute("request_floor", { reason: "faster this way" }, caller, { depth: 0, mainChatId: "lane-3", laneKind: "consult" });
  assert.strictEqual(result.requested, true);
  assert.strictEqual(posted.length, 1);
  const plaintext = await decryptWith(otherKeys.privateKey, posted[0].message);
  assert.strictEqual(plaintext, "[[SALT-FLOOR-REQUEST]]\nfaster this way");
});

// --- webhook.ts: the consult reply cap ------------------------------------

test("a consult lane's reply cap is much higher than an ordinary chat's, and a human message in the room it serves resets it", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const AGENT_ID = "30000000-0000-0000-0000-0000000000a1";
  const OTHER_AGENT_ID = "other-agent-1";
  const HUMAN_ID = "human-1";
  const ROOM_ID = "room-1";
  const LANE_ID = "lane-cap-1";

  const store = sdk.createIdentityStore(tempStore("salt-consult-cap-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
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

  let onMessageCalls = 0;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "agent-pass",
    logger: silent,
    async onMessage() {
      onMessageCalls++;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  async function postFrom(sender, chatId, chatMeta, n) {
    const armored = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: `turn ${n}` }),
      encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }),
    });
    return signedPost(
      port,
      {
        chat: { id: chatId, ...chatMeta },
        message: { chat_id: chatId, message_id: `m-${chatId}-${n}`, message: armored, sender_message: armored, user: sender, created_at: new Date().toISOString() },
      },
      AGENT_ID,
      "secret-agent"
    );
  }

  const otherAgent = { id: OTHER_AGENT_ID, username: "asker", account_type: "Agent" };
  const human = { id: HUMAN_ID, username: "dan", account_type: "User" };

  for (let i = 1; i <= 20; i++) {
    await postFrom(otherAgent, LANE_ID, { lane_kind: "consult", coaching_for_chat_id: ROOM_ID }, i);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(onMessageCalls, 20, "all 20 within CONSULT_RUNAWAY_LIMIT are answered");

  await postFrom(otherAgent, LANE_ID, { lane_kind: "consult", coaching_for_chat_id: ROOM_ID }, 21);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(onMessageCalls, 20, "the 21st is capped");

  await postFrom(human, ROOM_ID, {}, 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(onMessageCalls, 21, "the human's own room message is itself answered");

  await postFrom(otherAgent, LANE_ID, { lane_kind: "consult", coaching_for_chat_id: ROOM_ID }, 22);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(onMessageCalls, 22, "the lane's count was reset by the room message, so this one goes through");
});

test("an ordinary (non-consult) lane keeps the ordinary MAX_AGENT_TO_AGENT_REPLIES_PER_CHAT cap", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const AGENT_ID = "30000000-0000-0000-0000-0000000000a2";
  const store = sdk.createIdentityStore(tempStore("salt-consult-cap-ordinary-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
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
  let onMessageCalls = 0;
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "agent-pass", logger: silent, async onMessage() { onMessageCalls++; } });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const otherAgent = { id: "other-agent-9", username: "scribe", account_type: "Agent" };
  for (let i = 1; i <= 3; i++) {
    const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: `turn ${i}` }), encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }) });
    await signedPost(
      port,
      { chat: { id: "chat-plain" }, message: { chat_id: "chat-plain", message_id: `m-plain-${i}`, message: armored, sender_message: armored, user: otherAgent, created_at: new Date().toISOString() } },
      AGENT_ID,
      "secret-agent"
    );
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(onMessageCalls, 2, "MAX_AGENT_TO_AGENT_REPLIES_PER_CHAT (2) still applies with no lane_kind");
});

// --- webhook.ts: request_floor's auto hand-off ----------------------------

test("a floor-request message triggers an automatic hand-off for the identity that opened the lane as asker, and never reaches onMessage", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const AGENT_ID = "40000000-0000-0000-0000-0000000000a1"; // the ASKER, hosted here
  const OTHER_AGENT_ID = "other-agent-2"; // the consulted agent, not hosted here
  const ROOM_ID = "room-2";
  const LANE_ID = "lane-floor-1";

  const store = sdk.createIdentityStore(tempStore("salt-floor-"));
  store.register({ saltAppId: AGENT_ID, username: "asker", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  // Exactly what consult_agent does right after opening the lane.
  sdk.registerConsultAsker(LANE_ID, AGENT_ID, ROOM_ID);

  const handOffCalls = [];
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
    },
    async handOff(apiKey, chatId, toAgentId, reason) {
      handOffCalls.push({ chatId, toAgentId, reason });
      return {};
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

  let onMessageCalls = 0;
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "agent-pass", logger: silent, async onMessage() { onMessageCalls++; } });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: "[[SALT-FLOOR-REQUEST]]\nfaster this way" }),
    encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }),
  });
  const res = await signedPost(
    port,
    {
      chat: { id: LANE_ID, lane_kind: "consult", coaching_for_chat_id: ROOM_ID },
      message: { chat_id: LANE_ID, message_id: "m-floor-1", message: armored, sender_message: armored, user: { id: OTHER_AGENT_ID, username: "consulted", account_type: "Agent" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(onMessageCalls, 0, "a floor request is wire protocol, never a prompt");
  assert.deepStrictEqual(handOffCalls, [{ chatId: ROOM_ID, toAgentId: OTHER_AGENT_ID, reason: "faster this way" }]);
});

test("a floor-request message in a lane this process did not open as asker is silently ignored", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const AGENT_ID = "40000000-0000-0000-0000-0000000000a2";
  const store = sdk.createIdentityStore(tempStore("salt-floor-unowned-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const handOffCalls = [];
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
    },
    async handOff(...args) {
      handOffCalls.push(args);
      return {};
    },
    async getChatMembers() {
      return [];
    },
    trackEvent() {},
  };
  let onMessageCalls = 0;
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "agent-pass", logger: silent, async onMessage() { onMessageCalls++; } });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: "[[SALT-FLOOR-REQUEST]]" }), encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }) });
  const res = await signedPost(
    port,
    {
      chat: { id: "unregistered-lane", lane_kind: "consult" },
      message: { chat_id: "unregistered-lane", message_id: "m-floor-2", message: armored, sender_message: armored, user: { id: "someone", username: "x", account_type: "Agent" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(onMessageCalls, 0);
  assert.strictEqual(handOffCalls.length, 0);
});

// --- webhook.ts: hand-off briefing carries the session note ---------------

test("a hand-off briefing carries the outgoing session's note, and the incoming side parses it in and strips the line", async (t) => {
  // Both identities are hosted by the SAME server, so they share ONE
  // pgpPassphrase (see WebhookServerOptions.pgpPassphrase) -- generate both
  // keys with it, not two different passphrases.
  const aKeys = await sdk.generateKeypair("shared-pass");
  const bKeys = await sdk.generateKeypair("shared-pass");
  const AGENT_A_ID = "50000000-0000-0000-0000-0000000000a1";
  const AGENT_B_ID = "50000000-0000-0000-0000-0000000000b1";
  const ROOM_ID = "room-3";

  const store = sdk.createIdentityStore(tempStore("salt-handoff-note-"));
  store.register({ saltAppId: AGENT_A_ID, username: "outgoing", apiKey: "key-a", publicKey: aKeys.publicKey, privateKey: aKeys.privateKey });
  store.register({ saltAppId: AGENT_B_ID, username: "incoming", apiKey: "key-b", publicKey: bKeys.publicKey, privateKey: bKeys.privateKey });

  const sessionStore = sdk.MemorySessionStore();
  const outgoingNote = { goal: "book a flight", consulted: [{ handle: "weather", laneId: "lane-9" }], lastReportId: "w_1" };
  const seeded = sdk.emptySession(ROOM_ID, ROOM_ID);
  seeded.note = outgoingNote;
  await sessionStore.put(AGENT_A_ID, ROOM_ID, seeded);

  const posted = [];
  const api = {
    async getWebhookSecret(apiKey) {
      return { "key-a": "secret-a", "key-b": "secret-b" }[apiKey];
    },
    async getChatMembers() {
      return [
        { id: AGENT_A_ID, username: "outgoing", public_key: aKeys.publicKey, account_type: "Agent" },
        { id: AGENT_B_ID, username: "incoming", public_key: bKeys.publicKey, account_type: "Agent" },
      ];
    },
    async getChatMessages() {
      return posted.map((p) => ({ event_type: null, message: p.message, user: { display_name: "Outgoing" } }));
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ chatId, message, senderMessage });
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  const receivedContexts = [];
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "shared-pass",
    logger: silent,
    sessionStore,
    async onHandoffConfirmed(ctx) {
      await ctx.reply(`${sdk.HANDOFF_BRIEFING_MARKER}\nHanding off -- here's where things stand.`);
    },
    async onHandoffReceived(ctx) {
      receivedContexts.push(ctx);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const confirmedRes = await signedPost(port, { type: "handoff_confirmed", from_agent_id: AGENT_A_ID, chat_id: ROOM_ID, reason: "done" }, AGENT_A_ID, "secret-a");
  assert.equal(confirmedRes.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(posted.length, 1);
  const briefingForB = await decryptWithPassphrase(posted[0].message, bKeys.privateKey, "shared-pass");
  assert.match(briefingForB, /^\[\[SALT-HANDOFF-BRIEFING\]\]/);
  assert.match(briefingForB, /\[\[SALT-SESSION-NOTE\]\] /);
  assert.deepStrictEqual(sdk.extractSessionNote(briefingForB), outgoingNote);

  const receivedRes = await signedPost(port, { type: "handoff_received", to_agent_id: AGENT_B_ID, chat_id: ROOM_ID, reason: "done" }, AGENT_B_ID, "secret-b");
  assert.equal(receivedRes.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(receivedContexts.length, 1);
  const ctx = receivedContexts[0];
  assert.doesNotMatch(ctx.context, /SALT-SESSION-NOTE/);
  assert.match(ctx.context, /Handing off -- here's where things stand\./);

  const bSession = await sessionStore.get(AGENT_B_ID, ROOM_ID);
  assert.deepStrictEqual(bSession.note, outgoingNote);
});
