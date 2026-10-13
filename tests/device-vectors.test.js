// The [[SALT-DEVICE]] envelope and the device-task shapes, held to the shared fixture
// tests/fixtures/device_envelope_vectors.json. The SAME file is committed, byte for byte, in
// saltapp-python (tests/fixtures/device_envelope_vectors.json), written by scripts/
// generate_device_vectors.cjs from THIS module's compiled output; saltapp.device must encode the
// same bytes and normalise the same inputs. If this file changes, regenerate it there and copy it
// to both repos, or the two SDKs have drifted apart on the wire.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const sdk = require("../dist/index.js");

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "device_envelope_vectors.json"), "utf8"));

test("vectors: the fixture is well formed", () => {
  assert.ok(FIXTURE.envelopes.length >= 10);
  assert.ok(FIXTURE.decode_only.length >= 10);
  assert.ok(FIXTURE.task_args.length >= 15);
  assert.ok(FIXTURE.progress.length >= 10);
  assert.ok(FIXTURE.task_result.length >= 10);
});

test("vectors: constants are the ones the fixture was written with", () => {
  for (const [name, want] of Object.entries(FIXTURE.constants)) {
    assert.deepEqual(sdk[name], want, name);
  }
});

for (const v of FIXTURE.envelopes) {
  test(`vectors: encode — ${v.name}`, () => {
    assert.equal(sdk.encodeDeviceMessage(v.header, v.body), v.text);
  });
  test(`vectors: decode — ${v.name}`, () => {
    const m = sdk.decodeDeviceMessage(v.text);
    assert.deepEqual(m.header, v.decoded_header);
    assert.deepEqual(m.header, v.header);
    assert.deepEqual(m.body, v.decoded_body);
  });
}

for (const v of FIXTURE.decode_only) {
  test(`vectors: decode only — ${v.name}`, () => {
    if (v.expect_error) {
      assert.throws(() => sdk.decodeDeviceMessage(v.text), (e) => e instanceof sdk.DeviceProtocolError && e.code === v.expect_error);
    } else if (v.expect === null) {
      assert.equal(sdk.decodeDeviceMessage(v.text), null);
    } else {
      const m = sdk.decodeDeviceMessage(v.text);
      assert.deepEqual(m.header, v.expect.header);
      assert.deepEqual(m.body, v.expect.body);
    }
  });
}

for (const v of FIXTURE.task_args) {
  test(`vectors: task args — ${v.name}`, () => {
    if (v.expect_error) assert.throws(() => sdk.parseTaskArgs(v.input), (e) => e.code === v.expect_error);
    else assert.deepEqual(sdk.parseTaskArgs(v.input), v.expect);
  });
}

for (const v of FIXTURE.progress) {
  test(`vectors: progress — ${v.name}`, () => {
    assert.deepEqual(sdk.normalizeProgress(v.input), v.expect);
  });
}

for (const v of FIXTURE.task_result) {
  test(`vectors: task_result — ${v.name}`, () => {
    assert.deepEqual(sdk.normalizeTaskResult(v.input), v.expect);
  });
}
