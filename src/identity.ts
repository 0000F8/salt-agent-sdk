// Identity on Salt (design-fleet/runs/2026-09-22-identity/plan.md): the
// signed card Salt already serves for agents (A2A AgentCard, 0.72.0) made
// editable, section by section. This is R1 only: `identity.set`/`identity.get`
// on the SDK surface (plan section 7) -- reading/writing an agent's own
// CLAIM sections, and fetching + verifying anyone's signed public card.
// `identity.share` (an E2E slice into a chat) and `onIdentityAsk` are later
// releases, and there is deliberately no `setScope` here at all: scope is
// owner-authenticated through the agent-management API only (an agent may
// state a claim, never decide who else gets to see it).
//
// The card vocabulary is fixed (plan section 9.5 -- "like the Cards block
// vocabulary; a new section is a release"), split into two kinds:
//   - CLAIM sections: the subject's own word about themselves. An agent may
//     set its own claim sections via `identity.set`. Never signed as true --
//     only signed as "this is what they said".
//   - PROOF sections (pgp fingerprint, Salt DID, verified DID, health, trust
//     score, rail address): read-only, computed and signed by Salt itself.
//     No client-side API sets these -- they exist here only so a reader of
//     a fetched card can tell a proof row from a claim row and never launder
//     one as the other (plan section 6: "A proof glyph on a claim row would
//     launder the claim").
//
// Card signing (see salt-api's AgentCardSigner + Jcs + SaltSigningKey,
// read to get these bytes exactly right): a JWS-shaped (RFC 7515)
// signature over the card's own RFC 8785 canonical JSON (JCS), flattened
// without a `payload` field -- the payload IS the card itself, minus
// `signatures`. `canonicalizeJcs` below is a deliberately narrow port of
// salt-api's Jcs.rb: only what an identity card ever contains (nested
// objects/arrays, strings, booleans, null, integers), sorted by UTF-16
// code unit (JS's default string sort already does this for the plain
// ASCII keys a card uses). A float reaching it is a bug in the caller, so
// it throws rather than guessing at a serialization another implementation
// wouldn't match.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";

// --- Section vocabulary --------------------------------------------------

/**
 * The fixed set of CLAIM sections an agent may set about itself via
 * `identity.set` in R1. Per the plan (section 2): "Claim sections (name,
 * bio, link, avatar, category, price, funding disclosure) are editable by
 * their subject." Keyed here the way salt-api's registry names them
 * (snake_case, matching the agent's own existing field names where one
 * already exists -- `display_name`, `message_price` -- rather than the
 * plan's prose shorthand).
 */
export const AGENT_CLAIM_SECTION_KEYS = [
  "display_name",
  "bio",
  "link",
  "avatar",
  "category",
  "message_price",
  "funding_disclosure",
] as const;

export type AgentClaimSectionKey = (typeof AGENT_CLAIM_SECTION_KEYS)[number];

/** What `identity.set` accepts: any subset of the fixed claim vocabulary, each a plain string value. */
export type IdentityClaims = Partial<Record<AgentClaimSectionKey, string>>;

/**
 * The PROOF sections a card or an identity response can carry, for
 * reference -- these are never written through this SDK. Kept here (not
 * just in a comment) so a caller can check `PROOF_SECTION_KEYS.includes(key)`
 * instead of hardcoding the list a second time.
 */
export const PROOF_SECTION_KEYS = [
  "pgp_fingerprint",
  "salt_did",
  "verified_did",
  "health",
  "trust_score",
  "rail_address",
] as const;

export type ProofSectionKey = (typeof PROOF_SECTION_KEYS)[number];

// --- GET /api/v1/identity (the owner's own view, by api-key) ------------

export type IdentitySectionKind = "claim" | "proof";

/**
 * One row of the OWNER's own identity view (`GET /api/v1/identity` /
 * `PATCH /api/v1/identity/sections`) -- richer than what a public card
 * serves, since only the subject (or Salt, for a proof) ever sees `scope`,
 * `editable_by`, `checked_by`.
 */
export interface IdentitySection {
  key: string;
  label: string;
  value: string | null;
  /** "everyone" in R1 -- other scopes (`verified contacts`, `named`, `nobody`) ship in R2. */
  scope: string;
  kind: IdentitySectionKind;
  /** Who may edit this section's value -- null/absent for a proof. */
  editable_by?: string | null;
  /** Who checked and signed this section -- null/absent for a claim. */
  checked_by?: string | null;
}

export interface IdentitySections {
  sections: IdentitySection[];
  /** The public, signed card this identity is served as -- see `card()`. */
  card_url: string;
}

// --- A served public card (GET .../agent-card.json or .../card.json) ----

export interface CardSaltIdentity {
  did?: string;
  pgpFingerprint?: string;
  /** Present only once Salt has actually verified a DIFFERENT, externally-verified identity for the subject. */
  verifiedDid?: string;
}

/**
 * One section as it rides on a PUBLIC signed card: just `{key, value,
 * proof}`. `proof` is `null` for a claim; any other value marks a proof
 * section Salt itself checked and signed ("Checked by Salt.", plan section
 * 6) -- this SDK never inspects what shape a non-null proof takes, since
 * that is Salt's business, not the reader's.
 */
export interface CardSection {
  key: string;
  value: string | null;
  proof: unknown;
}

export interface CardSignatureEntry {
  protected: string;
  signature: string;
}

/**
 * The shape `AgentCardSigner.sign` produces: an A2A AgentCard (or, once
 * `GET /api/v1/users/:username/card.json` ships, the same shape for a
 * person) plus `sections` and, when a signing key is configured,
 * `signatures`. Left open (`[key: string]: unknown`) for every other A2A
 * field (`name`, `description`, `supportedInterfaces`, `capabilities`,
 * `skills`, ...) this module has no reason to type narrowly.
 */
