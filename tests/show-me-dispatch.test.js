// Show Me (0.22.0) through the real webhook dispatcher: ctx.askForHelp, help_request_* deliveries
// reaching onDeviceDelivery, and a SALT-POINT on a device lane reaching the host with its sender.
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "identities.json");
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
const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function boot(t, { client = {}, ...hooks } = {}) {
  const AGENT_ID = "70000000-0000-0000-0000-00000000b001";
  const keys = await sdk.generateKeypair("showme-pass");
  const store = sdk.createIdentityStore(tempStore("salt-showme-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-helper", publicKey: keys.publicKey, privateKey: keys.privateKey });
  const api = {
    async getWebhookSecret() { return "secret-helper"; },
    async getChatMembers() { return []; },
    async getChatMessages() { return []; },
    async signalTyping() {},
    trackEvent() {},
    ...client,
  };
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "showme-pass", logger: silent, ...hooks });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  return { AGENT_ID, keys, port: listening.address().port };
}

test("ctx.askForHelp binds this identity and chat, and drops chatId from the options", async (t) => {
  const calls = [];
  const { AGENT_ID, keys, port } = await boot(t, {
    client: { async askForHelp(apiKey, p) { calls.push([apiKey, p]); return { id: "hr-1", status: "open" }; } },
    async onMessage(ctx) {
      const hr = await ctx.askForHelp({ question: "Which one?", reason: "which", deviceSessionId: "sess-1" });
      calls.push(["result", hr.id]);
    },
  });
  const armored = await encryptFor("do the thing", keys.publicKey);
  const res = await signedPost(port, { chat: { id: "chat-1" }, message: { chat_id: "chat-1", message_id: "m1", message: armored, sender_message: armored, user: { id: "human-1", username: "dan", account_type: "User" }, created_at: new Date().toISOString() } }, AGENT_ID, "secret-helper");
  assert.equal(res.status, 200);
  await wait();
  assert.deepEqual(calls[0], ["key-helper", { question: "Which one?", reason: "which", deviceSessionId: "sess-1", chatId: "chat-1", selfId: AGENT_ID }]);
  assert.deepEqual(calls[1], ["result", "hr-1"]);
});

test("help_request_* deliveries reach onDeviceDelivery and a device host consumes them", async (t) => {
  const got = [];
  const { AGENT_ID, port } = await boot(t, { async onDeviceDelivery(type, body) { got.push([type, body]); } });
  for (const type of ["help_request_opened", "help_request_viewing", "help_request_closed"]) {
    const res = await signedPost(port, { type, help_request: { id: "hr-1", device_session_id: "sess-1" }, viewer: null }, AGENT_ID, "secret-helper");
    assert.equal(res.status, 200);
  }
  await wait();
  assert.deepEqual(got.map((g) => g[0]), ["help_request_opened", "help_request_viewing", "help_request_closed"]);

  const events = [];
  const host = sdk.createDeviceHost(
    { sessionId: "sess-1", agentId: "ag", readers: { chatId: "lane", publicKeys: ["k"] }, caps: {} },
    {},
    { async postResult() {}, async beat() {}, async reportCounts() {}, async stop() {} },
    { onHelpOpened: (r) => events.push(r.id) }
  );
  for (const [type, body] of got) host.handleDelivery(type, body);
  assert.deepEqual(events, ["hr-1"]);
});

test("a SALT-POINT on a device lane arrives with its sender and the host answers pointed", async (t) => {
  const posted = [];
  let host;
  const { AGENT_ID, keys, port } = await boot(t, {
    async onDeviceLaneMessage(ctx) {
      await host.handleLaneMessage(ctx.text, ctx.senderId);
    },
  });
  host = sdk.createDeviceHost(
    { sessionId: "sess-1", agentId: "ag", readers: { chatId: "lane-1", publicKeys: ["k"] }, caps: {} },
    { resolvePoint: async () => ({ screen: { x: 10, y: 20 }, app: "Finder", element: null, refused: null }) },
    { async postResult(pt) { posted.push(sdk.decodeDeviceMessage(pt)); }, async beat() {}, async reportCounts() {}, async stop() {} },
    {},
    { isPersonOverDevice: (id) => id === "human-1" }
  );
  host.handleDelivery("help_request_opened", { help_request: { id: "hr-1", device_session_id: "sess-1" } });

  const send = async (id, sender, messageId) => {
    const armored = await encryptFor(sdk.encodePoint({ help: "hr-1", obs: "O1", x: 0.25, y: 0.75, id, words: "here" }), keys.publicKey);
    const res = await signedPost(port, { chat: { id: "lane-1", lane_kind: "device" }, message: { chat_id: "lane-1", message_id: messageId, message: armored, sender_message: armored, user: { id: sender, username: sender, account_type: "User" }, created_at: new Date().toISOString() } }, AGENT_ID, "secret-helper");
    assert.equal(res.status, 200);
    await wait();
  };
  await send("PT1", "human-1", "m1");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].header.op, "pointed");
  assert.equal(posted[0].header.re, "PT1");
  assert.equal(posted[0].body.app, "Finder");
  await send("PT2", "stranger-1", "m2");
  assert.equal(posted.length, 1, "a point from someone who is not a person over the device is ignored");
});
