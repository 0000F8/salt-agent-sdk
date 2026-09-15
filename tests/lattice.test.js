// Lattice (see ../../salt-lattice/docs/PROTOCOL.md) lets a hosted identity
// ask the person it's chatting with for personal facts, over a real Salt
// message, and get an answer back the same way delegations.ts gets one from
// another agent. A request's plaintext id is visible to every current
// member of whatever chat it's sent into (see requestPersonalData's own
// comment in actions.ts) -- so the security boundary is NOT secrecy of the
// id, it's that a release can only ever resolve the wait it actually
// answers when it arrives from the EXACT chat and person that wait was
// bound to (lattice.register/classifyRelease). These tests pin: the wire
// markers round-trip exactly what PROTOCOL.md specifies, including
// rejecting out-of-protocol or malformed shapes; the pending registry
// resolves, refuses a mismatched chat/sender (a bystander forging a
// release), times out, and rejects a duplicate register(); a late or
// standing release reaches onRelease/onLatticeRelease (including when a
// handler itself throws or its promise rejects); and the three actions.ts
// tools built on top of all this -- via a fake client, never a real
// salt-api -- behave per PROTOCOL.md, including the group-chat side-lane
// hint and a bystander forgery attempt against a real request_personal_data
// call.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");
const { lattice } = sdk;

const silent = { info() {}, error() {} };

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-lattice-"));
  return path.join(dir, "identities.json");
}

// Fast by construction: every actions-level "pending" test below passes this
// instead of the real 15s LATTICE_REQUEST_TIMEOUT_MS, so the suite doesn't
// have to burn real wall-clock time to exercise the timeout path. One
// dedicated test pins the real production constant separately.
const FAST_TIMEOUT_MS = 60;

// =====================================================================
// Markers & builders
// =====================================================================

test("buildRequest mints a 26-char ULID and a marker parseRelease's sibling regex would recognize the same id in", () => {
  const { id, text } = lattice.buildRequest({ purpose: "pick a restaurant for Friday", asks: ["preferences.food.cuisine.*"] });

  assert.match(id, sdk.ULID_RE);
  assert.equal(id.length, 26);

  const match = lattice.REQUEST_MARKER_RE.exec(text);
  assert.ok(match, "REQUEST_MARKER_RE must match buildRequest's own output");
  assert.equal(match[1], id);

  const body = JSON.parse(text.slice(match[0].length));
  assert.equal(body.purpose, "pick a restaurant for Friday");
  assert.deepEqual(body.asks, ["preferences.food.cuisine.*"]);
});

test("buildProposal mints a marker matching PROPOSE_MARKER_RE with a valid ULID and the given proposals", () => {
  const proposals = [{ type: "preferences.food.cuisine", parent_name: "Food", fields: { name: "Japanese", strength: 0.8 } }];
  const text = lattice.buildProposal(proposals);

  const match = lattice.PROPOSE_MARKER_RE.exec(text);
  assert.ok(match, "PROPOSE_MARKER_RE must match buildProposal's own output");
  assert.match(match[1], sdk.ULID_RE);

  const body = JSON.parse(text.slice(match[0].length));
  assert.deepEqual(body.proposals, proposals);
});

test("LATTICE_REQUEST_TIMEOUT_MS is pinned at 15s (the actions-level tests below override it for speed, not for correctness)", () => {
  assert.equal(lattice.LATTICE_REQUEST_TIMEOUT_MS, 15_000);
});

const validFact = { path: "preferences/food/cuisine/Japanese", type: "preferences.food.cuisine", field: "strength", value: 0.8, author: "you", updated: 1789580100000 };

test("parseRelease parses an ordinary reply (request_id, facts) and matches RELEASE_MARKER_RE's own id group", () => {
  const releaseId = sdk.newUlid();
  const requestId = sdk.newUlid();
  const text = `[[SALT-LATTICE-RELEASE id=${releaseId}]]\n${JSON.stringify({ request_id: requestId, facts: [validFact] })}`;

  const parsed = lattice.parseRelease(text);
  assert.ok(parsed);
  assert.equal(parsed.id, releaseId);
  assert.equal(parsed.standing, undefined);
  assert.equal(parsed.body.request_id, requestId);
  assert.deepEqual(parsed.body.facts, [validFact]);
});

test("parseRelease parses a standing push (grant_id, since_seq, no request_id)", () => {
  const releaseId = sdk.newUlid();
  const grantId = `g_${sdk.newUlid()}`;
  const text = `[[SALT-LATTICE-RELEASE id=${releaseId} standing=${grantId}]]\n${JSON.stringify({ grant_id: grantId, since_seq: 1240, facts: [] })}`;

  const parsed = lattice.parseRelease(text);
  assert.ok(parsed);
  assert.equal(parsed.id, releaseId);
  assert.equal(parsed.standing, grantId);
  assert.equal(parsed.body.request_id, undefined);
  assert.equal(parsed.body.grant_id, grantId);
  assert.equal(parsed.body.since_seq, 1240);
  assert.deepEqual(parsed.body.facts, []);
});

