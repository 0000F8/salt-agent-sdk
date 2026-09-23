// Identity on Salt, R3 + R4 (identityShare.ts): the signed SLICE wire
// format and its round-trip parser, createIdentitySharer's share/ask/
// decline/revoke against a fake client (no HTTP -- same style
// consult.test.js uses for actions.ts), and webhook.ts's dispatcher-level
// wiring of onIdentityAsk/onIdentityShared over a real signed HTTP POST
// (same style reply-context-sessions.test.js uses).
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


// --- Wire format: format* / parseIdentityMarker round-trip ----------------

test("formatIdentityAsk / parseIdentityMarker round-trips, with and without trailing text", () => {
  const bare = sdk.formatIdentityAsk("ask-1", ["bio", "link"]);
  assert.strictEqual(bare, "[[SALT-IDENTITY-ASK id=ask-1 keys=bio,link]]");
  assert.deepStrictEqual(sdk.parseIdentityMarker(bare), { kind: "ask", id: "ask-1", keys: ["bio", "link"], text: undefined });

  const withText = sdk.formatIdentityAsk("ask-2", ["bio"], "Mind sharing your bio?");
  assert.strictEqual(withText, "[[SALT-IDENTITY-ASK id=ask-2 keys=bio]]\nMind sharing your bio?");
  assert.deepStrictEqual(sdk.parseIdentityMarker(withText), { kind: "ask", id: "ask-2", keys: ["bio"], text: "Mind sharing your bio?" });
});

test("formatIdentitySlice / parseIdentityMarker round-trips the sections+signature JSON, with and without ask=", () => {
  const sections = [{ key: "bio", value: "Forecasts for any city.", proof: null }];
  const plain = sdk.formatIdentitySlice("slice-1", sections, "armored-sig");
  assert.strictEqual(plain, '[[SALT-IDENTITY-SLICE id=slice-1]]\n{"sections":[{"key":"bio","value":"Forecasts for any city.","proof":null}],"signature":"armored-sig"}');
  const parsedPlain = sdk.parseIdentityMarker(plain);
  assert.strictEqual(parsedPlain.kind, "slice");
  assert.strictEqual(parsedPlain.id, "slice-1");
  assert.strictEqual(parsedPlain.askId, undefined);
  assert.deepStrictEqual(parsedPlain.payload, { sections, signature: "armored-sig" });

  const answering = sdk.formatIdentitySlice("slice-2", sections, "sig2", "ask-9");
  assert.strictEqual(answering.split("\n")[0], "[[SALT-IDENTITY-SLICE id=slice-2 ask=ask-9]]");
  const parsedAnswering = sdk.parseIdentityMarker(answering);
  assert.strictEqual(parsedAnswering.askId, "ask-9");
});

test("formatIdentityDecline / formatIdentityRevoke round-trip, DECLINE carrying ask= when answering one", () => {
  const bareDecline = sdk.formatIdentityDecline("dec-1");
  assert.strictEqual(bareDecline, "[[SALT-IDENTITY-DECLINE id=dec-1]]");
  assert.deepStrictEqual(sdk.parseIdentityMarker(bareDecline), { kind: "decline", id: "dec-1", askId: undefined });

  const answeringDecline = sdk.formatIdentityDecline("dec-2", "ask-7");
  assert.strictEqual(answeringDecline, "[[SALT-IDENTITY-DECLINE id=dec-2 ask=ask-7]]");
  assert.deepStrictEqual(sdk.parseIdentityMarker(answeringDecline), { kind: "decline", id: "dec-2", askId: "ask-7" });

  const revoke = sdk.formatIdentityRevoke("slice-1");
  assert.strictEqual(revoke, "[[SALT-IDENTITY-REVOKE id=slice-1]]");
  assert.deepStrictEqual(sdk.parseIdentityMarker(revoke), { kind: "revoke", id: "slice-1" });
});

test("parseIdentityMarker returns null for a malformed marker rather than guessing", () => {
  assert.strictEqual(sdk.parseIdentityMarker("[[SALT-IDENTITY-ASK id=bad!id keys=bio]]"), null, "an id outside [A-Za-z0-9_-] must not parse");
  assert.strictEqual(sdk.parseIdentityMarker("[[SALT-IDENTITY-ASK id=ask-1]]"), null, "an ASK with no keys= must not parse");
  assert.strictEqual(sdk.parseIdentityMarker("[[SALT-IDENTITY-SLICE id=s-1]]\nnot json"), null);
  assert.strictEqual(sdk.parseIdentityMarker("[[SALT-IDENTITY-SLICE id=s-1]]\n{\"sections\":[]}"), null, "a SLICE with no signature must not parse");
  assert.strictEqual(sdk.parseIdentityMarker("just an ordinary message"), null);
});

