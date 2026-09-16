// hand_off_to_agent (actions.ts): a hand-off Salt refuses (403 or 422 from
// client.handOff) is not a bug in this tool call -- it's an answer, so it
// comes back as a normal RESULT ({ok: false, refused: true, reason,
// next_step}) instead of a throw. That gives the model one consistent
// instruction instead of three different guesses at what a raw error meant.
// Any other status (e.g. 500) still throws -- that IS a bug.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

function makeClient(handOffImpl) {
  return {
    async getAgent(apiKey, id) {
      return { id, username: "weather", display_name: "Weather Bot", account_type: "Agent" };
    },
    async handOff(...args) {
      return handOffImpl(...args);
    },
    trackEvent() {},
  };
}

test("hand_off_to_agent returns a refusal result on a 403 from handOff", async () => {
  const client = makeClient(async () => {
    throw new sdk.SaltApiError("POST", "/api/v1/chats/chat-1/hand_off", 403, { error: "You can't hand off to a blocked agent." });
  });
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-a", apiKey: "k" };

  const result = await actions.execute("hand_off_to_agent", { agent_id: "weather", reason: "weather question" }, caller, {
    depth: 0,
    mainChatId: "chat-1",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.refused, true);
  assert.strictEqual(result.reason, "You can't hand off to a blocked agent.");
  assert.strictEqual(result.next_step, "Tell the person they can open @weather from Salt's agent directory and message them directly.");
});

test("hand_off_to_agent returns a refusal result on a 422 from handOff", async () => {
  const client = makeClient(async () => {
    throw new sdk.SaltApiError("POST", "/api/v1/chats/chat-1/hand_off", 422, { error: "The person has not said anything since the last hand-off." });
  });
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-a", apiKey: "k" };

  const result = await actions.execute("hand_off_to_agent", { agent_id: "weather", reason: "weather question" }, caller, {
    depth: 0,
    mainChatId: "chat-1",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.refused, true);
  assert.strictEqual(result.reason, "The person has not said anything since the last hand-off.");
  assert.strictEqual(result.next_step, "Tell the person they can open @weather from Salt's agent directory and message them directly.");
});

test("hand_off_to_agent propagates a non-refusal error (500) from handOff", async () => {
  const client = makeClient(async () => {
    throw new sdk.SaltApiError("POST", "/api/v1/chats/chat-1/hand_off", 500, { error: "boom" });
  });
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-a", apiKey: "k" };

  await assert.rejects(
    actions.execute("hand_off_to_agent", { agent_id: "weather", reason: "weather question" }, caller, { depth: 0, mainChatId: "chat-1" }),
    /boom/
  );
});

test("hand_off_to_agent still succeeds normally when handOff does not throw", async () => {
  const calls = [];
  const client = makeClient(async (apiKey, chatId, toAgentId, reason) => {
    calls.push({ apiKey, chatId, toAgentId, reason });
    return {};
  });
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-a", apiKey: "k" };

  const result = await actions.execute("hand_off_to_agent", { agent_id: "weather", reason: "weather question" }, caller, {
    depth: 0,
    mainChatId: "chat-1",
  });
  assert.strictEqual(result.handed_off, true);
  assert.deepStrictEqual(calls, [{ apiKey: "k", chatId: "chat-1", toAgentId: "weather", reason: "weather question" }]);
});
