// Show Me (0.22.0), agent side: client.askForHelp, client.helpRequests, the ask_for_help action,
// ctx.askForHelp wiring, and the device client's onStill / onPointed.
const test = require("node:test");
const assert = require("node:assert");
const openpgp = require("openpgp");
const sdk = require("../dist/index.js");

async function keypair(name) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{ name }], format: "armored" });
  return { privateKey, publicKey };
}
async function decryptArmored(armoredPrivate, armoredMessage) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivate });
  const message = await openpgp.readMessage({ armoredMessage });
  return (await openpgp.decrypt({ message, decryptionKeys: privateKey })).data;
}
function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return respond(url, opts, calls[calls.length - 1]);
  };
  fn.calls = calls;
  return fn;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

const HR = { id: "hr-1", status: "open", reason: "stuck", chat_id: "chat-1", device_session_id: "sess-1" };

async function world(extra = {}) {
  const agent = await keypair("agent");
  const human = await keypair("human");
  const users = extra.users ?? [
    { id: "agent-1", public_key: agent.publicKey, account_type: "Agent" },
    { id: "human-1", public_key: human.publicKey, account_type: "User" },
  ];
  const fetchImpl = recordingFetch((url, opts) => {
    if (url.includes("/api/v1/chats/chat-1")) return json(200, { session: { users, encrypted: extra.encrypted } });
    if (url.endsWith("/api/v1/messages") && opts.method === "POST") return json(201, { id: "msg-9" });
    if (url.endsWith("/api/v1/help_requests") && opts.method === "POST") return json(extra.helpStatus ?? 201, extra.helpStatus >= 400 ? { error: "no" } : { help_request: HR });
    if (url.includes("/api/v1/agents/webhook_secret")) return json(200, { agent_id: "agent-1" });
    if (url.includes("/api/v1/help_requests") && opts.method === "GET") return json(200, url.endsWith("hr-1") ? { help_request: HR } : { help_requests: [HR] });
    if (url.includes("/api/v1/help_requests/hr-1") && opts.method === "PATCH") return json(200, { help_request: { ...HR, status: "answered" } });
    return json(404, {});
  });
  return { agent, human, fetchImpl, client: sdk.createSaltClient({ host: "https://salt.test", fetchImpl }) };
}

test("askForHelp posts an encrypted SALT-HELP message the person can read, then opens the request", async () => {
  const { human, agent, fetchImpl, client } = await world();
  const hr = await client.askForHelp("agent-key", { chatId: "chat-1", question: "Which account?", reason: "which", deviceSessionId: "sess-1" });
  assert.equal(hr.id, "hr-1");
  const post = fetchImpl.calls.find((c) => c.url.endsWith("/api/v1/messages"));
  assert.equal(post.body.chat_id, "chat-1");
  const plain = await decryptArmored(human.privateKey, post.body.message);
  assert.equal(plain, "[[SALT-HELP reason=which]]\nWhich account?");
  assert.deepEqual(sdk.decodeHelp(plain), { reason: "which", question: "Which account?" });
  // The sender's own copy decrypts with the agent's key, not the human's.
  assert.equal(await decryptArmored(agent.privateKey, post.body.sender_message), plain);
  const req = fetchImpl.calls.find((c) => c.url.endsWith("/api/v1/help_requests"));
  assert.deepEqual(req.body, { chat_id: "chat-1", message_id: "msg-9", reason: "which", device_session_id: "sess-1" });
  // message first, request second
  assert.ok(fetchImpl.calls.indexOf(post) < fetchImpl.calls.indexOf(req));
});

test("askForHelp without a device session sends no device_session_id; selfId skips whoAmI", async () => {
  const { fetchImpl, client } = await world();
  await client.askForHelp("k", { chatId: "chat-1", question: "q", reason: "unclear", selfId: "agent-1" });
  assert.equal(fetchImpl.calls.some((c) => c.url.includes("webhook_secret")), false);
  const req = fetchImpl.calls.find((c) => c.url.endsWith("/api/v1/help_requests"));
  assert.equal("device_session_id" in req.body, false);
});

test("askForHelp refuses before posting: group chat, open room, empty or long question, bad reason", async () => {
  const w = await world({ users: [
    { id: "agent-1", public_key: "x", account_type: "Agent" },
    { id: "h1", public_key: "y" },
    { id: "h2", public_key: "z" },
  ] });
  await assert.rejects(() => w.client.askForHelp("k", { chatId: "chat-1", question: "q", reason: "stuck", selfId: "agent-1" }), /1:1/);
  const open = await world({ encrypted: false });
  await assert.rejects(() => open.client.askForHelp("k", { chatId: "chat-1", question: "q", reason: "stuck" }), /encrypted/);
  const ok = await world();
  await assert.rejects(() => ok.client.askForHelp("k", { chatId: "chat-1", question: "", reason: "stuck" }));
  await assert.rejects(() => ok.client.askForHelp("k", { chatId: "chat-1", question: "a".repeat(501), reason: "stuck" }));
  await assert.rejects(() => ok.client.askForHelp("k", { chatId: "chat-1", question: "q", reason: "panic" }));
  for (const x of [w, open, ok]) assert.equal(x.fetchImpl.calls.some((c) => c.method === "POST"), false);
});

