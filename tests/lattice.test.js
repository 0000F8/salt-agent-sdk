// Lattice (see ../../salt-lattice/docs/PROTOCOL.md) lets a hosted identity
// ask the person it's chatting with for personal facts, over a real Salt
// message, and get an answer back the same way delegations.ts gets one from
// another agent. These tests pin: the wire markers round-trip exactly what
// PROTOCOL.md specifies (a 26-char ULID id); the pending registry resolves,
// times out, and rejects a duplicate register(); a release that matches no
// pending wait (late, or a standing push) reaches onRelease instead of being
// dropped; and the three actions.ts tools built on top of all this -- via a
// fake client, never a real salt-api -- behave per PROTOCOL.md, including
// the group-chat side-lane hint.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sdk = require("../dist/index.js");
const { lattice } = sdk;

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-lattice-"));
  return path.join(dir, "identities.json");
}

// --- markers -------------------------------------------------------------

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

test("parseRelease parses an ordinary reply (request_id, facts) and matches RELEASE_MARKER_RE's own id group", () => {
  const releaseId = sdk.newUlid();
  const requestId = sdk.newUlid();
  const facts = [{ path: "preferences/food/cuisine/Japanese", type: "preferences.food.cuisine", field: "strength", value: 0.8, author: "you", updated: 1789580100000 }];
  const text = `[[SALT-LATTICE-RELEASE id=${releaseId}]]\n${JSON.stringify({ request_id: requestId, facts })}`;

  const parsed = lattice.parseRelease(text);
  assert.ok(parsed);
  assert.equal(parsed.id, releaseId);
  assert.equal(parsed.standing, undefined);
  assert.equal(parsed.body.request_id, requestId);
  assert.deepEqual(parsed.body.facts, facts);
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

test("parseRelease returns null for ordinary text, and for a release marker with a malformed or shapeless body", () => {
  assert.equal(lattice.parseRelease("just a normal chat message"), null);
  assert.equal(lattice.parseRelease("[[SALT-DELEGATION depth=1]]\nsome task"), null, "a different marker entirely");

  const id = sdk.newUlid();
  assert.equal(lattice.parseRelease(`[[SALT-LATTICE-RELEASE id=${id}]]\nnot json at all`), null, "unparseable body");
  assert.equal(lattice.parseRelease(`[[SALT-LATTICE-RELEASE id=${id}]]\n${JSON.stringify({ request_id: "x" })}`), null, "no facts array at all");
  assert.equal(lattice.parseRelease(`[[SALT-LATTICE-RELEASE id=${id}]]\n${JSON.stringify({ request_id: "x", facts: "nope" })}`), null, "facts isn't an array");
});

// --- pending registry ------------------------------------------------------

// The release marker's own id is arbitrary here -- these tests correlate on
// `request_id` inside the body, never on this id -- but it still has to be a
// well-formed ULID for RELEASE_MARKER_RE to match it at all.
const RELEASE_MARKER_ID = sdk.newUlid();
const releaseTextFor = (requestId, facts = []) =>
  `[[SALT-LATTICE-RELEASE id=${RELEASE_MARKER_ID}]]\n${JSON.stringify({ request_id: requestId, facts })}`;

test("register resolves the matching release, and clears the pending entry", async () => {
  const id = "01J8XK3V9Q4R5S6T7U8V9W0X7D";
  const facts = [{ path: "p", type: "t", field: "f", value: 1, author: "you", updated: 1 }];

  const waiting = lattice.register(id, { timeoutMs: 5000 });
  assert.equal(lattice.hasPending(id), true);

  assert.equal(lattice.resolveIfPending(releaseTextFor(id, facts)), true);
  assert.equal(lattice.hasPending(id), false);

  const body = await waiting;
  assert.deepEqual(body.facts, facts);
  assert.equal(body.request_id, id);
});

test("resolveIfPending returns false for a message that isn't a lattice release at all", () => {
  assert.equal(lattice.resolveIfPending("hey, what's up?"), false);
});

test("register rejects once its timeout elapses -- expected, not a protocol error (the phone answers when next open)", async () => {
  const id = "01J8XK3V9Q4R5S6T7U8V9W0X8E";
  const waiting = lattice.register(id, { timeoutMs: 30 });
  assert.equal(lattice.hasPending(id), true);
  await assert.rejects(waiting, /No release within/);
  assert.equal(lattice.hasPending(id), false, "the timed-out entry does not linger");
});

test("registering the same request id twice throws synchronously", () => {
  const id = "01J8XK3V9Q4R5S6T7U8V9W0X9F";
  const waiting = lattice.register(id, { timeoutMs: 5000 });
  assert.throws(() => lattice.register(id, { timeoutMs: 5000 }), /Already waiting/);
  lattice.cancel(id);
  waiting.catch(() => {}); // never settles -- silence an unhandled-rejection warning if it ever does
});

test("cancel clears a pending wait without settling its promise", async () => {
  const id = "01J8XK3V9Q4R5S6T7U8V9W0XAG";
  const waiting = lattice.register(id, { timeoutMs: 5000 });
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

test("a release naming no pending request -- late (already timed out) or standing (never had one) -- reaches onRelease instead of being dropped", async () => {
  const seen = [];
  const unsubscribe = lattice.onRelease((release) => seen.push(release));
  try {
    // Late: the request timed out before any release arrived.
    const lateId = "01J8XK3V9Q4R5S6T7U8V9W0XBH";
    await assert.rejects(lattice.register(lateId, { timeoutMs: 20 }));
    assert.equal(lattice.resolveIfPending(releaseTextFor(lateId, [])), true, "still handled -- must not fall through as a fresh prompt");

    // Standing: never had a pending wait at all.
    const grantId = `g_${sdk.newUlid()}`;
    const standingText = `[[SALT-LATTICE-RELEASE id=${sdk.newUlid()} standing=${grantId}]]\n${JSON.stringify({ grant_id: grantId, since_seq: 5, facts: [] })}`;
    assert.equal(lattice.resolveIfPending(standingText), true);

    assert.equal(seen.length, 2);
    assert.equal(seen[0].body.request_id, lateId);
    assert.equal(seen[1].standing, grantId);
  } finally {
    unsubscribe();
  }
});

test("onRelease's unsubscribe really stops the handler from firing again", () => {
  let calls = 0;
  const unsubscribe = lattice.onRelease(() => calls++);
  unsubscribe();

  const grantId = `g_${sdk.newUlid()}`;
  const text = `[[SALT-LATTICE-RELEASE id=${sdk.newUlid()} standing=${grantId}]]\n${JSON.stringify({ grant_id: grantId, facts: [] })}`;
  lattice.resolveIfPending(text);
  assert.equal(calls, 0);
});

// --- the three tools, via a fake client (no real salt-api) -----------------

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

test("request_personal_data: a release matching the sent request resolves the tool with exactly the facts received, never fabricated", async () => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const personKeys = await sdk.generateKeypair("person-pass");
  const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
  const PERSON_ID = "00000000-0000-0000-0000-0000000000b2";

  const caller = { saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey },
    { id: PERSON_ID, account_type: "User", public_key: personKeys.publicKey },
  ];
  const client = fakeClient({ members });
  const actions = sdk.createActions({ client, identities: sdk.createIdentityStore(tempStore()), pgpPassphrase: "agent-pass", publicWebhookUrl: "http://x/" });

  const resultPromise = actions.execute(
    "request_personal_data",
    { purpose: "pick a restaurant for Friday", asks: ["preferences.food.cuisine.*"] },
    caller,
    { depth: 0, mainChatId: "chat-1" }
  );

  // Give the tool a moment to encrypt + "post" its request marker, then read
  // it back the way the person's own device would -- decrypting with their
  // key -- to learn the request id the tool is actually waiting on.
  await new Promise((r) => setTimeout(r, 50));
  const sentPlaintext = await markerFrom(client.posted, 0, agentKeys.privateKey, "agent-pass");
  const requestId = lattice.REQUEST_MARKER_RE.exec(sentPlaintext)[1];
  assert.equal(client.posted[0].chatId, "chat-1");

  const facts = [{ path: "preferences/food/cuisine/Japanese", type: "preferences.food.cuisine", field: "strength", value: 0.8, author: "you", updated: 1789580100000 }];
  // Simulate what webhook.ts does after decrypting an inbound release: hand
  // the plaintext to lattice.resolveIfPending before it can become a prompt.
  assert.equal(lattice.resolveIfPending(releaseTextFor(requestId, facts)), true);

  const result = await resultPromise;
  assert.deepEqual(result, { status: "released", facts });
  // actions.execute() itself always fires a "tool_used" beacon before
  // dispatching to the tool -- see actions.ts's execute().
  assert.deepEqual(client.events.map((e) => e.name), ["tool_used", "lattice_request_released"]);
});

test("request_personal_data: no release arrives before the timeout -> pending, with a request_id to correlate a later reply", async () => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const personKeys = await sdk.generateKeypair("person-pass");
  const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
  const PERSON_ID = "00000000-0000-0000-0000-0000000000b2";

  const caller = { saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey },
    { id: PERSON_ID, account_type: "User", public_key: personKeys.publicKey },
  ];
  const client = fakeClient({ members });
  const actions = sdk.createActions({ client, identities: sdk.createIdentityStore(tempStore()), pgpPassphrase: "agent-pass", publicWebhookUrl: "http://x/" });

  // No release is ever supplied -- this genuinely waits out the real
  // LATTICE_REQUEST_TIMEOUT_MS (15s), on purpose: it is exercising the
  // actual production constant, not a shortened stand-in for it.
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
});