// --- createIdentitySharer against a fake client (no HTTP) -----------------

test("share() posts one ledger row per non-observer non-self member, then signs, sends once, and PATCHes message_id on every row", async () => {
  const agentKeys = await sdk.generateKeypair("share-pass");
  const danKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const dan = { id: "human-1", public_key: danKeys.publicKey };

  const calls = [];
  let postedMessage;
  const client = {
    async getChatMembers() {
      return [
        { id: "agent-1", account_type: "Agent", public_key: agentKeys.publicKey },
        dan,
        { id: "observer-1", account_type: "User", public_key: "irrelevant", observer: true },
      ];
    },
    async identity() {
      return { sections: [{ key: "bio", label: "Bio", value: "Forecasts for any city.", scope: "everyone", kind: "claim" }], card_url: "https://salt.test/card" };
    },
    async postIdentityDisclosure(apiKey, params) {
      calls.push(["post", params]);
      return { id: params.id, section_keys: params.section_keys, scope: params.scope, chat_id: params.chat_id, recipient_id: params.recipient_id, created_at: new Date().toISOString() };
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      postedMessage = message;
      calls.push(["postMessage"]);
      return { message_id: "msg-1" };
    },
    async setIdentityDisclosureMessage(apiKey, disclosureId, messageId) {
      calls.push(["patch", disclosureId, messageId]);
      return {};
    },
  };

  const sharer = sdk.createIdentitySharer(client, "share-pass");
  const result = await sharer.share({ saltAppId: "agent-1", apiKey: "key-1", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey }, "chat-1", ["bio"]);

  assert.strictEqual(result.messageId, "msg-1");
  assert.strictEqual(result.disclosures.length, 1, "the observer must be excluded");
  assert.strictEqual(result.disclosures[0].recipientId, "human-1");

  const order = calls.map((c) => c[0]);
  assert.deepStrictEqual(order, ["post", "postMessage", "patch"], "ledger row before the message, PATCH after");
  assert.strictEqual(calls[2][1], result.disclosures[0].id);
  assert.strictEqual(calls[2][2], "msg-1");

  // Readable by the recipient, and the slice signature verifies against the AGENT's own public key.
  const message = await openpgp.readMessage({ armoredMessage: postedMessage });
  const { data: plaintext } = await openpgp.decrypt({ message, decryptionKeys: [await openpgp.readPrivateKey({ armoredKey: danKeys.privateKey })] });
  const parsed = sdk.parseIdentityMarker(plaintext);
  assert.strictEqual(parsed.kind, "slice");
  assert.strictEqual(parsed.id, result.disclosures[0].id);
  assert.deepStrictEqual(parsed.payload.sections, [{ key: "bio", value: "Forecasts for any city.", proof: null }]);
  const ok = await sdk.verifyDetached(sdk.canonicalizeJcs(parsed.payload.sections), parsed.payload.signature, agentKeys.publicKey);
  assert.strictEqual(ok, true, "the slice's signature must verify against the agent's own public key");
});

test("share() aborts on the first 422 with nothing sent", async () => {
  const agentKeys = await sdk.generateKeypair("abort-pass");
  const calls = [];
  const client = {
    async getChatMembers() {
      return [
        { id: "agent-1", account_type: "Agent", public_key: agentKeys.publicKey },
        { id: "human-1", account_type: "User", public_key: "pub-1" },
        { id: "human-2", account_type: "User", public_key: "pub-2" },
      ];
    },
    async identity() {
      return { sections: [{ key: "bio", value: "hi", scope: "named", kind: "claim" }], card_url: "x" };
    },
    async postIdentityDisclosure(apiKey, params) {
      calls.push(params.recipient_id);
      if (params.recipient_id === "human-2") {
        throw new sdk.SaltApiError("POST", "https://salt.test/api/v1/identity/disclosures", 422, { error: "bio is not shared with human-2." });
      }
      return { id: params.id };
    },
    async postMessage() {
      calls.push("SENT");
      return { message_id: "should-not-happen" };
    },
    async setIdentityDisclosureMessage() {
      calls.push("PATCHED");
    },
  };

  const sharer = sdk.createIdentitySharer(client, "abort-pass");
  await assert.rejects(
    sharer.share({ saltAppId: "agent-1", apiKey: "key-1", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey }, "chat-1", ["bio"]),
    (err) => {
      assert.ok(err instanceof sdk.SaltApiError);
      assert.match(err.message, /bio is not shared with human-2/);
      return true;
    }
  );
  assert.deepStrictEqual(calls, ["human-1", "human-2"], "never reaches postMessage/PATCH once a row is refused");
});

