// A quiet hand-off, end to end (0.7.1). Four owner screenshots of a
// Concierge chat showed a lagging farewell followed by THREE Concierge
// replies: its own handoff_received intro (correct), a reply to the
// outgoing agent's "All set, taking you back!" farewell (wrong -- that's a
// goodbye, not a question), and a reply to the raw
// "[[SALT-HANDOFF-BRIEFING]]" message (wrong -- that's wire protocol).
//
// Two independent fixes, each pinned here:
//  1. A message that IS wire protocol (a hand-off briefing, a bare session
//     note line) never reaches onMessage at all -- webhook.ts's own
//     handleHandoffReceived poll (and the session-note reader) already
//     consume it; nothing else should ever see it as a prompt.
//  2. A message that ISN'T wire protocol but is agent-authored (a farewell,
//     an aside) is only ours to answer, in a chat with a real person in it,
//     when it @mentions us -- otherwise every agent in the room would hear
//     and answer every other agent's turn in front of the person. A lane
//     with no non-observer human (a consult lane, an agent-to-agent 1:1)
//     keeps the old runaway-reply cap instead, since there's no one there
//     to perform silence for.
//
// Also pinned: hand_off_to_agent / hand_back_to_concierge now carry
// `handedOff: true` on a successful result (actions.test-adjacent, but kept
// here since it's the other half of the same fix -- see knowledge in
// salt-claude-agent for what the host does with it).
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

const human = (id, username, observer = false) => ({ id, username, display_name: username, account_type: "User", observer });
const bot = (id, username, observer = false) => ({ id, username, display_name: username, account_type: "Agent", observer });

// --- item 1: wire-protocol messages never reach onMessage -----------------

test("a [[SALT-HANDOFF-BRIEFING]] message never reaches onMessage", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const AGENT_ID = "70000000-0000-0000-0000-0000000000a1";

  const store = sdk.createIdentityStore(tempStore("salt-handoff-quiet-briefing-"));
  store.register({ saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
    },
    async getChatMembers() {
      return [human("human-1", "dan"), bot(AGENT_ID, "concierge")];
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let onMessageCalls = 0;
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "agent-pass", logger: silent, async onMessage() { onMessageCalls++; } });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const armored = await encryptFor(`${sdk.HANDOFF_BRIEFING_MARKER}\nHanding off now. Dan wants a refund.`, agentKeys.publicKey);
  const res = await signedPost(
    port,
    {
      chat: { id: "chat-1" },
      message: {
        chat_id: "chat-1",
        message_id: "m-briefing-1",
        message: armored,
        sender_message: armored,
        user: { id: "other-agent", username: "claude", account_type: "Agent" },
        mentions: [],
        created_at: new Date().toISOString(),
      },
    },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(onMessageCalls, 0, "a hand-off briefing is wire protocol, never a prompt");
});

test("a bare [[SALT-SESSION-NOTE]] line never reaches onMessage", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass2");
  const AGENT_ID = "70000000-0000-0000-0000-0000000000a2";

  const store = sdk.createIdentityStore(tempStore("salt-handoff-quiet-note-"));
  store.register({ saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent2", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent2" ? "secret-agent2" : undefined;
    },
    async getChatMembers() {
      return [human("human-1", "dan"), bot(AGENT_ID, "concierge")];
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let onMessageCalls = 0;
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "agent-pass2", logger: silent, async onMessage() { onMessageCalls++; } });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const armored = await encryptFor(`${sdk.SESSION_NOTE_MARKER} {"goal":"refund"}`, agentKeys.publicKey);
  const res = await signedPost(
    port,
    {
      chat: { id: "chat-1" },
      message: {
        chat_id: "chat-1",
        message_id: "m-note-1",
        message: armored,
        sender_message: armored,
        user: { id: "other-agent", username: "claude", account_type: "Agent" },
        mentions: [],
        created_at: new Date().toISOString(),
      },
    },
    AGENT_ID,
    "secret-agent2"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(onMessageCalls, 0, "a bare session-note line is wire protocol, never a prompt");
});

// --- item 2: agent-authored messages in a chat with a real person ----------

test("an agent-authored message in a chat with a person present is NOT auto-replied to when it doesn't mention us", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass3");
  const AGENT_ID = "70000000-0000-0000-0000-0000000000a3";

  const store = sdk.createIdentityStore(tempStore("salt-handoff-quiet-nomention-"));
  store.register({ saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent3", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent3" ? "secret-agent3" : undefined;
    },
    async getChatMembers() {
      // A real person (dan) plus another agent (claude, observer after
      // handing off) -- exactly chat.rb's execute_hand_off! shape.
      return [human("human-1", "dan"), bot("other-agent", "claude", true), bot(AGENT_ID, "concierge")];
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let onMessageCalls = 0;
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "agent-pass3", logger: silent, async onMessage() { onMessageCalls++; } });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const armored = await encryptFor("All set, taking you back to the concierge now!", agentKeys.publicKey);
  const res = await signedPost(
    port,
    {
      chat: { id: "chat-1" },
      message: {
        chat_id: "chat-1",
        message_id: "m-farewell-1",
        message: armored,
        sender_message: armored,
        user: { id: "other-agent", username: "claude", account_type: "Agent" },
        created_at: new Date().toISOString(),
      },
    },
    AGENT_ID,
    "secret-agent3"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(onMessageCalls, 0, "an unmentioned agent farewell is not ours to answer while a person is in the room");
});

