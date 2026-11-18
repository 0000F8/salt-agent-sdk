// The screen card: marker build/parse, client.showScreen, the show_screen action.
const test = require("node:test");
const assert = require("node:assert");
const openpgp = require("openpgp");
const sdk = require("../dist/index.js");

const S = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";

async function keypair(name) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{ name }], format: "armored" });
  return { privateKey, publicKey };
}
async function decryptArmored(armoredPrivate, armoredMessage) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivate });
  const message = await openpgp.readMessage({ armoredMessage });
  return (await openpgp.decrypt({ message, decryptionKeys: privateKey })).data;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test("buildScreenMarker and parseScreenMarker round trip", () => {
  const text = sdk.buildScreenMarker({ sessionId: S, deviceId: D, caption: "Here is the laptop" });
  assert.equal(text, `[[SALT-SCREEN session=${S} device=${D}]]\nHere is the laptop`);
  assert.deepEqual(sdk.parseScreenMarker(text), { sessionId: S, deviceId: D, caption: "Here is the laptop" });
  assert.equal(sdk.isScreenMessage(text), true);
  assert.deepEqual(sdk.parseScreenMarker(sdk.buildScreenMarker({ sessionId: S, deviceId: D })), { sessionId: S, deviceId: D, caption: "" });
});

test("parseScreenMarker ignores unknown attributes and rejects malformed markers", () => {
  assert.deepEqual(sdk.parseScreenMarker(`[[SALT-SCREEN device=${D} session=${S} x=1]]\nhi`), { sessionId: S, deviceId: D, caption: "hi" });
  assert.equal(sdk.parseScreenMarker(`[[SALT-SCREEN session=nope device=${D}]]\nhi`), null);
  assert.equal(sdk.parseScreenMarker(`[[SALT-SCREEN session=${S}]]\nhi`), null);
  assert.equal(sdk.parseScreenMarker(`[[SALT-SCREEN session=${S} device=${D}\nhi`), null);
  assert.equal(sdk.parseScreenMarker(`[[SALT-SCREEN session=${S} device=${D}]]\n${"a".repeat(201)}`), null);
  assert.equal(sdk.parseScreenMarker("plain text"), null);
  assert.equal(sdk.isScreenMessage("plain text"), false);
});

test("buildScreenMarker refuses bad ids, multi-line and over-long captions", () => {
  assert.throws(() => sdk.buildScreenMarker({ sessionId: "x", deviceId: D }), /sessionId/);
  assert.throws(() => sdk.buildScreenMarker({ sessionId: S, deviceId: "x" }), /deviceId/);
  assert.throws(() => sdk.buildScreenMarker({ sessionId: S, deviceId: D, caption: "a\nb" }), /one line/);
  assert.throws(() => sdk.buildScreenMarker({ sessionId: S, deviceId: D, caption: "a".repeat(201) }), /200/);
});

async function world(encrypted) {
  const agent = await keypair("agent");
  const human = await keypair("human");
  const users = [
    { id: "agent-1", public_key: agent.publicKey },
    { id: "human-1", public_key: human.publicKey },
  ];
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : undefined });
    if (url.includes("/api/v1/chats/chat-1")) return json(200, { session: { users, encrypted } });
    if (url.endsWith("/api/v1/messages") && opts.method === "POST") return json(201, { id: "msg-9" });
    return json(404, {});
  };
  return { agent, human, calls, client: sdk.createSaltClient({ host: "https://salt.test", fetchImpl }) };
}

test("showScreen posts an encrypted marker the person and the agent can read", async () => {
  const { agent, human, calls, client } = await world();
  const res = await client.showScreen("agent-key", { chatId: "chat-1", sessionId: S, deviceId: D, caption: "Look", selfId: "agent-1" });
  assert.equal(res.message_id, "msg-9");
  const post = calls.find((c) => c.url.endsWith("/api/v1/messages"));
  const plain = await decryptArmored(human.privateKey, post.body.message);
  assert.deepEqual(sdk.parseScreenMarker(plain), { sessionId: S, deviceId: D, caption: "Look" });
  assert.equal(await decryptArmored(agent.privateKey, post.body.sender_message), plain);
});

test("showScreen refuses a plain chat and bad ids before posting", async () => {
  const w = await world(false);
  await assert.rejects(() => w.client.showScreen("k", { chatId: "chat-1", sessionId: S, deviceId: D, selfId: "agent-1" }), /encrypted/);
  await assert.rejects(() => w.client.showScreen("k", { chatId: "chat-1", sessionId: "x", deviceId: D, selfId: "agent-1" }), /sessionId/);
  assert.equal(w.calls.some((c) => c.method === "POST"), false);
});

test("show_screen is a declared action that defaults to the current chat", async () => {
  const seen = [];
  const client = { trackEvent() {}, async showScreen(key, p) { seen.push([key, p]); return { message_id: "m1" }; } };
  const store = { get: () => undefined, list: () => [] };
  const actions = sdk.createActions({ client, identities: store, pgpPassphrase: "p", publicWebhookUrl: "https://a.test/hook" });
  const def = actions.definitions.find((d) => d.name === "show_screen");
  assert.deepEqual(def.schema.required, ["session_id", "device_id"]);
  const caller = { saltAppId: "agent-1", apiKey: "agent-key", publicKey: "k" };
  const out = await actions.execute("show_screen", { session_id: S, device_id: D, caption: "Look" }, caller, { depth: 0, mainChatId: "chat-1" });
  assert.equal(out.shown, true);
  assert.deepEqual(seen[0], ["agent-key", { chatId: "chat-1", sessionId: S, deviceId: D, caption: "Look", selfId: "agent-1" }]);
  await assert.rejects(() => actions.execute("show_screen", { device_id: D }, caller, { depth: 0, mainChatId: "c" }), /session_id/);
  await assert.rejects(() => actions.execute("show_screen", { session_id: S, device_id: D }, caller, { depth: 0, mainChatId: null }), /chat_id/);
});
