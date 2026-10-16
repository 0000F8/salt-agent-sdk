// Show Me (0.22.0): the SALT-POINT and SALT-HELP markers and the still/pointed bodies.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const bad = (fn) => assert.throws(fn, (e) => e instanceof sdk.DeviceProtocolError && ["bad_args", "unsupported"].includes(e.code));

test("point: encode then decode round-trips with words and obs", () => {
  const text = sdk.encodePoint({ help: "h-1", obs: "OBS1", x: 0.6012, y: 0.411, id: "P1", words: "this one" });
  assert.equal(text, "[[SALT-POINT v=1 help=h-1 obs=OBS1 x=0.6012 y=0.4110 id=P1]]\nthis one");
  assert.ok(sdk.isPointMessage(text));
  assert.deepEqual(sdk.decodePoint(text), { v: 1, help: "h-1", obs: "OBS1", x: 0.6012, y: 0.411, id: "P1", words: "this one" });
});

test("point: obs and words are optional (a live-frame point)", () => {
  const text = sdk.encodePoint({ help: "h", x: 0, y: 1, id: "P2" });
  assert.equal(text, "[[SALT-POINT v=1 help=h x=0.0000 y=1.0000 id=P2]]");
  const p = sdk.decodePoint(text);
  assert.equal(p.obs, undefined);
  assert.equal(p.words, "");
  assert.equal(p.x, 0);
  assert.equal(p.y, 1);
});

test("point: not a point is null, never a throw", () => {
  assert.equal(sdk.decodePoint("hello"), null);
  assert.equal(sdk.decodePoint("[[SALT-DEVICE v=1 id=a seq=1 op=ack session=s]]"), null);
  assert.equal(sdk.isPointMessage("hello"), false);
});

test("point: x and y are bounded to 0..1 with at most four decimals", () => {
  for (const v of ["1.0001", "-0.1", "2", "0.12345", "abc", "", ".5", "01", "1.5"]) {
    bad(() => sdk.decodePoint(`[[SALT-POINT v=1 help=h x=${v} y=0.5 id=P]]`));
    bad(() => sdk.decodePoint(`[[SALT-POINT v=1 help=h x=0.5 y=${v} id=P]]`));
  }
  for (const v of ["0", "1", "0.5", "0.0001", "0.9999", "1.0"]) {
    assert.ok(sdk.decodePoint(`[[SALT-POINT v=1 help=h x=${v} y=${v} id=P]]`));
  }
  bad(() => sdk.encodePoint({ help: "h", x: 1.01, y: 0.5, id: "P" }));
  bad(() => sdk.encodePoint({ help: "h", x: 0.5, y: -0.01, id: "P" }));
  bad(() => sdk.encodePoint({ help: "h", x: NaN, y: 0.5, id: "P" }));
});

test("point: malformed markers are refused", () => {
  bad(() => sdk.decodePoint("[[SALT-POINT]]"));
  bad(() => sdk.decodePoint("[[SALT-POINT v=1 help=h x=0.5 y=0.5]]")); // no id
  bad(() => sdk.decodePoint("[[SALT-POINT v=1 x=0.5 y=0.5 id=P]]")); // no help
  bad(() => sdk.decodePoint("[[SALT-POINT v=2 help=h x=0.5 y=0.5 id=P]]")); // version
  bad(() => sdk.decodePoint("[[SALT-POINT v=1 help=h x=0.5 y=0.5 id=P x=0.6]]")); // repeated
  bad(() => sdk.decodePoint("[[SALT-POINT v=1 help=h x=0.5 y=0.5 id=P")); // unterminated
  bad(() => sdk.decodePoint("[[SALT-POINT v=1 help=h$ x=0.5 y=0.5 id=P]]")); // bad id char
  bad(() => sdk.decodePoint(`[[SALT-POINT v=1 help=${"a".repeat(65)} x=0.5 y=0.5 id=P]]`)); // id too long
});

test("point: words are capped at 200 characters, counted as code points", () => {
  const ok = "😀".repeat(200);
  assert.equal(sdk.decodePoint(`[[SALT-POINT v=1 help=h x=0.5 y=0.5 id=P]]\n${ok}`).words, ok);
  bad(() => sdk.decodePoint(`[[SALT-POINT v=1 help=h x=0.5 y=0.5 id=P]]\n${ok}a`));
  bad(() => sdk.encodePoint({ help: "h", x: 0.5, y: 0.5, id: "P", words: "a".repeat(201) }));
});

