// The Calls v1 crypto binding (salt-api CALL_PROTOCOL_SPEC.md section 4), ported from salt-fe's
// src/utilities/callCrypto.js and the bundle builders in src/utilities/webrtc.js. Byte-compatible:
// a bundle this module signs and encrypts is read by salt-fe's decryptAndVerify, and the other way
// round (tests/call-bundle.test.js proves both against a fixture generated from salt-fe itself).
//
// The signed-then-encrypted offer/answer bundle is
//   { v, call_id, kind, sdp, dtls_fingerprints, ts, nonce }
// (a renegotiation adds `sdp_type`; a trickle-ICE batch is { v, call_id, candidates, ts, nonce }).
// The sender SIGNS it with their own PGP private key and ENCRYPTS it to the peer's public key in one
// openpgp call. That closes the hole WebRTC leaves open: a signaling server substituting its own SDP
// to sit in the media path. Salt relays the opaque armored `payload` and never reads it.
//
// Pure crypto and string handling: no network, no WebRTC. Used by the device (it answers a watch call
// with a signed bundle to the caller) and by any agent that places or receives calls.

import { randomBytes } from "node:crypto";
import * as openpgp from "openpgp";

export const CALL_BUNDLE_VERSION = 1;

/** Reject a bundle whose `ts` has drifted more than this from wall-clock. */
export const TS_SKEW_MS = 5 * 60 * 1000;

/** A legacy server-custody private key is still armored under this constant passphrase. */
export const LEGACY_KEY_PASSPHRASE = "salt";

export interface CallBundle {
  v: number;
  call_id: string;
  kind: string;
  /** Present on a mid-call renegotiation only. */
  sdp_type?: "offer" | "answer";
  sdp: string;
  dtls_fingerprints: string[];
  /** Unix SECONDS (not milliseconds). */
  ts: number;
  nonce: string;
  [key: string]: unknown;
}

/** A trickle-ICE batch, signed and encrypted like an offer. */
export interface CallSignalBundle {
  v: number;
  call_id: string;
  candidates: unknown[];
  ts: number;
  nonce: string;
  [key: string]: unknown;
}

// Accepts a vault-issued key (already decrypted: no passphrase) or a legacy key armored under the
// passphrase (salt-fe's constant "salt" unless one is given).
async function unlockPrivateKey(armoredPrivateKey: string, passphrase: string = LEGACY_KEY_PASSPHRASE): Promise<openpgp.PrivateKey> {
  const key = await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey });
  if (key.isDecrypted()) return key;
  return openpgp.decryptKey({ privateKey: key, passphrase });
}

/** A 128-bit random nonce, hex (section 4's bundle shape). */
export function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

/** Build the plaintext offer/answer bundle. `dtls_fingerprints` is always derived from `sdp` itself,
 *  never supplied: pinning only means something if the fingerprints are the ones in the SDP being sent.
 *  `ts` is unix seconds. Throws when the SDP carries no `a=fingerprint:` line. */
export function buildCallBundle(p: {
  callId: string;
  kind: string;
  sdp: string;
  sdpType?: "offer" | "answer";
  ts?: number;
  nonce?: string;
}): CallBundle {
  const dtls_fingerprints = parseSdpFingerprints(p.sdp);
  if (dtls_fingerprints.length === 0) throw new Error("sdp carries no a=fingerprint lines to bind");
  const bundle: CallBundle = {
    v: CALL_BUNDLE_VERSION,
    call_id: p.callId,
    kind: p.kind,
    ...(p.sdpType !== undefined ? { sdp_type: p.sdpType } : {}),
    sdp: p.sdp,
    dtls_fingerprints,
    ts: p.ts ?? Math.floor(Date.now() / 1000),
    nonce: p.nonce ?? randomNonce(),
  };
  return bundle;
}

/** Build the plaintext trickle-ICE bundle. */
export function buildSignalBundle(p: { callId: string; candidates: unknown[]; ts?: number; nonce?: string }): CallSignalBundle {
  return {
    v: CALL_BUNDLE_VERSION,
    call_id: p.callId,
    candidates: p.candidates,
    ts: p.ts ?? Math.floor(Date.now() / 1000),
    nonce: p.nonce ?? randomNonce(),
  };
}

/** Sign `bundle` with the sender's private key and encrypt the result to the receiver's public key.
 *  Returns armored ciphertext, ready for the opaque `payload` field of POST /api/v1/calls (or /answer,
 *  /signal). `passphrase` only matters for a legacy key that is still locked (default "salt"). */
