// Open rooms, actions.ts half: every action that posts a wire-protocol
// message into a chat (delegate_to_agent, consult_agent, request_floor)
// reads that chat's `encrypted` from whatever payload it already fetches
// (or, for request_floor, a single client.getChat call) and posts PLAIN
// TEXT via the same postPlainMessage path client.ts's own open-room support
// uses when it's false, instead of PGP-encrypting -- never both, since
// salt-api refuses a ciphertext-shaped body on an open room and a plaintext
// one everywhere else. Cards/products/invoices need no such branch: they
// were already plain JSON with no client-side encryption on ANY chat.
//
// Also: webhook.ts's ChatOpenedContext.encrypted, read from the chat_opened
// payload's `chat.encrypted` (defaulted true when absent), so a greeting
// into an open room can be posted plain via client.postPlainMessage.
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

// --- actions.ts: delegate_to_agent --------------------------------------

test("delegate_to_agent posts PLAIN TEXT (no PGP) when the delegation chat is an open room", async () => {
  const callerKeys = await keypair("caller-open");
  const targetKeys = await keypair("target-open");

  const posted = [];
  const plainPosted = [];
  const client = {
    async getAgent() {
      return { id: "target-open-1", username: "weather", account_type: "Agent" };
    },
    async createOrGetChat() {
      // encrypted: false, and the target has NO public_key at all -- the
      // "usable public key" guard must not apply on an open room, since no
      // key is needed to post plain text.
      return { id: "deleg-open-1", encrypted: false, users: [{ id: "caller-open-1", username: "caller" }, { id: "target-open-1", username: "weather" }] };
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ chatId, message, senderMessage });
      return {};
    },
    async postPlainMessage(apiKey, chatId, text) {
      plainPosted.push({ chatId, text });
      setTimeout(() => sdk.resolveIfPending("deleg-open-1", "target-open-1", "Sunny."), 5);
      return {};
    },
    trackEvent() {},
  };

  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "caller-open-1", apiKey: "k", publicKey: callerKeys.publicKey };

  const result = await actions.execute(
    "delegate_to_agent",
    { target_agent_id: "target-open-1", task: "Forecast for Lisbon?" },
    caller,
    { depth: 0, mainChatId: null }
  );

  assert.strictEqual(result.delegated, true);
  assert.strictEqual(result.reply, "Sunny.");
  assert.strictEqual(posted.length, 0, "postMessage (PGP path) must never be called for an open room");
  assert.strictEqual(plainPosted.length, 1, "postPlainMessage must be called exactly once");
  assert.strictEqual(plainPosted[0].chatId, "deleg-open-1");
  assert.match(plainPosted[0].text, /Forecast for Lisbon\?/, "the wrapped task text rides plain, unencrypted");
});

