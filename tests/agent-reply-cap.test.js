// maxAgentToAgentReplies (webhook.ts): how many messages from AGENT senders one
// chat may deliver before the dispatcher stops answering them there. Default 2
// (the runaway guard between two hosted agents); a host whose agent really talks
// with an allow-listed agent raises it. Driven through createDispatcher, the one
// both createWebhookServer and createSocketClient end in, with open-room
// (plaintext) deliveries from an agent account in a chat with no person in it.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

const BOT_ID = "b0b0b0b0-7e57-4c0d-a1f2-0000000000b1";
const PEER_ID = "a1a1a1a1-7e57-4c0d-a1f2-0000000000a2";
const HUMAN_ID = "3f2a9c1e-7d4b-4e8a-9b21-5c6d7e8f9a01";
const CHAT = "11111111-1111-4111-8111-111111111111";

const bot = { saltAppId: BOT_ID, username: "bot", apiKey: "bot-key", publicKey: "fake-pub", privateKey: "fake-priv" };
const members = [
  { id: BOT_ID, username: "bot", account_type: "Agent" },
  { id: PEER_ID, username: "peer", account_type: "Agent" },
  { id: HUMAN_ID, username: "dan", account_type: "User" },
];

function setup(options, { humanPresent = false } = {}) {
  const store = { get: (id) => (String(id).toLowerCase() === BOT_ID ? bot : undefined), all: () => [bot], register() {}, reassignId: () => undefined };
  const client = {
    async getChatMembers() {
      return humanPresent ? members : members.slice(0, 2);
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
  const seen = [];
  const logs = [];
  const dispatcher = sdk.createDispatcher({
    client,
    identities: store,
    pgpPassphrase: "unused",
    logger: { info() {}, error: (m) => logs.push(m) },
    onMessage: async (ctx) => {
      seen.push(ctx.text);
    },
    ...options,
  });
  let n = 0;
  const deliver = (sender, text) =>
    dispatcher.dispatch(
      {
        chat: { id: CHAT },
        message: {
          chat_id: CHAT,
          message_id: `m-${Math.random().toString(36).slice(2)}-${++n}`,
          message: text,
          encrypted: false,
          user: { id: sender.id, username: sender.username, account_type: sender.account_type },
          created_at: new Date().toISOString(),
        },
      },
      BOT_ID
    );
  return { deliver, seen, logs, peer: members[1], human: members[2] };
}

test("default: the third message from an agent in a person-free chat is dropped, with the cap logged", async () => {
  const { deliver, seen, logs, peer } = setup({});
  for (const text of ["one", "two", "three", "four"]) await deliver(peer, text);
  assert.deepStrictEqual(seen, ["one", "two"]);
  assert.ok(logs.some((l) => /agent-to-agent reply cap reached/.test(l)));
});

test("maxAgentToAgentReplies raises the cap, and the cap still holds at the new number", async () => {
  const { deliver, seen, logs, peer } = setup({ maxAgentToAgentReplies: 5 });
  for (let i = 1; i <= 7; i++) await deliver(peer, `m${i}`);
  assert.deepStrictEqual(seen, ["m1", "m2", "m3", "m4", "m5"]);
  assert.ok(logs.some((l) => /agent-to-agent reply cap reached/.test(l)));
});

test("a person speaking resets the count, whatever the cap", async () => {
  const { deliver, seen, peer, human } = setup({ maxAgentToAgentReplies: 2 });
  await deliver(peer, "a1");
  await deliver(peer, "a2");
  await deliver(peer, "dropped");
  await deliver(human, "hello from a person");
  await deliver(peer, "a3");
  assert.deepStrictEqual(seen, ["a1", "a2", "hello from a person", "a3"]);
});

test("the option is a positive integer", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => setup({ maxAgentToAgentReplies: bad }), /maxAgentToAgentReplies must be a positive integer/);
  }
});

test("createSocketClient passes the option to its dispatcher (same options object)", () => {
  assert.throws(
    () =>
      sdk.createSocketClient({
        client: {},
        identities: { get: () => undefined, all: () => [], register() {}, reassignId: () => undefined },
        pgpPassphrase: "x",
        host: "http://127.0.0.1:9",
        apiKey: "k",
        agentId: BOT_ID,
        cursorStore: sdk.MemoryCursorStore(),
        dedupeStore: sdk.MemoryDedupeStore(),
        maxAgentToAgentReplies: 0,
      }),
    /maxAgentToAgentReplies must be a positive integer/
  );
});
