// Show Me (0.22.0): the device host's help-request deliveries, SALT-POINT handling and postStill.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const READERS = { chatId: "lane-1", publicKeys: ["-----PUB-----"] };
const PERSON = "person-1";

function transport() {
  const results = [];
  return {
    results,
    async postResult(plaintext) {
      results.push(sdk.decodeDeviceMessage(plaintext));
    },
    async beat() {},
    async reportCounts() {},
    async stop() {},
  };
}

function setup({ handlers = {}, options = {}, callbacks = {}, snapshotExtra } = {}) {
  const tx = transport();
  const audits = [];
  const events = [];
  const clock = { t: 1_000_000 };
  const host = sdk.createDeviceHost(
    { sessionId: "sess-1", agentId: "ag", readers: READERS, caps: { "device.observe": { mode: "auto" } }, ...(snapshotExtra ?? {}) },
    {
      resolvePoint: async (a) => ({
        screen: { x: 812, y: 401 },
        app: "Finder",
        element: { role: "AXRow", subrole: null, name: "Q3 Review (final).key", value: null, bounds: { x: 1, y: 2, w: 3, h: 4 } },
        refused: null,
        _args: a,
      }),
      ...handlers,
    },
    tx,
    {
      onAudit: (e) => audits.push(e),
      onHelpOpened: (r) => events.push(["opened", r.id]),
      onHelpViewing: (r, v) => events.push(["viewing", r.id, v && v.display_name]),
      onHelpClosed: (r) => events.push(["closed", r.id]),
      ...callbacks,
    },
    { now: () => clock.t, isPersonOverDevice: (id) => id === PERSON, ...options }
  );
  return { host, tx, audits, events, clock };
}

const helpReq = (id = "h1", extra = {}) => ({ id, device_session_id: "sess-1", reason: "stuck", status: "open", ...extra });
const point = (over = {}) => sdk.encodePoint({ help: "h1", obs: "O1", x: 0.6012, y: 0.411, id: "P1", words: "this one", ...over });
const still = (over = {}) => ({ help_id: "h1", obs: "O1", width: 1280, height: 800, scale: 2, format: "jpeg", image_b64: "AA", taken_at: "2026-10-15T10:00:00Z", ...over });

test("help deliveries open, view and close, calling the injected callbacks", () => {
  const { host, events } = setup();
  assert.equal(host.handleDelivery("help_request_opened", { help_request: helpReq(), viewer: null }), true);
  assert.deepEqual(host.openHelpIds(), ["h1"]);
  assert.equal(host.handleDelivery("help_request_viewing", { help_request: helpReq(), viewer: { id: PERSON, display_name: "Ada" } }), true);
  assert.equal(host.handleDelivery("help_request_closed", { help_request: helpReq("h1", { status: "answered" }) }), true);
  assert.deepEqual(host.openHelpIds(), []);
  assert.deepEqual(events, [["opened", "h1"], ["viewing", "h1", "Ada"], ["closed", "h1"]]);
});

test("a help delivery for another session or another type is not ours", () => {
  const { host, events } = setup();
  assert.equal(host.handleDelivery("help_request_opened", { help_request: helpReq("h2", { device_session_id: "other" }) }), false);
  assert.equal(host.handleDelivery("help_request_opened", { help_request: helpReq("h3", { device_session_id: null }) }), false);
  assert.equal(host.handleDelivery("device_session_active", { help_request: helpReq() }), false);
  assert.equal(host.handleDelivery("help_request_opened", {}), false);
  assert.deepEqual(events, []);
});

test("a point from a person over the device, while help is open, is resolved and answered once", async () => {
  const seen = [];
  const { host, tx } = setup({
    handlers: {
      resolvePoint: async (a) => {
        seen.push(a);
        return { screen: { x: 812, y: 401 }, app: "Finder", element: { role: "AXRow", subrole: null, name: "Q3 Review (final).key", value: null, bounds: { x: 0, y: 0, w: 0, h: 0 } }, refused: null };
      },
    },
  });
  host.handleDelivery("help_request_opened", { help_request: helpReq() });
  assert.equal(await host.handleLaneMessage(point(), PERSON), true);
  assert.deepEqual(seen, [{ help_id: "h1", obs: "O1", x: 0.6012, y: 0.411, words: "this one" }]);
  assert.equal(tx.results.length, 1);
  const r = tx.results[0];
  assert.equal(r.header.op, "pointed");
  assert.equal(r.header.re, "P1");
  assert.equal(r.body.help_id, "h1");
  assert.equal(r.body.app, "Finder");
  assert.equal(r.body.element.name, "Q3 Review (final).key");
  assert.equal(r.body.refused, null);
  assert.equal(r.body.words, "this one");
  // The same point id again: ignored.
  await host.handleLaneMessage(point(), PERSON);
  assert.equal(tx.results.length, 1);
  assert.equal(seen.length, 1);
});