test("share() refuses locally for a nobody-scoped section without ever posting a ledger row", async () => {
  const agentKeys = await sdk.generateKeypair("nobody-pass");
  let postedDisclosure = false;
  const client = {
    async getChatMembers() {
      return [
        { id: "agent-1", account_type: "Agent", public_key: agentKeys.publicKey },
        { id: "human-1", account_type: "User", public_key: "pub-1" },
      ];
    },
    async identity() {
      return { sections: [{ key: "bio", value: "hi", scope: "nobody", kind: "claim" }], card_url: "x" };
    },
    async postIdentityDisclosure() {
      postedDisclosure = true;
      return {};
    },
  };
  const sharer = sdk.createIdentitySharer(client, "nobody-pass");
  await assert.rejects(
    sharer.share({ saltAppId: "agent-1", apiKey: "key-1", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey }, "chat-1", ["bio"]),
    /not a section this agent shares/
  );
  assert.strictEqual(postedDisclosure, false);
});

test("ask() refuses outside a 1:1 chat, before sending anything", async () => {
  const agentKeys = await sdk.generateKeypair("ask-refuse-pass");
  let sent = false;
  const client = {
    async getChat() {
      return { id: "group-1", encrypted: true, users: [{ id: "agent-1" }, { id: "human-1" }, { id: "human-2" }] };
    },
    async postMessage() {
      sent = true;
    },
  };
  const sharer = sdk.createIdentitySharer(client, "ask-refuse-pass");
  await assert.rejects(
    sharer.ask({ saltAppId: "agent-1", apiKey: "key-1", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey }, "group-1", ["bio"]),
    /1:1 chat/
  );
  assert.strictEqual(sent, false);
});

test("ask() sends the ASK marker into a 1:1 and returns its id", async () => {
  const agentKeys = await sdk.generateKeypair("ask-ok-pass");
  const danKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  let posted;
  const client = {
    async getChat() {
      return { id: "dm-1", encrypted: true, users: [{ id: "agent-1", public_key: agentKeys.publicKey }, { id: "human-1", public_key: danKeys.publicKey }] };
    },
    async postMessage(apiKey, chatId, message) {
      posted = { chatId, message };
      return { message_id: "m-ask" };
    },
  };
  const sharer = sdk.createIdentitySharer(client, "ask-ok-pass");
  const id = await sharer.ask({ saltAppId: "agent-1", apiKey: "key-1", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey }, "dm-1", ["bio", "link"], "Mind sharing?");

  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(posted.chatId, "dm-1");
  const message = await openpgp.readMessage({ armoredMessage: posted.message });
  const { data: plaintext } = await openpgp.decrypt({ message, decryptionKeys: [await openpgp.readPrivateKey({ armoredKey: danKeys.privateKey })] });
  const parsed = sdk.parseIdentityMarker(plaintext);
  assert.strictEqual(parsed.kind, "ask");
  assert.strictEqual(parsed.id, id);
  assert.deepStrictEqual(parsed.keys, ["bio", "link"]);
  assert.strictEqual(parsed.text, "Mind sharing?");
});

