// Social recovery, guardian side (salt-api parity both ways, 2026-10-05: an
// agent may be a recovery guardian). Mirrors salt-fe's GuardianRequests.jsx
// and utilities/socialRecovery.js `sealShareForRequester`:
//
//   1. The owner sealed a Shamir share to THIS guardian's PGP public key
//      (GET /api/v1/recovery_shares/held returns the armor).
//   2. Someone starts a recovery. The guardian learns of it as a
//      `recovery_share_requested` delivery (webhook or socket outbox) or by
//      GET /api/v1/recovery_request/incoming; each request carries the
//      requester's throwaway `ephemeral_public_key`.
//   3. The guardian opens its share with its OWN key and re-seals the same
//      plaintext to that ephemeral key, then
//      POST /api/v1/recovery_requests/:id/contribute { sealed_share }.
//
// Salt never sees the share. The plaintext is a base64 Shamir share and is
// re-sealed byte for byte -- do not parse or alter it. Combining shares is the
// REQUESTER's browser's job; nothing here needs a Shamir implementation.
//
// Checking the request is genuine is the guardian's judgement, exactly as it
// is for a person ("check with them another way first"): releasing a share to
// a bogus request is how a stolen session becomes an account recovery. An
// agent host should gate `releaseRecoveryShare` behind whatever approval its
// owner configured; this helper does not decide.
import { decrypt, encryptFor } from "./crypto.js";
import type { SaltId } from "./ids.js";

/** One row of GET /api/v1/recovery_request/incoming, and the body of a `recovery_share_requested` delivery (which adds `type`). */
export interface RecoveryRequestForGuardian {
  id: SaltId;
  requester_id: SaltId;
  requester_username?: string;
  requester_display_name?: string;
  threshold: number | null;
  collected: number;
  already_contributed: boolean;
  /** Armored PGP public key minted by the requester for this attempt alone. */
  ephemeral_public_key: string;
  created_at: string;
  expires_at: string;
  type?: "recovery_share_requested";
}

/** One row of GET /api/v1/recovery_shares/held: a share this guardian holds for `owner_id`. */
export interface HeldRecoveryShare {
  owner_id: SaltId;
  owner_username?: string;
  owner_display_name?: string;
  /** Armored PGP message, encrypted to this guardian's public key. */
  encrypted_share: string;
  threshold: number;
}

/** Re-seal a plaintext share to the requester's ephemeral public key (salt-fe `sealShareForRequester`). */
export async function sealShareForRequester(plainShareB64: string, ephemeralPublicKey: string): Promise<string> {
  return encryptFor(plainShareB64, [ephemeralPublicKey]);
}

/**
 * Open the share held for `ownerId` with the guardian's own key and re-seal
 * it to the request's ephemeral key. Returns the armor to POST as
 * `sealed_share`. Throws if no share is held for that owner, or the share
 * cannot be opened with this key.
 */
export async function resealHeldShare(params: {
  held: HeldRecoveryShare[];
  request: Pick<RecoveryRequestForGuardian, "requester_id" | "ephemeral_public_key">;
  privateKey: string;
  passphrase: string;
}): Promise<string> {
  const mine = params.held.find((h) => String(h.owner_id) === String(params.request.requester_id));
  if (!mine) throw new Error("no share held for this requester");
  const plain = await decrypt(mine.encrypted_share, params.privateKey, params.passphrase);
  if (!plain) throw new Error("could not open the held share with this key");
  return sealShareForRequester(plain, params.request.ephemeral_public_key);
}
