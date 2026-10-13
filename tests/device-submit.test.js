// The accessibility-only `submit` op: client wire shape, host gates and the real reason passing through.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const EL = { obs: "o1", node: "n7" };

test("client.submit posts a submit command carrying the element and resolves on ack", async () => {
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
  const p = c.submit(EL);
  const sent = sdk.decodeDeviceMessage(posted[0]);
  assert.equal(sent.header.op, "submit");
  assert.deepEqual(sent.body, { element: EL });
  c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "r1", seq: 1, op: "ack", session: "sess-1", re: sent.header.id }, { ok: true }));
  await p;
});

function host(caps, submit) {
  const results = [];
  const noop = async () => {};
  const h = { observe: noop, click: noop, type: noop, key: noop, scroll: noop, submit, focusApp: noop, listApps: noop, readFile: noop, writeFile: noop };
  const tx = {
    results,
    async postResult(pt) { results.push(sdk.decodeDeviceMessage(pt)); },
    async beat() {}, async reportCounts() {}, async stop() {},
  };
  const snap = { sessionId: "sess-1", agentId: "ag", readers: { chatId: "chat-1", publicKeys: ["K"] }, caps };
  return { tx, host: sdk.createDeviceHost(snap, h, tx) };
}
const cmd = (seq, body) => sdk.encodeDeviceMessage({ v: 1, id: `c${seq}`, seq, op: "submit", session: "sess-1", exp: Date.now() + 30000 }, body);

test("host runs submit under device.act and acks", async () => {
  const calls = [];
  const { tx, host: h } = host({ "device.act": { mode: "auto" } }, async (a) => { calls.push(a); });
  await h.handleCommand(cmd(1, { element: EL }));
  assert.deepEqual(calls, [{ element: EL }]);
  assert.equal(tx.results.at(-1).header.op, "ack");
});

test("host refuses submit without device.act", async () => {
  const calls = [];
  const { tx, host: h } = host({ "device.observe": { mode: "auto" } }, async (a) => { calls.push(a); });
  await h.handleCommand(cmd(1, { element: EL }));
  assert.equal(calls.length, 0);
  assert.equal(tx.results.at(-1).body.code, "out_of_scope");
});

test("no_submit_control from the handler reaches the agent unchanged", async () => {
  const msg = "no_submit_control: this field has no submit action; a keystroke would be needed";
  const { tx, host: h } = host({ "device.act": { mode: "auto" } }, async () => { throw new Error(msg); });
  await h.handleCommand(cmd(1, { element: EL }));
  const r = tx.results.at(-1);
  assert.equal(r.header.op, "error");
  assert.equal(r.body.code, "failed");
  assert.equal(r.body.message, msg);
});

test("submit is a mutating, device.act op counted as a click", () => {
  assert.ok(sdk.MUTATING_OPS.includes("submit"));
  assert.equal(sdk.CAPABILITY_FOR_OP.submit, "device.act");
  assert.equal(sdk.countClassForOp("submit"), "click");
  assert.ok(sdk.AGENT_OPS.includes("submit"));
});