test("request_personal_data: in a GROUP chat, the pending hint says the person answers privately in a side-lane, not in the room", async () => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const adaKeys = await sdk.generateKeypair("ada-pass");
  const bobKeys = await sdk.generateKeypair("bob-pass");
  const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";

  const caller = { saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey },
    { id: "ada", account_type: "User", public_key: adaKeys.publicKey },
    { id: "bob", account_type: "User", public_key: bobKeys.publicKey },
  ];
  const client = fakeClient({ members });
  const actions = sdk.createActions({ client, identities: sdk.createIdentityStore(tempStore()), pgpPassphrase: "agent-pass", publicWebhookUrl: "http://x/" });

  const result = await actions.execute("request_personal_data", { purpose: "pick a restaurant", asks: ["preferences.food.cuisine.*"] }, caller, { depth: 0, mainChatId: "chat-group" });

  assert.equal(result.status, "pending");
  assert.match(result.hint, /privately/);
  assert.match(result.hint, /side-lane/);
  assert.doesNotMatch(result.hint, /next open Salt; you will get a message then\.$/, "must not be the plain 1:1 hint");
});

test("request_personal_data validates its input and its chat context", async () => {
  const client = fakeClient({ members: [] });
  const actions = sdk.createActions({ client, identities: sdk.createIdentityStore(tempStore()), pgpPassphrase: "x", publicWebhookUrl: "http://x/" });
  const caller = { saltAppId: "agent-1", username: "a", apiKey: "k", publicKey: "pub", privateKey: "priv" };

  await assert.rejects(actions.execute("request_personal_data", { purpose: "", asks: [] }, caller, { depth: 0, mainChatId: "chat-1" }), /required/);
  await assert.rejects(actions.execute("request_personal_data", { purpose: "why", asks: ["a.b"] }, caller, { depth: 0, mainChatId: null }), /only available while replying in a chat/);
});

test("propose_personal_fact: posts a proposal marker and reports it as pending, never confirmed", async () => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const personKeys = await sdk.generateKeypair("person-pass");
  const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
  const PERSON_ID = "00000000-0000-0000-0000-0000000000b2";

  const caller = { saltAppId: AGENT_ID, username: "concierge", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey };
  const members = [
    { id: AGENT_ID, account_type: "Agent", public_key: agentKeys.publicKey },
    { id: PERSON_ID, account_type: "User", public_key: personKeys.publicKey },
  ];
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