test("a point from anyone who is not a person over the device is ignored and audited once", async () => {
  const { host, tx, audits } = setup();
  host.handleDelivery("help_request_opened", { help_request: helpReq() });
  assert.equal(await host.handleLaneMessage(point(), "stranger"), true);
  assert.equal(tx.results.length, 0);
  const a = audits.filter((e) => e.op === "point");
  assert.equal(a.length, 1);
  assert.equal(a[0].decision, "refused");
});

test("without isPersonOverDevice every point is ignored", async () => {
  const { host, tx } = setup({ options: { isPersonOverDevice: undefined } });
  host.handleDelivery("help_request_opened", { help_request: helpReq() });
  await host.handleLaneMessage(point(), PERSON);
  assert.equal(tx.results.length, 0);
});

test("a point is ignored when its help request is not open, or after it closed", async () => {
  const { host, tx, audits } = setup();
  await host.handleLaneMessage(point(), PERSON);
  assert.equal(tx.results.length, 0);
  host.handleDelivery("help_request_opened", { help_request: helpReq() });
  host.handleDelivery("help_request_closed", { help_request: helpReq() });
  await host.handleLaneMessage(point({ id: "P2" }), PERSON);
  assert.equal(tx.results.length, 0);
  assert.equal(audits.filter((e) => e.op === "point").length, 2);
});

test("a point for a different help id is ignored", async () => {
  const { host, tx } = setup();
  host.handleDelivery("help_request_opened", { help_request: helpReq("h1") });
  await host.handleLaneMessage(point({ help: "other" }), PERSON);
  assert.equal(tx.results.length, 0);
});

test("a live watch lets a point through without a help request", async () => {
  const { host, tx } = setup({ options: { isWatchLive: () => true } });
  await host.handleLaneMessage(sdk.encodePoint({ help: "live", x: 0.5, y: 0.5, id: "P9" }), PERSON);
  assert.equal(tx.results.length, 1);
  assert.equal(tx.results[0].header.re, "P9");
});

test("malformed points are consumed and audited, never answered", async () => {
  const { host, tx, audits } = setup();
  host.handleDelivery("help_request_opened", { help_request: helpReq() });
  assert.equal(await host.handleLaneMessage("[[SALT-POINT v=1 help=h1 x=2 y=0.5 id=P]]", PERSON), true);
  assert.equal(await host.handleLaneMessage("[[SALT-POINT nonsense", PERSON), true);
  assert.equal(tx.results.length, 0);
  assert.equal(audits.filter((e) => e.op === "point").length, 2);
});

test("a message that is not a point is left for handleCommand", async () => {
  const { host } = setup();
  assert.equal(await host.handleLaneMessage("hello", PERSON), false);
  assert.equal(await host.handleLaneMessage("[[SALT-DEVICE v=1 id=a seq=1 op=observe session=sess-1]]", PERSON), false);
});

test("a never-allowed app is never named, whatever the handler returns", async () => {
  const { host, tx } = setup({
    handlers: {
      resolvePoint: async () => ({ screen: { x: 1, y: 1 }, app: "1Password 7 - Password Manager", element: { role: "AXRow", subrole: null, name: "bank", value: null, bounds: { x: 0, y: 0, w: 0, h: 0 } }, refused: null }),
    },
  });
  host.handleDelivery("help_request_opened", { help_request: helpReq() });
  await host.handleLaneMessage(point(), PERSON);
  const b = tx.results[0].body;
  assert.equal(b.refused, "forbidden_app");
  assert.equal(b.element, null);
  assert.equal(b.app, null);
});

test("a refused answer from the handler drops the element", async () => {
  const { host, tx } = setup({
    handlers: {
      resolvePoint: async () => ({ screen: { x: 1, y: 1 }, app: "Safari", element: { role: "AXTextField", subrole: "AXSecureTextField", name: "Password", value: "hunter2", bounds: { x: 0, y: 0, w: 1, h: 1 } }, refused: "secure_field" }),
    },
  });
  host.handleDelivery("help_request_opened", { help_request: helpReq() });
  await host.handleLaneMessage(point(), PERSON);
  assert.equal(tx.results[0].body.refused, "secure_field");
  assert.equal(tx.results[0].body.element, null);
});

