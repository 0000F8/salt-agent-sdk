// Approve-first (Salt 0.240.0): requestAsk, onApprovalDecided's typed ask, X-Salt-Plan, needs_ask,
// requestModeChange, replaces / plan_id, and the approve_first / plan_required errors.
const test = require("node:test");
const assert = require("node:assert");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");
const silent = { info() {}, error() {} };

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return respond(url, opts, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}
function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k] }, json: async () => body, text: async () => JSON.stringify(body) };
}
const ASKED = { status: "asked", exercise_id: "ex-1", expires_at: "2026-10-21T00:00:00Z", approved: 1, needed: 3 };

test("requestAsk posts the words with a generated Idempotency-Key and resolves to an AskedResult", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(202, ASKED));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const out = await client.requestAsk("k", "m1", { capability: "profile.post", words: "Hello world", where: "my profile" });
  assert.deepStrictEqual(out, { asked: true, exerciseId: "ex-1", expiresAt: "2026-10-21T00:00:00Z", approved: 1, needed: 3 });
  assert.ok(sdk.isAsked(out));
  const c = fetchImpl.calls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/v1/mandates/m1/asks"));
  assert.deepStrictEqual(c.body, { capability: "profile.post", where: "my profile", words: "Hello world" });
  assert.match(c.headers["Idempotency-Key"], /^[0-9a-f-]{36}$/);
  await client.requestAsk("k", "m1", { capability: "room.create", words: "A room", where: "public", idempotencyKey: "mine-1" });
  assert.equal(fetchImpl.calls[1].headers["Idempotency-Key"], "mine-1");
});

test("requestAsk for outreach: wordsArmored goes as words_armored, encryptTo armors the words to that key, plain words are refused to armor elsewhere", async () => {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs: [{ name: "p" }], format: "armored" });
  const own = await openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs: [{ name: "me" }], format: "armored" });
  const fetchImpl = recordingFetch(() => jsonResponse(202, ASKED));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await client.requestAsk("k", "m1", { capability: "outreach.request", wordsArmored: "-----BEGIN PGP MESSAGE-----x", where: "Sam", recipientId: "u7" });
  assert.deepStrictEqual(fetchImpl.calls[0].body, { capability: "outreach.request", where: "Sam", recipient_id: "u7", words_armored: "-----BEGIN PGP MESSAGE-----x" });

  await client.requestAsk("k", "m1", { capability: "outreach.request", words: "Hi Sam, a quick hello", encryptTo: publicKey, ownPublicKey: own.publicKey, where: "Sam", chatId: "room-3" });
  const sent = fetchImpl.calls[1].body;
  assert.equal(sent.words, undefined, "the plain words never leave");
  assert.ok(sent.words_armored.startsWith("-----BEGIN PGP MESSAGE-----"));
  const dec = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: sent.words_armored }),
    decryptionKeys: await openpgp.readPrivateKey({ armoredKey: privateKey }),
  });
  assert.equal(dec.data, "Hi Sam, a quick hello");
  const mine = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: sent.words_armored }),
    decryptionKeys: await openpgp.readPrivateKey({ armoredKey: own.privateKey }),
  });
  assert.equal(mine.data, "Hi Sam, a quick hello", "sealed to the agent itself too");
  await assert.rejects(client.requestAsk("k", "m1", { capability: "outreach.request", words: "x", encryptTo: publicKey, where: "Sam", chatId: "c" }), /ownPublicKey/);

  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "x", encryptTo: publicKey, where: "w" }), /outreach\.request only/);
  await assert.rejects(client.requestAsk("k", "m1", { capability: "outreach.request", words: "x", wordsArmored: "y", where: "w", recipientId: "u" }), /not both/);
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", where: "w" }), /exact words/);
  assert.equal(fetchImpl.calls[1].body.chat_id, "room-3");
  const withMore = await client.requestAsk("k", "m1", { capability: "outreach.request", words: "yo", encryptTo: [publicKey, publicKey], ownPublicKey: own.publicKey, where: "Sam", recipientId: "u" });
  assert.ok(withMore.asked);
  fetchImpl.calls.pop();
  await assert.rejects(client.requestAsk("k", "m1", { capability: "outreach.request", words: "x", where: "w" }), /recipientId .* or chatId/);
  await assert.rejects(client.requestAsk("k", "m1", { capability: "outreach.request", words: "x", where: "w", recipientId: "u", chatId: "c" }), /not both/);
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "x", where: "w", chatId: "c" }), /outreach\.request only/);
  assert.equal(fetchImpl.calls.length, 2, "nothing invalid reaches the network");
});