test("parseRelease returns null for ordinary text, a different marker, and an unparseable or shapeless body", () => {
  assert.equal(lattice.parseRelease("just a normal chat message"), null);
  assert.equal(lattice.parseRelease("[[SALT-DELEGATION depth=1]]\nsome task"), null, "a different marker entirely");

  const id = sdk.newUlid();
  const reqId = sdk.newUlid();
  assert.equal(lattice.parseRelease(`[[SALT-LATTICE-RELEASE id=${id}]]\nnot json at all`), null, "unparseable body");
  assert.equal(lattice.parseRelease(`[[SALT-LATTICE-RELEASE id=${id}]]\n${JSON.stringify({ request_id: reqId })}`), null, "no facts array at all");
  assert.equal(lattice.parseRelease(`[[SALT-LATTICE-RELEASE id=${id}]]\n${JSON.stringify({ request_id: reqId, facts: "nope" })}`), null, "facts isn't an array");
});

test("parseRelease rejects an out-of-protocol release: neither a request_id (ordinary reply) nor standing=/grant_id (a push)", () => {
  const id = sdk.newUlid();
  // No `standing=` on the marker line, and no request_id in the body.
  assert.equal(lattice.parseRelease(`[[SALT-LATTICE-RELEASE id=${id}]]\n${JSON.stringify({ facts: [] })}`), null);
  // `standing=` on the marker line, but the body never says which grant.
  const grantId = `g_${sdk.newUlid()}`;
  assert.equal(lattice.parseRelease(`[[SALT-LATTICE-RELEASE id=${id} standing=${grantId}]]\n${JSON.stringify({ since_seq: 1, facts: [] })}`), null);
});

test("parseRelease rejects a release whose facts don't match PROTOCOL.md's shape -- the whole body, not just the bad entry", () => {
  const id = sdk.newUlid();
  const reqId = sdk.newUlid();
  const releaseWith = (fact) => `[[SALT-LATTICE-RELEASE id=${id}]]\n${JSON.stringify({ request_id: reqId, facts: [fact] })}`;

  assert.equal(lattice.parseRelease(releaseWith({ ...validFact, path: undefined })), null, "missing path");
  assert.equal(lattice.parseRelease(releaseWith({ ...validFact, author: "the_agent_itself" })), null, "author outside you|agent");
  assert.equal(lattice.parseRelease(releaseWith({ ...validFact, updated: "not a number" })), null, "updated not a number");
  assert.equal(lattice.parseRelease(releaseWith({ ...validFact, value: { nested: "object" } })), null, "value isn't a primitive");

  // null IS a valid primitive value, and must be accepted on its own.
  assert.ok(lattice.parseRelease(releaseWith({ ...validFact, value: null })), "a null value is a valid primitive");
});

// =====================================================================
// The pending registry: matched / refused (bystander forgery) / timeout
// =====================================================================

const CHAT_A = "chat-a";
const PERSON_A = "person-a";
const PERSON_B = "person-b (a bystander)";

const releaseTextFor = (requestId, facts = []) => `[[SALT-LATTICE-RELEASE id=${sdk.newUlid()}]]\n${JSON.stringify({ request_id: requestId, facts })}`;

test("classifyRelease: a release from the exact chat and person register() bound resolves it (\"matched\")", async () => {
  const id = sdk.newUlid();
  const waiting = lattice.register(id, { chatId: CHAT_A, senderId: PERSON_A, timeoutMs: 5000 });

  const outcome = lattice.classifyRelease(CHAT_A, PERSON_A, releaseTextFor(id, [validFact]));
  assert.deepEqual(outcome, { kind: "matched" });
  assert.equal(lattice.hasPending(id), false);

  const body = await waiting;
  assert.deepEqual(body.facts, [validFact]);
});

test("classifyRelease REFUSES a release naming a live request but from the wrong sender -- a bystander who merely saw the broadcast id cannot forge the release", async () => {
  const id = sdk.newUlid();
  const waiting = lattice.register(id, { chatId: CHAT_A, senderId: PERSON_A, timeoutMs: 5000 });

  // The bystander read the plaintext request id (it was broadcast to every
  // member of the chat -- see requestPersonalData's own comment) and sends
  // back a release with fabricated fact data, citing the real request id.
  const forged = releaseTextFor(id, [{ ...validFact, value: "FORGED BY BYSTANDER" }]);
  const outcome = lattice.classifyRelease(CHAT_A, PERSON_B, forged);
  assert.deepEqual(outcome, { kind: "refused" });

  // Critically: the live wait is untouched -- still pending, and the REAL
  // person's later, correctly-addressed release still resolves it with
  // their own facts, not the forged ones.
  assert.equal(lattice.hasPending(id), true);
  const realOutcome = lattice.classifyRelease(CHAT_A, PERSON_A, releaseTextFor(id, [validFact]));
  assert.deepEqual(realOutcome, { kind: "matched" });
  assert.deepEqual((await waiting).facts, [validFact]);
});