test("a throwing or missing resolvePoint answers not_allowed with no element", async () => {
  for (const handlers of [{ resolvePoint: async () => { throw new Error("boom"); } }, { resolvePoint: undefined }]) {
    const { host, tx } = setup({ handlers });
    host.handleDelivery("help_request_opened", { help_request: helpReq() });
    await host.handleLaneMessage(point(), PERSON);
    assert.equal(tx.results[0].body.refused, "not_allowed");
    assert.equal(tx.results[0].body.element, null);
  }
});

test("postStill posts an unsolicited still op while help is open", async () => {
  const { host, tx } = setup();
  host.handleDelivery("help_request_viewing", { help_request: helpReq() });
  assert.deepEqual(await host.postStill(still()), { posted: true });
  const r = tx.results[0];
  assert.equal(r.header.op, "still");
  assert.equal(r.header.re, undefined);
  assert.equal(r.body.obs, "O1");
});

test("postStill refuses without an open help request and malformed bodies", async () => {
  const { host, tx } = setup();
  assert.deepEqual(await host.postStill(still()), { posted: false, reason: "no_help" });
  host.handleDelivery("help_request_viewing", { help_request: helpReq() });
  await assert.rejects(() => host.postStill({ help_id: "h1" }), (e) => e.code === "bad_args");
  assert.equal(tx.results.length, 0);
});

test("postStill enforces 2 s between stills and 30 a minute", async () => {
  const { host, clock } = setup();
  host.handleDelivery("help_request_viewing", { help_request: helpReq() });
  assert.equal((await host.postStill(still())).posted, true);
  clock.t += 1_999;
  assert.deepEqual(await host.postStill(still()), { posted: false, reason: "too_soon" });
  clock.t += 1;
  assert.equal((await host.postStill(still())).posted, true);
  // Thirty stills in a minute at the default gap never trip the cap (28 more, 2 s apart).
  for (let i = 0; i < 28; i++) {
    clock.t += 2_000;
    assert.equal((await host.postStill(still())).posted, true);
  }
});

test("postStill stops at 30 in any minute when the gap is shorter", async () => {
  const { host, clock } = setup({ options: { stillMinIntervalMs: 100 } });
  host.handleDelivery("help_request_viewing", { help_request: helpReq() });
  let posted = 0;
  for (let i = 0; i < 40; i++) {
    clock.t += 100;
    const r = await host.postStill(still());
    if (r.posted) posted += 1;
    else assert.equal(r.reason, "too_many");
  }
  assert.equal(posted, 30);
  clock.t += 60_000;
  assert.equal((await host.postStill(still())).posted, true);
});

test("no still while secure input is on, and none after the session ended", async () => {
  const { host } = setup();
  host.handleDelivery("help_request_viewing", { help_request: helpReq() });
  await host.pause("secure_field");
  assert.deepEqual(await host.postStill(still()), { posted: false, reason: "paused" });
  await host.resume();
  assert.equal((await host.postStill(still())).posted, true);
  await host.stop("done");
  assert.deepEqual(await host.postStill(still()), { posted: false, reason: "ended" });
});

test("a still is refused until the person has viewed the request, and after it closes", async () => {
  const { host, tx } = setup();
  host.handleDelivery("help_request_opened", { help_request: helpReq() });
  assert.deepEqual(await host.postStill(still()), { posted: false, reason: "not_viewed" });
  host.handleDelivery("help_request_viewing", { help_request: helpReq(), viewer: { id: PERSON } });
  assert.equal((await host.postStill(still())).posted, true);
  host.handleDelivery("help_request_closed", { help_request: helpReq() });
  assert.deepEqual(await host.postStill(still()), { posted: false, reason: "no_help" });
  assert.equal(tx.results.length, 1);
});

test("a still is refused while paused for ANY reason", async () => {
  for (const reason of ["person_active", "secure_field", "person", "other"]) {
    const { host } = setup();
    host.handleDelivery("help_request_viewing", { help_request: helpReq() });
    await host.pause(reason);
    assert.deepEqual(await host.postStill(still()), { posted: false, reason: "paused" }, reason);
  }
  const { host } = setup();
  host.handleDelivery("help_request_viewing", { help_request: helpReq() });
  host.handleDelivery("device_session_paused", { session_id: "sess-1", reason: "phone" });
  assert.deepEqual(await host.postStill(still()), { posted: false, reason: "paused" });
});

