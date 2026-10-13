// isPrivateChat mirrors salt-personal-agent's brain.chat_is_private, plus "no
// observer at all", and fails closed on anything the chat record cannot show.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

const SPEAKER = "00000000-0000-0000-0000-0000000000b2";
const ME = "00000000-0000-0000-0000-0000000000a1";
const record = (session) => ({ id: "chat-1", session });
const oneToOne = () => record({ encrypted: true, public: false, users: [{ id: SPEAKER }, { id: ME, observer: false }] });

test("isPrivateChat: an encrypted, non-public 1:1 of exactly the speaker and me is private", () => {
  assert.strictEqual(sdk.isPrivateChat(oneToOne(), SPEAKER, ME), true);
});

test("isPrivateChat: a private lane (coaching_for_chat_id set) is private too, like brain.chat_is_private", () => {
  const lane = record({ encrypted: true, users: [{ id: SPEAKER }, { id: ME }], coaching_for_chat_id: "room-1" });
  assert.strictEqual(sdk.isPrivateChat(lane, SPEAKER, ME), true);
});

test("isPrivateChat: an absent encrypted flag means encrypted; an explicit false does not", () => {
  assert.strictEqual(sdk.isPrivateChat(record({ users: [{ id: SPEAKER }, { id: ME }] }), SPEAKER, ME), true);
  assert.strictEqual(sdk.isPrivateChat(record({ encrypted: false, users: [{ id: SPEAKER }, { id: ME }] }), SPEAKER, ME), false);
});

test("isPrivateChat: a public chat is never private", () => {
  assert.strictEqual(sdk.isPrivateChat(record({ encrypted: true, public: true, users: [{ id: SPEAKER }, { id: ME }] }), SPEAKER, ME), false);
});

test("isPrivateChat: a third member makes it not private", () => {
  const group = record({ encrypted: true, users: [{ id: SPEAKER }, { id: ME }, { id: "someone-else" }] });
  assert.strictEqual(sdk.isPrivateChat(group, SPEAKER, ME), false);
});

test("isPrivateChat: ANY observer, silent or not, makes it not private (unlike brain.chat_is_private, which ignores them)", () => {
  const watched = record({ encrypted: true, users: [{ id: SPEAKER }, { id: ME }, { id: "owner-1", observer: true }] });
  assert.strictEqual(sdk.isPrivateChat(watched, SPEAKER, ME), false);
  const meObserving = record({ encrypted: true, users: [{ id: SPEAKER }, { id: ME, observer: true }] });
  assert.strictEqual(sdk.isPrivateChat(meObserving, SPEAKER, ME), false);
});

test("isPrivateChat: someone other than the speaker is not private to the speaker", () => {
  assert.strictEqual(sdk.isPrivateChat(oneToOne(), "someone-else", ME), false);
  const withOther = record({ encrypted: true, users: [{ id: "someone-else" }, { id: ME }] });
  assert.strictEqual(sdk.isPrivateChat(withOther, SPEAKER, ME), false);
});

test("isPrivateChat: a chat with only me (or only the speaker) is not a conversation between the two", () => {
  assert.strictEqual(sdk.isPrivateChat(record({ encrypted: true, users: [{ id: ME }] }), SPEAKER, ME), false);
  assert.strictEqual(sdk.isPrivateChat(record({ encrypted: true, users: [{ id: SPEAKER }] }), SPEAKER, ME), false);
  assert.strictEqual(sdk.isPrivateChat(oneToOne(), ME, ME), false);
});

test("isPrivateChat: any missing field fails closed", () => {
  assert.strictEqual(sdk.isPrivateChat(null, SPEAKER, ME), false);
  assert.strictEqual(sdk.isPrivateChat(undefined, SPEAKER, ME), false);
  assert.strictEqual(sdk.isPrivateChat({}, SPEAKER, ME), false, "no session");
  assert.strictEqual(sdk.isPrivateChat(record({ encrypted: true }), SPEAKER, ME), false, "no member list");
  assert.strictEqual(sdk.isPrivateChat(record({ encrypted: true, users: "nope" }), SPEAKER, ME), false, "member list not a list");
  assert.strictEqual(sdk.isPrivateChat(record({ encrypted: true, users: [{ id: SPEAKER }, { id: ME }, {}] }), SPEAKER, ME), false, "a member with no id");
  assert.strictEqual(sdk.isPrivateChat(record({ encrypted: true, users: [{ id: SPEAKER }, { id: ME }, null] }), SPEAKER, ME), false, "a null member");
  assert.strictEqual(sdk.isPrivateChat(oneToOne(), undefined, ME), false);
  assert.strictEqual(sdk.isPrivateChat(oneToOne(), SPEAKER, null), false);
  assert.strictEqual(sdk.isPrivateChat(oneToOne(), "", ME), false);
});

test("isPrivateChat: ids compare case-insensitively", () => {
  assert.strictEqual(sdk.isPrivateChat(oneToOne(), SPEAKER.toUpperCase(), ME.toUpperCase()), true);
});

test("client.getChatRecord returns Salt's chat record verbatim, fetched fresh", async () => {
  const seen = [];
  const client = sdk.createSaltClient({
    host: "https://salt.test",
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), key: init.headers["api-key"] });
      return new Response(JSON.stringify(oneToOne()), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const chat = await client.getChatRecord("key-1", "chat-1");
  assert.match(seen[0].url, /^https:\/\/salt\.test\/api\/v1\/chats\/chat-1\?_=\d+$/);
  assert.strictEqual(seen[0].key, "key-1");
  assert.strictEqual(sdk.isPrivateChat(chat, SPEAKER, ME), true);
});
