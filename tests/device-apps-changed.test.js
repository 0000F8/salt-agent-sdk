// The unsolicited `apps_changed` op (0.41.0): body allow-list, host.notifyAppsChanged (grant, rate limit,
// coalescing), and client.onAppsChanged.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

test("apps_changed is unsolicited: not an agent op, not a result op, constants mirror STILL", () => {
  assert.ok(sdk.DEVICE_UNSOLICITED_OPS.includes("apps_changed"));
  assert.ok(!sdk.AGENT_OPS.includes("apps_changed"));
  assert.ok(!sdk.DEVICE_RESULT_OPS.includes("apps_changed"));
  assert.equal(sdk.APPS_CHANGED_MIN_INTERVAL_MS, 1000);
  assert.equal(sdk.APPS_CHANGED_MAX_PER_MINUTE, 30);
  assert.equal(sdk.APPS_CHANGED_MAX_IDS, 50);
  assert.equal(sdk.APPS_CHANGED_ID_MAX, 200);
});

test("normalizeAppsChanged allow-lists, dedupes, clips and caps", () => {
  assert.deepEqual(sdk.normalizeAppsChanged({ at: 5, changed: ["a", "b", "a", "", 7, null], name: "Safari" }), { at: 5, changed: ["a", "b"] });
  assert.equal(sdk.normalizeAppsChanged({ at: 5, changed: ["x".repeat(500)] }).changed[0].length, 200);
  assert.equal(sdk.normalizeAppsChanged({ at: 5, changed: ["😀".repeat(300)] }).changed[0], "😀".repeat(200));
  const many = Array.from({ length: 80 }, (_, i) => `id${i}`);
  assert.deepEqual(sdk.normalizeAppsChanged({ at: 1, changed: many }).changed, many.slice(0, 50));
  for (const bad of [null, "x", [], {}, { at: "1", changed: ["a"] }, { at: 1.5, changed: ["a"] }, { at: -1, changed: ["a"] }, { at: 1, changed: "a" }, { at: 1, changed: [] }, { at: 1, changed: ["", 3] }]) {
    assert.equal(sdk.normalizeAppsChanged(bad), null, JSON.stringify(bad));
  }
});

function setup(caps, options = {}) {
  const results = [];
  const tx = { async postResult(p, readers) { results.push({ m: sdk.decodeDeviceMessage(p), readers }); }, async beat() {}, async reportCounts() {}, async stop() {} };
  const clock = { t: 1_000_000 };
  const snap = { sessionId: "sess-1", agentId: "ag", readers: { chatId: "c", publicKeys: ["K"] }, caps };
  const host = sdk.createDeviceHost(snap, {}, tx, {}, { now: () => clock.t, ...options });
  return { host, results, clock };
}

test("host posts apps_changed with {at, changed} to the agent, no re", async () => {
  const { host, results, clock } = setup({ "device.apps": true });
  assert.deepEqual(await host.notifyAppsChanged(["com.a", "com.b", "com.a"]), { posted: true, changed: 2 });
  const { m, readers } = results[0];
  assert.equal(m.header.op, "apps_changed");
  assert.equal(m.header.re, undefined);
  assert.equal(m.header.session, "sess-1");
  assert.deepEqual(m.body, { at: clock.t, changed: ["com.a", "com.b"] });
  assert.deepEqual(readers, { chatId: "c", publicKeys: ["K"] });
});

test("without device.apps nothing is sent; empty and ended are refused", async () => {
  const a = setup({ "device.observe": { mode: "auto" } });
  assert.deepEqual(await a.host.notifyAppsChanged(["x"]), { posted: false, reason: "not_granted" });
  assert.equal(a.results.length, 0);
  const b = setup({ "device.apps": true });
  assert.deepEqual(await b.host.notifyAppsChanged([]), { posted: false, reason: "empty" });
  assert.deepEqual(await b.host.notifyAppsChanged(["", 3]), { posted: false, reason: "empty" });
  await b.host.stop();
  assert.deepEqual(await b.host.notifyAppsChanged(["x"]), { posted: false, reason: "ended" });
  assert.equal(b.results.length, 0);
});

test("a burst inside the gap coalesces into one message with the union of ids", async () => {
  const { host, results } = setup({ "device.apps": true }, { appsChangedMinIntervalMs: 60 });
  assert.equal((await host.notifyAppsChanged(["a"])).posted, true);
  assert.deepEqual(await host.notifyAppsChanged(["b"]), { posted: false, reason: "coalesced" });
  assert.deepEqual(await host.notifyAppsChanged(["c", "b"]), { posted: false, reason: "coalesced" });
  assert.equal(results.length, 1);
  // the held ids are sent as one message when the gap ends (real clock for the timer, fake for the gap)
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(results.length, 2);
  assert.deepEqual(results[1].m.body.changed, ["b", "c"]);
});

test("stop drops held ids; 30 a minute then holds the 31st", async () => {
  const { host, results, clock } = setup({ "device.apps": true });
  for (let i = 0; i < 30; i++) {
    assert.equal((await host.notifyAppsChanged([`id${i}`])).posted, true);
    clock.t += 1_000;
  }
  assert.equal(results.length, 30);
  assert.deepEqual(await host.notifyAppsChanged(["late"]), { posted: false, reason: "coalesced" });
  assert.equal(results.length, 30);
  await host.stop();
  assert.equal(results.length, 30);
});

test("paused sessions drop the ids", async () => {
  const { host, results } = setup({ "device.apps": true });
  await host.pause("person_active");
  assert.deepEqual(await host.notifyAppsChanged(["a"]), { posted: false, reason: "paused" });
  assert.equal(results.length, 0);
});

async function openClient() {
  const t = { async openSession(d) { return { id: "sess-1", device_id: d, agent_id: "ag", mandate_id: "m", status: "requested" }; }, async stopSession() {}, async postCommand() {} };
  const c = sdk.createDeviceClient(t, { deviceId: "d" });
  const opened = c.open();
  c.handleDelivery("device_session", { type: "device_session_active", session: { id: "sess-1", device_id: "d", agent_id: "ag", mandate_id: "m", status: "active", chat: { id: "chat-1", readers: ["K"] } } });
  await opened;
  return c;
}
const msg = (body, header = {}) => sdk.encodeDeviceMessage({ v: 1, id: "m1", seq: 1, op: "apps_changed", session: "sess-1", ...header }, body);

test("client.onAppsChanged delivers allow-listed bodies from the device only, unsubscribes", async () => {
  const c = await openClient();
  const got = [];
  const off = c.onAppsChanged((x) => got.push(x));
  c.onAppsChanged(() => { throw new Error("boom"); });
  assert.equal(c.handleLaneMessage(msg({ at: 9, changed: ["com.a"], app: "Safari" }), "d"), true);
  assert.deepEqual(got, [{ at: 9, changed: ["com.a"] }]);
  // malformed: consumed, not delivered
  assert.equal(c.handleLaneMessage(msg({ at: 9, changed: [] }), "d"), true);
  // a `re` makes it not unsolicited; another sender or session is not ours
  assert.equal(c.handleLaneMessage(msg({ at: 9, changed: ["x"] }, { re: "r" }), "d"), false);
  assert.equal(c.handleLaneMessage(msg({ at: 9, changed: ["x"] }), "person-1"), false);
  assert.equal(c.handleLaneMessage(msg({ at: 9, changed: ["x"] }, { session: "other" }), "d"), false);
  assert.equal(got.length, 1);
  off();
  c.handleLaneMessage(msg({ at: 9, changed: ["y"] }), "d");
  assert.equal(got.length, 1);
});
