// Identity on Salt, R1 (identity.ts + client.ts's identity()/setIdentity()/
// card(), actions.ts's identity_set/identity_get): the signed card
// AgentCardSigner already produces, made editable section by section.
// Pinned here: RFC 8785 canonicalization matches salt-api's Jcs.rb closely
// enough to verify a real signature, card() never returns `verified: false`
// (a bad/missing/unmatched signature is always a throw), the signing-key
// directory is fetched once and cached, setIdentity refuses "scope"
// client-side before any request goes out, and the two actions surface
// which sections are proofs without ever presenting a claim as one.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");

const sdk = require("../dist/index.js");

// --- fixture: an independently-signed card ------------------------------
//
// Deliberately does NOT call sdk.canonicalizeJcs to build the signing
// input -- that would make this fixture circular (a bug in canonicalizeJcs
// would sign and verify with the same wrong bytes and this test would
// still pass). The canonical JSON string below is hand-written instead,
// matching Jcs.rb by inspection: object keys sorted alphabetically, no
// whitespace, `null`/`true` as bare literals, strings JSON-escaped.

function makeSignedCardFixture({ kid = "test-key-1" } = {}) {
  const kp = crypto.generateKeyPairSync("ed25519");
  const jwk = kp.publicKey.export({ format: "jwk" }); // { crv, x, kty }

  const card = {
    name: "Test Agent",
    sections: [
      { key: "bio", value: "hi", proof: null },
      { key: "trust_score", value: "4.9", proof: true },
    ],
  };
  // Hand-written canonical form of `card` (keys sorted: name < sections;
  // within a section: key < proof < value) -- the independent oracle this
  // fixture's signature is computed over.
  const canonical =
    '{"name":"Test Agent","sections":[' +
    '{"key":"bio","proof":null,"value":"hi"},' +
    '{"key":"trust_score","proof":true,"value":"4.9"}' +
    "]}";

  const protectedHeader = { alg: "EdDSA", kid };
  const protectedB64 = Buffer.from(JSON.stringify(protectedHeader), "utf8").toString("base64url");
  const payloadB64 = Buffer.from(canonical, "utf8").toString("base64url");
  const signingInput = Buffer.from(`${protectedB64}.${payloadB64}`, "utf8");
  const signature = crypto.sign(null, signingInput, kp.privateKey);
  const signatureB64 = signature.toString("base64url");

  const signedCard = { ...card, signatures: [{ protected: protectedB64, signature: signatureB64 }] };
  const directory = { keys: [{ kty: "OKP", crv: "Ed25519", kid, x: jwk.x }] };
  return { signedCard, directory, kid };
}

function routedFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [matcher, respond] of routes) {
      const matches = typeof matcher === "string" ? url === matcher : matcher.test(url);
      if (matches) return respond();
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }), text: async () => "not found" };
  };
  fn.calls = calls;
  return fn;
}

function jsonOk(body, status = 200) {
  return async () => ({ ok: true, status, json: async () => body, text: async () => JSON.stringify(body) });
}
function jsonErr(status, body) {
  return async () => ({ ok: false, status, json: async () => body, text: async () => JSON.stringify(body) });
}

// --- canonicalizeJcs -----------------------------------------------------

test("canonicalizeJcs sorts object keys, uses bare literals, and rejects a non-integer number", () => {
  assert.strictEqual(sdk.canonicalizeJcs({ b: 1, a: "x" }), '{"a":"x","b":1}');
  assert.strictEqual(sdk.canonicalizeJcs([1, "two", null, true, false]), '[1,"two",null,true,false]');
  assert.strictEqual(sdk.canonicalizeJcs({ nested: { z: 1, a: 2 } }), '{"nested":{"a":2,"z":1}}');
  assert.strictEqual(sdk.canonicalizeJcs("quote\"me"), '"quote\\"me"');
  assert.throws(() => sdk.canonicalizeJcs(1.5), sdk.JcsUnsupportedValueError);
  assert.throws(() => sdk.canonicalizeJcs(undefined), sdk.JcsUnsupportedValueError);
});

// --- client.card() --------------------------------------------------------

test("client.card() verifies a validly signed card fetched from the agent path", async () => {
  const { signedCard, directory } = makeSignedCardFixture();
  const fetchImpl = routedFetch([
    [/\/\.well-known\/http-message-signatures-directory$/, jsonOk(directory)],
    [/\/api\/v1\/agents\/weatherbot\/agent-card\.json$/, jsonOk(signedCard)],
  ]);
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const result = await client.card("weatherbot");
  assert.strictEqual(result.verified, true);
  assert.strictEqual(result.card.name, "Test Agent");
  assert.strictEqual(result.card.sections.length, 2);
});