test("the same agent-authored message IS delivered when it mentions us", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass4");
  const AGENT_ID = "70000000-0000-0000-0000-0000000000a4";

  const store = sdk.createIdentityStore(tempStore("salt-handoff-quiet-mention-"));
  store.register({ saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent4", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent4" ? "secret-agent4" : undefined;
    },
    async getChatMembers() {
      return [human("human-1", "dan"), bot("other-agent", "claude"), bot(AGENT_ID, "concierge")];
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let onMessageCalls = 0;
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "agent-pass4", logger: silent, async onMessage() { onMessageCalls++; } });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const armored = await encryptFor("@concierge can you take the refund from here?", agentKeys.publicKey);
  const res = await signedPost(
    port,
    {
      chat: { id: "chat-1" },
      message: {
        chat_id: "chat-1",
        message_id: "m-mention-1",
        message: armored,
        sender_message: armored,
        user: { id: "other-agent", username: "claude", account_type: "Agent" },
        mentions: [AGENT_ID],
        created_at: new Date().toISOString(),
      },
    },
    AGENT_ID,
    "secret-agent4"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.strictEqual(onMessageCalls, 1, "a message that actually names us is still ours to answer");
});

test("a consult lane (no non-observer human) keeps the old runaway-reply cap regardless of mentions", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass5");
  const AGENT_ID = "70000000-0000-0000-0000-0000000000a5";

  const store = sdk.createIdentityStore(tempStore("salt-handoff-quiet-lane-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent5", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent5" ? "secret-agent5" : undefined;
    },
    async getChatMembers() {
      // Only the two agents in the lane -- the delegation-observability
      // human, if any, is an OBSERVER here, never a real participant.
      return [bot("other-agent", "scribe"), bot(AGENT_ID, "helper"), human("human-1", "dan", true)];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  let onMessageCalls = 0;
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "agent-pass5", logger: silent, async onMessage(ctx) { onMessageCalls++; await ctx.reply("ok"); } });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  for (let i = 1; i <= 3; i++) {
    const armored = await encryptFor(`turn ${i}`, agentKeys.publicKey);
    await signedPost(
      port,
      {
        chat: { id: "lane-1", lane_kind: "consult" },
        message: { chat_id: "lane-1", message_id: `m-lane-${i}`, message: armored, sender_message: armored, user: { id: "other-agent", username: "scribe", account_type: "Agent" }, created_at: new Date().toISOString() },
      },
      AGENT_ID,
      "secret-agent5"
    );
    await new Promise((r) => setTimeout(r, 100));
  }

  assert.strictEqual(onMessageCalls, 3, "the consult lane's higher runaway cap (20) still governs -- no mention needed");
});

// --- item 3: a successful hand-off result carries handedOff: true ---------

test("hand_off_to_agent and hand_back_to_concierge results carry handedOff: true on success", async () => {
  const client = {
    async getAgent(apiKey, id) {
      return { id, username: "billing", display_name: "Billing", account_type: "Agent" };
    },
    async handOff() {
      return {};
    },
    async handBack() {
      return {};
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "", conciergeAgentId: "concierge-1" });

  const offResult = await actions.execute("hand_off_to_agent", { agent_id: "billing", reason: "billing question" }, { saltAppId: "agent-a", apiKey: "k" }, { depth: 0, mainChatId: "chat-1" });
  assert.strictEqual(offResult.handedOff, true);
  assert.strictEqual(offResult.handed_off, true);

  const backResult = await actions.execute("hand_back_to_concierge", { reason: "done here" }, { saltAppId: "agent-b", apiKey: "k" }, { depth: 0, mainChatId: "chat-1" });
  assert.strictEqual(backResult.handedOff, true);
  assert.strictEqual(backResult.handed_off, true);
});

test("a refused hand-off does NOT carry handedOff: true", async () => {
  const client = {
    async getAgent(apiKey, id) {
      return { id, username: "billing", display_name: "Billing", account_type: "Agent" };
    },
    async handOff() {
      throw new sdk.SaltApiError("POST", "/x", 422, { error: "nope" });
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const result = await actions.execute("hand_off_to_agent", { agent_id: "billing", reason: "billing question" }, { saltAppId: "agent-a", apiKey: "k" }, { depth: 0, mainChatId: "chat-1" });
  assert.strictEqual(result.refused, true);
  assert.strictEqual(result.handedOff, undefined);
});
