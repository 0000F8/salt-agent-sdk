// Round-two security review (2026-10-08): C-N1 path scope, H-N1 device lane
// routing through the real dispatcher, M-N2 floor, L-N1 client reuse, L-N2 skew.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const READERS = { chatId: "chat-1", publicKeys: ["-----PUB-----"] };
function handlers(over = {}) {
  const calls = [];
  const mk = (op) => async (a) => { calls.push([op, a]); };
  return Object.assign({
    calls,
    observe: async () => ({ obs: "o", width: 1, height: 1, scale: 1, format: "png", image_b64: "AA" }),
    click: mk("click"), type: mk("type"), key: mk("key"), scroll: mk("scroll"), focusApp: mk("focus"),
    listApps: async () => ({ apps: [] }),
    readFile: async (a) => { calls.push(["read", a]); return { path: a.path, size: 0, content_b64: "" }; },
    writeFile: async (a) => { calls.push(["write", a]); },
  }, over);
}
function transport() {
  const t = { results: [] };
  return Object.assign(t, {
    async postResult(p) { t.results.push(sdk.decodeDeviceMessage(p)); },
    async beat() {}, async reportCounts() {}, async stop() {}, async pause() {}, async resume() {},
  });
}
const snap = (caps) => ({ sessionId: "s1", agentId: "ag", readers: READERS, caps });
const cmd = (seq, op, body, o = {}) =>
  sdk.encodeDeviceMessage({ v: 1, id: o.id ?? `c${seq}`, seq, op, session: "s1", exp: o.exp ?? Date.now() + 30000 }, body);

// ---- C-N1 -------------------------------------------------------------------
test("C-N1: file paths must be absolute, normalised and inside a root on a segment boundary", async () => {
  const h = handlers(), t = transport();
  const host = sdk.createDeviceHost(snap({ "device.files.read": { mode: "auto", fileRoots: ["/a/doc", "/a/trail/"] } }), h, t);
  const attempts = [
    "/a/doc/../.ssh/id_ed25519", // traversal
    "/a/docs/secret", // sibling-prefix root
    "a/doc/x", // relative
    "doc/x",
    "/a/doc/", // trailing slash (not normalised)
    "/a/doc//x", // doubled slash
    "/a/doc/./x",
    "/etc/passwd",
    "",
  ];
  let seq = 1;
  for (const p of attempts) {
    await host.handleCommand(cmd(seq, "read_file", { path: p }, { id: `t${seq}` }));
    const r = t.results.at(-1);
    assert.equal(r.header.op, "error", p);
    assert.ok(["forbidden", "out_of_scope"].includes(r.body.code), `${p}: ${r.body.code}`);
    seq += 1;
  }
  assert.equal(h.calls.length, 0);
  await host.handleCommand(cmd(seq, "read_file", { path: "/a/doc/ok.txt" }, { id: "ok1" }));
  await host.handleCommand(cmd(seq + 1, "read_file", { path: "/a/doc" }, { id: "ok2" }));
  await host.handleCommand(cmd(seq + 2, "read_file", { path: "/a/trail/x/y" }, { id: "ok3" }));
  assert.equal(h.calls.length, 3);
});

test("C-N1: write_file is scoped the same way", async () => {
  const h = handlers(), t = transport();
  const host = sdk.createDeviceHost(snap({ "device.files.write": { mode: "auto", fileRoots: ["/a/doc"] } }), h, t);
  await host.handleCommand(cmd(1, "write_file", { path: "/a/doc/../x", content_b64: "AA" }));
  await host.handleCommand(cmd(2, "write_file", { path: "/a/docs/x", content_b64: "AA" }, { id: "w2" }));
  assert.equal(h.calls.length, 0);
  await host.handleCommand(cmd(3, "write_file", { path: "/a/doc/x", content_b64: "AA" }, { id: "w3" }));
  assert.equal(h.calls.length, 1);
});