export interface SignedCard {
  saltIdentity?: CardSaltIdentity;
  sections?: CardSection[];
  signatures?: CardSignatureEntry[];
  [key: string]: unknown;
}

/** Thrown by `verifySignedCard` (and so by `client.card()`) for any card whose signature this SDK cannot confirm -- untrusted, tampered, unsigned, or signed by a key this deployment doesn't publish. Never returned as `verified: false`; a card either verifies or this throws. */
export class IdentityCardInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityCardInvalid";
  }
}

/** One entry of the Web Bot Auth key directory (`/.well-known/http-message-signatures-directory`) -- see salt-api's `SaltSigningKey#public_jwk`. */
export interface Ed25519Jwk {
  kty: string;
  crv: string;
  kid?: string;
  x: string;
}

// --- RFC 8785 JCS (narrow port of salt-api's Jcs.rb) ---------------------

export class JcsUnsupportedValueError extends Error {}

/**
 * Canonicalizes `value` exactly the way salt-api's `Jcs.canonicalize` does:
 * object keys sorted by UTF-16 code unit (plain `Array#sort` on strings
 * already does this in JS, matching Ruby's default `String#<=>` for the
 * ASCII-only keys a card uses), no whitespace, integers as bare digits,
 * strings via JSON string escaping, and a hard refusal on anything else
 * (a non-integer number, undefined, a function) rather than guessing at a
 * serialization another implementation wouldn't match.
 */
export function canonicalizeJcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new JcsUnsupportedValueError(`canonicalizeJcs: unsupported non-integer number ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalizeJcs(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJcs(obj[k])}`).join(",") + "}";
  }
  throw new JcsUnsupportedValueError(`canonicalizeJcs: unsupported value of type ${typeof value}`);
}

// --- base64url (no padding), matching SaltSigningKey.b64/unb64 ----------

export function base64urlEncode(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// --- Signature verification ----------------------------------------------

export interface CardSignatureHeader {
  alg?: string;
  kid?: string;
}

/**
 * Parses (never verifies) `card`'s first signature's protected header --
 * just enough to read `kid` without a network round trip. Used by
 * `client.card()` to notice a kid its cached key set doesn't have (Salt
 * rotated its signing key since the last directory fetch) and force one
 * refetch BEFORE spending a verification attempt that would otherwise fail
 * for a perfectly legitimate card. Returns undefined for a card with no
 * signature at all or an unparseable header -- `verifySignedCard` raises
 * the actual, specific error for those cases at verify time; this helper
 * only ever informs a caching decision.
 */
export function parseCardSignatureHeader(card: SignedCard): CardSignatureHeader | undefined {
  const sigEntry = card.signatures?.[0];
  if (!sigEntry?.protected) return undefined;
  try {
    return JSON.parse(base64urlDecode(sigEntry.protected).toString("utf8")) as CardSignatureHeader;
  } catch {
    return undefined;
  }
}

/**
 * Verifies `card`'s first signature against the Web Bot Auth key directory
 * entries in `jwks`, reconstructing the signing input exactly the way
 * `AgentCardSigner.verify` does server-side: `protected_b64` is reused
 * verbatim from the card (never recomputed -- only the payload is), the
 * payload is the JCS canonicalization of the card with `signatures`
 * removed, and the whole thing is Ed25519-verified with no digest
 * (RFC 8032 pure EdDSA, not Ed25519ph).
 *
 * Throws `IdentityCardInvalidError` for every failure mode -- no signature
 * at all, an unparseable protected header, an unsupported algorithm, no
 * matching published key, or a signature that doesn't match -- so a caller
 * never has to remember to check a boolean before trusting the result. This
 * function itself never refetches anything -- see `parseCardSignatureHeader`
 * for the kid-rotation retry, which happens in client.ts BEFORE this is
 * called a second time with a freshened `jwks`.
 */
export function verifySignedCard(card: SignedCard, jwks: Ed25519Jwk[]): void {
  const sigEntry = card.signatures?.[0];
  if (!sigEntry || !sigEntry.protected || !sigEntry.signature) {
    throw new IdentityCardInvalidError(
      "This card carries no signature -- Salt has not signed it (signing may be unconfigured on this deployment, or this isn't really a Salt identity card)."
    );
  }

  const header = parseCardSignatureHeader(card);
  if (!header) {
    throw new IdentityCardInvalidError("This card's signature header could not be parsed.");
  }
  if (header.alg !== "EdDSA") {
    throw new IdentityCardInvalidError(`This card is signed with an unsupported algorithm (${header.alg ?? "none"}); only EdDSA (Ed25519) is trusted.`);
  }

  const key = jwks.find((k) => k.kid === header.kid && k.kty === "OKP" && k.crv === "Ed25519");
  if (!key) {
    throw new IdentityCardInvalidError(`No published Salt key matches this card's signing key id (${header.kid ?? "unknown"}).`);
  }

  const { signatures: _signatures, ...unsigned } = card;
  const payloadB64 = base64urlEncode(Buffer.from(canonicalizeJcs(unsigned), "utf8"));
  const signingInput = Buffer.from(`${sigEntry.protected}.${payloadB64}`, "utf8");
  const signatureBytes = base64urlDecode(sigEntry.signature);

  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
  // No digest -- Ed25519 (pure EdDSA) signs the message directly, mirroring
  // SaltSigningKey#sign/#verify server-side (`@pkey.sign(nil, message)`).
  const ok = cryptoVerify(null, signingInput, publicKey, signatureBytes);
  if (!ok) {
    throw new IdentityCardInvalidError("This card's signature does not match its contents -- it may have been tampered with.");
  }
}
