// Typed REST client for the Salt platform API (salt-api). Ported from
// salt-claude-agent/src/salt.js, generalized to not depend on a global
// config singleton -- callers construct a client bound to a host, then pass
// each identity's own api-key per call (a process can act as more than one
// Salt agent: the primary identity, plus any it spawns via createAgent).

import { sameId, type SaltId } from "./ids.js";
import {
  parseCardSignatureHeader,
  verifySignedCard,
  type Ed25519Jwk,
  type IdentityClaims,
  type IdentitySections,
  type SignedCard,
} from "./identity.js";

// --- Identity disclosures (R3, identityShare.ts) --------------------------
//
// The ledger row an E2E slice's `POST .../disclosures` writes: who, which
// section KEYS (never a value -- plan section 4, "A disclosure record
// never stores a value"), which chat, when, revoked or not. A row is keyed
// on (subject, recipient, id) -- identityShare.ts's share() generates ONE
// id per share() call and posts it for EVERY recipient, one row each, so
// the id names the whole share rather than a single recipient's row; the
// same id is what the wire SLICE carries, what a single
// setIdentityDisclosureMessage PATCH reaches every row of, and what a
// single revokeIdentityDisclosure call revokes every row of. `message_id`
// is null until that PATCH lands (the row is written BEFORE the message,
// so a 422 here means nothing was ever sent).

export interface IdentityDisclosure {
  id: string;
  section_keys: string[];
  scope: string;
  chat_id: SaltId;
  recipient_id: SaltId;
  message_id?: SaltId | null;
  created_at: string;
  revoked_at?: string | null;
}

export interface PostIdentityDisclosureParams {
  /** Client-generated (crypto.randomUUID()), ONE per share() call and posted for every recipient -- also what rides in the SLICE/DECLINE wire marker's `id=`. The server keys a row on (subject, recipient, id), so the same id with a DIFFERENT recipient_id creates its own row; the same id AND recipient_id together is idempotent (200 with the existing row instead of a second one). */
  id: string;
  section_keys: string[];
  scope: string;
  chat_id: SaltId;
  recipient_id: SaltId;
}

export interface SaltUser {
  id: SaltId;
  username: string;
  display_name: string;
  account_type: "User" | "Agent";
  public_key?: string;
  public_fingerprint?: string;
  [key: string]: unknown;
}

export interface SaltChat {
  id: SaltId;
  /** `encrypted` is undefined on a server that predates open rooms, which
   *  always means an ordinary end-to-end encrypted chat -- see getChat's
   *  doc comment for the resolved, defaulted value callers actually use. */
  session?: { users?: SaltUser[]; encrypted?: boolean };
  messages?: unknown[];
  [key: string]: unknown;
}

export interface CreateAgentParams {
  username: string;
  display_name: string;
  description?: string;
  webhook: string;
  public_key: string;
  public_fingerprint: string;
  category?: string;
  message_price?: string | number;
  link?: string;
}

export interface CardBlock {
  type: string;
  [key: string]: unknown;
}

export interface InvoiceLineItem {
  name: string;
  qty: number;
  unit_price: string | number;
  subtotal: string | number;
  product_id?: SaltId;
}

export interface CreateInvoiceParams {
  chatId: SaltId;
  receiverId: SaltId;
  walletId?: SaltId;
  amount: string | number;
  lineItems: InvoiceLineItem[];
  message?: string;
  dueAt?: string;
  /** See createInvoice's JSDoc for retry/reconciliation semantics. */
  idempotencyKey?: string;
}

export interface AddUsageParams {
  productId: SaltId;
  chatId: SaltId;
  qty: number;
  description?: string;
  payerId?: SaltId;
  /** See addUsage's JSDoc for retry/reconciliation semantics. */
  idempotencyKey?: string;
}