test("classifyRelease REFUSES a release from the right sender but the wrong chat", async () => {
  const id = sdk.newUlid();
  const waiting = lattice.register(id, { chatId: CHAT_A, senderId: PERSON_A, timeoutMs: 50 });

  const outcome = lattice.classifyRelease("some-other-chat", PERSON_A, releaseTextFor(id, []));
  assert.deepEqual(outcome, { kind: "refused" });
  assert.equal(lattice.hasPending(id), true);

  await assert.rejects(waiting, /No release within/);
});

test("resolveIfPending mirrors classifyRelease's boolean shape: true for matched/unmatched, false for not-a-release AND refused", () => {
  assert.equal(lattice.resolveIfPending(CHAT_A, PERSON_A, "hey, what's up?"), false, "not a release at all");

  const id = sdk.newUlid();
  const waiting = lattice.register(id, { chatId: CHAT_A, senderId: PERSON_A, timeoutMs: 5000 });
  assert.equal(lattice.resolveIfPending(CHAT_A, PERSON_B, releaseTextFor(id, [])), false, "refused (wrong sender) reads as false, same as not-a-release");
  assert.equal(lattice.resolveIfPending(CHAT_A, PERSON_A, releaseTextFor(id, [validFact])), true, "matched reads as true");
  waiting.then(() => {}, () => {});

  const grantId = `g_${sdk.newUlid()}`;
  const standingText = `[[SALT-LATTICE-RELEASE id=${sdk.newUlid()} standing=${grantId}]]\n${JSON.stringify({ grant_id: grantId, facts: [] })}`;
  assert.equal(lattice.resolveIfPending(CHAT_A, PERSON_A, standingText), true, "unmatched (standing) also reads as true");
});

test("case only: an id, chat, or sender differing purely in case still matches (the pending map key and sameId are both case-insensitive)", async () => {
  const id = sdk.newUlid(); // newUlid always produces uppercase
  const waiting = lattice.register(id.toLowerCase(), { chatId: "Chat-Mixed-Case", senderId: "Person-Mixed-Case", timeoutMs: 5000 });

  const text = `[[SALT-LATTICE-RELEASE id=${sdk.newUlid()}]]\n${JSON.stringify({ request_id: id.toUpperCase(), facts: [validFact] })}`;
  const outcome = lattice.classifyRelease("chat-mixed-case", "person-mixed-case", text);
  assert.deepEqual(outcome, { kind: "matched" });
  assert.deepEqual((await waiting).facts, [validFact]);
});

test("register rejects once its timeout elapses -- expected, not a protocol error (the phone answers when next open)", async () => {
  const id = sdk.newUlid();
  const waiting = lattice.register(id, { chatId: CHAT_A, senderId: PERSON_A, timeoutMs: 30 });
  assert.equal(lattice.hasPending(id), true);
  await assert.rejects(waiting, /No release within/);
  assert.equal(lattice.hasPending(id), false, "the timed-out entry does not linger");
});

test("registering the same request id twice throws synchronously", () => {
  const id = sdk.newUlid();
  const waiting = lattice.register(id, { chatId: CHAT_A, senderId: PERSON_A, timeoutMs: 5000 });
  assert.throws(() => lattice.register(id, { chatId: CHAT_A, senderId: PERSON_A, timeoutMs: 5000 }), /Already waiting/);
  lattice.cancel(id);
  waiting.catch(() => {}); // never settles -- silence an unhandled-rejection warning if it ever does
});

test("cancel clears a pending wait without settling its promise", async () => {
  const id = sdk.newUlid();
  const waiting = lattice.register(id, { chatId: CHAT_A, senderId: PERSON_A, timeoutMs: 5000 });
  lattice.cancel(id);
  assert.equal(lattice.hasPending(id), false);

  let settled = false;
  waiting.then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, "cancel must not resolve or reject -- only register()'s own timeout, or a match, may");
});

// =====================================================================
// onRelease: late/standing dispatch, including a misbehaving handler
// =====================================================================

