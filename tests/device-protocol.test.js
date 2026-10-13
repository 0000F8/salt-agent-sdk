// The [[SALT-DEVICE]] wire grammar (device/protocol.ts). Pure encode/decode;
// no transport, no crypto.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

test("encode then decode round-trips a command with a body", () => {
  const header = { v: 1, id: "ABC", seq: 3, op: "click", session: "sess-1" };
  const text = sdk.encodeDeviceMessage(header, { x: 10, y: 20, obs: "o1" });
  assert.ok(text.startsWith("[[SALT-DEVICE v=1 id=ABC seq=3 op=click session=sess-1]]"));
  const back = sdk.decodeDeviceMessage(text);
  assert.deepEqual(back.header, header);
  assert.deepEqual(back.body, { x: 10, y: 20, obs: "o1" });
});

test("a result carries re and round-trips", () => {
  const text = sdk.encodeDeviceMessage({ v: 1, id: "R1", seq: 1, op: "ack", session: "s", re: "C1" }, { ok: true });
  const back = sdk.decodeDeviceMessage(text);
  assert.equal(back.header.re, "C1");
  assert.deepEqual(back.body, { ok: true });
});

test("a marker with no body decodes to body undefined", () => {
  const text = sdk.encodeDeviceMessage({ v: 1, id: "X", seq: 1, op: "list_apps", session: "s" });
  const back = sdk.decodeDeviceMessage(text);
  assert.equal(back.body, undefined);
});

test("a plain chat line is not a device message", () => {
  assert.equal(sdk.decodeDeviceMessage("hello there"), null);
  assert.equal(sdk.decodeDeviceMessage("the [[SALT-DELEGATION]] marker"), null);
});

test("a marker missing a required field throws bad_args", () => {
  assert.throws(
    () => sdk.decodeDeviceMessage("[[SALT-DEVICE v=1 id=X op=click session=s]]"),
    (e) => e.code === "bad_args"
  );
});

test("seq must be a positive integer", () => {
  assert.throws(
    () => sdk.decodeDeviceMessage("[[SALT-DEVICE v=1 id=X seq=0 op=click session=s]]"),
    (e) => e.code === "bad_args"
  );
});

test("a non-JSON body throws bad_args", () => {
  assert.throws(
    () => sdk.decodeDeviceMessage("[[SALT-DEVICE v=1 id=X seq=1 op=type session=s]]\nnot json {"),
    (e) => e.code === "bad_args"
  );
});

test("capability map covers every agent op", () => {
  assert.equal(sdk.CAPABILITY_FOR_OP.observe, "device.observe");
  assert.equal(sdk.CAPABILITY_FOR_OP.click, "device.act");
  assert.equal(sdk.CAPABILITY_FOR_OP.read_file, "device.files.read");
  assert.equal(sdk.CAPABILITY_FOR_OP.write_file, "device.files.write");
  assert.equal(sdk.CAPABILITY_FOR_OP.focus_app, "device.apps");
  assert.equal(sdk.CAPABILITY_FOR_OP.stop, null);
  assert.equal(sdk.CAPABILITY_FOR_OP.shell, "device.shell");
});

test("count classes map correctly", () => {
  assert.equal(sdk.countClassForOp("observe"), "observe");
  assert.equal(sdk.countClassForOp("read_file"), "file_read");
  assert.equal(sdk.countClassForOp("list_apps"), "app_focus");
  assert.equal(sdk.countClassForOp("stop"), null);
});

test("message ids are unique", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(sdk.deviceMessageId());
  assert.equal(seen.size, 1000);
});
