// The agent side (device/client.ts). Fakes for the transport; the incoming
// deliveries and lane results are fed in the way a dispatcher would.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

function fakeTransport(overrides = {}) {
  const posted = [];
  return {
    posted,
    async openSession(deviceId) {
      return { id: "sess-1", device_id: deviceId, agent_id: "ag", mandate_id: "m", status: "requested" };
    },
    async stopSession() {},
    async postCommand(plaintext, readers) {
      posted.push({ plaintext, readers });
    },
    ...overrides,
  };
}

const READERS = { id: "chat-1", readers: ["-----PUBKEY-----"] };

function activeDelivery() {
  return { type: "device_session_active", session: { id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: READERS } };
}

test("open() resolves when the device approves (active delivery)", async () => {
  const t = fakeTransport();
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  // dispatcher delivers the approval
  c.handleDelivery("device_session", activeDelivery());
  const meta = await opened;
  assert.equal(meta.status, "active");
  assert.equal(c.session().status, "active");
});

test("a command posts a device message and resolves on the matching result", async () => {
  const t = fakeTransport();
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  c.handleDelivery("device_session", activeDelivery());
  await opened;

  const p = c.observe({ target: "screen" });
  // one command posted
  assert.equal(t.posted.length, 1);
  const sent = sdk.decodeDeviceMessage(t.posted[0].plaintext);
  assert.equal(sent.header.op, "observe");
  assert.equal(sent.header.seq, 1);

  // device answers with an observation keyed to the command id
  const answer = sdk.encodeDeviceMessage(
    { v: 1, id: "res1", seq: 1, op: "observation", session: "sess-1", re: sent.header.id },
    { obs: "o1", width: 100, height: 50, scale: 2, format: "png", image_b64: "AAAA" }
  );
  assert.equal(c.handleLaneMessage(answer), true);
  const shot = await p;
  assert.equal(shot.obs, "o1");
  assert.equal(shot.width, 100);
});

test("an error result rejects the command with its code", async () => {
  const t = fakeTransport();
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  c.handleDelivery("device_session", activeDelivery());
  await opened;

  const p = c.click({ x: 1, y: 1 });
  const sent = sdk.decodeDeviceMessage(t.posted[0].plaintext);
  const err = sdk.encodeDeviceMessage(
    { v: 1, id: "e1", seq: 1, op: "error", session: "sess-1", re: sent.header.id },
    { code: "out_of_scope", message: "no device.act" }
  );
  c.handleLaneMessage(err);
  await assert.rejects(p, (e) => e.code === "out_of_scope");
});

test("seq increments per command (one in flight at a time)", async () => {
  const t = fakeTransport();
  const c = sdk.createDeviceClient(t, { deviceId: "d" }, { commandTimeoutMs: 1000 });
  const opened = c.open();
  c.handleDelivery("device_session", activeDelivery());
  await opened;
  const a = c.type("a");
  const b = c.type("b");
  assert.equal(sdk.decodeDeviceMessage(t.posted[0].plaintext).header.seq, 1);
  assert.equal(t.posted.length, 1); // "b" waits for "a"
  c.handleLaneMessage(ack(t.posted[0].plaintext));
  await a;
  await new Promise((r) => setImmediate(r));
  assert.equal(sdk.decodeDeviceMessage(t.posted[1].plaintext).header.seq, 2);
  c.handleLaneMessage(ack(t.posted[1].plaintext));
  await b;
});

function ack(sentPlaintext) {
  const h = sdk.decodeDeviceMessage(sentPlaintext).header;
  return sdk.encodeDeviceMessage({ v: 1, id: "r" + h.id, seq: h.seq, op: "ack", session: "sess-1", re: h.id }, { ok: true });
}

test("session_ended rejects pending commands and fires ended", async () => {
  const t = fakeTransport();
  const c = sdk.createDeviceClient(t, { deviceId: "d" }, { commandTimeoutMs: 1000 });
  const opened = c.open();
  c.handleDelivery("device_session", activeDelivery());
  await opened;
  let endedReason = null;
  c.on("ended", (r) => (endedReason = r));
  const p = c.type("hello");
  c.handleDelivery("device_session", { type: "device_session_ended", session: { id: "sess-1" }, end_reason: "stopped_by_person" });
  await assert.rejects(p);
  assert.equal(endedReason, "stopped_by_person");
});

test("stop() calls the transport and ends the session", async () => {
  let stopped = null;
  const t = fakeTransport({ async stopSession(id) { stopped = id; } });
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  c.handleDelivery("device_session", activeDelivery());
  await opened;
  await c.stop();
  assert.equal(stopped, "sess-1");
  assert.equal(c.session().status, "ended");
});

test("a result for someone else's session is ignored", async () => {
  const t = fakeTransport();
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  c.handleDelivery("device_session", activeDelivery());
  await opened;
  const stray = sdk.encodeDeviceMessage({ v: 1, id: "r", seq: 1, op: "ack", session: "OTHER", re: "x" }, { ok: true });
  assert.equal(c.handleLaneMessage(stray), false);
});