test("a release naming no pending request -- late (already timed out) or standing (never had one) -- reaches onRelease with the chat/sender it actually arrived from", async () => {
  const seen = [];
  const unsubscribe = lattice.onRelease((release) => seen.push(release));
  try {
    const lateId = sdk.newUlid();
    await assert.rejects(lattice.register(lateId, { chatId: CHAT_A, senderId: PERSON_A, timeoutMs: 20 }));
    const outcome = lattice.classifyRelease(CHAT_A, PERSON_A, releaseTextFor(lateId, []));
    assert.equal(outcome.kind, "unmatched", "still handled -- must not fall through as a fresh prompt");

    const grantId = `g_${sdk.newUlid()}`;
    const standingText = `[[SALT-LATTICE-RELEASE id=${sdk.newUlid()} standing=${grantId}]]\n${JSON.stringify({ grant_id: grantId, since_seq: 5, facts: [] })}`;
    assert.equal(lattice.classifyRelease(CHAT_A, PERSON_A, standingText).kind, "unmatched");

    await new Promise((r) => setImmediate(r)); // fireOnRelease dispatches via a microtask (see finding #3's fix)
    assert.equal(seen.length, 2);
    assert.equal(seen[0].chatId, CHAT_A);
    assert.equal(seen[0].senderId, PERSON_A);
    assert.equal(seen[0].body.request_id, lateId);
    assert.equal(seen[1].standing, grantId);
  } finally {
    unsubscribe();
  }
});

test("onRelease's unsubscribe really stops the handler from firing again", async () => {
  let calls = 0;
  const unsubscribe = lattice.onRelease(() => calls++);
  unsubscribe();

  const grantId = `g_${sdk.newUlid()}`;
  const text = `[[SALT-LATTICE-RELEASE id=${sdk.newUlid()} standing=${grantId}]]\n${JSON.stringify({ grant_id: grantId, facts: [] })}`;
  lattice.classifyRelease(CHAT_A, PERSON_A, text);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 0);
});

test("a handler that throws synchronously does not stop other handlers, and does not crash the process", async () => {
  const seen = [];
  const unsubBad = lattice.onRelease(() => {
    throw new Error("boom (sync)");
  });
  const unsubGood = lattice.onRelease((release) => seen.push(release));
  try {
    const grantId = `g_${sdk.newUlid()}`;
    const text = `[[SALT-LATTICE-RELEASE id=${sdk.newUlid()} standing=${grantId}]]\n${JSON.stringify({ grant_id: grantId, facts: [] })}`;
    lattice.classifyRelease(CHAT_A, PERSON_A, text);
    await new Promise((r) => setImmediate(r));
    assert.equal(seen.length, 1, "the well-behaved handler still ran");
  } finally {
    unsubBad();
    unsubGood();
  }
});

