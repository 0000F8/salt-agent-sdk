// Social recovery, guardian side: an agent opens the share Salt holds for it
// with its own PGP key and re-seals it to the requester's ephemeral key
// (mirrors salt-fe's GuardianRequests.jsx), then contributes it.
const test = require("node:test");
const assert = require("node:assert");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");

async function keypair(passphrase) {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "ecc", curve: "curve25519", userIDs: [{ name: "k" }], passphrase, format: "armored",
  });
  return { privateKey, publicKey };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("releaseRecoveryShare opens the held share, re-seals it to the ephemeral key, and posts only that", async () => {
  const guardian = await keypair("g-pass");
  const ephemeral = await keypair("e-pass");
  const SHARE = "c2hhbWlyLXNoYXJlLWJ5dGVz"; // base64 share, opaque to the guardian
  const encrypted_share = await sdk.encryptFor(SHARE, [guardian.publicKey]);

  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined, key: opts.headers["api-key"] });
    if (url.includes("/recovery_request/incoming")) {
      return jsonResponse(200, [{ id: "req-1", requester_id: "owner-1", ephemeral_public_key: ephemeral.publicKey,
        threshold: 2, collected: 0, already_contributed: false, created_at: "t", expires_at: "t" }]);
    }
    if (url.includes("/recovery_shares/held")) {
      return jsonResponse(200, [{ owner_id: "owner-1", encrypted_share, threshold: 2 }]);
    }
    return jsonResponse(201, { collected: 1, threshold: 2 });
  };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const result = await client.releaseRecoveryShare("agent-key", { requestId: "req-1", privateKey: guardian.privateKey, passphrase: "g-pass" });
  assert.deepStrictEqual(result, { collected: 1, threshold: 2 });

  const post = calls.find((c) => c.method === "POST");
  assert.ok(post.url.endsWith("/api/v1/recovery_requests/req-1/contribute"));
  assert.strictEqual(post.key, "agent-key");
  // Only the re-sealed armor travels, and only the requester's ephemeral key opens it.
  assert.ok(post.body.sealed_share.includes("BEGIN PGP MESSAGE"));
  assert.ok(!JSON.stringify(post.body).includes(SHARE));
  const opened = await sdk.decrypt(post.body.sealed_share, ephemeral.privateKey, "e-pass");
  assert.strictEqual(opened, SHARE);
  await assert.rejects(sdk.decrypt(post.body.sealed_share, guardian.privateKey, "g-pass"));
});

test("releaseRecoveryShare refuses an id the server did not list, and ignores any requester/key a caller smuggles in", async () => {
  const guardian = await keypair("g");
  const attacker = await keypair("a");
  const real = await keypair("r");
  const encrypted_share = await sdk.encryptFor("SHARE", [guardian.publicKey]);
  const posts = [];
  const fetchImpl = async (url, opts) => {
    if (opts.method === "POST") { posts.push(JSON.parse(opts.body)); return jsonResponse(201, { collected: 1, threshold: 2 }); }
    if (url.includes("/recovery_request/incoming")) {
      return jsonResponse(200, [{ id: "req-1", requester_id: "owner-1", ephemeral_public_key: real.publicKey }]);
    }
    return jsonResponse(200, [{ owner_id: "owner-1", encrypted_share, threshold: 2 }]);
  };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(client.releaseRecoveryShare("k", { requestId: "forged", privateKey: guardian.privateKey, passphrase: "g" }), /no open recovery request/);
  assert.strictEqual(posts.length, 0);

  // Extra fields (a forged requester / key) are not part of the contract and change nothing.
  await client.releaseRecoveryShare("k", { requestId: "req-1", requester_id: "victim", ephemeral_public_key: attacker.publicKey, privateKey: guardian.privateKey, passphrase: "g" });
  assert.strictEqual(await sdk.decrypt(posts[0].sealed_share, real.privateKey, "r"), "SHARE");
  await assert.rejects(sdk.decrypt(posts[0].sealed_share, attacker.privateKey, "a"));
});

test("invitations can be listed, accepted and declined", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push(`${opts.method} ${url.split("salt.test")[1].split("?")[0]}`); return jsonResponse(200, []); };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await client.recoveryGuardianInvitations("k");
  await client.acceptRecoveryGuardian("k", "s1");
  await client.declineRecoveryGuardian("k", "s2");
  assert.deepStrictEqual(calls, ["GET /api/v1/recovery_shares/invitations", "POST /api/v1/recovery_shares/s1/accept", "POST /api/v1/recovery_shares/s2/decline"]);
});

test("resealHeldShare refuses when no share is held for that requester", async () => {
  const guardian = await keypair("p");
  const ephemeral = await keypair("e");
  await assert.rejects(
    sdk.resealHeldShare({
      held: [{ owner_id: "someone-else", encrypted_share: "x", threshold: 2 }],
      request: { requester_id: "owner-1", ephemeral_public_key: ephemeral.publicKey },
      privateKey: guardian.privateKey,
      passphrase: "p",
    }),
    /no share held/
  );
});

test("incomingRecoveryRequests and heldRecoveryShares hit the guardian endpoints", async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return jsonResponse(200, []); };
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  await client.incomingRecoveryRequests("k");
  await client.heldRecoveryShares("k");
  assert.ok(urls[0].includes("/api/v1/recovery_request/incoming"));
  assert.ok(urls[1].includes("/api/v1/recovery_shares/held"));
});
