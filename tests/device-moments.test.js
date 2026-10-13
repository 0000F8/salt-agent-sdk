// Device moments: device_session_ended (end_reason "lost_contact" when the
// person's computer stopped answering for 15 s mid-session) and device_back
// (the same computer answering again, once per lost session, within 24 h).
// Both are plaintext agent-rail deliveries, so they are dispatched directly
// (like mandate-events.test.js); only device_back's reply() needs real PGP.
// Shapes follow salt-api's DeviceSessionEventJob / DeviceBackEventJob and
// docs/DEVICE_PROTOCOL.md.
const test = require("node:test");
const assert = require("node:assert");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");
const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
const PERSON_ID = "00000000-0000-0000-0000-0000000000b2";
const DEVICE_ID = "00000000-0000-0000-0000-0000000000d3";
const SESSION_ID = "00000000-0000-0000-0000-0000000005e5";
const CHAT_ID = "00000000-0000-0000-0000-0000000000c4";

function identityStore(identities) {
  const byId = new Map(identities.map((i) => [String(i.saltAppId).toLowerCase(), i]));
  return {
    get: (id) => byId.get(String(id).toLowerCase()),
    all: () => Array.from(byId.values()),
    register(identity) {
      byId.set(String(identity.saltAppId).toLowerCase(), identity);
    },
    reassignId: () => undefined,
  };
}

const endedBody = (overrides = {}) => ({
  type: "device_session_ended",
  event: "ended",
  session_id: SESSION_ID,
  id: SESSION_ID,
  agent_id: AGENT_ID,
  device_id: DEVICE_ID,
  mandate_id: "mandate-1",
  chat_id: "lane-1",
  status: "ended",
  intent: "Reply to Maya in Mail",
  end_reason: "lost_contact",
  ended_at: "2026-10-12T09:00:15.000Z",
  chat: { id: "lane-1", readers: { ids: [PERSON_ID], open: false } },
  ...overrides,
});

const backBody = (overrides = {}) => ({
  type: "device_back",
  device_id: DEVICE_ID,
  device_name: "Work Mac",
  previous_session_id: SESSION_ID,
  offline_at: "2026-10-12T09:00:15.000Z",
  back_at: "2026-10-12T09:03:02.000Z",
  chat_id: CHAT_ID,
  chat: { id: CHAT_ID, readers: { ids: [PERSON_ID], open: false } },
  ...overrides,
});

test("device_session_ended reaches onDeviceSessionEnded with lostContact set for lost_contact", async () => {
  const agent = { saltAppId: AGENT_ID, username: "helper", apiKey: "k", publicKey: "x", privateKey: "y" };
  const got = [];
  const dispatcher = sdk.createDispatcher({
    client: { trackEvent() {} },
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: silent,
    onDeviceSessionEnded: (ctx) => got.push(ctx),
  });
  await dispatcher.dispatch(endedBody(), AGENT_ID);
  assert.strictEqual(got.length, 1);
  const ctx = got[0];
  assert.strictEqual(ctx.identity.saltAppId, AGENT_ID);
  assert.strictEqual(ctx.sessionId, SESSION_ID);
  assert.strictEqual(ctx.deviceId, DEVICE_ID);
  assert.strictEqual(ctx.endReason, "lost_contact");
  assert.strictEqual(ctx.lostContact, true);
  assert.strictEqual(ctx.laneChatId, "lane-1", "the device lane, not the person's 1:1");
  assert.strictEqual(ctx.intent, "Reply to Maya in Mail");
  assert.strictEqual(ctx.endedAt, "2026-10-12T09:00:15.000Z");
  assert.strictEqual(ctx.body.mandate_id, "mandate-1");
  assert.strictEqual(typeof ctx.reply, "undefined", "no reply(): the lane is not where the person reads");
});

test("device_session_ended fires for every end_reason but lostContact is only true for lost_contact", async () => {
  const agent = { saltAppId: AGENT_ID, username: "helper", apiKey: "k", publicKey: "x", privateKey: "y" };
  const got = [];
  const dispatcher = sdk.createDispatcher({
    client: { trackEvent() {} },
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: silent,
    onDeviceSessionEnded: (ctx) => got.push([ctx.endReason, ctx.lostContact]),
  });
  await dispatcher.dispatch(endedBody({ end_reason: "stopped_by_person" }), AGENT_ID);
  await dispatcher.dispatch(endedBody({ end_reason: null }), AGENT_ID);
  assert.deepStrictEqual(got, [["stopped_by_person", false], [null, false]]);
});

test("device_session_ended resolves the identity by X-Salt-Agent-Id, else the body's agent_id, and ignores the device's own copy", async () => {
  const agent = { saltAppId: AGENT_ID, username: "helper", apiKey: "k", publicKey: "x", privateKey: "y" };
  const device = { saltAppId: DEVICE_ID, username: "mac", apiKey: "dk", publicKey: "x", privateKey: "y" };
  const got = [];
  const dispatcher = sdk.createDispatcher({
    client: { trackEvent() {} },
    identities: identityStore([agent, device]),
    pgpPassphrase: "x",
    logger: silent,
    onDeviceSessionEnded: (ctx) => got.push(ctx.identity.saltAppId),
  });
  await dispatcher.dispatch(endedBody()); // no header: falls back to agent_id
  await dispatcher.dispatch(endedBody(), AGENT_ID);
  await dispatcher.dispatch(endedBody(), DEVICE_ID); // the computer hosting its own session
  assert.deepStrictEqual(got, [AGENT_ID, AGENT_ID]);
});