test("a handler whose promise REJECTS does not surface as an unhandled rejection (finding #3)", async () => {
  let sawUnhandled = false;
  const onUnhandled = () => (sawUnhandled = true);
  process.on("unhandledRejection", onUnhandled);

  const unsubscribe = lattice.onRelease(async () => {
    throw new Error("boom (async)");
  });
  try {
    const grantId = `g_${sdk.newUlid()}`;
    const text = `[[SALT-LATTICE-RELEASE id=${sdk.newUlid()} standing=${grantId}]]\n${JSON.stringify({ grant_id: grantId, facts: [] })}`;
    lattice.classifyRelease(CHAT_A, PERSON_A, text);
    // Give the rejection every chance to surface as unhandled before we check.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(sawUnhandled, false);
  } finally {
    unsubscribe();
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

// =====================================================================
// The three tools, via a fake client (no real salt-api)
// =====================================================================

function fakeClient({ members, latticeGrants = [], latticeSchema = {} }) {
  const posted = [];
  const events = [];
  return {
    posted,
    events,
    async getChatMembers() {
      return members;
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ apiKey, chatId, message, senderMessage });
    },
    trackEvent(apiKey, name, properties) {
      events.push({ apiKey, name, properties });
    },
    async getLatticeGrants() {
      return latticeGrants;
    },
    async getLatticeSchema() {
      return latticeSchema;
    },
  };
}

async function markerFrom(posted, index, privateKey, passphrase) {
  assert.equal(posted.length > index, true, `expected at least ${index + 1} posted message(s)`);
  return sdk.decrypt(posted[index].senderMessage, privateKey, passphrase);
}

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
const ADA_ID = "00000000-0000-0000-0000-0000000000b2";
const BOB_ID = "00000000-0000-0000-0000-0000000000c3";

async function makeOneOnOne() {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const adaKeys = await sdk.generateKeypair("ada-pass");
  const caller = { saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const members = [
    { id: AGENT_ID, username: "concierge", account_type: "Agent", public_key: agentKeys.publicKey, observer: false },
    { id: ADA_ID, username: "ada", account_type: "User", public_key: adaKeys.publicKey, observer: false },
  ];
  return { agentKeys, adaKeys, caller, members };
}

test("request_personal_data: a release matching the sent request (bound to the right chat + person) resolves the tool with exactly the facts received, never fabricated", async () => {
  const { agentKeys, caller, members } = await makeOneOnOne();
  const client = fakeClient({ members });
  const actions = sdk.createActions({ client, identities: sdk.createIdentityStore(tempStore()), pgpPassphrase: "agent-pass", publicWebhookUrl: "http://x/" });

  const resultPromise = actions.execute(
    "request_personal_data",
    { purpose: "pick a restaurant for Friday", asks: ["preferences.food.cuisine.*"] },
    caller,
    { depth: 0, mainChatId: "chat-1" }
  );

  await new Promise((r) => setTimeout(r, 30));
  const sentPlaintext = await markerFrom(client.posted, 0, agentKeys.privateKey, "agent-pass");
  const requestId = lattice.REQUEST_MARKER_RE.exec(sentPlaintext)[1];
  assert.equal(client.posted[0].chatId, "chat-1");

  const facts = [validFact];
  assert.equal(lattice.classifyRelease("chat-1", ADA_ID, releaseTextFor(requestId, facts)).kind, "matched");

  const result = await resultPromise;
  assert.deepEqual(result, { status: "released", facts });
  assert.deepEqual(client.events.map((e) => e.name), ["tool_used", "lattice_request_released"]);
});

test("request_personal_data: a bystander forging a release for the right request id, in the right chat, but as someone ELSE's account never resolves the call -- it still (correctly) reports pending", async () => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const adaKeys = await sdk.generateKeypair("ada-pass");
  const bobKeys = await sdk.generateKeypair("bob-pass");
  const caller = { saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const members = [
    { id: AGENT_ID, username: "concierge", account_type: "Agent", public_key: agentKeys.publicKey, observer: false },
    { id: ADA_ID, username: "ada", account_type: "User", public_key: adaKeys.publicKey, observer: false },
    { id: BOB_ID, username: "bob", account_type: "User", public_key: bobKeys.publicKey, observer: false },
  ];
  const client = fakeClient({ members });
  const actions = sdk.createActions({
    client,
    identities: sdk.createIdentityStore(tempStore()),
    pgpPassphrase: "agent-pass",
    publicWebhookUrl: "http://x/",
    latticeRequestTimeoutMs: FAST_TIMEOUT_MS,
  });

  const resultPromise = actions.execute(
    "request_personal_data",
    { purpose: "pick a restaurant", asks: ["preferences.food.cuisine.*"], to_username: "ada" },
    caller,
    { depth: 0, mainChatId: "chat-group" }
  );

  await new Promise((r) => setTimeout(r, 30));
  const sentPlaintext = await markerFrom(client.posted, 0, agentKeys.privateKey, "agent-pass");
  // Bob is a real member of this chat and can decrypt the same broadcast
  // request -- that's the whole point of the fix: reading the id must not
  // be enough to forge the release.
  const requestId = lattice.REQUEST_MARKER_RE.exec(sentPlaintext)[1];
  const forged = releaseTextFor(requestId, [{ ...validFact, value: "FORGED" }]);
  assert.equal(lattice.classifyRelease("chat-group", BOB_ID, forged).kind, "refused");

  const result = await resultPromise; // times out (FAST_TIMEOUT_MS) since Ada herself never answered
  assert.equal(result.status, "pending");
  assert.match(result.hint, /side-lane/);
});

test("request_personal_data: no release arrives before the (overridden, fast) timeout -> pending, with a request_id to correlate a later reply", async () => {
  const { agentKeys, caller, members } = await makeOneOnOne();
  const client = fakeClient({ members });
  const actions = sdk.createActions({
    client,
    identities: sdk.createIdentityStore(tempStore()),
    pgpPassphrase: "agent-pass",
    publicWebhookUrl: "http://x/",
    latticeRequestTimeoutMs: FAST_TIMEOUT_MS,
  });

  const result = await actions.execute(
    "request_personal_data",
    { purpose: "pick a restaurant for Friday", asks: ["preferences.food.cuisine.*"] },
    caller,
    { depth: 0, mainChatId: "chat-1" }
  );

  assert.equal(result.status, "pending");
  assert.match(result.request_id, sdk.ULID_RE);
  assert.match(result.hint, /next open Salt/);
  assert.equal(lattice.hasPending(result.request_id), false, "the timed-out entry does not linger in the registry");
  void agentKeys; // (unused here, kept for symmetry with the other 1:1 tests)
});

test("request_personal_data: in a GROUP chat (to_username disambiguates), the pending hint says the person answers privately in a side-lane, not in the room", async () => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const adaKeys = await sdk.generateKeypair("ada-pass");
  const bobKeys = await sdk.generateKeypair("bob-pass");
  const caller = { saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey, observer: false },
    { id: ADA_ID, username: "ada", account_type: "User", public_key: adaKeys.publicKey, observer: false },
    { id: BOB_ID, username: "bob", account_type: "User", public_key: bobKeys.publicKey, observer: false },
  ];
  const client = fakeClient({ members });
  const actions = sdk.createActions({
    client,
    identities: sdk.createIdentityStore(tempStore()),
    pgpPassphrase: "agent-pass",
    publicWebhookUrl: "http://x/",
    latticeRequestTimeoutMs: FAST_TIMEOUT_MS,
  });

  const result = await actions.execute(
    "request_personal_data",
    { purpose: "pick a restaurant", asks: ["preferences.food.cuisine.*"], to_username: "ada" },
    caller,
    { depth: 0, mainChatId: "chat-group" }
  );

  assert.equal(result.status, "pending");
  assert.match(result.hint, /privately/);
  assert.match(result.hint, /side-lane/);
  assert.doesNotMatch(result.hint, /next open Salt; you will get a message then\.$/, "must not be the plain 1:1 hint");
});