test("client.card() strips a leading @ and falls back from the agent path to the user path on 404", async () => {
  const { signedCard, directory } = makeSignedCardFixture();
  const fetchImpl = routedFetch([
    [/\/\.well-known\/http-message-signatures-directory$/, jsonOk(directory)],
    [/\/api\/v1\/agents\/dana\/agent-card\.json$/, jsonErr(404, { error: "not found" })],
    [/\/api\/v1\/users\/dana\/card\.json$/, jsonOk(signedCard)],
  ]);
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const result = await client.card("@dana");
  assert.strictEqual(result.verified, true);
  assert.ok(fetchImpl.calls.some((u) => u.includes("/api/v1/agents/dana/agent-card.json")));
  assert.ok(fetchImpl.calls.some((u) => u.includes("/api/v1/users/dana/card.json")));
});

test("client.card() respects opts.kind and only tries that one path", async () => {
  const { signedCard, directory } = makeSignedCardFixture();
  const fetchImpl = routedFetch([
    [/\/\.well-known\//, jsonOk(directory)],
    [/\/api\/v1\/users\/dana\/card\.json$/, jsonOk(signedCard)],
  ]);
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const result = await client.card("dana", { kind: "user" });
  assert.strictEqual(result.verified, true);
  assert.ok(!fetchImpl.calls.some((u) => u.includes("/agents/")), "must never try the agent path when kind is 'user'");
});

test("client.card() throws IdentityCardInvalidError, never verified:false, when the signed content was tampered with", async () => {
  const { signedCard, directory } = makeSignedCardFixture();
  const tampered = { ...signedCard, sections: [...signedCard.sections] };
  tampered.sections[0] = { ...tampered.sections[0], value: "not hi anymore" };

  const fetchImpl = routedFetch([
    [/\/\.well-known\//, jsonOk(directory)],
    [/agent-card\.json$/, jsonOk(tampered)],
  ]);
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(client.card("weatherbot"), (err) => {
    assert.ok(err instanceof sdk.IdentityCardInvalidError);
    assert.strictEqual(err.name, "IdentityCardInvalid");
    return true;
  });
});

test("client.card() throws IdentityCardInvalidError for a card with no signatures at all", async () => {
  const { signedCard, directory } = makeSignedCardFixture();
  const unsigned = { ...signedCard };
  delete unsigned.signatures;

  const fetchImpl = routedFetch([
    [/\/\.well-known\//, jsonOk(directory)],
    [/agent-card\.json$/, jsonOk(unsigned)],
  ]);
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(client.card("weatherbot"), sdk.IdentityCardInvalidError);
});

test("client.card() throws IdentityCardInvalidError when no published key matches the card's kid", async () => {
  const { signedCard } = makeSignedCardFixture();
  const fetchImpl = routedFetch([
    [/\/\.well-known\//, jsonOk({ keys: [] })], // some OTHER key rotated in, ours isn't published
    [/agent-card\.json$/, jsonOk(signedCard)],
  ]);
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(client.card("weatherbot"), /no published salt key matches/i);
});

test("client.card() fetches the signing-key directory once and caches it across calls", async () => {
  const { signedCard, directory } = makeSignedCardFixture();
  const fetchImpl = routedFetch([
    [/\/\.well-known\//, jsonOk(directory)],
    [/agent-card\.json$/, jsonOk(signedCard)],
  ]);
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await client.card("weatherbot");
  await client.card("weatherbot");
  const directoryCalls = fetchImpl.calls.filter((u) => u.includes(".well-known")).length;
  assert.strictEqual(directoryCalls, 1, "the directory should be fetched exactly once and reused");
});

test("client.card() recovers from a rotated Salt signing key: a cached key set that doesn't cover a card's kid is refetched once, then verifies", async () => {
  const oldFixture = makeSignedCardFixture({ kid: "key-old" });
  const newFixture = makeSignedCardFixture({ kid: "key-new" });

  let directoryCalls = 0;
  let rotated = false;
  const fetchImpl = async (url) => {
    if (/\.well-known\//.test(url)) {
      directoryCalls++;
      return { ok: true, status: 200, json: async () => (rotated ? newFixture.directory : oldFixture.directory) };
    }
    if (/agent-card\.json$/.test(url)) {
      return { ok: true, status: 200, json: async () => (rotated ? newFixture.signedCard : oldFixture.signedCard) };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const first = await client.card("weatherbot");
  assert.strictEqual(first.verified, true);
  assert.strictEqual(directoryCalls, 1, "priming the cache costs exactly one directory fetch");

  // Salt rotates its signing key and re-signs the card with it, all before
  // this cache would otherwise have expired.
  rotated = true;
  const second = await client.card("weatherbot");
  assert.strictEqual(second.verified, true, "a legitimate card signed with the newly-rotated key must still verify");
  assert.strictEqual(directoryCalls, 2, "the kid miss should trigger exactly one refetch, not a permanent failure");
});

test("client.card() throws IdentityCardInvalidError, after exactly one retry, when a kid is missing even from the freshly-refetched directory", async () => {
  const { signedCard } = makeSignedCardFixture({ kid: "key-that-is-never-published" });
  let directoryCalls = 0;
  const fetchImpl = async (url) => {
    if (/\.well-known\//.test(url)) {
      directoryCalls++;
      return { ok: true, status: 200, json: async () => ({ keys: [] }) }; // never has the right key, before or after refetch
    }
    if (/agent-card\.json$/.test(url)) {
      return { ok: true, status: 200, json: async () => signedCard };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(client.card("weatherbot"), sdk.IdentityCardInvalidError);
  assert.strictEqual(directoryCalls, 2, "one initial fetch plus exactly one retry -- never a silent permanent failure, never an unbounded retry loop");
});

test("client.card() refetches the signing-key directory once its Cache-Control max-age has elapsed, even with no kid mismatch", async () => {
  const { signedCard, directory } = makeSignedCardFixture();
  let directoryCalls = 0;
  const fetchImpl = async (url) => {
    if (/\.well-known\//.test(url)) {
      directoryCalls++;
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "cache-control" ? "public, max-age=0" : null) },
        json: async () => directory,
      };
    }
    if (/agent-card\.json$/.test(url)) {
      return { ok: true, status: 200, json: async () => signedCard };
    }
    return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
  };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await client.card("weatherbot");
  assert.strictEqual(directoryCalls, 1);
  await new Promise((resolve) => setTimeout(resolve, 5)); // let max-age=0 actually elapse
  await client.card("weatherbot");
  assert.strictEqual(directoryCalls, 2, "max-age=0 means the cached directory is stale on the very next call");
});

// --- client.identity() / client.setIdentity() -----------------------------

test("client.identity() GETs /api/v1/identity and setIdentity() PATCHes /api/v1/identity/sections", async () => {
  const identityBody = {
    sections: [
      { key: "bio", label: "Bio", value: "A helpful bot", scope: "everyone", kind: "claim" },
      { key: "pgp_fingerprint", label: "PGP fingerprint", value: "AB12", scope: "everyone", kind: "proof", checked_by: "Salt" },
    ],
    card_url: "https://salt.test/api/v1/agents/weatherbot/agent-card.json",
  };
  let patchedBody;
  const fetchImpl = async (url, opts) => {
    if (url.includes("/api/v1/identity/sections") && opts.method === "PATCH") {
      patchedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => identityBody };
    }
    if (url.includes("/api/v1/identity")) {
      return { ok: true, status: 200, json: async () => identityBody };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const got = await client.identity("api-key-1");
  assert.strictEqual(got.sections.length, 2);
  assert.strictEqual(got.card_url, identityBody.card_url);

  const set = await client.setIdentity("api-key-1", { bio: "A very helpful bot" });
  assert.deepStrictEqual(patchedBody, { bio: "A very helpful bot" });
  assert.strictEqual(set.card_url, identityBody.card_url);
});

test("client.setIdentity() refuses to send scope, before making any request at all", async () => {
  const fetchImpl = async () => {
    throw new Error("setIdentity must never call fetch when scope is present");
  };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(client.setIdentity("api-key-1", { bio: "hi", scope: "everyone" }), /scope/i);
});

// --- actions.ts: identity_set / identity_get ------------------------------

function fakeIdentityClient({ cardResult, cardError } = {}) {
  const setCalls = [];
  return {
    setCalls,
    async setIdentity(apiKey, claims) {
      setCalls.push({ apiKey, claims });
      return { sections: [], card_url: "https://salt.test/api/v1/agents/me/agent-card.json" };
    },
    async card(handle, opts) {
      if (cardError) throw cardError;
      return cardResult;
    },
    trackEvent() {},
  };
}

test("identity_set only forwards known claim keys and notes a claim is not a proof", async () => {
  const client = fakeIdentityClient();
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-1", apiKey: "k1", publicKey: "pub" };

  const result = await actions.execute(
    "identity_set",
    { bio: "A helpful bot", display_name: "Weatherbot", not_a_real_section: "ignored" },
    caller,
    { depth: 0, mainChatId: null }
  );

  assert.strictEqual(result.updated, true);
  assert.deepStrictEqual(client.setCalls[0].claims, { bio: "A helpful bot", display_name: "Weatherbot" });
  assert.ok(!("not_a_real_section" in client.setCalls[0].claims));
  assert.match(result.note, /claim/i);
  assert.match(result.note, /not verified as true/i);
});

test("identity_set throws when no known section is provided", async () => {
  const client = fakeIdentityClient();
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-1", apiKey: "k1", publicKey: "pub" };

  await assert.rejects(
    actions.execute("identity_set", { not_a_real_section: "x" }, caller, { depth: 0, mainChatId: null }),
    /provide at least one section/i
  );
});

test("identity_get tells apart proof sections from claim sections, reading checked_by from proof.by without ever assuming a checker", async () => {
  const client = fakeIdentityClient({
    cardResult: {
      verified: true,
      card: {
        name: "Weatherbot",
        sections: [
          { key: "bio", value: "Forecasts", proof: null },
          // Today's shape: a proof with no `by` at all -- the SDK must
          // never invent "Salt" (or anyone else) here.
          { key: "trust_score", value: "4.9", proof: true },
          // Tomorrow's shape: a proof that DOES name its checker.
          { key: "verified_did", value: "did:example:dana", proof: { by: "Grains" } },
        ],
      },
    },
  });
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-1", apiKey: "k1", publicKey: "pub" };

  const result = await actions.execute("identity_get", { handle: "weatherbot" }, caller, { depth: 0, mainChatId: null });

  assert.strictEqual(result.found, true);
  assert.strictEqual(result.verified, true);
  const bio = result.sections.find((s) => s.key === "bio");
  const trust = result.sections.find((s) => s.key === "trust_score");
  const verifiedDid = result.sections.find((s) => s.key === "verified_did");
  assert.strictEqual(bio.is_proof, false);
  assert.strictEqual(bio.checked_by, null);
  assert.strictEqual(trust.is_proof, true);
  assert.strictEqual(trust.checked_by, null, "an opaque proof (no `by`) must never be attributed to a guessed checker");
  assert.strictEqual(verifiedDid.is_proof, true);
  assert.strictEqual(verifiedDid.checked_by, "Grains");
  assert.doesNotMatch(result.note, /\bSalt itself\b/, "the note must not hardcode Salt as the checker of every proof");
});

test("identity_get returns found:false instead of throwing when the card is missing or untrustworthy", async () => {
  const missingClient = fakeIdentityClient({ cardError: new sdk.SaltApiError("GET", "https://x/card.json", 404, { error: "not found" }) });
  const missingActions = sdk.createActions({ client: missingClient, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-1", apiKey: "k1", publicKey: "pub" };
  const missing = await missingActions.execute("identity_get", { handle: "nobody" }, caller, { depth: 0, mainChatId: null });
  assert.strictEqual(missing.found, false);

  const badSigClient = fakeIdentityClient({ cardError: new sdk.IdentityCardInvalidError("tampered") });
  const badSigActions = sdk.createActions({ client: badSigClient, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const badSig = await badSigActions.execute("identity_get", { handle: "someone" }, caller, { depth: 0, mainChatId: null });
  assert.strictEqual(badSig.found, false);
  assert.match(badSig.reason, /could not trust it/i);
});

test("identity_set and identity_get are registered actions with plain JSON Schema", () => {
  const actions = sdk.createActions({ client: fakeIdentityClient(), identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const names = actions.definitions.map((d) => d.name);
  assert.ok(names.includes("identity_set"));
  assert.ok(names.includes("identity_get"));
  const tools = sdk.toAnthropicTools(actions.definitions);
  assert.ok(tools.find((t) => t.name === "identity_set").input_schema.properties.bio);
  assert.ok(tools.find((t) => t.name === "identity_get").input_schema.properties.handle);
});
