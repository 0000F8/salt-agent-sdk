// Re-key hosted identities to the ids salt-api actually uses for them.
//
// Every webhook is routed by Salt id: salt-api puts `agent.id` in
// X-Salt-Agent-Id and the server finds the signing key with
// `identities.get(thatId)`. The store, though, holds whatever id was current
// when the identity was REGISTERED -- an env var, a create response -- and
// nothing ever revisited it. When salt-api moved every primary key to a uuid
// (Sep 2026) each hosted identity kept its integer id on disk, every lookup
// missed, and every message to those agents was rejected as "no signing key"
// while health checks stayed green: the dot reports liveness, not delivery.
//
// So the stored id is a hint and the API is the truth. An api key belongs to
// exactly one agent, and GET /agents/webhook_secret answers with that agent's
// canonical id, so confirming an identity is one call. Run this at boot before
// serving; createWebhookServer also runs it when a lookup misses, so an id
// change while the process is up heals on the first affected delivery instead
// of waiting for a restart.

import type { SaltClient } from "./client";
import type { IdentityStore } from "./identities";
import { sameId, type SaltId } from "./ids.js";

export interface ReconcileLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
}

export interface ReconcileResult {
  /** Identities whose stored id already matched what salt-api reports. */
  unchanged: number;
  /** Identities moved to the id salt-api reports for their api key. */
  reassigned: Array<{ username: string; from: SaltId; to: SaltId }>;
  /** Identities left exactly as they were because the API could not be asked. */
  failed: Array<{ username: string; saltAppId: SaltId; error: string }>;
}

export async function reconcileIdentityIds(
  store: IdentityStore,
  client: Pick<SaltClient, "whoAmI">,
  logger: ReconcileLogger = { info: console.log, error: console.error },
): Promise<ReconcileResult> {
  const result: ReconcileResult = { unchanged: 0, reassigned: [], failed: [] };

  // all() is a snapshot, so re-keying inside the loop is safe.
  for (const identity of store.all()) {
    const label = identity.username || String(identity.saltAppId);

    let canonical: SaltId | undefined;
    let failure: string | undefined;
    try {
      canonical = (await client.whoAmI(identity.apiKey)).agent_id;
      if (!canonical) failure = "no agent_id in the response";
    } catch (err) {
      failure = (err as Error).message;
    }
    if (failure !== undefined || !canonical) {
      // A revoked key or an unreachable API is not a reason to touch the
      // store. The identity stays exactly as it is; deleting or guessing here
      // would turn a transient outage into lost keys.
      const error = failure ?? "no agent_id in the response";
      result.failed.push({ username: label, saltAppId: identity.saltAppId, error });
      logger.error(`[identities] could not confirm the id of ${label} (${identity.saltAppId}): ${error}`);
      continue;
    }

    if (sameId(canonical, identity.saltAppId)) {
      result.unchanged += 1;
      continue;
    }

    const from = identity.saltAppId;
    const alreadyRegistered = store.get(canonical) !== undefined;
    store.reassignId(from, canonical);
    result.reassigned.push({ username: label, from, to: canonical });
    logger.info(
      alreadyRegistered
        ? `[identities] ${label}: dropped the stale entry under ${from}; already registered as ${canonical}`
        : `[identities] ${label}: re-keyed ${from} -> ${canonical}`,
    );
  }

  return result;
}
