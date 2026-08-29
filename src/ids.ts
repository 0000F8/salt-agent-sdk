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