test("device events without a matching hosted identity or without a handler are dropped silently", async () => {
  let called = 0;
  const dispatcher = sdk.createDispatcher({
    client: { trackEvent() {} },
    identities: identityStore([]),
    pgpPassphrase: "x",
    logger: silent,
    onDeviceSessionEnded: () => called++,
    onDeviceBack: () => called++,
  });
  await dispatcher.dispatch(endedBody(), AGENT_ID);
  await dispatcher.dispatch(backBody(), AGENT_ID);
  const agent = { saltAppId: AGENT_ID, username: "helper", apiKey: "k", publicKey: "x", privateKey: "y" };
  const bare = sdk.createDispatcher({ client: { trackEvent() {} }, identities: identityStore([agent]), pgpPassphrase: "x", logger: silent });
  await bare.dispatch(endedBody(), AGENT_ID);
  await bare.dispatch(backBody(), AGENT_ID);
  assert.strictEqual(called, 0);
});

test("a throwing device handler is logged, not thrown", async () => {
  const agent = { saltAppId: AGENT_ID, username: "helper", apiKey: "k", publicKey: "x", privateKey: "y" };
  const errors = [];
  const dispatcher = sdk.createDispatcher({
    client: { trackEvent() {} },
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: { info() {}, error: (m) => errors.push(m) },
    onDeviceSessionEnded: () => {
      throw new Error("boom");
    },
    onDeviceBack: async () => {
      throw new Error("bang");
    },
  });
  await dispatcher.dispatch(endedBody(), AGENT_ID);
  await dispatcher.dispatch(backBody({ chat_id: null }), AGENT_ID);
  assert.match(errors[0], /onDeviceSessionEnded failed: boom/);
  assert.match(errors[1], /onDeviceBack failed: bang/);
});

test("device_back reaches onDeviceBack with every field, and reply() encrypts for the 1:1 and lands in the session", async () => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const personKeys = await sdk.generateKeypair("person-pass");
  const agent = { saltAppId: AGENT_ID, username: "helper", apiKey: "k", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const members = [
    { id: PERSON_ID, username: "ada", display_name: "Ada", account_type: "User", public_key: personKeys.publicKey },
    { id: AGENT_ID, username: "helper", display_name: "Helper", account_type: "Agent", public_key: agentKeys.publicKey },
  ];
  const posted = [];
  const client = {
    async getChatMembers() {
      return members;
    },
    async getChatMessages() {
      return [];
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ apiKey, chatId, message, senderMessage });
    },
    async signalTyping() {},
    trackEvent() {},
  };
  const sessionStore = sdk.MemorySessionStore();
  let seenCtx;
  const dispatcher = sdk.createDispatcher({
    client,
    identities: identityStore([agent]),
    pgpPassphrase: "agent-pass",
    logger: silent,
    sessionStore,
    onDeviceBack: async (ctx) => {
      seenCtx = ctx;
      await ctx.reply("Work Mac is back. Want me to finish “Reply to Maya in Mail”?");
    },
  });
  await dispatcher.dispatch(backBody(), AGENT_ID);

  assert.strictEqual(seenCtx.deviceId, DEVICE_ID);
  assert.strictEqual(seenCtx.deviceName, "Work Mac");
  assert.strictEqual(seenCtx.previousSessionId, SESSION_ID);
  assert.strictEqual(seenCtx.offlineAt, "2026-10-12T09:00:15.000Z");
  assert.strictEqual(seenCtx.backAt, "2026-10-12T09:03:02.000Z");
  assert.strictEqual(seenCtx.chatId, CHAT_ID);
  assert.strictEqual(seenCtx.body.chat.readers.ids[0], PERSON_ID);

  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].chatId, CHAT_ID);
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: posted[0].message }),
    decryptionKeys: await openpgp.decryptKey({
      privateKey: await openpgp.readPrivateKey({ armoredKey: personKeys.privateKey }),
      passphrase: "person-pass",
    }),
  });
  assert.match(data, /Work Mac is back/);

  const session = await sessionStore.get(AGENT_ID, CHAT_ID);
  assert.strictEqual(session.transcriptTail.at(-1).role, "assistant");
  assert.match(session.transcriptTail.at(-1).content, /Want me to finish/);
});

test("device_back with chat_id null: ctx.chatId and ctx.session are null and reply() throws a clear error", async () => {
  const agent = { saltAppId: AGENT_ID, username: "helper", apiKey: "k", publicKey: "x", privateKey: "y" };
  let outcome;
  const dispatcher = sdk.createDispatcher({
    client: { trackEvent() {} },
    identities: identityStore([agent]),
    pgpPassphrase: "x",
    logger: silent,
    onDeviceBack: async (ctx) => {
      assert.strictEqual(ctx.chatId, null);
      assert.strictEqual(ctx.session, null);
      outcome = await ctx.reply("hi").then(() => "sent", (e) => e.message);
    },
  });
  await dispatcher.dispatch(backBody({ chat_id: null, chat: undefined }), AGENT_ID);
  assert.match(outcome, /no 1:1 with this agent/);
});

test("DEVICE_LOST_CONTACT is exported", () => {
  assert.strictEqual(sdk.DEVICE_LOST_CONTACT, "lost_contact");
});
