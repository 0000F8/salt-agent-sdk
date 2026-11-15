// The `settings` op on the device client: a read, a set, the result shape and the refusals passing through.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

async function openClient() {
  const posted = [];
  const t = {
    async openSession(d) { return { id: "sess-1", device_id: d, agent_id: "ag", mandate_id: "m", status: "requested" }; },
    async stopSession() {},
    async postCommand(plaintext) { posted.push(plaintext); },
  };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  c.handleDelivery("device_session", { type: "device_session_active", session: { id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: ["K"] } } });
  await opened;
  return { c, posted };
}

const RESULT = {
  settings: { stay_awake: true, commands_enabled: true },
  state: { on_ac: true, battery_pct: 80, lid_closed: false, display: "on", holding_awake: true },
  changed: ["stay_awake"],
  refused: { color: "unknown_setting" },
};
const reply = (c, sent, body) =>
  c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "r1", seq: 1, op: "settings", session: "sess-1", re: sent.header.id }, body), "d");

test("settings() sends an empty-body settings command and resolves with the result", async () => {
  const { c, posted } = await openClient();
  const p = c.settings();
  const sent = sdk.decodeDeviceMessage(posted[0]);
  assert.equal(sent.header.op, "settings");
  assert.deepEqual(sent.body, {});
  reply(c, sent, RESULT);
  assert.deepEqual(await p, RESULT);
});

test("setSettings({stay_awake}) sends {set} and returns changed and refused", async () => {
  const { c, posted } = await openClient();
  const p = c.setSettings({ stay_awake: true });
  const sent = sdk.decodeDeviceMessage(posted[0]);
  assert.equal(sent.header.op, "settings");
  assert.deepEqual(sent.body, { set: { stay_awake: true } });
  reply(c, sent, RESULT);
  const r = await p;
  assert.deepEqual(r.changed, ["stay_awake"]);
  assert.equal(r.refused.color, "unknown_setting");
});

test("a declined set comes back as data in refused, not a throw", async () => {
  const { c, posted } = await openClient();
  const p = c.setSettings({ stay_awake: false });
  const sent = sdk.decodeDeviceMessage(posted[0]);
  reply(c, sent, { ...RESULT, changed: [], refused: { stay_awake: "declined" } });
  assert.deepEqual((await p).refused, { stay_awake: "declined" });
});

test("settings is a known op and result op, with no capability of its own", () => {
  assert.ok(sdk.AGENT_OPS.includes("settings"));
  assert.ok(sdk.DEVICE_RESULT_OPS.includes("settings"));
  assert.equal(sdk.CAPABILITY_FOR_OP.settings, null);
  assert.equal(sdk.countClassForOp("settings"), null);
});

function host(caps, settings) {
  const results = [];
  const noop = async () => {};
  const h = { observe: noop, click: noop, type: noop, key: noop, scroll: noop, submit: noop, focusApp: noop, listApps: noop, readFile: noop, writeFile: noop, ...(settings ? { settings } : {}) };
  const tx = {
    results,
    async postResult(pt) { results.push(sdk.decodeDeviceMessage(pt)); },
    async beat() {}, async reportCounts() {}, async stop() {},
  };
  const snap = { sessionId: "sess-1", agentId: "ag", readers: { chatId: "chat-1", publicKeys: ["K"] }, caps };
  return { tx, host: sdk.createDeviceHost(snap, h, tx) };
}
const cmd = (seq, body) => sdk.encodeDeviceMessage({ v: 1, id: `c${seq}`, seq, op: "settings", session: "sess-1", exp: Date.now() + 30000 }, body);

test("host runs settings with no capability in the grant and answers the handler's result as a settings op", async () => {
  const calls = [];
  const { tx, host: h } = host({}, async (a) => { calls.push(a); return RESULT; });
  await h.handleCommand(cmd(1, { set: { commands_enabled: true } }));
  assert.deepEqual(calls, [{ set: { commands_enabled: true } }]);
  const last = tx.results.at(-1);
  assert.equal(last.header.op, "settings");
  assert.deepEqual(last.body, RESULT);
});

test("host passes {} to the handler for a read", async () => {
  const calls = [];
  const { tx, host: h } = host({}, async (a) => { calls.push(a); return RESULT; });
  await h.handleCommand(cmd(1, {}));
  assert.deepEqual(calls, [{}]);
  assert.equal(tx.results.at(-1).header.op, "settings");
});

test("host without a settings handler answers unsupported", async () => {
  const { tx, host: h } = host({});
  await h.handleCommand(cmd(1, {}));
  const last = tx.results.at(-1);
  assert.equal(last.header.op, "error");
  assert.equal(last.body.code, "unsupported");
});

test("host replays a settings result by command id and does not run the handler twice", async () => {
  let n = 0;
  const { tx, host: h } = host({}, async () => { n++; return RESULT; });
  const text = cmd(1, { set: { stay_awake: true } });
  await h.handleCommand(text);
  await h.handleCommand(text);
  assert.equal(n, 1);
  assert.equal(tx.results.at(-1).header.op, "settings");
});