test("an observer in the chat reads the question too; an observer is not 'the other person'", async () => {
  const agent = await keypair("agent");
  const human = await keypair("human");
  const owner = await keypair("owner");
  const w = await world({ users: [
    { id: "agent-1", public_key: agent.publicKey },
    { id: "human-1", public_key: human.publicKey },
    { id: "owner-1", public_key: owner.publicKey, observer: true },
  ] });
  await w.client.askForHelp("k", { chatId: "chat-1", question: "q", reason: "stuck", selfId: "agent-1" });
  const post = w.fetchImpl.calls.find((c) => c.url.endsWith("/api/v1/messages"));
  assert.match(await decryptArmored(owner.privateKey, post.body.message), /SALT-HELP/);
});

test("a server refusal on the request surfaces as a SaltApiError", async () => {
  const { client } = await world({ helpStatus: 422 });
  await assert.rejects(() => client.askForHelp("k", { chatId: "chat-1", question: "q", reason: "stuck", selfId: "agent-1" }), (e) => e instanceof sdk.SaltApiError && e.status === 422);
});

test("helpRequests.list / get / close hit the contract endpoints", async () => {
  const { fetchImpl, client } = await world();
  const rows = await client.helpRequests.list("k", { state: "all", chatId: "chat-1", before: "hr-9" });
  assert.equal(rows.length, 1);
  const url = fetchImpl.calls[0].url;
  assert.match(url, /\/api\/v1\/help_requests\?/);
  assert.match(url, /state=all/);
  assert.match(url, /chat_id=chat-1/);
  assert.match(url, /before=hr-9/);
  assert.equal((await client.helpRequests.get("k", "hr-1")).id, "hr-1");
  const closed = await client.helpRequests.close("k", "hr-1", "answered");
  assert.equal(closed.status, "answered");
  const patch = fetchImpl.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body, { status: "answered" });
});

function makeActions(client) {
  const store = { get: () => undefined, list: () => [] };
  return sdk.createActions({ client, identities: store, pgpPassphrase: "p", publicWebhookUrl: "https://a.test/hook" });
}
const caller = { saltAppId: "agent-1", apiKey: "agent-key", publicKey: "k" };

test("ask_for_help and close_help_request are declared actions", () => {
  const actions = makeActions({ trackEvent() {} });
  const names = actions.definitions.map((d) => d.name);
  assert.ok(names.includes("ask_for_help"));
  assert.ok(names.includes("close_help_request"));
  const def = actions.definitions.find((d) => d.name === "ask_for_help");
  assert.deepEqual(def.schema.required, ["question", "reason"]);
  assert.deepEqual(def.schema.properties.reason.enum, ["stuck", "which", "unclear", "look"]);
});

test("ask_for_help defaults to the current chat and returns the request id", async () => {
  const seen = [];
  const client = { trackEvent() {}, async askForHelp(key, p) { seen.push([key, p]); return HR; } };
  const out = await makeActions(client).execute("ask_for_help", { question: "Which one?", reason: "which", device_session_id: "sess-1" }, caller, { depth: 0, mainChatId: "chat-1" });
  assert.equal(out.asked, true);
  assert.equal(out.help_request_id, "hr-1");
  assert.deepEqual(seen[0], ["agent-key", { chatId: "chat-1", question: "Which one?", reason: "which", deviceSessionId: "sess-1", selfId: "agent-1" }]);
});

test("ask_for_help needs a chat, a question and a valid reason", async () => {
  const actions = makeActions({ trackEvent() {}, async askForHelp() { return HR; } });
  await assert.rejects(() => actions.execute("ask_for_help", { question: "q", reason: "stuck" }, caller, { depth: 0, mainChatId: null }), /chat_id/);
  await assert.rejects(() => actions.execute("ask_for_help", { reason: "stuck" }, caller, { depth: 0, mainChatId: "c" }), /question/);
  await assert.rejects(() => actions.execute("ask_for_help", { question: "q", reason: "nope" }, caller, { depth: 0, mainChatId: "c" }), /reason/);
});

test("close_help_request closes through client.helpRequests", async () => {
  const seen = [];
  const client = { trackEvent() {}, helpRequests: { async close(k, id, s) { seen.push([k, id, s]); return { status: s }; } } };
  const out = await makeActions(client).execute("close_help_request", { help_request_id: "hr-1", status: "withdrawn" }, caller, { depth: 0, mainChatId: null });
  assert.deepEqual(seen, [["agent-key", "hr-1", "withdrawn"]]);
  assert.equal(out.closed, true);
  await assert.rejects(() => makeActions(client).execute("close_help_request", {}, caller, { depth: 0, mainChatId: null }), /help_request_id/);
});

// ---- the agent-side device client ------------------------------------------