export interface SaltClientOptions {
  host: string;
  /** Override fetch (e.g. for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** One chain's governed-spend budget, applied over a rolling period. */
export interface SpendingPolicyRule {
  chain: string;
  period: "daily" | "weekly" | "monthly";
  /** HUMAN-DECIMAL string, e.g. "0.5" = half an ETH -- never base units (wei/satoshis). */
  budget_amount: string;
  /** HUMAN-DECIMAL string cap on a single send, if set. */
  per_tx_max?: string;
  /** Server-computed: HUMAN-DECIMAL string already spent in the current period. */
  spent_this_period?: string;
  /** Server-computed: HUMAN-DECIMAL string remaining in the current period. */
  remaining?: string;
}

/**
 * An agent's governed-spend policy, as returned by the API. `frozen: true`
 * blocks every mainnet send regardless of `rules`; an agent with no policy
 * at all is refused by default (salt-api default-denies agent mainnet
 * sends until an owner sets one up) -- see getSpendingPolicy.
 */
export interface SpendingPolicy {
  frozen: boolean;
  rules: SpendingPolicyRule[];
}

/** Payload for updateSpendingPolicy -- same shape as SpendingPolicyRule minus the server-computed fields. */
export interface UpdateSpendingPolicyParams {
  frozen: boolean;
  rules: Array<{
    chain: string;
    period: string;
    /** HUMAN-DECIMAL string, e.g. "0.5" = half an ETH -- never base units. */
    budget_amount: string;
    /** HUMAN-DECIMAL string, if set. */
    per_tx_max?: string;
  }>;
}

export interface ReceiptParty {
  id: SaltId;
  username: string;
}

/** Only present when the settled transfer paid a TransferRequest (a regular send has no `request`). */
export interface ReceiptRequestSummary {
  id: SaltId;
  request_type: string;
  status: string;
  line_items: InvoiceLineItem[] | null;
}

export interface ReceiptPayload {
  transfer_id: SaltId;
  /** HUMAN-DECIMAL string, the declared send amount. */
  amount: string;
  /** HUMAN-DECIMAL string, the value the chain actually moved -- absent until/unless verified; authoritative over `amount` where they disagree. */
  settled_amount?: string;
  chain?: string;
  testnet?: boolean;
  token_contract_address?: string;
  tx_id?: string;
  sender?: ReceiptParty;
  receiver?: ReceiptParty;
  settled_at: string;
  /**
   * The sending agent's budget internals at enforcement time. Redacted
   * (key absent) unless the caller is the sending agent itself or its root
   * human owner -- a counterparty never sees the agent's per-tx/budget
   * limits, only that the send was governed.
   */
  policy_snapshot?: unknown;
  request?: ReceiptRequestSummary;
}

/** A tamper-evident settlement record, minted once a Transfer confirms on-chain. */
export interface Receipt {
  transfer_id: SaltId;
  payload: ReceiptPayload;
  /** SHA-256 over sorted-key canonical JSON of the FULL (unredacted) payload -- still verifiable even when `policy_snapshot` was redacted for this viewer. */
  digest: string;
  created_at: string;
}

export interface BillingAccountParty {
  id: SaltId;
  username: string;
  display_name: string;
  account_type: "User" | "Agent";
}

export interface BillingAccountCreditEntry {
  id: SaltId;
  kind: "deposit" | "usage" | "refund";
  /** HUMAN-DECIMAL string. */
  amount: string;
  qty?: string;
  description?: string;
  created_at: string;
}

/** A pair-scoped prepaid credit relationship: payer deposits with payee, payee's metered usage draws it down. */
export interface BillingAccount {
  id: SaltId;
  payer_id: SaltId;
  payee_id: SaltId;
  payer: BillingAccountParty;
  payee: BillingAccountParty;
  /** HUMAN-DECIMAL string: deposits + refunds - usage. This IS the payer's spend cap on this payee's metered products. */
  balance: string;
  /** Most recent 10 ledger entries, newest first. */
  recent_entries: BillingAccountCreditEntry[];
}

/**
 * Error codes salt-api can return for a governed-spend refusal. These ride
 * in the response body as `{error: string, code: SpendGovernanceCode}` --
 * check `SaltApiError.body.code` rather than parsing `.message`.
 *
 * - `spending_frozen` / `no_spending_policy` -- the agent's policy blocks all sends (see SpendingPolicy).
 * - `per_tx_max_exceeded` / `budget_exceeded` -- the send exceeds a configured rule.
 * - `spend_unconfirmed` -- the agent already has an unconfirmed governed send on this chain; wait for it to confirm, then retry.
 * - `token_sends_ungoverned` / `ungoverned_wallet` -- this send path isn't covered by policy enforcement yet.
 * - `invalid_amount` -- amount wasn't a valid human-decimal string.
 * - `unverifiable_tx` -- the signed transaction couldn't be decoded at all; a governed send must be a standard signed transfer.
 * - `declaration_mismatch` -- the signed transaction's destination, amount, or call data doesn't match what was declared.
 * - `request_in_flight` / `request_failed_terminal` / `idempotency_key_reuse` -- see addUsage's JSDoc (the invoice rail does not implement these -- see createInvoice's JSDoc).
 */
export type SpendGovernanceCode =
  | "spending_frozen"
  | "no_spending_policy"
  | "per_tx_max_exceeded"
  | "budget_exceeded"
  | "spend_unconfirmed"
  | "token_sends_ungoverned"
  | "ungoverned_wallet"
  | "invalid_amount"
  | "unverifiable_tx"
  | "declaration_mismatch"
  | "request_in_flight"
  | "request_failed_terminal"
  | "idempotency_key_reuse";

export class SaltApiError extends Error {
  status: number;
  body: unknown;