test("requestAsk errors keep the server's code and Retry-After", async () => {
  const fetchImpl = recordingFetch((u, o, i) =>
    i === 0 ? jsonResponse(409, { error: "Different words for that key.", code: "idempotency_mismatch" }) : jsonResponse(429, { error: "Waiting on earlier approvals." }, { "Retry-After": "60" })
  );
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "a", where: "w" }), (e) => e.status === 409 && e.code === "idempotency_mismatch");
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "a", where: "w" }), (e) => e.status === 429 && e.retryAfterSeconds === 60);
});

test("approval_decided reaches onApprovalDecided with approved and a typed ask; an ordinary exercise has no ask", async () => {
  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "k", publicKey: "x", privateKey: "y" };
  const store = { get: (id) => (String(id) === "agent-1" ? agent : undefined), all: () => [agent], register() {}, reassignId() {} };
  const seen = [];
  const dispatcher = sdk.createDispatcher({ client: { trackEvent() {} }, identities: store, pgpPassphrase: "x", logger: silent, onApprovalDecided: (ctx) => void seen.push(ctx) });
  const base = { mandate_id: "m1", capability: "profile.post", action: "mandates#ask", actor: { id: "agent-1", username: "helper", display_name: "H", account_type: "Agent" }, principal: { id: "owner-1", username: "dan" }, created_at: "x" };
  await dispatcher.dispatch({ type: "approval_decided", exercise: { ...base, id: "ex-1", decision: "approved", summary: { words: "Hello!", asked_words: "Hello", where: "my profile" }, target_label: "your profile" } }, "agent-1");
  await dispatcher.dispatch({ type: "approval_decided", exercise: { ...base, id: "ex-2", capability: "outreach.request", decision: "denied", summary: { words_armored: "ARMOR", where: "Sam" } } }, "agent-1");
  await dispatcher.dispatch({ type: "approval_decided", exercise: { ...base, id: 7, capability: "money.pay", action: "transfers#prepare", decision: "approved", summary: {} } }, "agent-1");
  assert.equal(seen.length, 3);
  assert.equal(seen[0].approved, true);
  assert.deepStrictEqual(seen[0].ask, { exerciseId: "ex-1", capability: "profile.post", where: "my profile", words: "Hello!", wordsArmored: undefined, edited: true, askedWords: "Hello", askedWordsArmored: undefined, targetLabel: "your profile" });
  assert.equal(seen[1].approved, false);
  assert.equal(seen[1].ask.wordsArmored, "ARMOR");
  assert.equal(seen[1].ask.capability, "outreach.request");
  assert.equal(seen[2].ask, undefined);
  assert.equal(seen[2].exercise.id, 7);
});