test("delegate_to_agent still refuses a target with no usable public key on an ORDINARY (encrypted) chat", async () => {
  const callerKeys = await keypair("caller-open2");
  const client = {
    async getAgent() {
      return { id: "target-2", username: "weather", account_type: "Agent" };
    },
    async createOrGetChat() {
      // encrypted omitted entirely -- defaults to true, same as an older server.
      return { id: "deleg-2", users: [{ id: "caller-2", username: "caller" }, { id: "target-2", username: "weather" }] };
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "caller-2", apiKey: "k", publicKey: callerKeys.publicKey };

  await assert.rejects(
    actions.execute("delegate_to_agent", { target_agent_id: "target-2", task: "hi" }, caller, { depth: 0, mainChatId: null }),
    /no usable public key/
  );
});

// --- actions.ts: consult_agent -------------------------------------------

test("consult_agent posts PLAIN TEXT when the consult lane is an open room, bypassing the public-key requirement", async () => {
  const callerKeys = await keypair("caller-consult-open");

  const posted = [];
  const plainPosted = [];
  const client = {
    async getChatMembers() {
      return [
        { id: "caller-co-1", username: "caller", public_key: callerKeys.publicKey, account_type: "Agent" },
        // No public_key at all -- fine, since the lane below is open.
        { id: "target-co-1", username: "weather", account_type: "Agent" },
      ];
    },
    async openConsultLane() {
      return {
        session: {
          id: "lane-open-1",
          encrypted: false,
          users: [{ id: "caller-co-1" }, { id: "target-co-1" }],
        },
      };
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ chatId, message, senderMessage });
      return {};
    },
    async postPlainMessage(apiKey, chatId, text) {
      plainPosted.push({ chatId, text });
      setTimeout(() => sdk.resolveIfPending("lane-open-1", "target-co-1", "It'll rain."), 5);
      return {};
    },
    trackEvent() {},
  };

  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "caller-co-1", apiKey: "k", publicKey: callerKeys.publicKey };

  const result = await actions.execute(
    "consult_agent",
    { handle: "weather", question: "Rain tomorrow?" },
    caller,
    { depth: 0, mainChatId: "chat-co-1" }
  );

  assert.strictEqual(result.consulted, true);
  assert.strictEqual(result.reply, "It'll rain.");
  assert.strictEqual(posted.length, 0, "postMessage (PGP path) must never be called for an open lane");
  assert.strictEqual(plainPosted.length, 1);
  assert.strictEqual(plainPosted[0].chatId, "lane-open-1");
  assert.match(plainPosted[0].text, /Rain tomorrow\?/);
});

test("consult_agent still refuses a target with no usable public key in an ORDINARY (encrypted) lane", async () => {
  const callerKeys = await keypair("caller-consult-enc");
  const targetKeys = await keypair("target-consult-enc");
  const client = {
    async getChatMembers() {
      return [
        { id: "caller-ce-1", username: "caller", public_key: callerKeys.publicKey, account_type: "Agent" },
        { id: "target-ce-1", username: "weather", public_key: targetKeys.publicKey, account_type: "Agent" },
      ];
    },
    async openConsultLane() {
      // encrypted omitted -- defaults true; the lane's OWN member list has no key for the target.
      return { session: { id: "lane-enc-1", users: [{ id: "caller-ce-1", public_key: callerKeys.publicKey }] } };
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "caller-ce-1", apiKey: "k", publicKey: callerKeys.publicKey };

  await assert.rejects(
    actions.execute("consult_agent", { handle: "weather", question: "?" }, caller, { depth: 0, mainChatId: "chat-ce-1" }),
    /no usable public key in the lane/
  );
});

// --- actions.ts: request_floor --------------------------------------------

test("request_floor posts PLAIN TEXT via client.getChat when the lane is an open room, even with zero other members", async () => {
  const callerKeys = await keypair("caller-floor-open");

  const posted = [];
  const plainPosted = [];
  let getChatCalls = 0;
  const client = {
    async getChat(apiKey, chatId) {
      getChatCalls++;
      // Zero OTHER members -- would normally trip "No one in this lane to
      // ask for the floor", but must not on an open room (no keys needed).
      return { id: chatId, encrypted: false, users: [{ id: "caller-fo-1", username: "caller" }] };
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ chatId, message, senderMessage });
      return {};
    },
    async postPlainMessage(apiKey, chatId, text) {
      plainPosted.push({ chatId, text });
      return {};
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "caller-fo-1", apiKey: "k", publicKey: callerKeys.publicKey };

  const result = await actions.execute(
    "request_floor",
    { reason: "faster this way" },
    caller,
    { depth: 0, mainChatId: "lane-floor-open-1", laneKind: "consult" }
  );

  assert.strictEqual(result.requested, true);
  assert.strictEqual(getChatCalls, 1, "exactly one getChat call -- request_floor's one dependency for both members and encrypted status");
  assert.strictEqual(posted.length, 0);
  assert.strictEqual(plainPosted.length, 1);
  assert.match(plainPosted[0].text, /SALT-FLOOR-REQUEST/);
  assert.match(plainPosted[0].text, /faster this way/);
});

