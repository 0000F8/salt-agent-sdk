// Key reset, phase 2 (KEY_RESET_DESIGN.md 4, 7, 10): resetChatKey builds the request (new DEK, rewraps, dual-signed
// reseals), onMemberKeyChanged reaches the handler, recipient keys are resolved at send time, and a 409
// stale_recipient_keys is answered with one re-encrypt.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac, webcrypto, randomBytes } = require("node:crypto");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");

const subtle = webcrypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();
const silent = { info() {}, error() {} };
const ITER = 1000;

// ---- webhook side ----------------------------------------------------------------------------------------------

const tempStore = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "salt-key-reset-")), "identities.json");

function signedPost(port, body, agentId, secret) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "Content-Type": "application/json", "X-Salt-Agent-Id": agentId, "X-Salt-Signature": `t=${t},v1=${v1}` }, body: raw });
}

async function agentWorld() {
  const agent = await sdk.generateKeypair("agent-pass");
  const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agent.publicKey, privateKey: agent.privateKey });
  return { agent, AGENT_ID, store };
}

const user = (id, keys) => ({ id, username: `u${id.slice(-1)}`, display_name: `U${id.slice(-1)}`, account_type: "User", public_key: keys.publicKey, public_fingerprint: keys.fingerprint.toUpperCase() });

function fakeApi(state) {
  const posted = [];
  return {
    posted,
    async getWebhookSecret() {
      return "secret-agent";
    },
    async getChatMembers() {
      return state.members;
    },
    async postMessage(apiKey, chatId, message, senderMessage, delegations, mentions, opts) {
      posted.push({ message, senderMessage, opts });
      if (state.refuse) return state.refuse(posted.length);
      return { id: "m" };
    },
    async signalTyping() {},
    trackEvent() {},
  };
}

async function readWith(armored, privateKey, passphrase) {
  const key = await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: privateKey }), passphrase });
  const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ armoredMessage: armored }), decryptionKeys: [key] });
  return data;
}

test("member_key_changed reaches onMemberKeyChanged with the user, generation and fingerprint; no handler is a quiet no-op", async (t) => {
  const { AGENT_ID, store } = await agentWorld();
  const api = fakeApi({ members: [] });
  const seen = [];
  const server = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "x", logger: silent, onMemberKeyChanged: (ctx) => void seen.push(ctx) });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;
  const body = { type: "member_key_changed", user_id: "00000000-0000-0000-0000-0000000000b2", key_generation: 3, public_fingerprint: "ABCD" };
  assert.equal((await signedPost(port, body, AGENT_ID, "secret-agent")).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userId, body.user_id);
  assert.equal(seen[0].keyGeneration, 3);
  assert.equal(seen[0].publicFingerprint, "ABCD");
  assert.equal(seen[0].identity.saltAppId, AGENT_ID);

  const quiet = sdk.createWebhookServer({ client: api, identities: store, pgpPassphrase: "x", logger: silent });
  const l2 = quiet.app.listen(0);
  t.after(() => l2.close());
  assert.equal((await signedPost(l2.address().port, body, AGENT_ID, "secret-agent")).status, 200);
});

