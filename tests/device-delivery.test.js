// The device-control session lifecycle delivery: a `device_session_*` body
// (event !== "message") is routed to onDeviceDelivery with its type verbatim,
// never to onMessage. This is the one SDK touch-up salt-device's renderer needs
// so a DeviceSession request/active/ended reaches its session controller.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

function dispatcherWith(onDeviceDelivery) {
  return sdk.createDispatcher({
    client: { trackEvent() {} },
    identities: { get: () => undefined, all: () => [] },
    pgpPassphrase: "x",
    logger: { info() {}, error() {} },
    onDeviceDelivery,
  });
}

test("dispatch routes every device_session_* type to onDeviceDelivery, verbatim", async () => {
  const seen = [];
  const d = dispatcherWith((type, body) => void seen.push([type, body]));
  for (const type of ["device_session_request", "device_session_active", "device_session_ended"]) {
    await d.dispatch({ type, session: { id: "s1" } }, "dev-1");
  }
  assert.deepEqual(
    seen.map((s) => s[0]),
    ["device_session_request", "device_session_active", "device_session_ended"],
  );
  assert.equal(seen[0][1].session.id, "s1");
});

test("a non-device delivery never triggers onDeviceDelivery", async () => {
  let called = false;
  const d = dispatcherWith(() => void (called = true));
  await d.dispatch({ type: "something_else" }, "dev-1");
  assert.equal(called, false);
});

test("a device_session delivery with no handler set is a silent no-op", async () => {
  const d = dispatcherWith(undefined);
  await d.dispatch({ type: "device_session_request", session: { id: "s1" } }, "dev-1");
  assert.ok(true); // reached here without throwing, and it never fell through to onMessage
});

test("a device_queue delivery (the device's own rail) reaches onDeviceDelivery too", async () => {
  const seen = [];
  const d = dispatcherWith((type, body) => void seen.push([type, body]));
  await d.dispatch({ type: "device_queue", device_id: "d", controller: null, queue: [] }, "dev-1");
  assert.deepEqual(seen.map((s) => s[0]), ["device_queue"]);
});

test("grant and owner signals (identity-free) reach onDeviceDelivery", async () => {
  const seen = [];
  const d = dispatcherWith((type, body) => void seen.push([type, body]));
  await d.dispatch({ type: "device_grants_changed", device_id: "d" }, "dev-1");
  await d.dispatch({ type: "device_owner_changed", device_id: "d" }, "dev-1");
  assert.deepEqual(seen.map((s) => s[0]), ["device_grants_changed", "device_owner_changed"]);
});