test("plan sends X-Salt-Plan on the post, reply, message and first-chat helpers, and only when given", async () => {
  const fetchImpl = recordingFetch((url) => jsonResponse(200, url.endsWith("/profile_room") ? { room_id: "r1" } : { reply: {}, message_id: "mm", id: "c1" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await client.postToProfile("k", { text: "hi", plan: "plan-9" });
  await client.replyToPost("k", "p1", "re", { plan: "plan-9" });
  await client.postMessage("k", "c1", "cipher", "sender", undefined, undefined, { plan: "plan-9" });
  await client.postPlainMessage("k", "c1", "plain", { plan: "plan-9" });
  await client.createOrGetChat("k", "u1", { plan: "plan-9" });
  assert.deepStrictEqual(fetchImpl.calls.map((c) => c.headers["X-Salt-Plan"]), ["plan-9", "plan-9", "plan-9", "plan-9", "plan-9", "plan-9"]);
  await client.postToProfile("k", { text: "no plan" });
  await client.postMessage("k", "c1", "cipher", "sender");
  assert.equal(fetchImpl.calls.slice(6).every((c) => !("X-Salt-Plan" in c.headers)), true);
});

test("approve_first and plan_required refusals are typed errors carrying the server's sentence", async () => {
  const fetchImpl = recordingFetch((u, o, i) => {
    if (i === 0) return jsonResponse(403, { error: "Each public post waits for the person's OK first.", code: "approve_first", capability: "profile.post", approved: 1, needed: 3 });
    if (i === 1) return jsonResponse(403, { error: "Name the plan this post belongs to.", code: "plan_required" });
    if (i === 2) return jsonResponse(422, { error: "Each public post waits for the person's OK (mode ask) until they have approved 3 of them.", code: "approve_first", capability: "profile.post", approved: 0, needed: 3 });
    return jsonResponse(403, { error: "No.", code: "forbidden" });
  });
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await assert.rejects(client.postToProfile("k", { text: "x" }), (e) => {
    // the first call is POST /profile_room, which is where the fake refuses
    assert.ok(e instanceof sdk.ApproveFirstError && e instanceof sdk.SaltApiError);
    assert.equal(e.code, "approve_first");
    assert.equal(e.sentence, "Each public post waits for the person's OK first.");
    assert.equal(e.capability, "profile.post");
    assert.equal(e.approved, 1);
    assert.equal(e.needed, 3);
    assert.match(e.message, /Each public post waits/);
    return true;
  });
  await assert.rejects(client.postMessage("k", "c1", "x"), (e) => e instanceof sdk.PlanRequiredError && e.sentence === "Name the plan this post belongs to." && e.status === 403);
  await assert.rejects(client.requestGrant("k", { grantorId: "o", capabilities: [{ capability: "profile.post", selector: {}, mode: "auto" }] }), (e) => e instanceof sdk.ApproveFirstError && e.status === 422 && e.needed === 3);
  await assert.rejects(client.postMessage("k", "c1", "x"), (e) => !(e instanceof sdk.ApproveFirstError) && !(e instanceof sdk.PlanRequiredError) && e.code === "forbidden");
});

test("checkGrant reads needs_ask for an ask row", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { allowed: false, mandate_id: "m1", mode: "ask", needs_ask: true }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const check = await client.checkGrant("k", "profile.post");
  assert.equal(check.needs_ask, true);
  assert.equal(check.mode, "ask");
  assert.equal(check.allowed, false);
});

test("requestModeChange posts mode_change and a reason; the answer arrives with changes.mode_change", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(201, { id: "m1", tune_request: { id: "t1", changes: { mode_change: { capability: "profile.post", mode: "notify" } }, reason: "3 approved", at: "x" } }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const m = await client.requestModeChange("k", "m1", { capability: "profile.post" }, { reason: "You approved 3" });
  assert.ok(fetchImpl.calls[0].url.endsWith("/api/v1/mandates/m1/tune_requests"));
  assert.deepStrictEqual(fetchImpl.calls[0].body, { mode_change: { capability: "profile.post", mode: "notify" }, reason: "You approved 3" });
  assert.deepStrictEqual(m.tune_request.changes.mode_change, { capability: "profile.post", mode: "notify" });

  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "k", publicKey: "x", privateKey: "y" };
  const store = { get: () => agent, all: () => [agent], register() {}, reassignId() {} };
  const tuned = [];
  const declined = [];
  const dispatcher = sdk.createDispatcher({ client: { trackEvent() {} }, identities: store, pgpPassphrase: "x", logger: silent, onStrategyTuned: (c) => void tuned.push(c), onStrategyTuneDeclined: (c) => void declined.push(c) });
  const mc = { mode_change: { capability: "profile.post", mode: "notify" } };
  await dispatcher.dispatch({ id: "m1", type: "strategy_tuned", strategy_id: "s1", changes: mc, strategy: {}, version: 3 }, "agent-1");
  await dispatcher.dispatch({ id: "m1", type: "strategy_tune_declined", strategy_id: "s1", changes: mc, version: 3 }, "agent-1");
  assert.deepStrictEqual(tuned[0].changes, mc);
  assert.deepStrictEqual(declined[0].changes, mc);
});

test("replaces and planId ride on the proposal; revoke surfaces also_ended", async () => {
  const fetchImpl = recordingFetch((url) => jsonResponse(200, url.endsWith("/revoke") ? { id: "m1", status: "revoked", also_ended: ["m2", "m3"] } : { id: "m9" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await client.mandates.propose("k", { grantor_id: "o", capabilities: [], replaces: "strat_old" });
  await client.mandates.propose("k", { grantor_id: "o", capabilities: [{ capability: "profile.post", selector: {} }], plan_id: "plan-9" });
  await client.requestGrant("k", { grantorId: "o", capabilities: [], replaces: "strat_old", planId: "plan-9" });
  assert.equal(fetchImpl.calls[0].body.replaces, "strat_old");
  assert.equal(fetchImpl.calls[1].body.plan_id, "plan-9");
  assert.equal(fetchImpl.calls[2].body.replaces, "strat_old");
  assert.equal(fetchImpl.calls[2].body.plan_id, "plan-9");
  const revoked = await client.mandates.revoke("k", "m1");
  assert.deepStrictEqual(revoked.also_ended, ["m2", "m3"]);
});

test("createRoom posts a group create (open or public), and plan rides as X-Salt-Plan", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { id: "room-1" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const room = await client.createRoom("k", { name: "Dark Orbit", description: "d", open: true, plan: "plan-9" });
  assert.equal(room.id, "room-1");
  const c = fetchImpl.calls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/v1/chats"));
  assert.deepStrictEqual(c.body, { contact_ids: [], name: "Dark Orbit", description: "d", encrypted: false });
  assert.equal(c.headers["X-Salt-Plan"], "plan-9");
  await client.createRoom("k", { name: "Club", public: true, contactIds: ["u1"] });
  assert.deepStrictEqual(fetchImpl.calls[1].body, { contact_ids: ["u1"], name: "Club", public: true });
  assert.ok(!("X-Salt-Plan" in fetchImpl.calls[1].headers));
});

test("createRoom without an approved ask is a typed ApproveFirstError", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(403, { error: "This waits for your owner's OK. File it with POST /mandates/:id/asks and wait for approval.", code: "approve_first", capability: "room.create" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await assert.rejects(client.createRoom("k", { name: "x", open: true }), (e) => e instanceof sdk.ApproveFirstError && e.capability === "room.create" && /waits for your owner/.test(e.sentence));
});

test("requestAsk carries about, kind and a media digest, and refuses them on the wrong capability", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(202, ASKED));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const digest = sdk.mediaDigestOf(Buffer.from("abc"));
  assert.equal(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  await client.requestAsk("k", "m1", { capability: "profile.post", words: "pic", where: "profile", kind: "reply", mediaDigest: digest });
  assert.deepStrictEqual(fetchImpl.calls[0].body, { capability: "profile.post", where: "profile", kind: "reply", media_digest: digest, words: "pic" });
  await client.requestAsk("k", "m1", { capability: "room.create", words: "Club", where: "public", about: "Weekly chess" });
  assert.equal(fetchImpl.calls[1].body.about, "Weekly chess");
  await assert.rejects(client.requestAsk("k", "m1", { capability: "room.create", words: "x", where: "w", kind: "post" }), /profile\.post only/);
  await assert.rejects(client.requestAsk("k", "m1", { capability: "profile.post", words: "x", where: "w", about: "a" }), /room\.create only/);
  assert.equal(fetchImpl.calls.length, 2);
});

test("an approved outreach ask is decrypted for the agent; an edit shows the original", async () => {
  const kp = await openpgp.generateKey({ type: "ecc", curve: "curve25519Legacy", userIDs: [{ name: "me" }], format: "armored", passphrase: "pw" });
  const armored = await openpgp.encrypt({ message: await openpgp.createMessage({ text: "Edited hello" }), encryptionKeys: await openpgp.readKey({ armoredKey: kp.publicKey }) });
  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "k", publicKey: kp.publicKey, privateKey: kp.privateKey };
  const store = { get: () => agent, all: () => [agent], register() {}, reassignId() {} };
  const seen = [];
  const dispatcher = sdk.createDispatcher({ client: { trackEvent() {} }, identities: store, pgpPassphrase: "pw", logger: silent, onApprovalDecided: (c) => void seen.push(c) });
  const ex = { id: "ex-9", mandate_id: "m1", capability: "outreach.request", action: "mandates#ask", decision: "approved", actor: { id: "agent-1" }, principal: { id: "o" }, summary: { words_armored: armored, asked_words_armored: "ORIGINAL", where: "Sam", recipient_id: "u7" }, target_label: "Sam" };
  await dispatcher.dispatch({ type: "approval_decided", exercise: ex }, "agent-1");
  assert.equal(seen[0].ask.words, "Edited hello");
  assert.equal(seen[0].ask.edited, true);
  assert.equal(seen[0].ask.askedWordsArmored, "ORIGINAL");
  assert.equal(seen[0].ask.targetLabel, "Sam");
});