async function replyScenario(t, state, options = {}) {
  const { AGENT_ID, store } = await agentWorld();
  const api = fakeApi(state);
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "x",
    logger: silent,
    onChatOpened: async (ctx) => {
      await ctx.reply("hello");
      if (options.second) {
        options.second();
        await ctx.reply("again");
      }
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  return { api, AGENT_ID, port: listening.address().port };
}

// chat_opened finds the hosted identity by noticing itself among the members, so the agent is always one of them.
const AGENT_SELF = { id: "00000000-0000-0000-0000-0000000000a1", username: "helper", display_name: "H", account_type: "Agent", public_key: "unused" };
const openedBody = (id, AGENT_ID, members) => ({ type: "chat_opened", chat: { id }, opened_by: members[0], members: [...members, AGENT_SELF], opened_at: "2026-10-17T00:00:00Z" });

test("recipient keys are resolved at send time: a member who reset between two replies gets the second one under the new key", async (t) => {
  const oldK = await sdk.generateKeypair("old-pass");
  const newK = await sdk.generateKeypair("new-pass");
  const MEMBER = "00000000-0000-0000-0000-0000000000b2";
  const state = { members: [user(MEMBER, oldK)] };
  const { api, AGENT_ID, port } = await replyScenario(t, state, { second: () => void (state.members = [user(MEMBER, newK)]) });
  state.members.push({ id: AGENT_ID, username: "helper", display_name: "H", account_type: "Agent", public_key: "unused" });
  // The agent's own entry must be skipped; give it a real key so a mistake would be caught by openpgp.
  state.members[1].public_key = (await sdk.generateKeypair("x")).publicKey;
  assert.equal((await signedPost(port, openedBody("chat-1", AGENT_ID, state.members), AGENT_ID, "secret-agent")).status, 200);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(api.posted.length, 2);
  assert.equal(await readWith(api.posted[0].message, oldK.privateKey, "old-pass"), "hello");
  await assert.rejects(readWith(api.posted[1].message, oldK.privateKey, "old-pass"));
  assert.equal(await readWith(api.posted[1].message, newK.privateKey, "new-pass"), "again");
});

test("the guard fields ride along: recipient_fingerprints by user id and the sender's own fingerprint", async (t) => {
  const k = await sdk.generateKeypair("k-pass");
  const MEMBER = "00000000-0000-0000-0000-0000000000b2";
  const state = { members: [user(MEMBER, k)] };
  const { api, AGENT_ID, port } = await replyScenario(t, state);
  await signedPost(port, openedBody("chat-2", AGENT_ID, state.members), AGENT_ID, "secret-agent");
  await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(api.posted[0].opts.recipientFingerprints, { [MEMBER]: k.fingerprint.toUpperCase() });
  assert.match(api.posted[0].opts.senderFingerprint, /^[0-9A-F]{40}$/);
});

test("409 stale_recipient_keys: re-encrypts to the members it names and sends once more; a second refusal does not loop", async (t) => {
  const oldK = await sdk.generateKeypair("old-pass");
  const newK = await sdk.generateKeypair("new-pass");
  const MEMBER = "00000000-0000-0000-0000-0000000000b2";
  const stale = (calls) => {
    throw new sdk.SaltApiError("POST", "/api/v1/messages", 409, { code: "stale_recipient_keys", stale: [MEMBER], members: [user(MEMBER, newK)] });
  };
  const state = { members: [user(MEMBER, oldK)], refuse: (n) => (n === 1 ? stale() : { id: "ok" }) };
  const { api, AGENT_ID, port } = await replyScenario(t, state);
  await signedPost(port, openedBody("chat-3", AGENT_ID, state.members), AGENT_ID, "secret-agent");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(api.posted.length, 2, "the refused send and exactly one retry");
  assert.equal(await readWith(api.posted[1].message, newK.privateKey, "new-pass"), "hello");

  const always = { members: [user(MEMBER, oldK)], refuse: () => stale() };
  const again = await replyScenario(t, always);
  await signedPost(again.port, openedBody("chat-4", again.AGENT_ID, always.members), again.AGENT_ID, "secret-agent");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(again.api.posted.length, 2, "one retry, then stop");
});

// ---- the reset request -----------------------------------------------------------------------------------------

const b64 = (b) => Buffer.from(b).toString("base64");
const kek = async (secret, salt, form) => subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(salt, "base64"), iterations: ITER }, await subtle.importKey("raw", te.encode(secret.normalize(form)), "PBKDF2", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
async function gcm(key, plain, aad) {
  const iv = randomBytes(12);
  return b64(Buffer.concat([iv, Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad), tagLength: 128 }, key, plain))]));
}
async function open(key, blob, aad) {
  const d = Buffer.from(blob, "base64");
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: d.subarray(0, 12), additionalData: te.encode(aad), tagLength: 128 }, key, d.subarray(12)));
}
const dekKey = (raw) => subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
async function pgpPair(name) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{ name }], format: "armored" });
  return { privateKey, publicKey, fingerprint: (await openpgp.readKey({ armoredKey: publicKey })).getFingerprint().toUpperCase() };
}