test("request_personal_data: observers don't count toward the group hint or as someone to ask", async () => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const adaKeys = await sdk.generateKeypair("ada-pass");
  const observerKeys = await sdk.generateKeypair("observer-pass");
  const caller = { saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey, observer: false },
    { id: ADA_ID, username: "ada", account_type: "User", public_key: adaKeys.publicKey, observer: false },
    { id: "observer-1", username: "silent_owner", account_type: "User", public_key: observerKeys.publicKey, observer: true },
  ];
  const client = fakeClient({ members });
  const actions = sdk.createActions({
    client,
    identities: sdk.createIdentityStore(tempStore()),
    pgpPassphrase: "agent-pass",
    publicWebhookUrl: "http://x/",
    latticeRequestTimeoutMs: FAST_TIMEOUT_MS,
  });

  // No to_username needed -- ada is the only non-observer human, even
  // though the raw member count (3) would otherwise look like a group.
  const result = await actions.execute("request_personal_data", { purpose: "pick a restaurant", asks: ["preferences.food.cuisine.*"] }, caller, {
    depth: 0,
    mainChatId: "chat-1",
  });

  assert.equal(result.status, "pending");
  assert.match(result.hint, /next open Salt; you will get a message then\.$/, "the plain 1:1 hint, not the group one -- the observer must not count");
});

test("request_personal_data: refuses to guess in an ambiguous multi-human chat, refuses an unknown to_username, and refuses when nobody is there to ask", async () => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const adaKeys = await sdk.generateKeypair("ada-pass");
  const bobKeys = await sdk.generateKeypair("bob-pass");
  const caller = { saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const twoHumans = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey, observer: false },
    { id: ADA_ID, username: "ada", account_type: "User", public_key: adaKeys.publicKey, observer: false },
    { id: BOB_ID, username: "bob", account_type: "User", public_key: bobKeys.publicKey, observer: false },
  ];

  const actionsFor = (members) =>
    sdk.createActions({ client: fakeClient({ members }), identities: sdk.createIdentityStore(tempStore()), pgpPassphrase: "agent-pass", publicWebhookUrl: "http://x/" });

  await assert.rejects(
    actionsFor(twoHumans).execute("request_personal_data", { purpose: "p", asks: ["a"] }, caller, { depth: 0, mainChatId: "chat-1" }),
    /there's more than one person/
  );
  await assert.rejects(
    actionsFor(twoHumans).execute("request_personal_data", { purpose: "p", asks: ["a"], to_username: "carol" }, caller, { depth: 0, mainChatId: "chat-1" }),
    /No person named @carol/
  );

  const noHumans = [{ id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey, observer: false }];
  await assert.rejects(
    actionsFor(noHumans).execute("request_personal_data", { purpose: "p", asks: ["a"] }, caller, { depth: 0, mainChatId: "chat-1" }),
    /No person in this chat to ask/
  );
});

test("request_personal_data validates its input and its chat context", async () => {
  const client = fakeClient({ members: [] });
  const actions = sdk.createActions({ client, identities: sdk.createIdentityStore(tempStore()), pgpPassphrase: "x", publicWebhookUrl: "http://x/" });
  const caller = { saltAppId: "agent-1", username: "a", apiKey: "k", publicKey: "pub", privateKey: "priv" };

  await assert.rejects(actions.execute("request_personal_data", { purpose: "", asks: [] }, caller, { depth: 0, mainChatId: "chat-1" }), /required/);
  await assert.rejects(actions.execute("request_personal_data", { purpose: "why", asks: ["a.b"] }, caller, { depth: 0, mainChatId: null }), /only available while replying in a chat/);
});