test("request_floor still refuses when there's no one to ask on an ORDINARY (encrypted) lane", async () => {
  const callerKeys = await keypair("caller-floor-enc");
  const client = {
    async getChat(apiKey, chatId) {
      // encrypted omitted -- defaults true; no other member with a key.
      return { id: chatId, encrypted: true, users: [{ id: "caller-fe-1", username: "caller" }] };
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "caller-fe-1", apiKey: "k", publicKey: callerKeys.publicKey };

  await assert.rejects(
    actions.execute("request_floor", { reason: "x" }, caller, { depth: 0, mainChatId: "lane-floor-enc-1", laneKind: "consult" }),
    /No one in this lane to ask for the floor/
  );
});

// --- webhook.ts: ChatOpenedContext.encrypted ------------------------------

function fakeChatOpenedApi(secretsByApiKey, members) {
  const posted = [];
  const plainPosted = [];
  return {
    posted,
    plainPosted,
    async getWebhookSecret(apiKey) {
      const secret = secretsByApiKey[apiKey];
      if (!secret) throw new sdk.SaltApiError("GET", "/api/v1/agents/webhook_secret", 401, { error: "unauthorized" });
      return secret;
    },
    async getChatMembers() {
      return members;
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ apiKey, chatId, message, senderMessage });
    },
    async postPlainMessage(apiKey, chatId, text) {
      plainPosted.push({ apiKey, chatId, text });
    },
    async signalTyping() {},
    trackEvent() {},
  };
}

test("ChatOpenedContext.encrypted is true when chat.encrypted is absent (an ordinary chat, or an older server)", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-co1");
  const AGENT_ID = "70000000-0000-0000-0000-0000000000a1";
  const store = sdk.createIdentityStore(tempStore("salt-open-co-"));
  store.register({ saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [{ id: AGENT_ID, username: "concierge", display_name: "Concierge", account_type: "Agent", public_key: agentKeys.publicKey }];
  const api = fakeChatOpenedApi({ "key-agent": "secret-agent" }, members);

  let seen;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "agent-pass-co1",
    logger: silent,
    onChatOpened(ctx) {
      seen = ctx.encrypted;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const res = await signedPost(
    port,
    { type: "chat_opened", chat: { id: "chat-open-1", mode: "auto" }, opened_by: members[0], members, opened_at: "2026-09-22T00:00:00Z" },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(seen, true);
});

test("ChatOpenedContext.encrypted is false when the delivery says chat.encrypted === false, so a greeting can be posted plain", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass-co2");
  const AGENT_ID = "70000000-0000-0000-0000-0000000000a2";
  const store = sdk.createIdentityStore(tempStore("salt-open-co2-"));
  store.register({ saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [{ id: AGENT_ID, username: "concierge", display_name: "Concierge", account_type: "Agent", public_key: agentKeys.publicKey }];
  const api = fakeChatOpenedApi({ "key-agent": "secret-agent" }, members);

  let seen;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "agent-pass-co2",
    logger: silent,
    async onChatOpened(ctx) {
      seen = ctx.encrypted;
      // The consumer's own choice, matching MessageContext.encrypted's
      // convention -- reply() always PGP-encrypts, so an open room greets
      // via postPlainMessage directly.
      if (!ctx.encrypted) await api.postPlainMessage(ctx.identity.apiKey, ctx.chatId, "Hi there.");
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const res = await signedPost(
    port,
    { type: "chat_opened", chat: { id: "chat-open-2", mode: "auto", encrypted: false }, opened_by: members[0], members, opened_at: "2026-09-22T00:00:00Z" },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(seen, false);
  assert.strictEqual(api.plainPosted.length, 1);
  assert.strictEqual(api.posted.length, 0, "reply()'s PGP path was never invoked");
});