async function resetWorld({ lockMode = "login", vaultPassword } = {}) {
  const PASSWORD = "correct horse battery";
  const lockSecret = lockMode === "separate" ? vaultPassword : PASSWORD;
  const saltPw = b64(randomBytes(16));
  const saltRec = b64(randomBytes(16));
  const phrase = "test test test test test test test test test test test junk";
  const kekPw = await kek(lockSecret, saltPw, "NFKC");
  const kekRec = await kek(phrase, saltRec, "NFKD");
  const msgRaw = randomBytes(32);
  const walletsRaw = randomBytes(32);
  const oldDek = await dekKey(msgRaw);
  const [retiredK, activeK, agentK, computerK, readerK] = await Promise.all(["r", "a", "g", "c", "d"].map(pgpPair));
  const wrapKey = (k, aad) => gcm(oldDek, te.encode(JSON.stringify({ private_key: k.privateKey })), aad);
  const vault = {
    version: 4,
    salt_password: saltPw,
    salt_recovery: saltRec,
    kdf_iterations: ITER,
    kdf_algo: "PBKDF2-SHA256",
    lock_mode: lockMode,
    phrase_ciphertext: await gcm(oldDek, te.encode(JSON.stringify(phrase)), "recovery-phrase"),
    wrapped_deks: {
      messages: { password: await gcm(kekPw, msgRaw, "wrap:messages:password"), recovery: await gcm(kekRec, msgRaw, "wrap:messages:recovery"), social: "OLD-SOCIAL-MESSAGES" },
      wallets: { password: await gcm(kekPw, walletsRaw, "wrap:wallets:password"), recovery: await gcm(kekRec, walletsRaw, "wrap:wallets:recovery"), social: "SOCIAL-WALLETS" },
    },
  };
  const userKeys = {
    generation: 2,
    public_key: activeK.publicKey,
    public_fingerprint: activeK.fingerprint,
    encrypted_private_key: await wrapKey(activeK, `userkey:${activeK.fingerprint}`),
    retired: [{ generation: 1, public_fingerprint: retiredK.fingerprint, encrypted_private_key: await wrapKey(retiredK, `userkey:${retiredK.fingerprint}`) }],
  };
  const agentBlob = await gcm(oldDek, te.encode(JSON.stringify({ private_key: agentK.privateKey, revocation_cert: null })), `agentkey:${agentK.fingerprint}`);
  const devices = [
    { id: "dev-computer", kind: "computer", public_key: computerK.publicKey, sealed_key_generation: 2 },
    { id: "dev-reader", kind: "reader", public_key: readerK.publicKey, sealed_key_generation: 1 },
    { id: "dev-lost", kind: "computer", public_key: (await pgpPair("lost")).publicKey, sealed_key_generation: 2 },
  ];
  return { PASSWORD, phrase, vault, userKeys, devices, keys: { retiredK, activeK, agentK, computerK, readerK }, oldDek, kekPw, walletsRaw, agent: { agent_id: "agent-1", public_fingerprint: agentK.fingerprint, encrypted_private_key: agentBlob } };
}

const build = (w, extra = {}) =>
  sdk.buildChatKeyReset({ userKeys: w.userKeys, vault: w.vault, password: w.PASSWORD, userId: "user-1", linkedDevices: w.devices, keepDeviceIds: ["dev-computer", "dev-reader"], agentKeys: [w.agent], authIterations: ITER, ...extra });