function activeClient() {
  const t = {
    async openSession(deviceId) { return { id: "sess-1", device_id: deviceId, agent_id: "ag", mandate_id: "m", status: "requested" }; },
    async stopSession() {},
    async postCommand() {},
  };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  c.handleDelivery("device_session", { type: "device_session_active", session: { id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: ["k"] } } });
  return opened.then(() => c);
}

test("device client surfaces a still and a pointed result through onStill / onPointed", async () => {
  const c = await activeClient();
  const stills = [];
  const pointed = [];
  const offStill = c.onStill((s) => stills.push(s));
  c.onPointed((p, id) => pointed.push([p, id]));
  const still = { help_id: "h", obs: "O1", width: 10, height: 10, scale: 1, format: "jpeg", image_b64: "AA", taken_at: "t" };
  assert.equal(c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "s1", seq: 1, op: "still", session: "sess-1" }, still), "d"), true);
  assert.equal(stills.length, 1);
  assert.equal(stills[0].obs, "O1");
  const body = { help_id: "h", x: 0.5, y: 0.5, screen: { x: 1, y: 2 }, app: "Finder", element: null, refused: null, words: "" };
  assert.equal(c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "p1", seq: 2, op: "pointed", session: "sess-1", re: "POINT1" }, body), "d"), true);
  assert.equal(pointed[0][1], "POINT1");
  assert.equal(pointed[0][0].app, "Finder");
  // a malformed body is consumed but never delivered
  c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "p2", seq: 3, op: "pointed", session: "sess-1", re: "P2" }, { nope: 1 }), "d");
  assert.equal(pointed.length, 1);
  // another session's still is not ours
  assert.equal(c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "s2", seq: 4, op: "still", session: "other" }, still), "d"), false);
  offStill();
  c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "s3", seq: 5, op: "still", session: "sess-1" }, still), "d");
  assert.equal(stills.length, 1);
});

test("a throwing onPointed listener never breaks the stream", async () => {
  const c = await activeClient();
  c.onPointed(() => { throw new Error("boom"); });
  const got = [];
  c.onPointed((p) => got.push(p));
  const body = { help_id: "h", x: 0.5, y: 0.5, screen: { x: 1, y: 2 }, app: null, element: null, refused: null, words: "" };
  assert.equal(c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "p1", seq: 1, op: "pointed", session: "sess-1", re: "P" }, body), "d"), true);
  assert.equal(got.length, 1);
});

test("the device client accepts lane messages only from the device's own account", async () => {
  const t = {
    async openSession(deviceId) { return { id: "sess-1", device_id: deviceId, agent_id: "ag", mandate_id: "m", status: "requested" }; },
    async stopSession() {},
    posted: [],
    async postCommand(pt) { this.posted.push(pt); },
  };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  c.handleDelivery("device_session", { type: "device_session_active", session: { id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: ["k"] } } });
  await opened;
  const stills = [];
  const pointed = [];
  c.onStill((s) => stills.push(s));
  c.onPointed((p) => pointed.push(p));
  const still = { help_id: "h", obs: "O", width: 1, height: 1, scale: 1, format: "jpeg", image_b64: "AA", taken_at: "t" };
  const stillMsg = sdk.encodeDeviceMessage({ v: 1, id: "s", seq: 1, op: "still", session: "sess-1" }, still);
  const body = { help_id: "h", x: 0.5, y: 0.5, screen: { x: 1, y: 1 }, app: null, element: null, refused: null, words: "" };
  const pointedMsg = sdk.encodeDeviceMessage({ v: 1, id: "p", seq: 2, op: "pointed", session: "sess-1", re: "P" }, body);
  for (const who of ["person-1", "another-agent", "", undefined, null]) {
    assert.equal(c.handleLaneMessage(stillMsg, who), false);
    assert.equal(c.handleLaneMessage(pointedMsg, who), false);
  }
  assert.equal(stills.length + pointed.length, 0);
  // a forged result from a non-device sender does not settle a pending command
  const p = c.observe({ target: "screen" });
  const sent = sdk.decodeDeviceMessage(t.posted[0]);
  const forged = sdk.encodeDeviceMessage({ v: 1, id: "r", seq: 3, op: "observation", session: "sess-1", re: sent.header.id }, { obs: "fake", image_b64: "AA" });
  assert.equal(c.handleLaneMessage(forged, "person-1"), false);
  const settled = await Promise.race([p.then(() => "settled", () => "rejected"), new Promise((r) => setTimeout(() => r("pending"), 50))]);
  assert.equal(settled, "pending");
  const real = sdk.encodeDeviceMessage({ v: 1, id: "r2", seq: 4, op: "observation", session: "sess-1", re: sent.header.id }, { obs: "real", image_b64: "AA" });
  assert.equal(c.handleLaneMessage(real, "d"), true);
  assert.equal((await p).obs, "real");
  assert.equal(c.handleLaneMessage(stillMsg, "d"), true);
  assert.equal(c.handleLaneMessage(pointedMsg, "D"), true, "ids compare as ids");
  assert.equal(stills.length, 1);
  assert.equal(pointed.length, 1);
});