test("help: encode then decode round-trips every reason", () => {
  for (const reason of sdk.HELP_REASONS) {
    const text = sdk.encodeHelp({ reason, question: "Which account do I use?" });
    assert.equal(text, `[[SALT-HELP reason=${reason}]]\nWhich account do I use?`);
    assert.ok(sdk.isHelpMessage(text));
    assert.deepEqual(sdk.decodeHelp(text), { reason, question: "Which account do I use?" });
  }
});

test("help: malformed or over-long input decodes to null; encode refuses it", () => {
  assert.equal(sdk.decodeHelp("hello"), null);
  assert.equal(sdk.decodeHelp("[[SALT-HELP reason=panic]]\nq"), null);
  assert.equal(sdk.decodeHelp("[[SALT-HELP reason=stuck]]"), null);
  assert.equal(sdk.decodeHelp("[[SALT-HELP reason=stuck]]\n   "), null);
  assert.equal(sdk.decodeHelp(`[[SALT-HELP reason=stuck]]\n${"a".repeat(501)}`), null);
  assert.equal(sdk.decodeHelp(`[[SALT-HELP reason=stuck]]\n${"a".repeat(500)}`).question.length, 500);
  assert.throws(() => sdk.encodeHelp({ reason: "nope", question: "q" }));
  assert.throws(() => sdk.encodeHelp({ reason: "stuck", question: "" }));
  assert.throws(() => sdk.encodeHelp({ reason: "stuck", question: "a".repeat(501) }));
});

test("still and pointed ride the normal SALT-DEVICE envelope", () => {
  const still = { help_id: "h", obs: "O1", width: 1280, height: 800, scale: 2, format: "jpeg", image_b64: "AA", taken_at: "2026-10-15T10:00:00Z" };
  const text = sdk.encodeDeviceMessage({ v: 1, id: "S1", seq: 4, op: "still", session: "s" }, still);
  const back = sdk.decodeDeviceMessage(text);
  assert.equal(back.header.op, "still");
  assert.equal(back.header.re, undefined);
  assert.deepEqual(sdk.normalizeStill(back.body), still);
  assert.deepEqual(sdk.DEVICE_UNSOLICITED_OPS, ["still", "pointed"]);
});

test("normalizeStill rejects malformed bodies", () => {
  const good = { help_id: "h", obs: "O", width: 10, height: 10, scale: 1, format: "png", image_b64: "AA", taken_at: "t" };
  assert.ok(sdk.normalizeStill(good));
  assert.equal(sdk.normalizeStill(null), null);
  assert.equal(sdk.normalizeStill({ ...good, format: "gif" }), null);
  assert.equal(sdk.normalizeStill({ ...good, width: 0 }), null);
  assert.equal(sdk.normalizeStill({ ...good, image_b64: "" }), null);
  assert.equal(sdk.normalizeStill({ ...good, obs: "" }), null);
  assert.equal(sdk.normalizeStill({ ...good, extra: 1 }).extra, undefined);
});

test("normalizePointed allow-lists, bounds x/y and drops the element when refused", () => {
  const el = { role: "AXRow", subrole: null, name: "Q3 Review.key", value: null, bounds: { x: 1, y: 2, w: 3, h: 4 } };
  const good = { help_id: "h", x: 0.6, y: 0.4, screen: { x: 812, y: 401 }, app: "Finder", element: el, refused: null, words: "this" };
  assert.deepEqual(sdk.normalizePointed(good), good);
  assert.equal(sdk.normalizePointed({ ...good, x: 1.2 }), null);
  assert.equal(sdk.normalizePointed({ ...good, screen: null }), null);
  assert.equal(sdk.normalizePointed({ ...good, help_id: "" }), null);
  const refused = sdk.normalizePointed({ ...good, refused: "secure_field" });
  assert.equal(refused.refused, "secure_field");
  assert.equal(refused.element, null);
  assert.equal(sdk.normalizePointed({ ...good, refused: "bogus", element: null }).refused, null);
  assert.equal(sdk.normalizePointed({ ...good, element: { role: 5 } }).element, null);
});
