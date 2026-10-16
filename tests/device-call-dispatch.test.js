// Show Me (0.22.0): call.* deliveries for a DEVICE account reach onDeviceCall (and the controlling
// agent's call.watch_* reach onWatchEvent) through the one dispatcher both the webhook route and
// socket mode use. Then the full device-side handshake: decrypt the person's offer with callBundle.ts,
// pin the fingerprints, answer with a signed bundle.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sdk = require("../dist/index.js");

const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };
const F = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "call_bundle_vectors.json"), "utf8"));
const DEVICE_ID = "70000000-0000-0000-0000-00000000d001";

function dispatcher(hooks) {
  const store = sdk.createIdentityStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "salt-devcall-")), "identities.json"));
  store.register({ saltAppId: DEVICE_ID, username: "mac", apiKey: "dev-key", publicKey: F.keys.device.publicKey, privateKey: F.keys.device.privateKey });
  const client = { async getWebhookSecret() { return "s"; }, async getChatMembers() { return []; }, async getChatMessages() { return []; }, async signalTyping() {}, trackEvent() {} };
  return sdk.createDispatcher({ client, identities: store, pgpPassphrase: "unused", logger: silent, ...hooks });
}

test("call.offer reaches onDeviceCall with the call, payload, caller and device", async () => {
  const seen = [];
  const d = dispatcher({ onDeviceCall: (ctx) => seen.push(ctx) });
  await d.dispatch(
    { event: "call.offer", call: { id: "call-1", chat_id: "chat-1", caller_id: "person-1", kind: "watch", device_id: DEVICE_ID }, from_user_id: "person-1", payload: "ARMORED" },
    DEVICE_ID
  );
  assert.equal(seen.length, 1);
  const c = seen[0];
  assert.equal(c.event, "call.offer");
  assert.equal(c.callId, "call-1");
  assert.equal(c.chatId, "chat-1");
  assert.equal(c.payload, "ARMORED");
  assert.equal(c.fromUserId, "person-1");
  assert.equal(c.deviceId, DEVICE_ID);
  assert.equal(c.identity.saltAppId, DEVICE_ID);
});

test("call.signal (call_id at the top) and call.end reach onDeviceCall, in order, awaited", async () => {
  const order = [];
  const d = dispatcher({
    onDeviceCall: async (ctx) => {
      await new Promise((r) => setTimeout(r, ctx.event === "call.offer" ? 30 : 0));
      order.push(ctx.event);
    },
  });
  await d.dispatch({ event: "call.offer", call: { id: "c", chat_id: "x", caller_id: "p" }, payload: "A" }, DEVICE_ID);
  await d.dispatch({ event: "call.signal", call_id: "c", payload: "B" }, DEVICE_ID);
  await d.dispatch({ event: "call.answer", call: { id: "c" }, payload: "C" }, DEVICE_ID);
  await d.dispatch({ event: "call.end", call: { id: "c", chat_id: "x" } }, DEVICE_ID);
  assert.deepEqual(order, ["call.offer", "call.signal", "call.answer", "call.end"]);
});

test("a throwing onDeviceCall is logged, never thrown into the transport", async () => {
  const d = dispatcher({ onDeviceCall: () => { throw new Error("boom"); } });
  await d.dispatch({ event: "call.offer", call: { id: "c", chat_id: "x" }, payload: "A" }, DEVICE_ID);
});

test("without onDeviceCall, or for an unknown identity, a call delivery is dropped as before", async () => {
  let n = 0;
  const none = dispatcher({});
  await none.dispatch({ event: "call.offer", call: { id: "c" }, payload: "A" }, DEVICE_ID);
  const d = dispatcher({ onDeviceCall: () => { n += 1; } });
  await d.dispatch({ event: "call.offer", call: { id: "c" }, payload: "A" }, "someone-else");
  await d.dispatch({ event: "call.offer", call: { id: "c" }, payload: "A" }, undefined);
  assert.equal(n, 0);
});

test("call.watch_started / call.watch_ended reach onWatchEvent, not onDeviceCall", async () => {
  const watch = [];
  const calls = [];
  const d = dispatcher({ onWatchEvent: (c) => watch.push(c), onDeviceCall: (c) => calls.push(c) });
  await d.dispatch({ event: "call.watch_started", call_id: "call-1", device_id: DEVICE_ID, viewer_id: "person-1", chat_id: "chat-1" }, DEVICE_ID);
  await d.dispatch({ event: "call.watch_ended", call: { id: "call-1", device_id: DEVICE_ID, caller_id: "person-1", chat_id: "chat-1" } }, DEVICE_ID);
  assert.deepEqual(watch.map((w) => [w.event, w.callId, w.deviceId, w.viewerId, w.chatId]), [
    ["call.watch_started", "call-1", DEVICE_ID, "person-1", "chat-1"],
    ["call.watch_ended", "call-1", DEVICE_ID, "person-1", "chat-1"],
  ]);
  assert.equal(calls.length, 0);
});

test("the device-side handshake: decrypt the offer, check freshness and the pin, answer with a signed bundle", async () => {
  const answers = [];
  const d = dispatcher({
    async onDeviceCall(ctx) {
      if (ctx.event !== "call.offer") return;
      const { bundle, signatureValid } = await sdk.decryptAndVerify({ armored: ctx.payload, decryptionPrivateKey: ctx.identity.privateKey, senderPublicKey: F.keys.person.publicKey });
      assert.ok(signatureValid && sdk.isBundleFresh({ bundle, now: F.offer_bundle.ts * 1000 }));
      assert.ok(sdk.fingerprintsMatch(bundle.dtls_fingerprints, bundle.sdp));
      const answer = sdk.buildCallBundle({ callId: bundle.call_id, kind: bundle.kind, sdp: F.answer_sdp });
      answers.push(await sdk.signAndEncrypt({ bundle: answer, signingPrivateKey: ctx.identity.privateKey, receiverPublicKey: F.keys.person.publicKey }));
    },
  });
  await d.dispatch({ event: "call.offer", call: { id: "call-1", chat_id: "chat-1", caller_id: "person-1", kind: "watch", device_id: DEVICE_ID }, from_user_id: "person-1", payload: F.fe_offer }, DEVICE_ID);
  assert.equal(answers.length, 1);
  const r = await sdk.decryptAndVerify({ armored: answers[0], decryptionPrivateKey: F.keys.person.privateKey, senderPublicKey: F.keys.device.publicKey });
  assert.equal(r.signatureValid, true);
  assert.equal(r.bundle.call_id, "call-session-1");
  assert.ok(sdk.fingerprintsMatch(r.bundle.dtls_fingerprints, F.answer_sdp));
});