test("propose_personal_fact: posts a proposal marker and reports it as pending, never confirmed", async () => {
  const { agentKeys, caller, members } = await makeOneOnOne();
  const client = fakeClient({ members });
  const actions = sdk.createActions({ client, identities: sdk.createIdentityStore(tempStore()), pgpPassphrase: "agent-pass", publicWebhookUrl: "http://x/" });

  const proposals = [{ type: "preferences.food.cuisine", parent_name: "Food", fields: { name: "Japanese", strength: 0.8 } }];
  const result = await actions.execute("propose_personal_fact", { proposals }, caller, { depth: 0, mainChatId: "chat-1" });

  assert.deepEqual(result, { proposed: true, count: 1, note: result.note });
  assert.match(result.note, /pending/);

  const sentPlaintext = await markerFrom(client.posted, 0, agentKeys.privateKey, "agent-pass");
  const match = lattice.PROPOSE_MARKER_RE.exec(sentPlaintext);
  assert.ok(match);
  assert.deepEqual(JSON.parse(sentPlaintext.slice(match[0].length)).proposals, proposals);
  assert.deepEqual(client.events.map((e) => e.name), ["tool_used", "lattice_proposal_sent"]);
});

test("list_personal_data_access returns this agent's grants and the Lattice schema straight from the client", async () => {
  const grants = [{ id: "g1", agent: { id: "a1", username: "concierge", display_name: "Concierge" }, agent_fingerprint: "fp", key_changed: false, rules: [{ selector: "preferences.food.cuisine.*", mode: "auto" }], trusted_writes: [], standing: null, version: 1, created_at: "now", revoked_at: null }];
  const schema = { types: { "preferences.food.cuisine": { fields: { strength: "number" } } } };
  const client = fakeClient({ members: [], latticeGrants: grants, latticeSchema: schema });
  const actions = sdk.createActions({ client, identities: sdk.createIdentityStore(tempStore()), pgpPassphrase: "x", publicWebhookUrl: "http://x/" });
  const caller = { saltAppId: "agent-1", username: "a", apiKey: "key-agent", publicKey: "pub", privateKey: "priv" };

  const result = await actions.execute("list_personal_data_access", {}, caller, { depth: 0, mainChatId: null });
  assert.deepEqual(result, { grants, schema });
});

// =====================================================================
// webhook.ts: onLatticeRelease wiring, and a bystander forgery end to end
// =====================================================================

function fakeWebhookApi(secretsByApiKey, members) {
  const posted = [];
  return {
    posted,
    async getWebhookSecret(apiKey) {
      const secret = secretsByApiKey[apiKey];
      if (!secret) throw new sdk.SaltApiError("GET", "/api/v1/agents/webhook_secret", 401, { error: "unauthorized" });
      return secret;
    },
    async getChatMembers() {
      return members;
    },
    async postMessage(apiKey, chatId, message, senderMessage) {
      posted.push({ apiKey, chatId, message, senderMessage });
    },
    async signalTyping() {},
    trackEvent() {},
  };
}

function signedPost(port, body, agentId, secret) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Salt-Agent-Id": agentId, "X-Salt-Signature": `t=${t},v1=${v1}` },
    body: raw,
  });
}

function serveWebhook(t, api, options) {
  const server = sdk.createWebhookServer({ client: api, pgpPassphrase: "agent-pass", logger: silent, ...options });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  return listening.address().port;
}

async function messageBody({ chatId, senderId, plaintext, encryptToPublicKey }) {
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: plaintext }),
    encryptionKeys: await openpgp.readKey({ armoredKey: encryptToPublicKey }),
  });
  return {
    chat: { id: chatId, name: null, public: false, managed: false, open_invite: false, mode: "auto" },
    message: {
      chat_id: chatId,
      message_id: `m-${Math.random().toString(16).slice(2)}`,
      message: armored,
      sender_message: armored,
      message_type: "User",
      user: { id: senderId, username: "someone", display_name: "Someone", account_type: "User" },
      created_at: new Date().toISOString(),
    },
  };
}

