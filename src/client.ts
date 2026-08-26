// Typed REST client for the Salt platform API (salt-api). Ported from
// salt-claude-agent/src/salt.js, generalized to not depend on a global
// config singleton -- callers construct a client bound to a host, then pass
// each identity's own api-key per call (a process can act as more than one
// Salt agent: the primary identity, plus any it spawns via createAgent).

export interface SaltUser {
  id: number;
  username: string;
  display_name: string;
  account_type: "User" | "Agent";
  public_key?: string;
  public_fingerprint?: string;
  [key: string]: unknown;
}

export interface SaltChat {
  id: number;
  session?: { users?: SaltUser[] };
  messages?: unknown[];
  [key: string]: unknown;
}

export interface CreateAgentParams {
  username: string;
  display_name: string;
  description?: string;
  webhook: string;
  public_key: string;
  private_key: string;
  public_fingerprint: string;
  revocation_cert?: string;
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
  product_id?: number;
}

export interface CreateInvoiceParams {
  chatId: number;
  receiverId: number;
  walletId?: number;
  amount: string | number;
  lineItems: InvoiceLineItem[];
  message?: string;
  dueAt?: string;
  /** See createInvoice's JSDoc for retry/reconciliation semantics. */
  idempotencyKey?: string;
}

export interface AddUsageParams {
  productId: number;
  chatId: number;
  qty: number;
  description?: string;
  payerId?: number;
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
  id: number;
  username: string;
}

/** Only present when the settled transfer paid a TransferRequest (a regular send has no `request`). */
export interface ReceiptRequestSummary {
  id: number;
  request_type: string;
  status: string;
  line_items: InvoiceLineItem[] | null;
}

export interface ReceiptPayload {
  transfer_id: number;
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
  transfer_id: number;
  payload: ReceiptPayload;
  /** SHA-256 over sorted-key canonical JSON of the FULL (unredacted) payload -- still verifiable even when `policy_snapshot` was redacted for this viewer. */
  digest: string;
  created_at: string;
}

export interface BillingAccountParty {
  id: number;
  username: string;
  display_name: string;
  account_type: "User" | "Agent";
}

export interface BillingAccountCreditEntry {
  id: number;
  kind: "deposit" | "usage" | "refund";
  /** HUMAN-DECIMAL string. */
  amount: string;
  qty?: string;
  description?: string;
  created_at: string;
}

/** A pair-scoped prepaid credit relationship: payer deposits with payee, payee's metered usage draws it down. */
export interface BillingAccount {
  id: number;
  payer_id: number;
  payee_id: number;
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
    super(`Salt API ${method} ${url} -> ${status}`);
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

