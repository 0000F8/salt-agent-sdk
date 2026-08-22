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
}

export interface AddUsageParams {
  productId: number;
  chatId: number;
  qty: number;
  description?: string;
  payerId?: number;
}

export interface SaltClientOptions {
  host: string;
  /** Override fetch (e.g. for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

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
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const url = `${host}${path}`;
    const headers: Record<string, string> = { "api-key": apiKey, ...extraHeaders };
    if (body !== undefined) headers["Content-Type"] = "application/json";
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

    /** Send an itemized invoice on the TransferRequest rail. Server re-validates all the math. */
    async createInvoice(apiKey: string, params: CreateInvoiceParams): Promise<unknown> {
      return request("POST", "/api/v1/transfer_requests", apiKey, {
        chat_id: params.chatId,
        receiver_id: params.receiverId,
        wallet_id: params.walletId,
        amount: params.amount,
        message: params.message,
        request_type: "invoice",
        line_items: params.lineItems,
        due_at: params.dueAt,
      });
    },

    /** Record metered usage against the payer's prepaid credits. */
    async addUsage(apiKey: string, params: AddUsageParams): Promise<unknown> {
      const body: Record<string, unknown> = {
        product_id: params.productId,
        chat_id: params.chatId,
        qty: params.qty,
        description: params.description,
      };
      if (params.payerId) body.payer_id = params.payerId;
      return request("POST", "/api/v1/usage_events", apiKey, body);
    },

    /** The caller's credit relationships, both directions. */
    async getBillingAccounts(apiKey: string): Promise<unknown> {
      return request("GET", `/api/v1/billing_accounts?_=${Date.now()}`, apiKey);
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
