// hand_back_to_concierge (actions.ts): a real one step back via
// client.handBack (salt-api's POST /chats/:id/hand_off/back), so
// Concierge -> A -> B's hand-back returns to A, not straight past it to a
// fixed concierge id. Falls back to hand-off-to-the-configured-concierge
// ONLY on a 422 ("Already at the start of this conversation.") -- any other
// error from handBack propagates untouched.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

test("hand_back_to_concierge calls handBack first, and does NOT fall back when it succeeds", async () => {
  const handBackCalls = [];
  const handOffCalls = [];
  const client = {
    async handBack(apiKey, chatId) {
      handBackCalls.push({ apiKey, chatId });
      return {};
    },
    async handOff(apiKey, chatId, toAgentId, reason) {
      handOffCalls.push({ apiKey, chatId, toAgentId, reason });
      return {};
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "", conciergeAgentId: "concierge-1" });
  const caller = { saltAppId: "agent-b", apiKey: "k" };

  const result = await actions.execute("hand_back_to_concierge", { reason: "done here" }, caller, { depth: 0, mainChatId: "chat-1" });
  assert.strictEqual(result.handed_off, true);
  assert.strictEqual(result.to, "previous");
  assert.deepStrictEqual(handBackCalls, [{ apiKey: "k", chatId: "chat-1" }]);
  assert.strictEqual(handOffCalls.length, 0, "no fallback when handBack succeeds");
});

test("hand_back_to_concierge falls back to the configured concierge only on a 422 from handBack", async () => {
  const handOffCalls = [];
  const client = {
    async handBack() {
      throw new sdk.SaltApiError("POST", "/api/v1/chats/chat-1/hand_off/back", 422, { error: "Already at the start of this conversation." });
    },
    async handOff(apiKey, chatId, toAgentId, reason) {
      handOffCalls.push({ apiKey, chatId, toAgentId, reason });
      return {};
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "", conciergeAgentId: "concierge-1" });
  const caller = { saltAppId: "agent-first", apiKey: "k" };

  const result = await actions.execute("hand_back_to_concierge", { reason: "done here" }, caller, { depth: 0, mainChatId: "chat-1" });
  assert.strictEqual(result.handed_off, true);
  assert.strictEqual(result.to, "concierge");
  assert.deepStrictEqual(handOffCalls, [{ apiKey: "k", chatId: "chat-1", toAgentId: "concierge-1", reason: "done here" }]);
});

test("hand_back_to_concierge propagates a non-422 error from handBack without falling back", async () => {
  const handOffCalls = [];
  const client = {
    async handBack() {
      throw new sdk.SaltApiError("POST", "/api/v1/chats/chat-1/hand_off/back", 500, { error: "boom" });
    },
    async handOff(...args) {
      handOffCalls.push(args);
      return {};
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "", conciergeAgentId: "concierge-1" });
  const caller = { saltAppId: "agent-b", apiKey: "k" };

  await assert.rejects(actions.execute("hand_back_to_concierge", { reason: "x" }, caller, { depth: 0, mainChatId: "chat-1" }), /boom/);
  assert.strictEqual(handOffCalls.length, 0);
});

test("hand_back_to_concierge on a 422 with no concierge configured refuses clearly", async () => {
  const client = {
    async handBack() {
      throw new sdk.SaltApiError("POST", "/x", 422, { error: "Already at the start of this conversation." });
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-b", apiKey: "k" };
  await assert.rejects(actions.execute("hand_back_to_concierge", {}, caller, { depth: 0, mainChatId: "chat-1" }), /No concierge is configured/);
});

test("hand_back_to_concierge on a 422 when the caller IS the concierge refuses clearly", async () => {
  const client = {
    async handBack() {
      throw new sdk.SaltApiError("POST", "/x", 422, { error: "Already at the start of this conversation." });
    },
    trackEvent() {},
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "", conciergeAgentId: "concierge-1" });
  const caller = { saltAppId: "concierge-1", apiKey: "k" };
  await assert.rejects(actions.execute("hand_back_to_concierge", {}, caller, { depth: 0, mainChatId: "chat-1" }), /You already are the concierge/);
});
