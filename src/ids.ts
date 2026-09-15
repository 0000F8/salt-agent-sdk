// A Salt record id.
//
// These were integers until salt-api moved every primary key to a uuid, and
// this alias exists so the change is legible rather than looking like a field
// that was always a string. The distinction that matters to code in here: an
// id is now an OPAQUE token. It can be compared and passed along; it cannot be
// parsed, ordered, or done arithmetic to.
//
// The old shape did not fail loudly when it changed. `parseInt(uuid)` is NaN,
// `NaN !== anything` is true and `NaN === anything` is false, so the SDK's
// guards -- do not reply to your own message, do not delegate to yourself --
// silently inverted rather than throwing.

import { randomBytes } from "node:crypto";

export type SaltId = string;

/**
 * Do two ids name the same record?
 *
 * Ids reach this SDK from several places -- a webhook body, a REST response,
 * an env var, a model's tool call -- and only some of them are guaranteed to
 * be canonically cased. Comparing through here rather than with `===` keeps a
 * capitalisation difference from reading as a different record.
 */
export function sameId(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// Crockford's Base32: 0-9 and A-Z minus I, L, O, U (each too easily confused
// with a digit or with each other). Used for ULIDs (see newUlid below), not
// for a SaltId in general -- a Salt record id is whatever salt-api's own
// primary keys are (uuids today; see the header comment), this is only for
// ids this SDK itself mints, such as a Lattice request (lattice.ts).
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_LEN = 10;
const ULID_RANDOM_LEN = 16;

/** Matches a bare ULID: 26 Crockford-Base32 characters, case-insensitively. */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

function encodeUlidTime(time: number): string {
  let remaining = time;
  let out = "";
  for (let i = 0; i < ULID_TIME_LEN; i++) {
    const mod = remaining % CROCKFORD_ALPHABET.length;
    out = CROCKFORD_ALPHABET[mod] + out;
    remaining = (remaining - mod) / CROCKFORD_ALPHABET.length;
  }
  return out;
}

function encodeUlidRandom(): string {
  // 256 is an exact multiple of 32 (the alphabet's length), so `byte % 32`
  // is uniform over the alphabet -- no modulo-bias correction needed.
  const bytes = randomBytes(ULID_RANDOM_LEN);
  let out = "";
  for (let i = 0; i < ULID_RANDOM_LEN; i++) {
    out += CROCKFORD_ALPHABET[bytes[i] % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/**
 * Mints a fresh ULID: a 26-character, lexicographically time-sortable id
 * (a 48-bit millisecond timestamp plus 80 bits of randomness, Crockford-
 * Base32 encoded). A uuid would work just as well as an opaque token, but a
 * ULID sorts by creation time, which suits a disclosure log -- see
 * lattice.ts, whose request/release/proposal ids are ULIDs per
 * ../../salt-lattice/docs/PROTOCOL.md.
 */
export function newUlid(now: number = Date.now()): string {
  return encodeUlidTime(now) + encodeUlidRandom();
}
