// The read-only `apps_access` op: client round trip, host handler, unsupported when absent, capability gate.
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
  as_of: "2026-11-17T10:00:00Z",
  system: { accessibility: { state: "granted" }, screen_recording: { state: "off" } },
  apps: [
    { bundle_id: "com.apple.Safari", app: "Safari", group: "can_control", status: "allowed", installed: true, running: true, live: true, used_by: [{ agent: "salt", last_used_at: "2026-11-17T09:00:00Z" }], actions: ["check"] },
    { bundle_id: "com.example.Vault", app: "Vault", group: "never_allowed", status: "never_allowed", reason: "blocked", actions: [] },
  ],
};

test("apps_access is a known op and result op under device.apps, never counted", () => {
  assert.ok(sdk.AGENT_OPS.includes("apps_access"));
  assert.ok(sdk.DEVICE_RESULT_OPS.includes("apps_access"));
  assert.equal(sdk.CAPABILITY_FOR_OP.apps_access, "device.apps");
  assert.equal(sdk.CAPABILITY_FOR_OP.apps_access, sdk.CAPABILITY_FOR_OP.list_apps);
  assert.equal(sdk.countClassForOp("apps_access"), null);
  assert.ok(!sdk.MUTATING_OPS.includes("apps_access"));
});

test("appsAccess() sends an apps_access command and resolves with the result", async () => {
  const { c, posted } = await openClient();
  const p = c.appsAccess();
  const sent = sdk.decodeDeviceMessage(posted[0]);
  assert.equal(sent.header.op, "apps_access");
  c.handleLaneMessage(sdk.encodeDeviceMessage({ v: 1, id: "r1", seq: 1, op: "apps_access", session: "sess-1", re: sent.header.id }, RESULT), "d");
  assert.deepEqual(await p, RESULT);
});

function host(caps, appsAccess) {
  const results = [];
  const noop = async () => {};
  const h = { observe: noop, click: noop, type: noop, key: noop, scroll: noop, submit: noop, focusApp: noop, listApps: noop, readFile: noop, writeFile: noop, ...(appsAccess ? { appsAccess } : {}) };
  const tx = {
    results,
    async postResult(pt) { results.push(sdk.decodeDeviceMessage(pt)); },
    async beat() {}, async reportCounts() {}, async stop() {},
  };
  const snap = { sessionId: "sess-1", agentId: "ag", readers: { chatId: "chat-1", publicKeys: ["K"] }, caps };
  return { tx, host: sdk.createDeviceHost(snap, h, tx) };
}
const cmd = (seq, op = "apps_access") => sdk.encodeDeviceMessage({ v: 1, id: `c${seq}`, seq, op, session: "sess-1", exp: Date.now() + 30000 }, {});

test("host answers apps_access from the handler as an apps_access op", async () => {
  const { tx, host: h } = host({ "device.apps": true }, async () => RESULT);
  await h.handleCommand(cmd(1));
  const last = tx.results.at(-1);
  assert.equal(last.header.op, "apps_access");
  assert.deepEqual(last.body, RESULT);
});

test("host without an appsAccess handler answers unsupported", async () => {
  const { tx, host: h } = host({ "device.apps": true });
  await h.handleCommand(cmd(1));
  const last = tx.results.at(-1);
  assert.equal(last.header.op, "error");
  assert.equal(last.body.code, "unsupported");
});

test("apps_access is refused without device.apps exactly as list_apps is", async () => {
  let called = false;
  const { tx, host: h } = host({}, async () => { called = true; return RESULT; });
  await h.handleCommand(cmd(1, "list_apps"));
  await h.handleCommand(cmd(2, "apps_access"));
  assert.equal(called, false);
  const [a, b] = tx.results.slice(-2);
  assert.equal(a.header.op, "error");
  assert.equal(b.header.op, "error");
  assert.equal(b.body.code, a.body.code);
});