// ---- M-N2 -------------------------------------------------------------------
test("M-N2: Apple Passwords is on the never-allowed floor", async () => {
  assert.ok(sdk.NEVER_ALLOWED_APPS.includes("com.apple.passwords"));
  assert.ok(sdk.NEVER_ALLOWED_APPS.includes("passwords"));
  const h = handlers(), t = transport();
  const host = sdk.createDeviceHost(snap({ "device.apps": { mode: "auto" }, "device.observe": { mode: "auto" } }), h, t);
  await host.handleCommand(cmd(1, "focus_app", { app: "com.apple.Passwords" }, { id: "p1" }));
  assert.equal(t.results.at(-1).body.code, "forbidden");
  await host.handleCommand(cmd(2, "focus_app", { app: "Passwords" }, { id: "p2" }));
  assert.equal(t.results.at(-1).body.code, "forbidden");
  await host.handleCommand(cmd(3, "observe", { target: "screen", app: "Passwords" }, { id: "p3" }));
  assert.equal(t.results.at(-1).body.code, "forbidden");
  assert.equal(h.calls.length, 0);
});

// ---- H-N1 -------------------------------------------------------------------
// The API's real delivery shape (salt-api app/jobs/webhook_job.rb): { chat: {id,
// lane_kind, ...}, message: {chat_id, message_id, message, encrypted, user:{...}} }.
function laneDelivery(n, text, { laneKind = "device", sender = { id: "agent-1", account_type: "Agent" } } = {}) {
  return {
    chat: { id: "lane-1", name: null, private_lane: false, lane_kind: laneKind, readers: [] },
    message: { chat_id: "lane-1", message_id: `m-${n}`, message: text, encrypted: false, user: sender, mentions: [] },
  };
}
function dispatcher(opts = {}, members = [{ id: "dev-1", account_type: "Device" }, { id: "agent-1", account_type: "Agent" }]) {
  const identity = { saltAppId: "dev-1", username: "device", apiKey: "k", publicKey: "p", privateKey: "x" };
  const store = { get: (id) => (String(id) === "dev-1" ? identity : undefined), all: () => [identity], register() {}, reassignId: () => undefined };
  const client = { async getChatMembers() { return members; }, async postMessage() { return {}; }, async signalTyping() {}, trackEvent() {} };
  return sdk.createDispatcher({ client, identities: store, pgpPassphrase: "x", verifySignatures: false, logger: { info() {}, error() {} }, ...opts });
}

test("H-N1: five of five commands reach the host in order through createDispatcher", async () => {
  const h = handlers(), t = transport();
  const host = sdk.createDeviceHost(snap({ "device.act": { mode: "auto" }, "device.observe": { mode: "auto" } }), h, t);
  const gated = [];
  const d = dispatcher({
    onDeviceLaneMessage: (c) => { gated.push(c.senderId); return host.handleCommand(c.text); },
    onMessage: async () => assert.fail("a device lane must never reach onMessage"),
  });
  const ops = [["click", { x: 1, y: 1 }], ["type", { text: "a" }], ["key", { keys: ["enter"] }], ["scroll", { dx: 0, dy: 3 }], ["click", { x: 2, y: 2 }]];
  for (let i = 0; i < ops.length; i++) {
    await d.dispatch(laneDelivery(i, cmd(i + 1, ops[i][0], ops[i][1])), "dev-1");
    // wait for the (un-awaited) hook to finish this command before the next arrives
    for (let k = 0; k < 50 && t.results.length < i + 1; k++) await new Promise((r) => setTimeout(r, 2));
  }
  assert.deepEqual(h.calls.map((c) => c[0]), ["click", "type", "key", "scroll", "click"]);
  assert.deepEqual(t.results.map((r) => r.header.op), ["ack", "ack", "ack", "ack", "ack"]);
  assert.equal(gated.length, 5);
});

test("H-N1: a device lane is routed even when a Device member would have counted as a person", async () => {
  let n = 0;
  const d = dispatcher({ onDeviceLaneMessage: () => void n++, onMessage: async () => assert.fail("no") });
  for (let i = 0; i < 6; i++) await d.dispatch(laneDelivery(i, `line ${i}`), "dev-1");
  assert.equal(n, 6); // the agent-to-agent reply cap never applies
});