test("without device.observe auto/notify a still is encrypted for the people over the device only", async () => {
  const posts = [];
  const mk = (caps, peopleReaderKeys) => {
    const tx = { async postResult(pt, readers) { posts.push(readers); }, async beat() {}, async reportCounts() {}, async stop() {} };
    return sdk.createDeviceHost({ sessionId: "sess-1", agentId: "ag", readers: { chatId: "lane-1", publicKeys: ["AGENT", "PERSON"] }, caps }, {}, tx, {}, { now: () => 1_000_000, peopleReaderKeys });
  };
  for (const caps of [{}, { "device.observe": { mode: "ask" } }]) {
    const host = mk(caps, () => ["PERSON"]);
    host.handleDelivery("help_request_viewing", { help_request: helpReq() });
    assert.equal((await host.postStill(still())).posted, true);
    assert.deepEqual(posts.pop(), { chatId: "lane-1", publicKeys: ["PERSON"] });
    const none = mk(caps, undefined);
    none.handleDelivery("help_request_viewing", { help_request: helpReq() });
    assert.deepEqual(await none.postStill(still()), { posted: false, reason: "not_granted" });
    const empty = mk(caps, () => []);
    empty.handleDelivery("help_request_viewing", { help_request: helpReq() });
    assert.deepEqual(await empty.postStill(still()), { posted: false, reason: "not_granted" });
  }
  for (const mode of ["auto", "notify"]) {
    const host = mk({ "device.observe": { mode } }, () => ["PERSON"]);
    host.handleDelivery("help_request_viewing", { help_request: helpReq() });
    await host.postStill(still());
    assert.deepEqual(posts.pop().publicKeys, ["AGENT", "PERSON"], "with the grant, the usual readers");
  }
});

test("a phone pause and resume reach the host as deliveries, with reason phone", async () => {
  const { host } = setup();
  assert.equal(host.handleDelivery("device_session_paused", { session_id: "other", reason: "phone" }), false);
  assert.equal(host.pausedReason(), null);
  assert.equal(host.handleDelivery("device_session_paused", { session_id: "sess-1", reason: "person" }), false, "only the phone reason is taken from the wire");
  assert.equal(host.handleDelivery("device_session_paused", { session_id: "sess-1", reason: "phone" }), true);
  assert.equal(host.pausedReason(), "phone");
  assert.equal(host.handleDelivery("device_session_resumed", { session_id: "sess-1" }), true);
  assert.equal(host.pausedReason(), null);
});

test("a resume delivery never clears a local guard pause, and a phone pause never replaces one", async () => {
  const { host } = setup();
  await host.pause("secure_field");
  host.handleDelivery("device_session_paused", { session_id: "sess-1", reason: "phone" });
  assert.equal(host.pausedReason(), "secure_field", "the local guard stays on top");
  host.handleDelivery("device_session_resumed", { session_id: "sess-1" });
  assert.equal(host.pausedReason(), "secure_field");
  const b = setup();
  await b.host.pause("person");
  b.host.handleDelivery("device_session_resumed", { session_id: "sess-1" });
  assert.equal(b.host.pausedReason(), "person", "the tray pause is the person's, the phone cannot resume it");
});

test("an automatic resume leaves a phone pause; only a local resume clears it, and tells Salt local:true", async () => {
  const calls = [];
  const tx = {
    async postResult() {}, async beat() {}, async reportCounts() {}, async stop() {},
    async pause(sid, reason) { calls.push(["pause", reason]); },
    async resume(sid, o) { calls.push(["resume", o ?? null]); },
  };
  const host = sdk.createDeviceHost({ sessionId: "sess-1", agentId: "ag", readers: READERS, caps: {} }, {}, tx, {});
  host.handleDelivery("device_session_paused", { session_id: "sess-1", reason: "phone" });
  await host.pause("person_active"); // a local guard rides over it: reported, and Salt keeps phone
  await host.resume(); // the machine's idle timer
  assert.equal(host.pausedReason(), "phone", "still paused from the phone");
  await host.resume();
  assert.equal(host.pausedReason(), "phone");
  assert.equal(calls.some((c) => c[0] === "resume"), false, "no resume is sent for an automatic one");
  await host.resume({ local: true });
  assert.equal(host.pausedReason(), null);
  assert.deepEqual(calls.filter((c) => c[0] === "resume"), [["resume", { local: true }]]);
});