export async function signAndEncrypt(p: {
  bundle: CallBundle | CallSignalBundle | Record<string, unknown>;
  signingPrivateKey: string;
  receiverPublicKey: string;
  passphrase?: string;
}): Promise<string> {
  const privateKey = await unlockPrivateKey(p.signingPrivateKey, p.passphrase);
  const publicKey = await openpgp.readKey({ armoredKey: p.receiverPublicKey });
  const message = await openpgp.createMessage({ text: JSON.stringify(p.bundle) });
  return (await openpgp.encrypt({ message, encryptionKeys: publicKey, signingKeys: privateKey })) as string;
}

/** Decrypt an armored bundle and check its signature against the SENDER's public key (never a key
 *  embedded in the message). Never throws for an ordinary crypto failure (corrupted payload, a signature
 *  from the wrong key): those come back as `{ bundle: null, signatureValid: false }` so callers fail
 *  closed. A bundle that decrypts but is not JSON is the same. */
export async function decryptAndVerify(p: {
  armored: string;
  decryptionPrivateKey: string;
  senderPublicKey: string;
  passphrase?: string;
}): Promise<{ bundle: Record<string, any> | null; signatureValid: boolean }> {
  try {
    const privateKey = await unlockPrivateKey(p.decryptionPrivateKey, p.passphrase);
    const publicKey = await openpgp.readKey({ armoredKey: p.senderPublicKey });
    const message = await openpgp.readMessage({ armoredMessage: p.armored });
    const { data, signatures } = await openpgp.decrypt({
      message,
      decryptionKeys: privateKey,
      verificationKeys: publicKey,
      expectSigned: false, // the signatures are inspected below
    });

    let signatureValid = false;
    if (signatures && signatures.length > 0) {
      try {
        await signatures[0].verified;
        signatureValid = true;
      } catch {
        signatureValid = false;
      }
    }

    let bundle: Record<string, any> | null = null;
    try {
      bundle = JSON.parse(data as string);
    } catch {
      return { bundle: null, signatureValid: false };
    }
    return { bundle, signatureValid };
  } catch {
    return { bundle: null, signatureValid: false };
  }
}

/** Section 4's replay half: `call_id` and `ts` bind the bundle to THIS call. No crypto here. `ts` is
 *  unix SECONDS and must be within 5 minutes of `now` (milliseconds, default the wall clock); when
 *  `expectedCallId` is given the bundle's `call_id` must equal it. */
export function isBundleFresh(p: { bundle: Record<string, any> | null | undefined; expectedCallId?: string; now?: number }): boolean {
  const { bundle, expectedCallId } = p;
  const now = p.now ?? Date.now();
  if (!bundle) return false;
  if (expectedCallId && bundle.call_id !== expectedCallId) return false;
  if (typeof bundle.ts !== "number") return false;
  return Math.abs(now - bundle.ts * 1000) <= TS_SKEW_MS;
}

function normalizeFingerprint(fp: unknown): string {
  return String(fp ?? "").trim().toUpperCase().replace(/\s+/g, " ");
}

/** Every `a=fingerprint:<algo> <hex>` line of an SDP, normalised (trimmed, upper-cased, whitespace
 *  collapsed): `"SHA-256 AB:CD:..."`. Accepts CRLF or LF line ends. */
export function parseSdpFingerprints(sdp: string): string[] {
  return Array.from(String(sdp || "").matchAll(/^a=fingerprint:(.+)$/gim)).map((m) => normalizeFingerprint(m[1]));
}

/** Section 4's pin: every fingerprint in the SDP being applied must be one the signed bundle carries
 *  (case and whitespace insensitive). False when either side has none. A mismatch means: hang up with
 *  reason `error`, do not apply the SDP. */
export function fingerprintsMatch(signed: string[] | null | undefined, actualSdp: string): boolean {
  const signedSet = new Set((signed || []).map(normalizeFingerprint));
  const actual = parseSdpFingerprints(actualSdp);
  if (actual.length === 0 || signedSet.size === 0) return false;
  return actual.every((fp) => signedSet.has(fp));
}

/** The verified badge: only when the signing key's own fingerprint matches the stored public key. */
export async function senderKeyMatchesContact(p: { senderPublicKey: string; contactPublicKey: string }): Promise<boolean> {
  if (!p.senderPublicKey || !p.contactPublicKey) return false;
  try {
    const [a, b] = await Promise.all([openpgp.readKey({ armoredKey: p.senderPublicKey }), openpgp.readKey({ armoredKey: p.contactPublicKey })]);
    return a.getFingerprint().toUpperCase() === b.getFingerprint().toUpperCase();
  } catch {
    return false;
  }
}