test("reset request: a NEW DEK -- the old DEK opens none of the new wraps; the new DEK opens everything", async () => {
  const w = await resetWorld();
  const out = await build(w);
  const r = out.request;
  assert.equal(r.expected_generation, 2);
  assert.equal(out.newGeneration, 3);
  assert.equal(r.expected_vault_version, 4);
  assert.equal(r.current_password, await sdk.authString(w.PASSWORD, ITER));
  assert.deepEqual(r.linked_set, ["dev-computer", "dev-reader", "dev-lost"], "the server compares this with the devices it knows");
  assert.deepEqual(r.reseals.map((x) => x.linked_device_id), ["dev-computer", "dev-reader"], "the unticked device is simply not re-sealed");

  // The old DEK opens nothing the request carries.
  const newFp = out.newFingerprint;
  await assert.rejects(open(w.oldDek, r.encrypted_private_key, `userkey:${newFp}`));
  const fpOf = (g) => ({ 1: w.keys.retiredK.fingerprint, 2: w.keys.activeK.fingerprint })[g];
  for (const rw of r.retired_rewraps) await assert.rejects(open(w.oldDek, rw.encrypted_private_key, `userkey:${fpOf(rw.generation)}`));
  await assert.rejects(open(w.oldDek, r.vault.phrase_ciphertext, "recovery-phrase"));
  await assert.rejects(open(w.oldDek, r.agent_rewraps[0].encrypted_private_key, `agentkey:${w.keys.agentK.fingerprint}`));

  // The new messages DEK comes out of the password wrap and of the NEW recovery phrase, and is not the old one.
  const kekPw = await kek(w.PASSWORD, r.vault.salt_password, "NFKC");
  const newRaw = await open(kekPw, r.vault.wrapped_deks.messages.password, "wrap:messages:password");
  const kekRec = await kek(out.recoveryPhrase.trim().toLowerCase(), r.vault.salt_recovery, "NFKD");
  assert.deepEqual(await open(kekRec, r.vault.wrapped_deks.messages.recovery, "wrap:messages:recovery"), newRaw);
  assert.notEqual(out.recoveryPhrase, w.phrase);
  assert.equal(out.recoveryPhrase.split(" ").length, 12);
  assert.equal(r.vault.wrapped_deks.messages.social, undefined, "guardian wraps of the old DEK are dropped, not carried");
  const newDek = await dekKey(newRaw);

  // Under the new DEK: the new key, every older generation, the phrase, the agent key.
  const nk = JSON.parse(td.decode(await open(newDek, r.encrypted_private_key, `userkey:${newFp}`)));
  assert.equal((await openpgp.readPrivateKey({ armoredKey: nk.private_key })).getFingerprint().toUpperCase(), newFp);
  assert.equal((await openpgp.readKey({ armoredKey: r.public_key })).getFingerprint().toUpperCase(), newFp);
  assert.deepEqual(r.retired_rewraps.map((x) => x.generation).sort(), [1, 2]);
  const back = {};
  for (const rw of r.retired_rewraps) back[rw.generation] = JSON.parse(td.decode(await open(newDek, rw.encrypted_private_key, `userkey:${fpOf(rw.generation)}`))).private_key;
  assert.equal(back[1], w.keys.retiredK.privateKey);
  assert.equal(back[2], w.keys.activeK.privateKey);
  assert.equal(JSON.parse(td.decode(await open(newDek, r.vault.phrase_ciphertext, "recovery-phrase"))), out.recoveryPhrase);
  assert.equal(JSON.parse(td.decode(await open(newDek, r.agent_rewraps[0].encrypted_private_key, `agentkey:${w.keys.agentK.fingerprint}`))).private_key, w.keys.agentK.privateKey);

  // Wallets: same DEK, password and guardian wraps untouched, recovery wrap now follows the new phrase.
  assert.equal(r.vault.wrapped_deks.wallets.password, w.vault.wrapped_deks.wallets.password);
  assert.equal(r.vault.wrapped_deks.wallets.social, "SOCIAL-WALLETS");
  assert.deepEqual(await open(kekRec, r.vault.wrapped_deks.wallets.recovery, "wrap:wallets:recovery"), new Uint8Array(w.walletsRaw));
});

test("reseals: v2 keyring signed by BOTH the new key and the generation that device holds; the unticked device gets none", async () => {
  const w = await resetWorld();
  const out = await build(w);
  const newPub = (await openpgp.readPrivateKey({ armoredKey: JSON.parse(td.decode(await open(await dekKey(await open(await kek(w.PASSWORD, out.request.vault.salt_password, "NFKC"), out.request.vault.wrapped_deks.messages.password, "wrap:messages:password")), out.request.encrypted_private_key, `userkey:${out.newFingerprint}`))).private_key })).toPublic();
  const holders = { "dev-computer": [w.keys.computerK, w.keys.activeK], "dev-reader": [w.keys.readerK, w.keys.retiredK] }; // [device, held generation key]
  for (const seal of out.request.reseals) {
    const [device, held] = holders[seal.linked_device_id];
    const { data, signatures } = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: seal.sealed_key }),
      decryptionKeys: await openpgp.readPrivateKey({ armoredKey: device.privateKey }),
      verificationKeys: [newPub, await openpgp.readKey({ armoredKey: held.publicKey })],
    });
    assert.equal(signatures.length, 2);
    for (const s of signatures) assert.equal(await s.verified, true);
    const payload = JSON.parse(data);
    assert.equal(payload.v, 2);
    assert.equal(payload.user_id, "user-1");
    assert.deepEqual(payload.keys.map((k) => [k.generation, k.active]).sort(), [[1, false], [2, false], [3, true]]);
    for (const k of payload.keys) assert.equal((await openpgp.readPrivateKey({ armoredKey: k.private_key })).getFingerprint().toUpperCase(), k.fingerprint);
  }
});