  constructor(method: string, url: string, status: number, body: unknown) {
    // Salt's refusals carry one plain sentence ({error: "..."}). Put it in
    // the message: a tool result that says only "-> 422" leaves a model
    // guessing, while "The person has not said anything since the last
    // hand-off. Answer them yourself..." tells it what to do instead.
    const reason = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? `: ${(body as { error: string }).error}` : "";
    super(`Salt API ${method} ${url} -> ${status}${reason}`);
    this.name = "SaltApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Creates a REST client bound to a Salt deployment's host. Every method
 * takes the acting identity's own api-key explicitly rather than a
 * module-level header, since one process can legitimately act as several
 * Salt agents at once.
 */
export function createSaltClient(options: SaltClientOptions) {
  const host = options.host.replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  async function request<T>(
    method: string,
    path: string,
    apiKey: string,
    body?: unknown,
    opts?: { extraHeaders?: Record<string, string>; idempotencyKey?: string }
  ): Promise<T> {
    const url = `${host}${path}`;
    const headers: Record<string, string> = { "api-key": apiKey, ...opts?.extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts?.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const res = await doFetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = await res.text().catch(() => undefined);
      }
      throw new SaltApiError(method, url, res.status, parsed);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async function whoAmI(apiKey: string): Promise<{ agent_id: SaltId; webhook_secret?: string }> {
    // Cache-busted: the answer changes on rotation and on re-keying, and a
    // stale intermediary copy would quietly defeat both.
    return request("GET", `/api/v1/agents/webhook_secret?_=${Date.now()}`, apiKey);
  }

  // Salt's Web Bot Auth signing key(s), published unauthenticated at the
  // domain root (see salt-api's WebBotAuthController) -- the SAME key
  // AgentCardSigner signs cards with. Cached per client instance, honouring
  // the directory's own Cache-Control: max-age (the controller sends 300s;
  // DEFAULT_DIRECTORY_MAX_AGE_MS stands in when the header is absent or
  // unparseable) so a long-lived process doesn't re-fetch on every card()
  // call, but also doesn't hold a stale key set indefinitely. Beyond age-based
  // expiry, card() below also forces a refetch the moment a card names a
  // kid this cache doesn't have -- see its comment for why that matters
  // more than the age check alone (a rotation can land well inside the
  // 5-minute window). A failed fetch never poisons the cache: the in-flight
  // promise is cleared in `finally` so the next call (forced or not) tries again.
  const DEFAULT_DIRECTORY_MAX_AGE_MS = 300_000;
  let signingKeysCache: { keys: Ed25519Jwk[]; fetchedAt: number; maxAgeMs: number } | null = null;
  let signingKeysInFlight: Promise<Ed25519Jwk[]> | null = null;

  function directoryMaxAgeMs(res: { headers?: { get?: (name: string) => string | null | undefined } }): number {
    const raw = res.headers?.get?.("Cache-Control") ?? res.headers?.get?.("cache-control");
    const match = raw ? /max-age=(\d+)/i.exec(raw) : null;
    const seconds = match ? Number(match[1]) : NaN;
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_DIRECTORY_MAX_AGE_MS;
  }

  async function getSigningKeys(opts?: { forceRefresh?: boolean }): Promise<Ed25519Jwk[]> {
    if (opts?.forceRefresh) signingKeysCache = null;
    const stale = !signingKeysCache || Date.now() - signingKeysCache.fetchedAt > signingKeysCache.maxAgeMs;
    if (!stale) return signingKeysCache!.keys;

    if (!signingKeysInFlight) {
      signingKeysInFlight = (async () => {
        const url = `${host}/.well-known/http-message-signatures-directory`;
        const res = await doFetch(url);
        if (!res.ok) throw new SaltApiError("GET", url, res.status, await res.text().catch(() => undefined));
        const body = (await res.json()) as { keys?: Ed25519Jwk[] };
        const keys = body.keys ?? [];
        signingKeysCache = { keys, fetchedAt: Date.now(), maxAgeMs: directoryMaxAgeMs(res) };
        return keys;
      })().finally(() => {
        signingKeysInFlight = null;
      });
    }
    return signingKeysInFlight;
  }

  return {
    /** A chat's members (with public keys), for encrypting a reply to everyone who should read it. */
    async getChatMembers(apiKey: string, chatId: SaltId): Promise<SaltUser[]> {
      const chat = await request<SaltChat>("GET", `/api/v1/chats/${chatId}?_=${Date.now()}`, apiKey);
      return chat?.session?.users ?? [];
    },

    /** Recent messages in a chat this identity is a member of (even as a silent observer). */
    async getChatMessages(apiKey: string, chatId: SaltId): Promise<unknown[]> {
      const chat = await request<SaltChat>("GET", `/api/v1/chats/${chatId}?_=${Date.now()}`, apiKey);
      return chat?.messages ?? [];
    },

    /**
     * One `GET /api/v1/chats/:id` call for a caller that needs BOTH the
     * member list and whether the chat is end-to-end encrypted -- e.g.
     * actions.ts's request_floor, which (unlike delegate_to_agent/
     * consult_agent) has no other reason to fetch the chat at all.
     * `encrypted` is already resolved to a real boolean (defaulted `true`
     * when the field is absent, same convention as ChatOpenedContext.encrypted
     * and MessageContext.encrypted) -- never undefined.
     */
    async getChat(apiKey: string, chatId: SaltId): Promise<{ id: SaltId; encrypted: boolean; users: SaltUser[] }> {
      const chat = await request<SaltChat>("GET", `/api/v1/chats/${chatId}?_=${Date.now()}`, apiKey);
      return { id: chatId, encrypted: chat?.session?.encrypted !== false, users: chat?.session?.users ?? [] };
    },

    /** Download an attachment's ciphertext bytes. Decrypt separately (see crypto.ts). */
    async getAttachment(apiKey: string, messageId: SaltId): Promise<Buffer> {
      const url = `${host}/api/v1/messages/${messageId}/attachment`;
      const res = await doFetch(url, { headers: { "api-key": apiKey } });
      if (!res.ok) throw new SaltApiError("GET", url, res.status, await res.text().catch(() => undefined));
      return Buffer.from(await res.arrayBuffer());
    },

    /**
     * Post a reply into a chat. `message` is the ciphertext every human
     * recipient reads; `senderMessage` is the copy encrypted to the
     * sender's own key. `delegations` (optional) is the provenance trail
     * -- salt-api re-validates every entry against the sender's actual
     * memberships before storing it.
     */
    async postMessage(
      apiKey: string,
      chatId: SaltId,
      message: string,
      senderMessage?: string,
      delegations?: Array<{ agent_id: SaltId; chat_id: SaltId; username: string }>,
      // Who this reply addresses. Salt never sees the plaintext, so an "@handle"
      // written into the body is invisible to it -- these ids are what actually
      // reach the person as a mention notification. Without them a reply can
      // SAY it is addressed to someone and, as far as the server is concerned,
      // be addressed to nobody.
      mentions?: SaltId[],
      // `quiet` (salt-api 0.55.0): no push for this message. Honoured only for
      // an agent posting into a private lane -- a progress report (work.ts) --
      // and silently dropped anywhere else.
      opts?: { quiet?: boolean }
    ): Promise<unknown> {
      const body: Record<string, unknown> = { chat_id: chatId, message, sender_message: senderMessage };
      if (delegations && delegations.length > 0) body.delegations = delegations;
      if (mentions && mentions.length > 0) body.mentions = mentions;
      if (opts?.quiet) body.quiet = true;
      return request("POST", "/api/v1/messages", apiKey, body);
    },

    /**
     * Post into an OPEN ROOM -- a chat with no end-to-end encryption, so
     * `text` rides the wire and is stored as plain text rather than a PGP
     * blob. There is no `senderMessage`/`delegations`/`mentions` shape here
     * the way postMessage has: salt-api refuses this call 422 against a
     * chat that isn't plain (never silently encrypts, never silently
     * drops the call). Webhook/socket deliveries for a plain chat carry
     * `message.encrypted === false` -- see webhook.ts's handleMessage,
     * which hands the body straight through as ctx.text (ctx.encrypted
     * false) instead of attempting PGP decrypt.
     */
    async postPlainMessage(apiKey: string, chatId: SaltId, text: string): Promise<unknown> {
      return request("POST", "/api/v1/messages", apiKey, { chat_id: chatId, message: text });
    },

    /**
     * Open rooms (0.6x): declares what this identity wants delivered from
     * a chat it isn't necessarily addressed in every message of --
     * `"addressed"` (only a direct reply/@mention, the closest analogue to
     * how a normal encrypted chat already gates agent delivery),
     * `"keywords"` (any message containing one of `keywords`), or `"all"`
     * (every message). Always this identity's OWN subscription for
     * `chatId` -- same "acts on the caller, never someone else" shape as
     * setDeliveryMode/setCallback.
     */
    async setChatSubscription(
      apiKey: string,
      chatId: SaltId,
      params: { mode: "addressed" | "keywords" | "all"; keywords?: string[] }
    ): Promise<unknown> {
      const body: Record<string, unknown> = { mode: params.mode };
      if (params.keywords && params.keywords.length > 0) body.keywords = params.keywords;
      return request("PUT", `/api/v1/chats/${chatId}/subscription`, apiKey, body);
    },

    /** Removes this identity's subscription record for `chatId` -- salt-api's
     *  default (unsubscribed) behavior applies again, same as never having
     *  called setChatSubscription. */
    async clearChatSubscription(apiKey: string, chatId: SaltId): Promise<unknown> {
      return request("DELETE", `/api/v1/chats/${chatId}/subscription`, apiKey);
    },

    /**
     * Get-or-create the private lane (a sidechain) between this identity and
     * `withId`, both members of `chatId`. Once per pair on Salt's side. Answers
     * 422 when `chatId` is itself a lane. The lane's members come back with
     * their public keys.
     */
    async openSidechain(
      apiKey: string,
      chatId: SaltId,
      withId: SaltId
    ): Promise<{ session: { id: SaltId; users?: SaltUser[]; coaching_for_chat_id?: SaltId; [key: string]: unknown }; messages?: unknown[] }> {
      return request("POST", `/api/v1/chats/${chatId}/sidechain?_=${Date.now()}`, apiKey, { with_id: withId });
    },

    /**
     * Opens (or reuses) a CONSULT lane between the caller and `withId`, both
     * already members of `roomId` -- mechanically identical to
     * openSidechain (same endpoint, same get-or-create-per-pair semantics),
     * named separately because actions.ts's consult_agent reads more
     * clearly calling "open the lane I'm about to consult in" than a
     * generic sidechain call. salt-api tags the resulting chat
     * `lane_kind: "consult"`, which webhook.ts reads back off the webhook
     * body to raise the agent-to-agent reply cap for that lane and to gate
     * request_floor.
     */
    async openConsultLane(
      apiKey: string,
      roomId: SaltId,
      withId: SaltId
    ): Promise<{ session: { id: SaltId; users?: SaltUser[]; coaching_for_chat_id?: SaltId; lane_kind?: string; [key: string]: unknown }; messages?: unknown[] }> {
      return request("POST", `/api/v1/chats/${roomId}/sidechain?_=${Date.now()}`, apiKey, { with_id: withId });
    },

    /** Register a new Salt agent, owned by whoever's api-key calls this. */
    /**
     * The create response carries the new agent's raw api key EXACTLY ONCE --
     * salt-api stores only a digest, so no later endpoint can show it again.
     * Capture `api_key` here; a lost key means rotateAgentApiKey, not re-reading.
     *
     * Key custody: `CreateAgentParams` deliberately has no `private_key` --
     * salt-api rejects one with a 422 unconditionally (salt-api docs/
     * KEY_CUSTODY.md Phase 5). The key stays with whoever generates it
     * (pgp.generateKeypair, above the call site) and is registered with
     * identities.register/a session store; salt-api never receives a copy in
     * any form it can decrypt, so there is nothing to fetch back later --
     * getAgentAdmin's `userkeys` never carries a usable key either.
     */
    async createAgent(apiKey: string, params: CreateAgentParams): Promise<SaltUser & { api_key?: string }> {
      return request("POST", "/api/v1/agents", apiKey, params);
    },

    /** Owner-only: mint a new api key for an agent. The old one stops working immediately. */
    async rotateAgentApiKey(apiKey: string, agentId: SaltId): Promise<{ api_key: string }> {
      return request("POST", `/api/v1/agents/${agentId}/rotate_api_key`, apiKey);
    },

    /**
     * This identity's own webhook signing key, used to verify that an incoming
     * webhook really came from salt-api.
     *
     * Fetched with the identity's own api key rather than configured from the
     * environment: salt-api mints one secret per agent, so shipping them through
     * env/Secrets Manager would mean the deploy had to know values the API
     * generates. Fetching at boot also means rotation takes effect on restart.
     */
    async getWebhookSecret(apiKey: string): Promise<string | undefined> {
      return (await whoAmI(apiKey))?.webhook_secret;
    },

    /**
     * Which agent does this api key belong to, according to salt-api?
     *
     * The same endpoint as getWebhookSecret: alongside the secret it returns
     * the canonical `agent_id` of the key's owner, which is the id salt-api
     * puts in X-Salt-Agent-Id on every callback. An identity registered under
     * any other id -- an env var, or a store entry that predates an id
     * migration -- can never be found when a webhook arrives; that is what
     * reconcileIdentityIds uses this to detect and repair.
     */
    whoAmI,

    /**
     * Owner-only: mint a new webhook signing secret for an agent. The old
     * secret stops verifying immediately, so the agent must re-fetch via
     * getWebhookSecret before it can validate any further deliveries.
     */
    async rotateWebhookSecret(apiKey: string, agentId: SaltId): Promise<{ agent_id: SaltId; webhook_secret: string }> {
      return request("POST", `/api/v1/agents/${agentId}/rotate_webhook_secret`, apiKey);
    },

    /**
     * K2 socket mode: the caller sets its OWN delivery mode -- "webhook"
     * (the default, POST to its registered callback) or "socket" (drain
     * GET /api/v1/agent/updates or AgentUpdatesChannel instead; see
     * socket.ts's createSocketClient). No id parameter, same reason
     * getWebhookSecret has none -- an agent can only ever change its own.
     * A blank callback is always socket mode regardless of this setting.
     */
    async setDeliveryMode(apiKey: string, mode: "webhook" | "socket"): Promise<{ agent_id: SaltId; delivery_mode: string; socket_mode: boolean }> {
      return request("PATCH", "/api/v1/agents/delivery", apiKey, { mode });
    },

    /**
     * Owner-only agent admin record. `apikey` is metadata (hint, last-used) --
     * the raw key rides only on the createAgent response, and after that only
     * rotateAgentApiKey can produce a usable value.
     */
    async getAgentAdmin(apiKey: string, agentId: SaltId): Promise<{ apikey: { token_hint?: string; last_used_at?: string } | null; userkeys: unknown; [key: string]: unknown }> {
      return request("GET", `/api/v1/agents/${agentId}/admin`, apiKey);
    },

    // --- Identity (identity.ts): this agent's own claim sections + anyone's signed card ---

    /**
     * This agent's own identity: every section (claim and proof) with
     * `scope`/`editable_by`/`checked_by`, plus the public card URL it's
     * served from. Cache-busted like getChatMembers -- a value just set
     * with setIdentity should read back immediately.
     */
    async identity(apiKey: string): Promise<IdentitySections> {
      return request("GET", `/api/v1/identity?_=${Date.now()}`, apiKey);
    },

    /**
     * Set one or more of this agent's own CLAIM sections (see
     * AGENT_CLAIM_SECTION_KEYS). `scope` is never accepted here -- section
     * visibility is owner-authenticated through the agent-management API
     * only (plan section 7: "setScope is never on this surface"), so a
     * caller that tries to slip one in is refused BEFORE any request is
     * made, the same way a bad tool call should fail loud and immediately
     * rather than round-tripping to find out the server also says no.
     * A 422 from salt-api ({errors: {key: "line"}} for an invalid value, or
     * {error: "Scope comes later."} were scope to somehow reach it anyway)
     * surfaces as an ordinary SaltApiError.
     */
    async setIdentity(apiKey: string, claims: IdentityClaims): Promise<IdentitySections> {
      if (claims && Object.prototype.hasOwnProperty.call(claims, "scope")) {
        throw new Error(
          'setIdentity cannot set "scope" -- section visibility is owner-controlled, not agent-controlled, and isn\'t on this SDK surface at all yet.'
        );
      }
      return request("PATCH", "/api/v1/identity/sections", apiKey, claims);
    },

    /**
     * Writes one disclosure ledger row -- metadata only, never a section
     * VALUE (plan section 4). identityShare.ts's share() calls this once
     * per recipient BEFORE sending any ciphertext, with the SAME `id` every
     * time (the row is keyed on subject + recipient + id, so this creates
     * one row per recipient under one shared id), and aborts the whole
     * share on the first refusal (422, one plain sentence -- e.g. a key
     * that isn't actually shared with that recipient) with nothing sent.
     */
    async postIdentityDisclosure(apiKey: string, params: PostIdentityDisclosureParams): Promise<IdentityDisclosure> {
      return request("POST", "/api/v1/identity/disclosures", apiKey, params);
    },

    /**
     * Records which chat message actually carried a share's slice, once
     * it's been posted. Called ONCE per share() call (with the share's one
     * `id`) right after the one encrypted SLICE message goes out
     * (identityShare.ts's share()) -- since every recipient's row shares
     * that id, one PATCH reaches all of them.
     */
    async setIdentityDisclosureMessage(apiKey: string, id: string, messageId: SaltId): Promise<{ disclosures: IdentityDisclosure[] }> {
      return request("PATCH", `/api/v1/identity/disclosures/${id}`, apiKey, { message_id: messageId });
    },

    /** This agent's own disclosure ledger, newest first. */
    async listIdentityDisclosures(apiKey: string, opts?: { before?: string; limit?: number }): Promise<{ disclosures: IdentityDisclosure[] }> {
      const params = new URLSearchParams();
      if (opts?.before) params.set("before", opts.before);
      if (opts?.limit != null) params.set("limit", String(opts.limit));
      params.set("_", String(Date.now()));
      return request("GET", `/api/v1/identity/disclosures?${params.toString()}`, apiKey);
    },

    /**
     * Revokes EVERY ledger row under `id` (every recipient of that share)
     * in one call -- stops them being served again and is the signal
     * identityShare.ts's revoke() sends a `[[SALT-IDENTITY-REVOKE]]` wire
     * marker off of. Cannot reach a message already read; the rows
     * themselves are the only thing this call changes.
     */
    async revokeIdentityDisclosure(apiKey: string, id: string): Promise<{ disclosures: IdentityDisclosure[] }> {
      return request("POST", `/api/v1/identity/disclosures/${id}/revoke`, apiKey);
    },

    /**
     * Fetches a person's or an agent's PUBLICLY SERVED signed card and
     * verifies its signature before returning it -- this is a public,
     * unauthenticated GET (no api-key), matching agent_cards_controller's
     * `skip_before_action :auth_user`. Tries the agent path then the user
     * path unless `opts.kind` says which one. A card whose signature this
     * SDK cannot confirm (missing, unparseable, unknown key, tampered)
     * throws IdentityCardInvalidError rather than ever coming back
     * `verified: false` -- a card either verifies or this call fails.
     */
    async card(handle: string, opts?: { kind?: "agent" | "user" }): Promise<{ card: SignedCard; verified: true }> {
      const clean = String(handle || "")
        .replace(/^@/, "")
        .trim();
      if (!clean) throw new Error("card: handle is required.");

      const attempts: Array<{ url: string }> =
        opts?.kind === "agent"
          ? [{ url: `${host}/api/v1/agents/${encodeURIComponent(clean)}/agent-card.json` }]
          : opts?.kind === "user"
            ? [{ url: `${host}/api/v1/users/${encodeURIComponent(clean)}/card.json` }]
            : [
                { url: `${host}/api/v1/agents/${encodeURIComponent(clean)}/agent-card.json` },
                { url: `${host}/api/v1/users/${encodeURIComponent(clean)}/card.json` },
              ];

      let lastError: unknown;
      for (const attempt of attempts) {
        let res: Awaited<ReturnType<typeof doFetch>>;
        try {
          res = await doFetch(attempt.url);
        } catch (err) {
          lastError = err;
          continue;
        }
        if (res.status === 404) {
          lastError = new SaltApiError("GET", attempt.url, 404, await res.json().catch(() => undefined));
          continue;
        }
        if (!res.ok) {
          throw new SaltApiError("GET", attempt.url, res.status, await res.json().catch(() => undefined));
        }
        const card = (await res.json()) as SignedCard;
        let jwks = await getSigningKeys();
        // A card signed with a kid this cache doesn't have could mean Salt
        // rotated its key since we last fetched the directory (well inside
        // the max-age window, since rotation doesn't wait for a cache to
        // expire) rather than a bad card -- refetch once before deciding.
        // Never retried for any OTHER verification failure (bad signature,
        // unparseable header, unsupported alg): those can't be fixed by a
        // fresher key set, so they fail immediately.
        const header = parseCardSignatureHeader(card);
        if (header?.kid && !jwks.some((k) => k.kid === header.kid)) {
          jwks = await getSigningKeys({ forceRefresh: true });
        }
        verifySignedCard(card, jwks); // throws IdentityCardInvalidError on any failure
        return { card, verified: true };
      }
      throw lastError ?? new SaltApiError("GET", attempts[attempts.length - 1].url, 404, undefined);
    },

    /** The public Agents directory. */
    async listAgents(apiKey: string): Promise<SaltUser[]> {
      return request("GET", "/api/v1/agents", apiKey);
    },

    /** A single agent's directory entry. */
    async getAgent(apiKey: string, agentId: SaltId): Promise<SaltUser> {
      return request("GET", `/api/v1/agents/${agentId}`, apiKey);
    },

    /** Create-or-reuse a 1:1 chat with `contactId` -- idempotent on Salt's side. */
    async createOrGetChat(apiKey: string, contactId: SaltId): Promise<SaltChat> {
      return request("POST", "/api/v1/chats", apiKey, { contact_id: contactId });
    },

    /** Post a declarative blocks card into a chat (see CARD_PROTOCOL_SPEC.md / cards.ts). */
    async postCard(apiKey: string, chatId: SaltId, blocks: CardBlock[], text: string): Promise<unknown> {
      return request("POST", "/api/v1/cards", apiKey, { chat_id: chatId, blocks, text });
    },

    /** Replace an owned card's blocks -- re-broadcasts into everyone's bubble live. */
    async updateCard(apiKey: string, cardId: SaltId, blocks: CardBlock[]): Promise<unknown> {
      return request("PATCH", `/api/v1/cards/${cardId}`, apiKey, { blocks });
    },

    // --- Commerce (products, invoices, prepaid credits) ---

    /** My own products (sellerId omitted) or a seller's active products (sellerId given). */
    async listProducts(apiKey: string, sellerId?: SaltId): Promise<unknown[]> {
      const path = sellerId ? `/api/v1/products?seller_id=${sellerId}` : "/api/v1/products";
      return request("GET", path, apiKey);
    },

    /** Create a product in the caller's shop. */
    async createProduct(apiKey: string, params: Record<string, unknown>): Promise<unknown> {
      return request("POST", "/api/v1/products", apiKey, params);
    },

    /** Drop one of the caller's products into a chat as a Buy-able bubble. */
    async shareProduct(apiKey: string, productId: SaltId, chatId: SaltId): Promise<unknown> {
      return request("POST", `/api/v1/products/${productId}/share`, apiKey, { chat_id: chatId });
    },

    /**
     * Send an itemized invoice on the TransferRequest rail. Server
     * re-validates all the math.
     *
     * `idempotencyKey` is sent as an `Idempotency-Key` header, but
     * `transfer_requests_controller` does NOT include salt-api's `Idempotent`
     * concern (unlike addUsage/createTransfer paths) -- the server currently
     * ignores it entirely. A retried call with the same key still creates a
     * second invoice; there is no dedup, no replay, and none of the 409
     * `request_in_flight` / `request_failed_terminal` behavior described for
     * addUsage applies here. Retries of createInvoice are the caller's own
     * responsibility to guard against for now.
     */
    async createInvoice(apiKey: string, params: CreateInvoiceParams): Promise<unknown> {
      return request(
        "POST",
        "/api/v1/transfer_requests",
        apiKey,
        {
          chat_id: params.chatId,
          receiver_id: params.receiverId,
          wallet_id: params.walletId,
          amount: params.amount,
          message: params.message,
          request_type: "invoice",
          line_items: params.lineItems,
          due_at: params.dueAt,
        },
        { idempotencyKey: params.idempotencyKey }
      );
    },

    /**
     * Record metered usage against the payer's prepaid credits.
     *
     * Pass `idempotencyKey` to make a retried call safe -- a replayed
     * response carries the `Idempotency-Replayed: true` header. A 409
     * `request_in_flight` means an earlier call with the same key is still
     * being processed: retry with a NEW key. A 409 `request_failed_terminal`
     * means the usage/debit side-effect already happened under that key --
     * do NOT retry with a new key (that would double-charge); reconcile
     * against the existing usage event instead.
     */
    async addUsage(apiKey: string, params: AddUsageParams): Promise<unknown> {
      const body: Record<string, unknown> = {
        product_id: params.productId,
        chat_id: params.chatId,
        qty: params.qty,
        description: params.description,
      };
      if (params.payerId) body.payer_id = params.payerId;
      return request("POST", "/api/v1/usage_events", apiKey, body, { idempotencyKey: params.idempotencyKey });
    },

    // --- Spending policy (governed agent mainnet sends) ---

    /**
     * Owner-only: an agent's governed-spend policy. Call with the OWNER's
     * api-key/JWT, not the agent's own key.
     *
     * Rule amounts (`budget_amount`, `per_tx_max`, `spent_this_period`,
     * `remaining`) are all HUMAN-DECIMAL strings, e.g. "0.5" = half an ETH --
     * never base units (wei/satoshis).
     *
     * If the agent has no policy at all, salt-api default-denies every
     * mainnet send from it -- an owner must call updateSpendingPolicy at
     * least once before the agent can move mainnet funds.
     */
    async getSpendingPolicy(apiKey: string, agentId: SaltId): Promise<SpendingPolicy> {
      return request("GET", `/api/v1/agents/${agentId}/spending_policy`, apiKey);
    },

    /**
     * Owner-only: replace an agent's governed-spend policy. Call with the
     * OWNER's api-key/JWT, not the agent's own key.
     *
     * `rules[].budget_amount` and `rules[].per_tx_max` are HUMAN-DECIMAL
     * strings, e.g. "0.5" = half an ETH -- never base units. `frozen: true`
     * blocks all mainnet sends regardless of `rules`. Governed-spend
     * refusals from this or any subsequent send carry `{error, code}`
     * bodies -- see SpendGovernanceCode.
     */
    async updateSpendingPolicy(
      apiKey: string,
      agentId: SaltId,
      policy: UpdateSpendingPolicyParams
    ): Promise<SpendingPolicy> {
      return request("PUT", `/api/v1/agents/${agentId}/spending_policy`, apiKey, policy);
    },

    /**
     * The settlement record for a transfer the caller was party to (sender
     * or receiver) -- 404 for anyone else, or if the transfer hasn't
     * confirmed on-chain yet (receipts are minted only at confirmation).
     */
    async getReceipt(apiKey: string, transferId: SaltId): Promise<Receipt> {
      return request("GET", `/api/v1/receipts/${transferId}`, apiKey);
    },

    /** The caller's credit relationships, both directions. */
    async getBillingAccounts(apiKey: string): Promise<unknown> {
      return request("GET", `/api/v1/billing_accounts?_=${Date.now()}`, apiKey);
    },

    /**
     * Payer-initiated deposit: drops a "Credits top-up" invoice into
     * `chatId` for `payeeId` to receive. Nothing is credited by this call
     * itself -- the deposit lands only once that invoice is paid (see
     * onInvoicePaid's `isTopUp`).
     */
    async topUpBillingAccount(
      apiKey: string,
      params: { chatId: SaltId; payeeId: SaltId; amount: string | number }
    ): Promise<{ ok: true; transfer_request_id: SaltId; billing_account: BillingAccount }> {
      return request("POST", "/api/v1/billing_accounts/top_up", apiKey, {
        chat_id: params.chatId,
        payee_id: params.payeeId,
        amount: params.amount,
      });
    },

    /**
     * Payee-only: return value onto the credits ledger. Capped at net usage
     * (Σusage - Σrefunds) so a refund can only give back credits that were
     * actually consumed -- it can never mint new balance. A 422
     * `refund_exceeds_usage` means `amount` is above what's currently
     * refundable. This is a ledger entry, not an on-chain transfer -- no
     * Receipt is minted for it.
     */
    async refundBillingAccount(
      apiKey: string,
      billingAccountId: SaltId,
      params: { amount: string | number; memo?: string }
    ): Promise<{ ok: true; entry_id: SaltId; billing_account: BillingAccount }> {
      return request("POST", `/api/v1/billing_accounts/${billingAccountId}/refund`, apiKey, {
        amount: params.amount,
        memo: params.memo,
      });
    },

    /**
     * A transfer's current record, to verify a payment actually confirmed
     * before an agent claims money work "done" (see actions.ts's
     * report_progress evidence check). Status is one of "Pending" |
     * "Confirmed" | "Failed" (Transfer#status in salt-api's
     * app/models/transfer.rb) -- "Confirmed" is the only settled state.
     *
     * NOTE: as of this SDK version salt-api's TransfersController defines
     * no `show` action (only index, create, and the :id/info member
     * route) -- this call requires that route added server-side in the
     * same release this evidence check ships in.
     */
    async getTransfer(apiKey: string, transferId: SaltId): Promise<{ id: SaltId; status: string; [key: string]: unknown }> {
      return request("GET", `/api/v1/transfers/${transferId}`, apiKey);
    },

    /** The caller's own wallets. */
    async listWallets(apiKey: string): Promise<unknown[]> {
      return request("GET", "/api/v1/wallets", apiKey);
    },

    /** Upload an already-encrypted wallet under the caller's own identity (see crypto.ts). */
    async createWallet(apiKey: string, params: Record<string, unknown>): Promise<unknown> {
      return request("POST", "/api/v1/wallets", apiKey, params);
    },

    /** Hand a chat off to another agent; salt-api does the whole swap atomically. */
    async handOff(apiKey: string, chatId: SaltId, toAgentId: SaltId, reason?: string): Promise<unknown> {
      return request("POST", `/api/v1/chats/${chatId}/hand_off`, apiKey, { to_agent_id: toAgentId, reason });
    },

    /**
     * One step back: return the chat to whoever handed it TO the current
     * active agent most recently (a real hop off the trail, not a fixed
     * destination) -- salt-api's `Chat#hand_off_back!`. 422 with "Already
     * at the start of this conversation." when there's no previous hop;
     * callers (actions.ts's hand_back_to_concierge) fall back to something
     * fixed in that case. The acting agent must currently be this chat's
     * active agent (or a human member) -- salt-api's `gacm_actor_allowed?`.
     */
    async handBack(apiKey: string, chatId: SaltId): Promise<unknown> {
      return request("POST", `/api/v1/chats/${chatId}/hand_off/back`, apiKey);
    },

    /** Ephemeral "is typing" ping. Fire-and-forget by design -- a failed ping must never block a reply. */
    async signalTyping(apiKey: string, chatId: SaltId): Promise<void> {
      try {
        await request("POST", `/api/v1/chats/${chatId}/typing`, apiKey, {});
      } catch {
        // non-fatal by design
      }
    },

    /**
     * Fire-and-forget product-metrics beacon. Deliberately not awaited by
     * callers -- an analytics post must never delay or fail a reply. Only
     * names in salt-api's Event::CLIENT_EVENT_NAMES allowlist are accepted.
     */
    trackEvent(apiKey: string, name: string, properties: Record<string, unknown> = {}): void {
      request("POST", "/api/v1/events", apiKey, { name, properties }).catch(() => {});
    },
  };
}

export type SaltClient = ReturnType<typeof createSaltClient>;