test("revoke() calls revokeIdentityDisclosure then sends a REVOKE marker into that disclosure's chat", async () => {
  const agentKeys = await sdk.generateKeypair("revoke-pass");
  const danKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const calls = [];
  let posted;
  const client = {
    async revokeIdentityDisclosure(apiKey, id) {
      calls.push("revoked");
      return { id, chat_id: "chat-9", recipient_id: "human-1", section_keys: ["bio"], scope: "named", created_at: "x", revoked_at: new Date().toISOString() };
    },
    async getChatMembers() {
      return [{ id: "agent-1", account_type: "Agent", public_key: agentKeys.publicKey }, { id: "human-1", account_type: "User", public_key: danKeys.publicKey }];
    },
    async postMessage(apiKey, chatId, message) {
      calls.push("sent");
      posted = { chatId, message };
      return { message_id: "m-revoke" };
    },
  };
  const sharer = sdk.createIdentitySharer(client, "revoke-pass");
  const row = await sharer.revoke({ saltAppId: "agent-1", apiKey: "key-1", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey }, "disc-1");

  assert.strictEqual(row.chat_id, "chat-9");
  assert.deepStrictEqual(calls, ["revoked", "sent"]);
  assert.strictEqual(posted.chatId, "chat-9");

  const message = await openpgp.readMessage({ armoredMessage: posted.message });
  const { data: plaintext } = await openpgp.decrypt({ message, decryptionKeys: [await openpgp.readPrivateKey({ armoredKey: danKeys.privateKey })] });
  assert.deepStrictEqual(sdk.parseIdentityMarker(plaintext), { kind: "revoke", id: "disc-1" });
});

// --- webhook.ts dispatcher wiring: onIdentityAsk / onIdentityShared -------