test("onLatticeRelease: a late release (no live wait at all) reaches it with the identity that decrypted it, and can reply into the chat", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const personKeys = await sdk.generateKeypair("person-pass");
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [
    { id: AGENT_ID, username: "concierge", account_type: "Agent", public_key: agentKeys.publicKey, observer: false },
    { id: ADA_ID, username: "ada", account_type: "User", public_key: personKeys.publicKey, observer: false },
  ];
  const api = fakeWebhookApi({ "key-agent": "secret-agent" }, members);

  const calls = [];
  const port = serveWebhook(t, api, {
    identities: store,
    async onLatticeRelease(ctx) {
      calls.push(ctx);
      await ctx.reply("got it, thanks");
    },
  });

  const requestId = sdk.newUlid();
  const plaintext = releaseTextFor(requestId, [validFact]);
  const body = await messageBody({ chatId: "chat-1", senderId: ADA_ID, plaintext, encryptToPublicKey: agentKeys.publicKey });

  const res = await signedPost(port, body, AGENT_ID, "secret-agent");
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(calls.length, 1);
  const ctx = calls[0];
  assert.equal(ctx.identity.saltAppId, AGENT_ID);
  assert.equal(ctx.chatId, "chat-1");
  assert.equal(ctx.senderId, ADA_ID);
  assert.equal(ctx.standing, undefined);
  assert.deepEqual(ctx.body.facts, [validFact]);
  assert.equal(ctx.body.request_id, requestId);

  assert.equal(api.posted.length, 1, "ctx.reply() posted the follow-up");
  const replyPlaintext = await sdk.decrypt(api.posted[0].message, personKeys.privateKey, "person-pass");
  assert.match(replyPlaintext, /got it, thanks/);
});

test("onLatticeRelease: a MATCHED release never reaches it -- the original request_personal_data caller already has the facts", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const personKeys = await sdk.generateKeypair("person-pass");
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey, observer: false },
    { id: ADA_ID, account_type: "User", public_key: personKeys.publicKey, observer: false },
  ];
  const api = fakeWebhookApi({ "key-agent": "secret-agent" }, members);

  const releaseCalls = [];
  const port = serveWebhook(t, api, {
    identities: store,
    onLatticeRelease(ctx) {
      releaseCalls.push(ctx);
    },
  });

  const requestId = sdk.newUlid();
  const waiting = lattice.register(requestId, { chatId: "chat-1", senderId: ADA_ID, timeoutMs: 5000 });

  const plaintext = releaseTextFor(requestId, [validFact]);
  const body = await messageBody({ chatId: "chat-1", senderId: ADA_ID, plaintext, encryptToPublicKey: agentKeys.publicKey });
  const res = await signedPost(port, body, AGENT_ID, "secret-agent");
  assert.equal(res.status, 200);

  const releaseBody = await waiting;
  assert.deepEqual(releaseBody.facts, [validFact]);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(releaseCalls.length, 0, "a matched release must not also be offered to onLatticeRelease");
});

test("webhook.ts: a bystander's forged release (right id, wrong sender) is refused -- falls through to onMessage as ordinary text, never resolves the real wait, and never reaches onLatticeRelease", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const adaKeys = await sdk.generateKeypair("ada-pass");
  const bobKeys = await sdk.generateKeypair("bob-pass");
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey, observer: false },
    { id: ADA_ID, username: "ada", account_type: "User", public_key: adaKeys.publicKey, observer: false },
    { id: BOB_ID, username: "bob", account_type: "User", public_key: bobKeys.publicKey, observer: false },
  ];
  const api = fakeWebhookApi({ "key-agent": "secret-agent" }, members);

  const messageCalls = [];
  const releaseCalls = [];
  const port = serveWebhook(t, api, {
    identities: store,
    onMessage(ctx) {
      messageCalls.push(ctx);
    },
    onLatticeRelease(ctx) {
      releaseCalls.push(ctx);
    },
  });

  const requestId = sdk.newUlid();
  const waiting = lattice.register(requestId, { chatId: "chat-group", senderId: ADA_ID, timeoutMs: 5000 });
  t.after(() => lattice.cancel(requestId));
  let settled = false;
  waiting.then(
    () => (settled = true),
    () => (settled = true)
  );

  // Bob is a genuine member of this chat -- his own key legitimately
  // decrypts messages here -- but he is NOT the person this request was
  // addressed to. His forged release must be encrypted so the AGENT can
  // decrypt it (as any real member's message would be); the forgery is in
  // `message.user` claiming Bob sent it, not in the encryption.
  const forgedPlaintext = releaseTextFor(requestId, [{ ...validFact, value: "FORGED" }]);
  const body = await messageBody({ chatId: "chat-group", senderId: BOB_ID, plaintext: forgedPlaintext, encryptToPublicKey: agentKeys.publicKey });

  const res = await signedPost(port, body, AGENT_ID, "secret-agent");
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(settled, false, "the real wait for Ada's answer must still be pending");
  assert.equal(releaseCalls.length, 0, "a refused release is not an \"unmatched\" release either");
  assert.equal(messageCalls.length, 1, "refused falls through as an ordinary message");
  assert.equal(messageCalls[0].text, forgedPlaintext);
  assert.equal(messageCalls[0].senderId, BOB_ID);
});
