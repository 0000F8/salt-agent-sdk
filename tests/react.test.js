// client.react / ctx.react / the react_to_message action, against a mock
// server shaped like salt-api's ReactionsController (the real answer is
// {message_id, reactions: [{emoji, count, user_ids}]}; a refusal is a 422
// {error: "<sentence>"}). Reactions are plaintext metadata: no crypto.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");

const silent = { info() {}, error() {} };
const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// A toggle store like the server's: same emoji again removes, 12 distinct max, one grapheme only.
function mockServer() {
  const calls = [];
  const mine = new Set();
  const fn = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, body });
    const m = url.match(/\/api\/v1\/messages\/([^/]+)\/reactions$/);
    if (m) {
      const emoji = body.emoji;
      if (mine.has(emoji)) mine.delete(emoji);
      else {
        if (!/^\p{Extended_Pictographic}/u.test(emoji) || [...new Intl.Segmenter().segment(emoji)].length !== 1) return json(422, { error: "Pick a single emoji." });
        if (mine.size >= 12) return json(422, { error: "You can react with up to 12 emoji." });
        mine.add(emoji);
      }
      return json(200, { message_id: m[1], reactions: [...mine].map((e) => ({ emoji: e, count: 1, user_ids: ["agent-1"] })) });
    }
    if (url.endsWith("/api/v1/reactions/mine")) return json(200, { recent: [...mine] });
    if (url.includes("/agents/webhook_secret")) return json(200, { agent_id: "agent-1", webhook_secret: "secret-agent" });
    if (url.includes("/api/v1/chats/chat-1")) return json(200, { session: { users: [] }, messages: [] });
    return json(200, {});
  };
  fn.calls = calls;
  return fn;
}

test("client.react posts the emoji, toggles off on repeat, and surfaces the server's 422 sentence", async () => {
  const fetchImpl = mockServer();
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const first = await client.react("key", "msg-9", "✅");
  assert.deepStrictEqual(first, { message_id: "msg-9", reactions: [{ emoji: "✅", count: 1, user_ids: ["agent-1"] }] });
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.equal(fetchImpl.calls[0].url, "https://salt.test/api/v1/messages/msg-9/reactions");
  assert.equal(fetchImpl.calls[0].headers["api-key"], "key");
  assert.deepStrictEqual(fetchImpl.calls[0].body, { emoji: "✅" });

  const again = await client.react("key", "msg-9", "✅");
  assert.deepStrictEqual(again.reactions, [], "same emoji again removes it");

  await assert.rejects(client.react("key", "msg-9", "hi"), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.equal(err.status, 422);
    assert.match(err.message, /Pick a single emoji\./);
    return true;
  });

  const history = await client.myReactions("key");
  assert.deepStrictEqual(history, { recent: [] });
});

test("react_to_message refuses an id that is not a plain id (no path smuggling)", async () => {
  const fetchImpl = mockServer();
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-react-"));
  const { execute } = sdk.createActions({ client, identities: sdk.createIdentityStore(path.join(dir, "i.json")), pgpPassphrase: "p", publicWebhookUrl: "https://h.test" });
  await assert.rejects(execute("react_to_message", { message_id: "../agents/callback", emoji: "👍" }, { apiKey: "k" }, { depth: 0, mainChatId: null }), /plain Salt message id/);
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes("/reactions")).length, 0);
});

test("client.react surfaces the 12-emoji cap sentence", async () => {
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl: mockServer() });
  const pool = ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🙂", "😉", "😊", "😇", "🥰"];
  for (const e of pool) await client.react("key", "m", e);
  await assert.rejects(client.react("key", "m", "😍"), /You can react with up to 12 emoji\./);
});

test("react_to_message action reacts through the client and describes the owner's rule", async () => {
  const fetchImpl = mockServer();
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-react-"));
  const identities = sdk.createIdentityStore(path.join(dir, "identities.json"));
  const { definitions, execute } = sdk.createActions({ client, identities, pgpPassphrase: "p", publicWebhookUrl: "https://h.test" });
  const def = definitions.find((d) => d.name === "react_to_message");
  assert.ok(def, "action is listed");
  assert.match(def.description, /relevantly complements the chat in a friendly way/);
  assert.match(def.description, /never to every/i);
  assert.deepStrictEqual(def.schema.required, ["message_id", "emoji"]);

  const out = await execute("react_to_message", { message_id: "m-1", emoji: "👀" }, { apiKey: "key", saltAppId: "agent-1" }, { depth: 0, mainChatId: "chat-1" });
  assert.equal(out.ok, true);
  assert.equal(out.message_id, "m-1");
  assert.equal(fetchImpl.calls.find((c) => c.url.endsWith("/reactions")).body.emoji, "👀");
});

test("ctx.react inside onMessage reacts to the message being handled", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const fetchImpl = mockServer();
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-react-"));
  const store = sdk.createIdentityStore(path.join(dir, "identities.json"));
  store.register({ saltAppId: "agent-1", username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  let seen;
  const server = sdk.createWebhookServer({
    client,
    pgpPassphrase: "agent-pass",
    logger: silent,
    identities: store,
    async onMessage(ctx) {
      seen = { messageId: ctx.messageId, result: await ctx.react("🎉") };
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());

  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: "we shipped it" }),
    encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }),
  });
  const raw = JSON.stringify({
    chat: { id: "chat-1", name: "Room", public: false, managed: false, open_invite: false, mode: "auto" },
    message: {
      chat_id: "chat-1",
      message_id: "msg-42",
      message: armored,
      sender_message: armored,
      message_type: "User",
      user: { id: "ada-1", username: "ada", display_name: "ada", account_type: "User" },
      created_at: new Date().toISOString(),
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", "secret-agent").update(`${ts}.${raw}`).digest("hex");
  const res = await fetch(`http://127.0.0.1:${listening.address().port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Salt-Agent-Id": "agent-1", "X-Salt-Signature": `t=${ts},v1=${v1}` },
    body: raw,
  });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(seen?.messageId, "msg-42");
  assert.equal(seen.result.message_id, "msg-42");
  const call = fetchImpl.calls.find((c) => c.url.endsWith("/api/v1/messages/msg-42/reactions"));
  assert.ok(call, "reaction POST went to the handled message");
  assert.deepStrictEqual(call.body, { emoji: "🎉" });
});