test("an incoming ASK with onIdentityAsk registered never reaches onMessage, and a returned key set answers with a SLICE carrying ask=", async (t) => {
  const agentKeys = await sdk.generateKeypair("dispatch-ask-pass");
  const danKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const AGENT_ID = "70000000-0000-0000-0000-00000000a001";
  const CHAT_ID = "chat-ask-1";

  const store = sdk.createIdentityStore(tempStore("salt-identity-ask-"));
  store.register({ saltAppId: AGENT_ID, username: "weatherbot", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [
    { id: AGENT_ID, username: "weatherbot", account_type: "Agent", public_key: agentKeys.publicKey },
    { id: "human-1", username: "dan", account_type: "User", public_key: danKeys.publicKey },
  ];
  let posted;
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
    },
    async getChatMembers() {
      return members;
    },
    async getChatMessages() {
      return [];
    },
    async identity() {
      return { sections: [{ key: "bio", value: "Forecasts for any city.", scope: "everyone", kind: "claim" }], card_url: "x" };
    },
    async postIdentityDisclosure(apiKey, params) {
      return { id: params.id, section_keys: params.section_keys, scope: params.scope, chat_id: params.chat_id, recipient_id: params.recipient_id, created_at: new Date().toISOString() };
    },
    async postMessage(apiKey, chatId, message) {
      posted = message;
      return { message_id: "m-slice" };
    },
    async setIdentityDisclosureMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let onMessageCalled = false;
  let onAskInfo = null;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "dispatch-ask-pass",
    logger: silent,
    async onIdentityAsk(info) {
      onAskInfo = info;
      return ["bio"];
    },
    async onMessage() {
      onMessageCalled = true;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const askPlaintext = sdk.formatIdentityAsk("ask-abc", ["bio"], "Mind sharing your bio?");
  const armored = await encryptFor(askPlaintext, agentKeys.publicKey);
  const res = await signedPost(
    port,
    {
      chat: { id: CHAT_ID },
      message: { chat_id: CHAT_ID, message_id: "m-in-1", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(onMessageCalled, false, "an ASK with a handler registered must never reach onMessage");
  assert.ok(onAskInfo);
  assert.strictEqual(onAskInfo.id, "ask-abc");
  assert.deepStrictEqual(onAskInfo.keys, ["bio"]);
  assert.strictEqual(onAskInfo.text, "Mind sharing your bio?");
  assert.strictEqual(onAskInfo.from, "human-1");

  assert.ok(posted, "a SLICE message was sent");
  const inMessage = await openpgp.readMessage({ armoredMessage: posted });
  const { data: plaintext } = await openpgp.decrypt({ message: inMessage, decryptionKeys: [await openpgp.readPrivateKey({ armoredKey: danKeys.privateKey })] });
  const parsed = sdk.parseIdentityMarker(plaintext);
  assert.strictEqual(parsed.kind, "slice");
  assert.strictEqual(parsed.askId, "ask-abc");
  assert.deepStrictEqual(
    parsed.payload.sections.map((s) => s.key),
    ["bio"]
  );
});

test("an incoming ASK with onIdentityAsk returning null answers with a DECLINE carrying ask=", async (t) => {
  const agentKeys = await sdk.generateKeypair("dispatch-decline-pass");
  const danKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const AGENT_ID = "70000000-0000-0000-0000-00000000a002";
  const CHAT_ID = "chat-ask-2";

  const store = sdk.createIdentityStore(tempStore("salt-identity-decline-"));
  store.register({ saltAppId: AGENT_ID, username: "weatherbot2", apiKey: "key-agent2", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [
    { id: AGENT_ID, username: "weatherbot2", account_type: "Agent", public_key: agentKeys.publicKey },
    { id: "human-1", username: "dan", account_type: "User", public_key: danKeys.publicKey },
  ];
  let posted;
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
    async postMessage(apiKey, chatId, message) {
      posted = message;
      return { message_id: "m-decline" };
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let onMessageCalled = false;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "dispatch-decline-pass",
    logger: silent,
    async onIdentityAsk() {
      return null;
    },
    async onMessage() {
      onMessageCalled = true;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const askPlaintext = sdk.formatIdentityAsk("ask-xyz", ["bio"]);
  const armored = await encryptFor(askPlaintext, agentKeys.publicKey);
  const res = await signedPost(
    port,
    {
      chat: { id: CHAT_ID },
      message: { chat_id: CHAT_ID, message_id: "m-in-2", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent2"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(onMessageCalled, false);
  assert.ok(posted);
  const message = await openpgp.readMessage({ armoredMessage: posted });
  const { data: plaintext } = await openpgp.decrypt({ message, decryptionKeys: [await openpgp.readPrivateKey({ armoredKey: danKeys.privateKey })] });
  const parsed = sdk.parseIdentityMarker(plaintext);
  assert.strictEqual(parsed.kind, "decline");
  assert.strictEqual(parsed.askId, "ask-xyz");
});

test("an incoming ASK with no onIdentityAsk handler falls through to onMessage as ordinary text, marker stripped", async (t) => {
  const agentKeys = await sdk.generateKeypair("dispatch-fallthrough-pass");
  const AGENT_ID = "70000000-0000-0000-0000-00000000a003";
  const CHAT_ID = "chat-ask-3";

  const store = sdk.createIdentityStore(tempStore("salt-identity-fallthrough-"));
  store.register({ saltAppId: AGENT_ID, username: "plainbot", apiKey: "key-agent3", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent3" ? "secret-agent3" : undefined;
    },
    async getChatMembers() {
      return [{ id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey }, { id: "human-1", account_type: "User", public_key: "pub-1" }];
    },
    async getChatMessages() {
      return [];
    },
    async postMessage() {
      return { message_id: "unused" };
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let seenText;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "dispatch-fallthrough-pass",
    logger: silent,
    // onIdentityAsk deliberately NOT registered.
    async onMessage(ctx) {
      seenText = ctx.text;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const askPlaintext = sdk.formatIdentityAsk("ask-fallthrough", ["bio"], "Got a bio for me?");
  const armored = await encryptFor(askPlaintext, agentKeys.publicKey);
  const res = await signedPost(
    port,
    {
      chat: { id: CHAT_ID },
      message: { chat_id: CHAT_ID, message_id: "m-in-3", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent3"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(seenText, "Got a bio for me?", "the marker line is stripped; the trailing text reaches onMessage as ordinary text");
});

test("an incoming SLICE is verified against the sender's public key, recorded on the session, exposed via onIdentityShared, and never reaches onMessage", async (t) => {
  const agentKeys = await sdk.generateKeypair("dispatch-slice-pass");
  const danKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const AGENT_ID = "70000000-0000-0000-0000-00000000a004";
  const CHAT_ID = "chat-slice-1";

  const store = sdk.createIdentityStore(tempStore("salt-identity-slice-"));
  store.register({ saltAppId: AGENT_ID, username: "recorder", apiKey: "key-agent4", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey },
    { id: "human-1", username: "dan", account_type: "User", public_key: danKeys.publicKey },
  ];
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent4" ? "secret-agent4" : undefined;
    },
    async getChatMembers() {
      return members;
    },
    async getChatMessages() {
      return [];
    },
    async postMessage() {
      return { message_id: "unused" };
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let onMessageCalled = false;
  let sharedEvent = null;
  let sessionAfter = null;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "dispatch-slice-pass",
    logger: silent,
    async onIdentityShared(event) {
      sharedEvent = event;
    },
    async onMessage(ctx) {
      onMessageCalled = true;
      sessionAfter = ctx.session;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const sections = [{ key: "legal_name", value: "Dana Reyes", proof: null }];
  const signed = await openpgp.sign({
    message: await openpgp.createMessage({ text: sdk.canonicalizeJcs(sections) }),
    signingKeys: await openpgp.readPrivateKey({ armoredKey: danKeys.privateKey }),
    detached: true,
    format: "armored",
  });
  const slicePlaintext = sdk.formatIdentitySlice("slice-abc", sections, signed);
  const armored = await encryptFor(slicePlaintext, agentKeys.publicKey);
  const res = await signedPost(
    port,
    {
      chat: { id: CHAT_ID },
      message: { chat_id: CHAT_ID, message_id: "m-in-4", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent4"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(onMessageCalled, false, "a SLICE must never reach onMessage");
  assert.ok(sharedEvent);
  assert.strictEqual(sharedEvent.kind, "slice");
  assert.strictEqual(sharedEvent.id, "slice-abc");
  assert.strictEqual(sharedEvent.from, "human-1");
  assert.strictEqual(sharedEvent.verified, true, "a real signature from the sender's own key must verify");

  // A following ordinary message lets us read back what the session recorded.
  const followUp = await encryptFor("hi again", agentKeys.publicKey);
  const res2 = await signedPost(
    port,
    {
      chat: { id: CHAT_ID },
      message: { chat_id: CHAT_ID, message_id: "m-in-5", message: followUp, sender_message: followUp, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent4"
  );
  assert.equal(res2.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(onMessageCalled);
  assert.ok(sessionAfter.identity["human-1"], "the slice was recorded under the sender's id");
  assert.strictEqual(sessionAfter.identity["human-1"][0].id, "slice-abc");
  assert.strictEqual(sessionAfter.identity["human-1"][0].verified, true);
});

test("an incoming SLICE with a tampered signature is recorded as unverified, never thrown", async (t) => {
  const agentKeys = await sdk.generateKeypair("dispatch-tamper-pass");
  const danKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const otherKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const AGENT_ID = "70000000-0000-0000-0000-00000000a005";
  const CHAT_ID = "chat-slice-2";

  const store = sdk.createIdentityStore(tempStore("salt-identity-tamper-"));
  store.register({ saltAppId: AGENT_ID, username: "recorder2", apiKey: "key-agent5", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey },
    { id: "human-1", username: "dan", account_type: "User", public_key: danKeys.publicKey },
  ];
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent5" ? "secret-agent5" : undefined;
    },
    async getChatMembers() {
      return members;
    },
    async getChatMessages() {
      return [];
    },
    async postMessage() {
      return { message_id: "unused" };
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let sharedEvent = null;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "dispatch-tamper-pass",
    logger: silent,
    async onIdentityShared(event) {
      sharedEvent = event;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const sections = [{ key: "legal_name", value: "Dana Reyes", proof: null }];
  // Signed with a DIFFERENT key than the sender's own (member public_key is danKeys) -- must not verify.
  const signed = await openpgp.sign({
    message: await openpgp.createMessage({ text: sdk.canonicalizeJcs(sections) }),
    signingKeys: await openpgp.readPrivateKey({ armoredKey: otherKeys.privateKey }),
    detached: true,
    format: "armored",
  });
  const slicePlaintext = sdk.formatIdentitySlice("slice-bad", sections, signed);
  const armored = await encryptFor(slicePlaintext, agentKeys.publicKey);
  const res = await signedPost(
    port,
    {
      chat: { id: CHAT_ID },
      message: { chat_id: CHAT_ID, message_id: "m-in-6", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() },
    },
    AGENT_ID,
    "secret-agent5"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(sharedEvent);
  assert.strictEqual(sharedEvent.verified, false);
});

test("an incoming REVOKE forgets the matching recorded slice and is exposed via onIdentityShared", async (t) => {
  const agentKeys = await sdk.generateKeypair("dispatch-revoke-pass");
  const danKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const AGENT_ID = "70000000-0000-0000-0000-00000000a006";
  const CHAT_ID = "chat-revoke-1";

  const store = sdk.createIdentityStore(tempStore("salt-identity-revoke-"));
  store.register({ saltAppId: AGENT_ID, username: "recorder3", apiKey: "key-agent6", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey },
    { id: "human-1", username: "dan", account_type: "User", public_key: danKeys.publicKey },
  ];
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent6" ? "secret-agent6" : undefined;
    },
    async getChatMembers() {
      return members;
    },
    async getChatMessages() {
      return [];
    },
    async postMessage() {
      return { message_id: "unused" };
    },
    async signalTyping() {},
    trackEvent() {},
  };

  const events = [];
  let sessionAfterRevoke = null;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "dispatch-revoke-pass",
    logger: silent,
    async onIdentityShared(event) {
      events.push(event);
    },
    async onMessage(ctx) {
      sessionAfterRevoke = ctx.session;
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const sections = [{ key: "legal_name", value: "Dana Reyes", proof: null }];
  const signed = await openpgp.sign({
    message: await openpgp.createMessage({ text: sdk.canonicalizeJcs(sections) }),
    signingKeys: await openpgp.readPrivateKey({ armoredKey: danKeys.privateKey }),
    detached: true,
    format: "armored",
  });
  const sliceArmored = await encryptFor(sdk.formatIdentitySlice("slice-to-revoke", sections, signed), agentKeys.publicKey);
  await signedPost(
    port,
    { chat: { id: CHAT_ID }, message: { chat_id: CHAT_ID, message_id: "m-in-7", message: sliceArmored, sender_message: sliceArmored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() } },
    AGENT_ID,
    "secret-agent6"
  );
  await new Promise((r) => setTimeout(r, 150));

  const revokeArmored = await encryptFor(sdk.formatIdentityRevoke("slice-to-revoke"), agentKeys.publicKey);
  await signedPost(
    port,
    { chat: { id: CHAT_ID }, message: { chat_id: CHAT_ID, message_id: "m-in-8", message: revokeArmored, sender_message: revokeArmored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() } },
    AGENT_ID,
    "secret-agent6"
  );
  await new Promise((r) => setTimeout(r, 150));

  const followUp = await encryptFor("checking", agentKeys.publicKey);
  await signedPost(
    port,
    { chat: { id: CHAT_ID }, message: { chat_id: CHAT_ID, message_id: "m-in-9", message: followUp, sender_message: followUp, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() } },
    AGENT_ID,
    "secret-agent6"
  );
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].kind, "slice");
  assert.strictEqual(events[1].kind, "revoke");
  assert.strictEqual(events[1].id, "slice-to-revoke");
  assert.ok(sessionAfterRevoke);
  assert.deepStrictEqual(sessionAfterRevoke.identity["human-1"], [], "the revoked slice was forgotten");
});

test("ctx.shareIdentity(keys) from onMessage calls through to the same share() the SDK exposes on identity.share", async (t) => {
  const agentKeys = await sdk.generateKeypair("dispatch-ctxshare-pass");
  const danKeys = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const AGENT_ID = "70000000-0000-0000-0000-00000000a007";
  const CHAT_ID = "chat-ctxshare-1";

  const store = sdk.createIdentityStore(tempStore("salt-identity-ctxshare-"));
  store.register({ saltAppId: AGENT_ID, username: "sharer", apiKey: "key-agent7", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey },
    { id: "human-1", username: "dan", account_type: "User", public_key: danKeys.publicKey },
  ];
  let posted;
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent7" ? "secret-agent7" : undefined;
    },
    async getChatMembers() {
      return members;
    },
    async getChatMessages() {
      return [];
    },
    async identity() {
      return { sections: [{ key: "bio", value: "Hello.", scope: "everyone", kind: "claim" }], card_url: "x" };
    },
    async postIdentityDisclosure(apiKey, params) {
      return { id: params.id, section_keys: params.section_keys, scope: params.scope, chat_id: params.chat_id, recipient_id: params.recipient_id, created_at: new Date().toISOString() };
    },
    async postMessage(apiKey, chatId, message) {
      posted = message;
      return { message_id: "m-ctxshare" };
    },
    async setIdentityDisclosureMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "dispatch-ctxshare-pass",
    logger: silent,
    async onMessage(ctx) {
      await ctx.shareIdentity(["bio"]);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const armored = await encryptFor("share your bio please", agentKeys.publicKey);
  const res = await signedPost(
    port,
    { chat: { id: CHAT_ID }, message: { chat_id: CHAT_ID, message_id: "m-in-10", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() } },
    AGENT_ID,
    "secret-agent7"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(posted);
  const message = await openpgp.readMessage({ armoredMessage: posted });
  const { data: plaintext } = await openpgp.decrypt({ message, decryptionKeys: [await openpgp.readPrivateKey({ armoredKey: danKeys.privateKey })] });
  const parsed = sdk.parseIdentityMarker(plaintext);
  assert.strictEqual(parsed.kind, "slice");
  assert.deepStrictEqual(parsed.payload.sections.map((s) => s.key), ["bio"]);
});