  return {
    /** A chat's members (with public keys), for encrypting a reply to everyone who should read it. */
    async getChatMembers(apiKey: string, chatId: number | string): Promise<SaltUser[]> {
      const chat = await request<SaltChat>("GET", `/api/v1/chats/${chatId}?_=${Date.now()}`, apiKey);
      return chat?.session?.users ?? [];
    },

    /** Recent messages in a chat this identity is a member of (even as a silent observer). */
    async getChatMessages(apiKey: string, chatId: number | string): Promise<unknown[]> {
      const chat = await request<SaltChat>("GET", `/api/v1/chats/${chatId}?_=${Date.now()}`, apiKey);
      return chat?.messages ?? [];
    },

    /** Download an attachment's ciphertext bytes. Decrypt separately (see crypto.ts). */
    async getAttachment(apiKey: string, messageId: number | string): Promise<Buffer> {
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
      chatId: number | string,
      message: string,
      senderMessage?: string,
      delegations?: Array<{ agent_id: number; chat_id: number; username: string }>
    ): Promise<unknown> {
      const body: Record<string, unknown> = { chat_id: chatId, message, sender_message: senderMessage };
      if (delegations && delegations.length > 0) body.delegations = delegations;
      return request("POST", "/api/v1/messages", apiKey, body);
    },

    /** Register a new Salt agent, owned by whoever's api-key calls this. */
    /**
     * The create response carries the new agent's raw api key EXACTLY ONCE --
     * salt-api stores only a digest, so no later endpoint can show it again.
     * Capture `api_key` here; a lost key means rotateAgentApiKey, not re-reading.
     */
    async createAgent(apiKey: string, params: CreateAgentParams): Promise<SaltUser & { api_key?: string }> {
      return request("POST", "/api/v1/agents", apiKey, params);
    },

    /** Owner-only: mint a new api key for an agent. The old one stops working immediately. */
    async rotateAgentApiKey(apiKey: string, agentId: number | string): Promise<{ api_key: string }> {
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
      const res = await request<{ agent_id: number; webhook_secret?: string }>(
        "GET",
        `/api/v1/agents/webhook_secret?_=${Date.now()}`,
        apiKey,
      );
      return res?.webhook_secret;
    },

    /**
     * Owner-only: mint a new webhook signing secret for an agent. The old
     * secret stops verifying immediately, so the agent must re-fetch via
     * getWebhookSecret before it can validate any further deliveries.
     */
    async rotateWebhookSecret(apiKey: string, agentId: number | string): Promise<{ agent_id: number; webhook_secret: string }> {
      return request("POST", `/api/v1/agents/${agentId}/rotate_webhook_secret`, apiKey);
    },

    /**
     * Owner-only agent admin record. `apikey` is metadata (hint, last-used) --
     * the raw key rides only on the createAgent response, and after that only
     * rotateAgentApiKey can produce a usable value.
     */
    async getAgentAdmin(apiKey: string, agentId: number | string): Promise<{ apikey: { token_hint?: string; last_used_at?: string } | null; userkeys: unknown; [key: string]: unknown }> {
      return request("GET", `/api/v1/agents/${agentId}/admin`, apiKey);
    },

    /** The public Agents directory. */
    async listAgents(apiKey: string): Promise<SaltUser[]> {
      return request("GET", "/api/v1/agents", apiKey);
    },

    /** A single agent's directory entry. */
    async getAgent(apiKey: string, agentId: number | string): Promise<SaltUser> {
      return request("GET", `/api/v1/agents/${agentId}`, apiKey);
    },

    /** Create-or-reuse a 1:1 chat with `contactId` -- idempotent on Salt's side. */
    async createOrGetChat(apiKey: string, contactId: number | string): Promise<SaltChat> {
      return request("POST", "/api/v1/chats", apiKey, { contact_id: contactId });
    },

    /** Post a declarative blocks card into a chat (see CARD_PROTOCOL_SPEC.md / cards.ts). */
    async postCard(apiKey: string, chatId: number | string, blocks: CardBlock[], text: string): Promise<unknown> {
      return request("POST", "/api/v1/cards", apiKey, { chat_id: chatId, blocks, text });
    },

    /** Replace an owned card's blocks -- re-broadcasts into everyone's bubble live. */
    async updateCard(apiKey: string, cardId: number | string, blocks: CardBlock[]): Promise<unknown> {
      return request("PATCH", `/api/v1/cards/${cardId}`, apiKey, { blocks });
    },

    // --- Commerce (products, invoices, prepaid credits) ---

    /** My own products (sellerId omitted) or a seller's active products (sellerId given). */
    async listProducts(apiKey: string, sellerId?: number | string): Promise<unknown[]> {
      const path = sellerId ? `/api/v1/products?seller_id=${sellerId}` : "/api/v1/products";
      return request("GET", path, apiKey);
    },

    /** Create a product in the caller's shop. */
    async createProduct(apiKey: string, params: Record<string, unknown>): Promise<unknown> {
      return request("POST", "/api/v1/products", apiKey, params);
    },

    /** Drop one of the caller's products into a chat as a Buy-able bubble. */
    async shareProduct(apiKey: string, productId: number | string, chatId: number | string): Promise<unknown> {
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
    async getSpendingPolicy(apiKey: string, agentId: number | string): Promise<SpendingPolicy> {
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
      agentId: number | string,
      policy: UpdateSpendingPolicyParams
    ): Promise<SpendingPolicy> {
      return request("PUT", `/api/v1/agents/${agentId}/spending_policy`, apiKey, policy);
    },

    /**
     * The settlement record for a transfer the caller was party to (sender
     * or receiver) -- 404 for anyone else, or if the transfer hasn't
     * confirmed on-chain yet (receipts are minted only at confirmation).
     */
    async getReceipt(apiKey: string, transferId: number | string): Promise<Receipt> {
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
      params: { chatId: number | string; payeeId: number | string; amount: string | number }
    ): Promise<{ ok: true; transfer_request_id: number; billing_account: BillingAccount }> {
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
      billingAccountId: number | string,
      params: { amount: string | number; memo?: string }
    ): Promise<{ ok: true; entry_id: number; billing_account: BillingAccount }> {
      return request("POST", `/api/v1/billing_accounts/${billingAccountId}/refund`, apiKey, {
        amount: params.amount,
        memo: params.memo,
      });
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
    async handOff(apiKey: string, chatId: number | string, toAgentId: number | string, reason?: string): Promise<unknown> {
      return request("POST", `/api/v1/chats/${chatId}/hand_off`, apiKey, { to_agent_id: toAgentId, reason });
    },

    /** Ephemeral "is typing" ping. Fire-and-forget by design -- a failed ping must never block a reply. */
    async signalTyping(apiKey: string, chatId: number | string): Promise<void> {
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
