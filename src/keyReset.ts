// Reset your chat key -- the agent path (KEY_RESET_DESIGN.md sections 4 and 10). Everything a person's browser does
// when they tap "Reset your chat key", for a caller that holds the owner's login password (and, for a separate lock,
// the lock password): an owner's explicit grant, never a bare token. The server never sees any key in the clear.
//
//   1. open the current messages DEK from the vault (the password wrap), then the active key and every retired
//      generation under it;
//   2. mint a NEW messages DEK -- never wrap the new key under the old DEK (section 4.1) -- and a new vault row:
//      password + recovery wraps of the new DEK, the wallets wraps carried over (their recovery wrap is re-made for
//      the new phrase), a new recovery phrase, `phrase_ciphertext` under the new DEK;
//   3. mint the new keypair; wrap it, and every older generation, under the new DEK;
//   4. rewrap the owner's vault-scheme agent keys under the new DEK (fingerprint-checked);
//   5. re-seal the whole keyring (v2 payload) to every linked device that stays, signed by BOTH the new key and the
//      generation that device already holds, so a device refuses a key Salt planted.
//
// `buildChatKeyReset` is the pure builder (no network); `client.resetChatKey` fetches, calls it and POSTs. Guardian
// (social) wraps of the old messages DEK cannot be remade here: they are dropped and each guardian is asked to
// re-share (design section 5, Phase 3).
import { randomBytes, webcrypto } from "node:crypto";
import * as openpgp from "openpgp";
import { Mnemonic } from "ethers";
import { fingerprintOf } from "./crypto.js";
import type { SaltId } from "./ids.js";

const subtle = webcrypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

// A label, not a hostname: every account's login string was derived under it (salt-fe passwordDerivation.js).
const AUTH_SALT = "saltfor.com/auth/v1";
export const AUTH_ITERATIONS = 600000;
const GCM_TAG_BITS = 128;
const IV_BYTES = 12;

const b64 = (bytes: Uint8Array | ArrayBuffer): string => Buffer.from(bytes as ArrayBuffer).toString("base64");
const unb64 = (s: string): Buffer => Buffer.from(s, "base64");

/** What Devise receives as "the password": base64 of PBKDF2-HMAC-SHA256(NFKC(password), "saltfor.com/auth/v1", 600000, 256 bits). */
export async function authString(password: string, iterations: number = AUTH_ITERATIONS): Promise<string> {
  const material = await subtle.importKey("raw", te.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: te.encode(AUTH_SALT), iterations }, material, 256);
  return b64(new Uint8Array(bits));
}

async function deriveKek(secret: string, saltB64: string, iterations: number, form: "NFKC" | "NFKD"): Promise<webcrypto.CryptoKey> {
  const material = await subtle.importKey("raw", te.encode(secret.normalize(form)), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function gcmEncrypt(key: webcrypto.CryptoKey, plain: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad), tagLength: GCM_TAG_BITS }, key, plain));
  return b64(Buffer.concat([iv, ct]));
}

async function gcmDecrypt(key: webcrypto.CryptoKey, blob: string, aad: string): Promise<Uint8Array> {
  const data = unb64(blob);
  return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: data.subarray(0, IV_BYTES), additionalData: te.encode(aad), tagLength: GCM_TAG_BITS }, key, data.subarray(IV_BYTES)));
}

const importDek = (raw: Uint8Array) => subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

// GCM's AAD check is byte-exact and the fingerprint's case has varied: as served, then both cases.
const aadCandidates = (prefix: string, fingerprint: string): string[] => [...new Set([fingerprint, fingerprint.toLowerCase(), fingerprint.toUpperCase()])].map((f) => `${prefix}:${f}`);