test("H-N1: an agent message in a NON-device lane is gated as before", async () => {
  const got = [];
  // A person (non-observer) is present: an unaddressed agent message is dropped.
  const withPerson = dispatcher(
    { onMessage: async (c) => void got.push(c.text), onDeviceLaneMessage: () => assert.fail("not a device lane") },
    [{ id: "dev-1", account_type: "Agent" }, { id: "agent-1", account_type: "Agent" }, { id: "u", account_type: "User", observer: false }]
  );
  await withPerson.dispatch(laneDelivery(1, "hello", { laneKind: undefined }), "dev-1");
  assert.deepEqual(got, []);
  // Agents only: the reply cap of 2 still applies.
  const only = dispatcher(
    { onMessage: async (c) => void got.push(c.text) },
    [{ id: "dev-1", account_type: "Agent" }, { id: "agent-1", account_type: "Agent" }]
  );
  for (let i = 0; i < 4; i++) await only.dispatch(laneDelivery(10 + i, `a${i}`, { laneKind: undefined }), "dev-1");
  assert.deepEqual(got, ["a0", "a1"]);
});

test("H-N1: a Device member is never counted as a person in the mention gate", async () => {
  const got = [];
  const d = dispatcher(
    { onMessage: async (c) => void got.push(c.text) },
    [{ id: "dev-1", account_type: "Device" }, { id: "agent-1", account_type: "Agent" }]
  );
  await d.dispatch(laneDelivery(1, "x", { laneKind: undefined }), "dev-1");
  assert.deepEqual(got, ["x"]); // not dropped as "agent message not addressed to us"
});

// ---- L-N1 / L-N2 ------------------------------------------------------------
function wired({ hostNow } = {}) {
  const h = handlers();
  const raw = [];
  const t2 = transport();
  t2.postResult = async (p) => { raw.push(p); };
  const host2 = sdk.createDeviceHost(snap({ "device.act": { mode: "auto" } }), h, t2, {}, hostNow ? { now: hostNow } : {});
  let client;
  const tr = {
    async openSession(deviceId) { return { id: "s1", device_id: deviceId, agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: ["-----PUB-----"] } }; },
    async stopSession() {},
  };
  tr.postCommand = async (p) => {
    const dm = sdk.decodeDeviceMessage(p);
    if (dm.header.op === "cancel") return;
    await host2.handleCommand(p);
    while (raw.length) client.handleLaneMessage(raw.shift());
  };
  client = sdk.createDeviceClient(tr, { deviceId: "d" }, { commandTimeoutMs: 2000 });
  return { client, h, raw };
}

test("L-N2: a device clock far behind the agent's is corrected once and the command runs (same id)", async () => {
  const { client, h } = wired({ hostNow: () => Date.now() - 120_000 });
  await client.open();
  await client.click({ x: 1, y: 1 });
  assert.equal(h.calls.length, 1);
  // the offset sticks: the next command needs no retry
  await client.click({ x: 2, y: 2 });
  assert.equal(h.calls.length, 2);
});

test("L-N2: the host answers clock_skew with its own now, not bad_args", async () => {
  const t = transport();
  const host = sdk.createDeviceHost(snap({ "device.act": { mode: "auto" } }), handlers(), t, {}, { now: () => 5_000_000 });
  await host.handleCommand(sdk.encodeDeviceMessage({ v: 1, id: "k", seq: 1, op: "click", session: "s1", exp: 5_000_000 + 120_000 }, { x: 1, y: 1 }));
  const r = t.results.at(-1);
  assert.equal(r.body.code, "clock_skew");
  assert.equal(r.body.now, 5_000_000);
});

test("L-N1: two sequential sessions on one client do not leak the first into the second", async () => {
  let n = 0;
  const calls = [];
  const tr = {
    async openSession(deviceId) {
      n += 1;
      return { id: `s${n}`, device_id: deviceId, agent_id: "ag", mandate_id: "m", status: "active", chat: { id: `chat-${n}`, readers: [`KEY${n}`] } };
    },
    async stopSession() {},
    async postCommand(p, readers) { calls.push({ p, readers }); },
  };
  const c = sdk.createDeviceClient(tr, { deviceId: "d" }, { commandTimeoutMs: 500 });
  await c.open();
  assert.equal(c.session().id, "s1");
  await c.stop();
  const second = await c.open();
  assert.equal(second.id, "s2");
  assert.equal(c.session().status, "active");
  const p = c.click({ x: 1, y: 1 });
  p.catch(() => {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.at(-1).readers.chatId, "chat-2");
  assert.deepEqual(calls.at(-1).readers.publicKeys, ["KEY2"]);
  assert.equal(sdk.decodeDeviceMessage(calls.at(-1).p).header.session, "s2");
  assert.equal(sdk.decodeDeviceMessage(calls.at(-1).p).header.seq, 1);
});