test("a kept device that holds a generation we cannot open is reported, not given a payload nobody can verify", async () => {
  const w = await resetWorld();
  w.userKeys.retired[0].encrypted_private_key = "AAAA"; // the DEK minted by "start fresh": this row cannot be opened
  const out = await build(w);
  assert.deepEqual(out.skippedGenerations, [1]);
  assert.deepEqual(out.notResealed, ["dev-reader"]);
  assert.deepEqual(out.request.reseals.map((x) => x.linked_device_id), ["dev-computer"]);
});

test("an agent key that is not the one its fingerprint names is refused; a separate lock needs its own password", async () => {
  const w = await resetWorld();
  await assert.rejects(build(w, { agentKeys: [{ ...w.agent, public_fingerprint: w.keys.activeK.fingerprint, encrypted_private_key: w.agent.encrypted_private_key }] }));
  const sep = await resetWorld({ lockMode: "separate", vaultPassword: "separate lock" });
  await assert.rejects(build(sep), /vaultPassword/);
  const ok = await build(sep, { vaultPassword: "separate lock" });
  assert.equal(ok.newGeneration, 3);
});

// ---- client.resetChatKey ----------------------------------------------------------------------------------------

function resetFetch(w, calls) {
  return async (url, init = {}) => {
    const p = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: p, body, headers: init.headers });
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (p === "/api/v1/userkeys/reset" && body?.dry_run) return json({ devices: w.devices, chats_affected: 4, current_generation: 2, vault_version: 4, agents_to_rewrap: [{ id: "agent-1", handle: "bot", public_fingerprint: w.agent.public_fingerprint }] });
    if (p === "/api/v1/agents/agent-1/admin") return json({ userkeys: { encrypted_private_key: w.agent.encrypted_private_key } });
    if (p === "/api/v1/userkeys/reset") return json({ ok: true, resealed: ["dev-computer", "dev-reader"], unlinked: ["dev-lost"] });
    if (p === "/api/v1/userkeys") return json(w.userKeys);
    if (p === "/api/v1/vault") return json(w.vault);
    if (p === "/api/v1/linked_devices") return json({ linked_devices: w.devices });
    if (p === "/api/v1/account") return json({ id: "user-1" });
    return json({}, 404);
  };
}

test("client.resetChatKey: dry run touches nothing; the real run posts the built request with the human session beside the api-key", async () => {
  const w = await resetWorld();
  const calls = [];
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl: resetFetch(w, calls) });
  const dry = await client.resetChatKey("api-key", { password: w.PASSWORD, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.plan.current_generation, 2);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /api/v1/userkeys/reset"]);
  assert.deepEqual(calls[0].body, { dry_run: true });

  calls.length = 0;
  // The real login string costs 600k rounds; the builder's test iterations are not reachable through the client, so
  // only assert the shape here (the request itself is covered above).
  const done = await client.resetChatKey("api-key", { password: w.PASSWORD, devices: ["dev-computer", "dev-reader"], token: "jwt-abc" });
  const post = calls.filter((c) => c.method === "POST" && c.path === "/api/v1/userkeys/reset" && !c.body.dry_run);
  assert.equal(post.length, 1);
  assert.equal(post[0].headers.Authorization, "Bearer jwt-abc");
  assert.equal(post[0].headers["api-key"], "api-key");
  assert.ok(post[0].headers["Idempotency-Key"]);
  assert.deepEqual(post[0].body.reseals.map((x) => x.linked_device_id), ["dev-computer", "dev-reader"]);
  assert.deepEqual(post[0].body.linked_set, ["dev-computer", "dev-reader", "dev-lost"]);
  assert.equal(post[0].body.agent_rewraps[0].agent_id, "agent-1");
  assert.equal(post[0].body.agent_rewraps[0].fingerprint, w.agent.public_fingerprint);
  assert.deepEqual(Object.keys(post[0].body.retired_rewraps[0]).sort(), ["encrypted_private_key", "generation"]);
  assert.equal(done.newGeneration, 3);
  assert.equal(done.recoveryPhrase.split(" ").length, 12);
  assert.deepEqual(done.response.unlinked, ["dev-lost"]);
});