async function openWithAad(dek: webcrypto.CryptoKey, blob: string, prefix: string, fingerprint: string): Promise<Record<string, unknown>> {
  let last: unknown = new Error("could not open");
  for (const aad of aadCandidates(prefix, fingerprint)) {
    try {
      return JSON.parse(td.decode(await gcmDecrypt(dek, blob, aad)));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** A key row as `GET /api/v1/userkeys` serves it (the active row at the top level, older generations under `retired`). */
export interface KeyRow {
  generation?: number;
  public_key?: string;
  public_fingerprint: string;
  encrypted_private_key?: string;
  retired_at?: string;
}

export interface UserKeysResponse extends KeyRow {
  retired?: KeyRow[];
}

/** `GET /api/v1/vault`. */
export interface VaultRow {
  version: number;
  salt_password: string;
  salt_recovery: string;
  kdf_iterations: number;
  kdf_algo?: string;
  lock_mode?: string;
  phrase_ciphertext?: string;
  wrapped_deks: Record<string, Record<string, string>>;
}

/** One row of `GET /api/v1/linked_devices`. */
export interface LinkedDeviceRow {
  id: SaltId;
  name?: string;
  kind?: string;
  public_key: string;
  sealed_key_generation?: number | null;
}

/** An agent key wrapped under the owner's messages DEK that must move to the new DEK (dry run's `agents_to_rewrap`). */
export interface AgentKeyToRewrap {
  agent_id: SaltId;
  public_fingerprint: string;
  encrypted_private_key: string;
}

export interface BuildChatKeyResetInput {
  userKeys: UserKeysResponse;
  vault: VaultRow;
  /** The owner's login password: the Devise gate (as an auth string) and, in lock mode "login", the vault's lock. */
  password: string;
  /** The separate lock password, when `vault.lock_mode` is "separate". */
  vaultPassword?: string;
  userId: SaltId;
  /** Every device linked right now (`linked_set`). */
  linkedDevices: LinkedDeviceRow[];
  /** Ids of the devices that keep working (re-sealed). Every other linked device is unlinked by the server. */
  keepDeviceIds: SaltId[];
  agentKeys?: AgentKeyToRewrap[];
  expectedGeneration?: number;
  expectedVaultVersion?: number;
  /** Tests only: the real login string costs 600k PBKDF2 rounds. */
  authIterations?: number;
}

export interface ChatKeyResetRequest {
  public_key: string;
  encrypted_private_key: string;
  retired_rewraps: Array<{ generation: number; public_fingerprint: string; encrypted_private_key: string }>;
  vault: {
    salt_password: string;
    salt_recovery: string;
    kdf_iterations: number;
    kdf_algo: string;
    lock_mode: string;
    phrase_ciphertext: string;
    wrapped_deks: Record<string, Record<string, string>>;
  };
  agent_rewraps: Array<{ agent_id: SaltId; encrypted_private_key: string }>;
  expected_generation: number;
  expected_vault_version: number;
  current_password: string;
  linked_set: SaltId[];
  reseals: Array<{ linked_device_id: SaltId; sealed_key: string }>;
}

export interface BuiltChatKeyReset {
  request: ChatKeyResetRequest;
  /** The NEW recovery phrase. Shown to the owner once and kept by them; Salt never receives it. */
  recoveryPhrase: string;
  newGeneration: number;
  newFingerprint: string;
  /** Older generations that could not be opened with the current DEK: left out, that history stays unreadable. */
  skippedGenerations: number[];
  /** Kept devices that hold a generation we could not open, so no valid re-seal can be made: they are not re-sealed. */
  notResealed: SaltId[];
}

interface Generation {
  generation: number;
  fingerprint: string;
  armored: string;
}

/** Builds the whole reset request. Pure apart from randomness and PBKDF2; touches no network. */
export async function buildChatKeyReset(input: BuildChatKeyResetInput): Promise<BuiltChatKeyReset> {
  const { userKeys, vault } = input;
  const iterations = vault.kdf_iterations;
  const lockSecret = vault.lock_mode === "separate" ? input.vaultPassword : input.password;
  if (!lockSecret) throw new Error("This account uses a separate lock password: pass vaultPassword.");

  // 1. The current messages (and wallets) DEK, from the password wrap.
  const kekPw = await deriveKek(lockSecret, vault.salt_password, iterations, "NFKC");
  const messagesWrap = vault.wrapped_deks?.messages?.password;
  if (!messagesWrap) throw new Error("This account has no messages wrap in its vault.");
  const oldDekRaw = await gcmDecrypt(kekPw, messagesWrap, "wrap:messages:password");
  const oldDek = await importDek(oldDekRaw);
  oldDekRaw.fill(0);
  let walletsDekRaw: Uint8Array | null = null;
  if (vault.wrapped_deks?.wallets?.password) walletsDekRaw = await gcmDecrypt(kekPw, vault.wrapped_deks.wallets.password, "wrap:wallets:password");

  // 2. Every generation we can open (active first, then retired); an unopenable one is skipped, never fatal.
  const activeGeneration = input.expectedGeneration ?? userKeys.generation ?? 1;
  if (!userKeys.encrypted_private_key) throw new Error("This account's chat key is not vault-held; there is nothing to reset here.");
  const active = await openWithAad(oldDek, userKeys.encrypted_private_key, "userkey", userKeys.public_fingerprint);
  const generations: Generation[] = [{ generation: activeGeneration, fingerprint: userKeys.public_fingerprint.toUpperCase(), armored: String(active.private_key) }];
  const skippedGenerations: number[] = [];
  for (const row of userKeys.retired ?? []) {
    try {
      if (!row.encrypted_private_key) throw new Error("no wrap");
      const opened = await openWithAad(oldDek, row.encrypted_private_key, "userkey", row.public_fingerprint);
      generations.push({ generation: Number(row.generation), fingerprint: row.public_fingerprint.toUpperCase(), armored: String(opened.private_key) });
    } catch {
      skippedGenerations.push(Number(row.generation));
    }
  }

  // 3. New keys, new DEK, new vault row.
  const generated = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{}], format: "armored" });
  const newFingerprint = await fingerprintOf(generated.publicKey);
  const newGeneration = activeGeneration + 1;
  const newDekRaw = new Uint8Array(randomBytes(32));
  const newDek = await importDek(newDekRaw);
  const recoveryPhrase = Mnemonic.entropyToPhrase(randomBytes(16)); // 12 words
  const saltRecovery = b64(randomBytes(16));
  const kekRec = await deriveKek(recoveryPhrase.trim().toLowerCase(), saltRecovery, iterations, "NFKD");

  const wrapped_deks: Record<string, Record<string, string>> = {};
  wrapped_deks.messages = {
    password: await gcmEncrypt(kekPw, newDekRaw, "wrap:messages:password"),
    recovery: await gcmEncrypt(kekRec, newDekRaw, "wrap:messages:recovery"),
  };
  if (walletsDekRaw) {
    // Same wallets DEK; only its recovery wrap follows the new phrase. Password and guardian wraps carry over untouched.
    wrapped_deks.wallets = { ...vault.wrapped_deks.wallets, recovery: await gcmEncrypt(kekRec, walletsDekRaw, "wrap:wallets:recovery") };
    walletsDekRaw.fill(0);
  } else if (vault.wrapped_deks?.wallets) {
    throw new Error("The vault's wallets password wrap is missing; refusing to drop the wallets key.");
  }
  newDekRaw.fill(0);

  const phrase_ciphertext = await gcmEncrypt(newDek, te.encode(JSON.stringify(recoveryPhrase)), "recovery-phrase");
  const wrapKey = (g: { armored: string }, fingerprint: string) => gcmEncrypt(newDek, te.encode(JSON.stringify({ private_key: g.armored })), `userkey:${fingerprint}`);
  const encrypted_private_key = await wrapKey({ armored: generated.privateKey }, newFingerprint);
  const retired_rewraps: ChatKeyResetRequest["retired_rewraps"] = [];
  for (const g of generations) retired_rewraps.push({ generation: g.generation, public_fingerprint: g.fingerprint, encrypted_private_key: await wrapKey(g, g.fingerprint) });

  // 4. The owner's vault-scheme agent keys move to the new DEK; each must still be the key its fingerprint names.
  const agent_rewraps: ChatKeyResetRequest["agent_rewraps"] = [];
  for (const a of input.agentKeys ?? []) {
    const opened = await openWithAad(oldDek, a.encrypted_private_key, "agentkey", a.public_fingerprint);
    const fpr = (await openpgp.readPrivateKey({ armoredKey: String(opened.private_key) })).getFingerprint().toUpperCase();
    if (fpr !== a.public_fingerprint.toUpperCase()) throw new Error(`agent ${a.agent_id}: the stored key is not the one its fingerprint names; refusing to rewrap.`);
    const aad = `agentkey:${a.public_fingerprint.toUpperCase()}`;
    agent_rewraps.push({ agent_id: a.agent_id, encrypted_private_key: await gcmEncrypt(newDek, te.encode(JSON.stringify({ private_key: opened.private_key, revocation_cert: opened.revocation_cert ?? null })), aad) });
  }

  // 5. Re-seal the keyring to every device that stays: v2, signed by the new key AND the generation the device holds.
  const keyring = [
    { private_key: generated.privateKey, fingerprint: newFingerprint, generation: newGeneration, active: true },
    ...generations.map((g) => ({ private_key: g.armored, fingerprint: g.fingerprint, generation: g.generation, active: false })),
  ];
  const newSigner = await openpgp.readPrivateKey({ armoredKey: generated.privateKey });
  const reseals: ChatKeyResetRequest["reseals"] = [];
  const notResealed: SaltId[] = [];
  for (const device of input.linkedDevices.filter((d) => input.keepDeviceIds.includes(d.id))) {
    const heldGeneration = device.sealed_key_generation ?? activeGeneration;
    const held = generations.find((g) => g.generation === heldGeneration);
    if (!held) {
      notResealed.push(device.id);
      continue;
    }
    const sealed = (await openpgp.encrypt({
      message: await openpgp.createMessage({ text: JSON.stringify({ v: 2, user_id: input.userId, keys: keyring }) }),
      encryptionKeys: await openpgp.readKey({ armoredKey: device.public_key }),
      signingKeys: [newSigner, await openpgp.readPrivateKey({ armoredKey: held.armored })],
    })) as string;
    reseals.push({ linked_device_id: device.id, sealed_key: sealed });
  }

  return {
    recoveryPhrase,
    newGeneration,
    newFingerprint,
    skippedGenerations,
    notResealed,
    request: {
      public_key: generated.publicKey,
      encrypted_private_key,
      retired_rewraps,
      vault: { salt_password: vault.salt_password, salt_recovery: saltRecovery, kdf_iterations: iterations, kdf_algo: vault.kdf_algo ?? "PBKDF2-SHA256", lock_mode: vault.lock_mode ?? "login", phrase_ciphertext, wrapped_deks },
      agent_rewraps,
      expected_generation: activeGeneration,
      expected_vault_version: input.expectedVaultVersion ?? vault.version,
      current_password: await authString(input.password, input.authIterations),
      linked_set: input.linkedDevices.map((d) => d.id),
      reseals,
    },
  };
}
