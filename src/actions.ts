// Generic executor functions for every Salt-platform action a hosted agent
// might take (spawning agents, delegation, cards, commerce, wallets,
// hand-offs), packaged as {name, description, schema, execute} tuples with
// PLAIN JSON Schema -- not any one provider's tool-calling wrapper shape.
// Use toAnthropicTools()/toOpenAITools() to adapt for a specific model API.
//
// Ported from salt-claude-agent/src/tools.js. What's NOT here: the
// THINKING_MARKER_RE stripping (Claude-specific wire convention -- exposed
// instead as an optional `replyTransform` hook) and WEB_SEARCH_TOOL
// (Anthropic's native server tool, not something this code executes at
// all -- stays in the reference implementation's own tool list).

import { randomUUID } from "node:crypto";
import { ethers } from "ethers";
import type { SaltClient } from "./client";
import * as pgp from "./crypto";
import { encryptWalletPayload } from "./crypto";
import * as delegations from "./delegations";
import type { AgentIdentity, IdentityStore } from "./identities";

export type JsonSchema = Record<string, unknown>;

export interface ActionContext {
  /** Delegation hop depth of the message this action is being taken in service of (0 for a direct turn). */
  depth: number;
  /** The chat this action should act on, or null when not currently replying in a chat (e.g. a background job). */
  mainChatId: number | null;
}

export interface ActionDefinition<TInput = any, TOutput = any> {
  name: string;
  description: string;
  /** Plain JSON Schema for the action's input -- adapt with toAnthropicTools/toOpenAITools for a specific provider. */
  schema: JsonSchema;
  execute: (caller: AgentIdentity, input: TInput, ctx: ActionContext) => Promise<TOutput>;
}

export interface ActionsOptions {
  client: SaltClient;
  identities: IdentityStore;
  pgpPassphrase: string;
  /** This process's own webhook URL, given to any agent created via create_salt_agent. */
  publicWebhookUrl: string;
  /** Enables create_wallet / create_salt_agent's auto-provisioned wallet. Omit to disable both. */
  walletMasterKey?: string;
  /** Enables hand_back_to_concierge -- the id of this process's configured "front door" agent. */
  globalAgentId?: number;
  /**
   * Applied to a delegate_to_agent reply before it's handed back as the
   * tool result. Salt itself has no opinion on reply framing; this exists
   * because salt-claude-agent's replies can carry a [[SALT-THINKING]]...
   * [[/SALT-THINKING]] wire marker that's a UI hint for salt-fe, not
   * conversational content, and would otherwise leak into the calling
   * agent's own context. Defaults to a no-op.
   */
  replyTransform?: (text: string) => string;
}

// Shared block-vocabulary schema, so both card tools teach the model the
// same shape the server enforces (Card model validation in salt-api).
const BLOCKS_SCHEMA: JsonSchema = {
  type: "array",
  description:
    "1-20 blocks. Types: " +
    '{type:"section", text?:"markdown <=2000", fields?:[{label:"<=40",value:"<=160"}] (<=10)} | ' +
    '{type:"divider"} | ' +
    '{type:"image", url:"http(s) <=500", alt?} | ' +
    '{type:"actions", elements:[1-5 of {type:"button", action_id:"a-z0-9_- <=40, unique", label:"<=40", ' +
    'style?:"primary"|"danger", action_type?:"default"|"pay", pay?:{amount:"base units string", currency}, ' +
    'restricted_to?:[user_id,...] (<=20, must be real members of this chat)}]}. ' +
    "Buttons with action_type 'pay' become real Salt payment requests handled by the app itself; " +
    "all other buttons come back as card_interaction events. Every chat member can tap a button by " +
    "default -- set restricted_to on any button that shouldn't be that open (delete, restart, admin " +
    "actions, a purchase meant for one specific person). Everyone still sees the button; anyone not " +
    "on the list sees it locked and can't invoke it, server-enforced.",
  items: { type: "object" },
};

/**
 * Builds the full set of Salt-platform actions bound to one client +
 * identity store. Each entry's `schema` is plain JSON Schema; feed the
 * whole set through toAnthropicTools/toOpenAITools before handing it to a
 * model API, and dispatch tool calls through `execute()`.
 */
export function createActions(options: ActionsOptions) {
  const { client, identities, pgpPassphrase, publicWebhookUrl, walletMasterKey, globalAgentId } = options;
  const replyTransform = options.replyTransform ?? ((text: string) => text);

  // Generates an EVM keypair, encrypts it under walletMasterKey (no human
  // recovery phrase), and uploads it under `identity`'s own api-key. Shared
  // by the create_wallet action and create_salt_agent's auto-provision hook.
  async function provisionWallet(identity: AgentIdentity, opts: { chain?: string; testnet?: boolean } = {}) {
    if (!walletMasterKey) {
      throw new Error("No wallet master key is configured on this server, so I can't generate a wallet.");
    }
    const wallet = ethers.Wallet.createRandom();
    const encrypted_payload = encryptWalletPayload(
      walletMasterKey,
      { private_key: wallet.privateKey, mnemonic: wallet.mnemonic ? wallet.mnemonic.phrase : null },
      wallet.address
    );
    return client.createWallet(identity.apiKey, {
      chain: opts.chain ?? "ethereum",
      testnet: opts.testnet ?? true,
      wallet_type: "ETH",
      public_address: wallet.address,
      public_key: wallet.publicKey,
      encrypted_payload,
      public: false,
      default: false,
    }) as Promise<{ id: number; chain: string; testnet: boolean; public_address: string }>;
  }

  async function myWalletId(caller: AgentIdentity): Promise<number> {
    const wallets = (await client.listWallets(caller.apiKey)) as Array<{ id: number; deleted_at?: string | null }>;
    const active = (Array.isArray(wallets) ? wallets : []).filter((w) => !w.deleted_at);
    if (active.length === 0) throw new Error("You have no wallet to receive payments.");
    return active[0].id;
  }

  // --- create_salt_agent ---------------------------------------------

  async function createSaltAgent(
    creator: AgentIdentity,
    input: { display_name: string; username: string; description: string; category?: string; persona: string }
  ) {
    const keys = await pgp.generateKeypair(pgpPassphrase);

    // No email or password: salt-api synthesizes a placeholder email and
    // leaves the account non-loginable -- agents are pure API entities.
    const created = await client.createAgent(creator.apiKey, {
      display_name: input.display_name,
      username: input.username,
      description: input.description,
      webhook: publicWebhookUrl,
      category: input.category,
      public_key: keys.publicKey,
      private_key: keys.privateKey,
      public_fingerprint: keys.fingerprint,
    });

    // The raw api key rides on the create response exactly once -- the server
    // stores a digest, so the admin endpoint can no longer show it. The
    // rotate fallback covers an older server that predates that change.
    const childApiKey =
      created.api_key ??
      (await client.rotateAgentApiKey(creator.apiKey, created.id)).api_key;

    const childIdentity: AgentIdentity = {
      saltAppId: created.id,
      username: created.username,
      displayName: created.display_name,
      apiKey: childApiKey,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      systemPrompt: input.persona,
    };
    identities.register(childIdentity);

    // Best-effort: a child that can't get a wallet right now can still
    // provision one itself later. Never let a wallet hiccup fail agent creation.
    let walletNote = "It has no receiving wallet yet -- it can provision one itself with create_wallet.";
    try {
      await provisionWallet(childIdentity, { chain: "ethereum", testnet: true });
      walletNote =
        "It was also given a receiving wallet (Ethereum testnet) so it can be paid right away -- " +
        "note that agent-provisioned wallets have no human recovery phrase.";
    } catch {
      // Missing wallet master key or a transient API error -- not fatal.
    }

    return {
      created: true,
      id: created.id,
      username: created.username,
      display_name: created.display_name,
      note: `Live now on the same server as you. People can find and message it in the Agents directory at /agents/${created.id}. ${walletNote}`,
    };
  }

  // --- list_salt_agents ------------------------------------------------

  async function listSaltAgents(caller: AgentIdentity, input: { category?: string; limit?: number } = {}) {
    const agents = (await client.listAgents(caller.apiKey)) as Array<Record<string, any>>;
    let filtered = agents.filter((a) => a.id !== caller.saltAppId);

    if (input.category) {
      const needle = input.category.toLowerCase();
      filtered = filtered.filter((a) => String(a.category || "").toLowerCase().includes(needle));
    }
    filtered.sort(
      (a, b) =>
        (b.average_rating || 0) - (a.average_rating || 0) ||
        (b.ratings_count || 0) - (a.ratings_count || 0) ||
        (b.chats_count || 0) - (a.chats_count || 0)
    );
    const cap = Math.min(Math.max(input.limit || 10, 1), 20);

    return {
      agents: filtered.slice(0, cap).map((a) => ({
        id: a.id,
        username: a.username,
        display_name: a.display_name,
        category: a.category,
        bio: a.bio,
        average_rating: a.average_rating,
        ratings_count: a.ratings_count,
        chats_count: a.chats_count,
        message_price: a.message_price,
        owner: a.owner && a.owner.username,
      })),
    };
  }

  // --- delegate_to_agent ------------------------------------------------

  async function delegateToAgent(
    caller: AgentIdentity,
    input: { target_agent_id: number; task: string },
    ctx: ActionContext
  ) {
    const targetId = Number(input.target_agent_id);
    const task = (input.task || "").trim();
    if (!targetId || !task) throw new Error("target_agent_id and task are both required.");
    if (targetId === caller.saltAppId) throw new Error("You can't delegate to yourself.");
    if (ctx.depth >= delegations.MAX_DELEGATION_DEPTH) {
      throw new Error("Delegation depth limit reached -- handle this yourself (or answer with what you already know) instead of delegating further.");
    }

    let target: Record<string, any>;
    try {
      target = await client.getAgent(caller.apiKey, targetId);
    } catch {
      throw new Error(`No agent with id ${targetId} could be found.`);
    }
    if (target.account_type !== "Agent") {
      throw new Error(`${targetId} isn't an agent -- delegate_to_agent only targets other agents.`);
    }

    const chat = (await client.createOrGetChat(caller.apiKey, targetId)) as { id: number; users?: Array<Record<string, any>> };
    const targetMember = (chat.users || []).find((u) => parseInt(u.id, 10) === targetId);
    if (!targetMember || !targetMember.public_key) {
      throw new Error(`Agent ${targetId} has no usable public key; can't message it securely.`);
    }

    // Encrypt for every non-self member with a key, not just the target --
    // delegation chats carry a silent human observer (the caller's root
    // owner, added server-side) whose key must be a recipient for the
    // conversation to be auditable. Falls out naturally from the member list.
    const recipientKeys = (chat.users || [])
      .filter((u) => parseInt(u.id, 10) !== caller.saltAppId && u.public_key)
      .map((u) => u.public_key as string);

    const marked = delegations.wrap(ctx.depth + 1, task);
    const recipientMessage = await pgp.encryptFor(marked, recipientKeys);
    const senderMessage = await pgp.encryptFor(marked, [caller.publicKey]);

    // register() throws synchronously (before any network call) if this
    // chat already has a pending wait -- surfaces as a normal action error
    // rather than an ambiguous race over which reply belongs to which caller.
    const waitForReply = delegations.register(chat.id, targetId, delegations.DELEGATION_TIMEOUT_MS);
    try {
      await client.postMessage(caller.apiKey, chat.id, recipientMessage, senderMessage);
    } catch (err) {
      delegations.cancel(chat.id);
      throw err;
    }

    const rawReplyText = await waitForReply; // rejects with a timeout Error if nothing arrives in time
    const replyText = replyTransform(rawReplyText);

    if (ctx.mainChatId != null) {
      delegations.recordTrail(caller.saltAppId, ctx.mainChatId, {
        agent_id: target.id,
        chat_id: chat.id,
        username: target.username,
        // fee is advisory here; salt-api overwrites it with the agent's
        // actual message_price so the displayed cost can't be fabricated.
        fee: target.message_price || null,
      } as never);
    }

    client.trackEvent(caller.apiKey, "delegation_made", { to_agent_username: target.username });

    return {
      delegated: true,
      target: { id: target.id, username: target.username, display_name: target.display_name },
      reply: replyText,
    };
  }

  // --- post_card / update_card ------------------------------------------

  async function postCard(caller: AgentIdentity, input: { text?: string; blocks: unknown[] }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("post_card is only available while replying in a chat.");
    const result = (await client.postCard(caller.apiKey, ctx.mainChatId, input.blocks as never, input.text || "")) as {
      resource_id: number;
      message_id: number;
    };
    return { posted: true, card_id: result.resource_id, message_id: result.message_id };
  }

  async function updateCard(caller: AgentIdentity, input: { card_id: number; blocks: unknown[] }) {
    const cardId = Number(input.card_id);
    if (!cardId) throw new Error("card_id is required.");
    await client.updateCard(caller.apiKey, cardId, input.blocks as never);
    return { updated: true, card_id: cardId };
  }

  // --- commerce: create_product / list_products / offer_product / send_invoice / add_usage ---

  async function createProduct(caller: AgentIdentity, input: Record<string, unknown>) {
    const walletId = await myWalletId(caller);
    const product = await client.createProduct(caller.apiKey, { ...input, wallet_id: walletId });
    return { created: true, product };
  }

  async function listProducts(caller: AgentIdentity, input: { seller_id?: number } = {}) {
    const products = await client.listProducts(caller.apiKey, input.seller_id);
    return { products };
  }

  async function offerProduct(caller: AgentIdentity, input: { product_id: number }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("offer_product is only available while replying in a chat.");
    const productId = Number(input.product_id);
    if (!productId) throw new Error("product_id is required.");
    await client.shareProduct(caller.apiKey, productId, ctx.mainChatId);
    return { offered: true, product_id: productId };
  }

  async function sendInvoice(
    caller: AgentIdentity,
    input: { receiver_username?: string; line_items: Array<{ name: string; subtotal: string | number }>; due_date?: string },
    ctx: ActionContext
  ) {
    if (ctx.mainChatId == null) throw new Error("send_invoice is only available while replying in a chat.");
    const items = Array.isArray(input.line_items) ? input.line_items : [];
    if (items.length === 0) throw new Error("line_items is required.");

    const members = (await client.getChatMembers(caller.apiKey, ctx.mainChatId)) as Array<Record<string, any>>;
    let receiver: Record<string, any> | undefined;
    if (input.receiver_username) {
      receiver = members.find((m) => m.username === input.receiver_username);
      if (!receiver) throw new Error(`No chat member named @${input.receiver_username}.`);
    } else {
      const others = members.filter((m) => m.id !== caller.saltAppId && !m.observer);
      if (others.length !== 1) throw new Error("Say who to bill (receiver_username) in a group chat.");
      receiver = others[0];
    }

    // Total must equal the item sum exactly (server checks with BigDecimal)
    // -- compute it here rather than trusting the model's arithmetic, and
    // round to 12 decimals so float noise can't fail the server's equality
    // check. Real prices never need more.
    const total = items.reduce((sum, item) => sum + parseFloat(String(item.subtotal || 0)), 0);
    const amount = total.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");

    const invoice = (await client.createInvoice(caller.apiKey, {
      chatId: ctx.mainChatId,
      receiverId: receiver.id,
      walletId: await myWalletId(caller),
      amount,
      lineItems: items as never,
      message: items.map((item) => item.name).join(", ").slice(0, 100),
      dueAt: input.due_date,
    })) as { id: number };
    return { sent: true, invoice_id: invoice.id, amount };
  }

  async function addUsage(caller: AgentIdentity, input: { product_id: number; qty?: string; description?: string }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("add_usage is only available while replying in a chat.");
    const productId = Number(input.product_id);
    if (!productId) throw new Error("product_id is required.");
    // Generated once per call to this function -- i.e. once per model tool
    // call -- NOT re-generated if the underlying HTTP request is retried.
    // That's the point: usage_events_controller includes salt-api's
    // Idempotent concern, so replaying the SAME key on a retried request is
    // what makes a network-level retry safe against double-billing prepaid
    // credits. Minting a fresh key per attempt would defeat that -- it would
    // look like a brand-new usage event each time.
    const idempotencyKey = randomUUID();
    const result = (await client.addUsage(caller.apiKey, {
      productId,
      chatId: ctx.mainChatId,
      qty: parseFloat(input.qty || "1"),
      description: input.description,
      idempotencyKey,
    })) as { balance: unknown };
    return { recorded: true, balance_remaining: result.balance };
  }

  // --- hand-offs: hand_off_to_agent / hand_back_to_concierge / offer_handoff_choices ---

  async function handOffToAgent(caller: AgentIdentity, input: { agent_id: number; reason?: string }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("hand_off_to_agent is only available while replying in a chat.");
    const agentId = Number(input.agent_id);
    if (!agentId) throw new Error("agent_id is required.");
    if (agentId === caller.saltAppId) throw new Error("You can't hand off to yourself.");

    const target = await client.getAgent(caller.apiKey, agentId);
    if (!target || target.account_type !== "Agent") throw new Error(`${agentId} isn't an agent.`);

    await client.handOff(caller.apiKey, ctx.mainChatId, agentId, input.reason);
    return {
      handed_off: true,
      to: { id: target.id, username: target.username, display_name: target.display_name },
      note: "They're live in this chat now; you'll be prompted SEPARATELY to write them a briefing -- do NOT include any briefing or summary in your current reply. Your current reply is just the goodbye: one short sentence telling the person who's taking over.",
    };
  }

  async function handBackToConcierge(caller: AgentIdentity, input: { reason?: string }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("hand_back_to_concierge is only available while replying in a chat.");
    if (!globalAgentId) throw new Error("No Global agent is configured on this server.");
    if (globalAgentId === caller.saltAppId) throw new Error("You already are the concierge.");

    await client.handOff(caller.apiKey, ctx.mainChatId, globalAgentId, input.reason);
    return {
      handed_off: true,
      to: "concierge",
      note: "The concierge is live in this chat now; you'll be prompted SEPARATELY to write them a briefing -- do NOT include any briefing or summary in your current reply. Your current reply is just the goodbye: one short sentence letting the person know you're wrapping up and handing back.",
    };
  }

  async function offerHandoffChoices(
    caller: AgentIdentity,
    input: { candidates: Array<{ agent_id: number; why?: string }> },
    ctx: ActionContext
  ) {
    if (ctx.mainChatId == null) throw new Error("offer_handoff_choices is only available while replying in a chat.");
    const candidates = (Array.isArray(input.candidates) ? input.candidates : []).slice(0, 4);
    if (candidates.length === 0) throw new Error("candidates is required.");

    const [directory, members] = await Promise.all([
      client.listAgents(caller.apiKey) as Promise<Array<Record<string, any>>>,
      client.getChatMembers(caller.apiKey, ctx.mainChatId) as Promise<Array<Record<string, any>>>,
    ]);
    const humanIds = members.filter((m) => m.account_type !== "Agent" && !m.observer).map((m) => parseInt(m.id, 10));
    if (humanIds.length === 0) throw new Error("No human member to offer choices to.");

    const blocks: Array<Record<string, unknown>> = [{ type: "section", text: "Who should take this over? Pick one:" }];
    for (const c of candidates) {
      const agent = directory.find((a) => a.id === Number(c.agent_id));
      if (!agent || agent.id === caller.saltAppId) continue;
      const fields: Array<{ label: string; value: string }> = [];
      if (agent.category) fields.push({ label: "Category", value: String(agent.category).slice(0, 160) });
      if (agent.average_rating) fields.push({ label: "Rating", value: `${agent.average_rating}/5 (${agent.ratings_count})` });
      if (agent.message_price) fields.push({ label: "Price", value: `${agent.message_price}/message` });
      blocks.push({
        type: "section",
        text: `**${agent.display_name}** -- ${String(c.why || agent.bio || "").slice(0, 300)}`,
        fields,
      });
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: `handoff_${agent.id}`,
            label: `Hand off to @${agent.username}`.slice(0, 40),
            style: "primary",
            action_type: "handoff",
            handoff_target_agent_id: agent.id,
            restricted_to: humanIds,
          },
        ],
      });
    }
    if (blocks.length === 1) throw new Error("None of those candidates exist in the directory.");

    const card = (await client.postCard(caller.apiKey, ctx.mainChatId, blocks as never, "Choose who takes over")) as {
      card_id?: number;
      id?: number;
    };
    return {
      offered: true,
      card_id: card.card_id || card.id,
      note: "Card posted; the person picks and the server performs the hand-off. Don't hand off yourself now -- just tell them to choose.",
    };
  }

  // --- create_wallet ------------------------------------------------

  async function createWalletAction(caller: AgentIdentity, input: { chain?: string; testnet?: boolean } = {}) {
    const wallet = await provisionWallet(caller, { chain: input.chain || "ethereum", testnet: input.testnet ?? true });
    return {
      created: true,
      wallet_id: wallet.id,
      chain: wallet.chain,
      testnet: wallet.testnet,
      public_address: wallet.public_address,
      note: "No recovery phrase exists for this wallet -- it's only as safe as this server's wallet master key.",
    };
  }

  const definitions: ActionDefinition[] = [
    {
      name: "create_salt_agent",
      description:
        "Register a brand-new Salt agent that YOU own, and bring it fully online. This is a real " +
        "action with a real effect: it generates the new agent a fresh PGP keypair, registers it " +
        "with Salt under your ownership (exactly the same call a human uses to create an agent, " +
        "just with your API key instead of theirs), and starts it running on this same server " +
        "immediately -- it will actually answer messages people send it. Use this when someone " +
        "genuinely wants a new agent to exist, not as a joke or hypothetical. Requires a distinct " +
        "username (lowercase, no spaces).",
      schema: {
        type: "object",
        properties: {
          display_name: { type: "string", description: "Shown on the new agent's profile and message bubbles." },
          username: { type: "string", description: 'Unique handle, lowercase, no spaces, e.g. "weatherbot".' },
          description: { type: "string", description: "One-line bio shown in the Agents directory." },
          category: { type: "string", description: "Optional directory category, e.g. Assistant, Trading, Fun, Utilities." },
          persona: {
            type: "string",
            description:
              "The new agent's personality and instructions -- this becomes its own system prompt, " +
              "separate from yours. Be specific: tone, what it's for, how it should behave.",
          },
        },
        required: ["display_name", "username", "description", "persona"],
      },
      execute: createSaltAgent,
    },
    {
      name: "list_salt_agents",
      description:
        "Browse Salt's public Agents directory to find another agent that might help accomplish " +
        "part of your task -- e.g. a specialist for research, trading, or a domain you're not " +
        "suited for. Returns each agent's id, username, category, bio, and reputation (average " +
        "rating out of 5, number of ratings, how many chats have adopted it) so you can judge who's " +
        "actually good, not just who exists -- results are sorted best-rated first. Use this before " +
        "delegate_to_agent so you pick a real, well-regarded agent rather than guessing an id.",
      schema: {
        type: "object",
        properties: {
          category: { type: "string", description: 'Optional loose filter against each agent\'s category, e.g. "Trading", "Assistant". Omit for all categories.' },
          limit: { type: "integer", description: "Max agents to return, highest-rated first. Default 10, max 20." },
        },
        required: [],
      },
      execute: listSaltAgents,
    },
    {
      name: "delegate_to_agent",
      description:
        "Ask another Salt agent to help with part of your task, over a real Salt chat message -- " +
        "exactly like a human messaging that agent. Creates (or reuses) a 1:1 chat with the target, " +
        "sends it your request, and waits for its reply, which is returned to you to use. This is a " +
        "real, visible conversation, not a shortcut: anyone who opens that chat can see the " +
        "delegation happen. Use list_salt_agents first to pick a suitable, well-rated target rather " +
        "than guessing an id. Only delegate work the other agent is plausibly better positioned for " +
        "-- don't delegate something you can already just answer yourself. You can't delegate to " +
        "yourself, and delegation depth is limited, so don't chain delegations further than the " +
        "task actually needs.",
      schema: {
        type: "object",
        properties: {
          target_agent_id: { type: "integer", description: "The Salt user id of the agent to delegate to (from list_salt_agents)." },
          task: { type: "string", description: "The sub-task or question to send, written as a clear, self-contained request -- the target agent has no other context about your conversation." },
        },
        required: ["target_agent_id", "task"],
      },
      execute: delegateToAgent,
    },
    {
      name: "post_card",
      description:
        "Post an interactive card (a mini app) into the CURRENT chat: sections of markdown text " +
        "and label/value fields, dividers, images, and button rows. Buttons are live -- when a " +
        "member taps one you receive a card_interaction event and should answer it with " +
        "update_card. Use for polls, order status, dashboards, menus, RSVPs -- anywhere tappable " +
        "structure beats prose. Returns the created card's id; remember it to update the card later.",
      schema: {
        type: "object",
        properties: {
          text: { type: "string", description: 'Short plaintext preview shown in chat lists / notifications, e.g. "Poll: lunch spot".' },
          blocks: BLOCKS_SCHEMA,
        },
        required: ["blocks"],
      },
      execute: postCard,
    },
    {
      name: "update_card",
      description:
        "Replace the blocks of a card YOU posted -- your response to a card_interaction event " +
        "(e.g. increment the tapped option's vote count and re-render the results). The new state " +
        "updates live in everyone's chat. Send the card's COMPLETE new blocks array, not a diff.",
      schema: {
        type: "object",
        properties: {
          card_id: { type: "integer", description: "The card's id (from post_card's result or the card_interaction event)." },
          blocks: BLOCKS_SCHEMA,
        },
        required: ["card_id", "blocks"],
      },
      execute: updateCard,
    },
    {
      name: "create_product",
      description:
        "Add a product to YOUR shop (shown on your profile, shareable into chats). Three kinds: " +
        "'one_time' (a good/service bought outright), 'metered' (each use draws down the buyer's " +
        "prepaid credits -- requires `unit`, e.g. 'haiku'), 'subscription' (re-invoiced " +
        "automatically -- requires `interval`: daily|weekly|monthly). Price is a human-decimal " +
        'string in your wallet\'s native token (e.g. "0.01"). Payments land in your first active wallet.',
      schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "<=80 chars" },
          description: { type: "string" },
          kind: { type: "string", enum: ["one_time", "metered", "subscription"] },
          price: { type: "string", description: 'Positive decimal string, e.g. "0.01"' },
          unit: { type: "string", description: "metered only: what one qty means" },
          interval: { type: "string", enum: ["daily", "weekly", "monthly"], description: "subscription only" },
        },
        required: ["name", "kind", "price"],
      },
      execute: createProduct,
    },
    {
      name: "list_products",
      description: "List shop products -- your own (default) or another seller's (pass seller_id). Use before offering/metering so you reference real product ids and current prices.",
      schema: {
        type: "object",
        properties: { seller_id: { type: "integer", description: "Omit for your own products." } },
      },
      execute: listProducts,
    },
    {
      name: "offer_product",
      description: "Share one of YOUR products into the current chat as a bubble with a real Buy button. Buying drops an invoice the buyer pays on Salt's normal rail -- you never handle the money.",
      schema: {
        type: "object",
        properties: { product_id: { type: "integer" } },
        required: ["product_id"],
      },
      execute: offerProduct,
    },
    {
      name: "send_invoice",
      description:
        "Send an itemized invoice into the current chat. Each line item needs name, qty, " +
        "unit_price, and subtotal (qty x unit_price, exact); the invoice total must equal the sum " +
        "of subtotals -- the server rejects any mismatch. The payer gets a Pay button with the " +
        "full breakdown. NEVER state amounts in prose that differ from the invoice.",
      schema: {
        type: "object",
        properties: {
          receiver_username: { type: "string", description: "Who pays. Omit in a 1:1 (inferred)." },
          line_items: {
            type: "array",
            description: '[{name:"<=120", qty:"1", unit_price:"0.01", subtotal:"0.01", product_id?}]',
            items: { type: "object" },
          },
          due_date: { type: "string", description: "Optional, YYYY-MM-DD." },
        },
        required: ["line_items"],
      },
      execute: sendInvoice,
    },
    {
      name: "add_usage",
      description:
        "Record metered usage of one of YOUR metered products against the chat partner's prepaid " +
        "credits -- call it right after doing the billable work (qty = units delivered). The " +
        "amount is computed server-side from the product's price. If it fails with " +
        "insufficient_credits, tell the user their balance and ask them to top up from the Credits " +
        "strip to continue.",
      schema: {
        type: "object",
        properties: {
          product_id: { type: "integer" },
          qty: { type: "string", description: 'Units delivered, e.g. "1" or "3". Default "1".' },
          description: { type: "string", description: "Short human-readable line for the ledger." },
        },
        required: ["product_id"],
      },
      execute: addUsage,
    },
    {
      name: "create_wallet",
      description:
        "Provision a real receiving wallet for YOURSELF, so you can be paid (sell products, " +
        "invoice, meter usage). Generates a fresh Ethereum keypair server-side and uploads it " +
        "encrypted -- there is NO human-memorable recovery phrase for this wallet (unlike a " +
        "person's Salt wallet); if this server's wallet master key is ever lost, its funds are " +
        "unrecoverable. Only call this if you don't already have a wallet (check via list_products " +
        "or ask; calling again just adds another).",
      schema: {
        type: "object",
        properties: {
          chain: { type: "string", description: 'Chain key, e.g. "ethereum", "polygon", "base". Default "ethereum".' },
          testnet: { type: "boolean", description: "Default true." },
        },
      },
      execute: createWalletAction,
    },
    {
      name: "hand_off_to_agent",
      description:
        "Hand THIS conversation off to another Salt agent -- they become the live participant in " +
        "this same chat (no new chat is created), you stay in the room silently, and you'll be " +
        "asked to write a briefing for them right after. Use in AUTO-mode hand-off chats when " +
        "another agent clearly serves the person better (check list_salt_agents first for a " +
        "well-rated match). ALWAYS tell the person you're handing off and why, in the same reply or " +
        "just before. Never use this in MANUAL mode -- offer_handoff_choices is for that.",
      schema: {
        type: "object",
        properties: {
          agent_id: { type: "integer", description: "The agent taking over (from list_salt_agents)." },
          reason: { type: "string", description: "One line on why -- shown in the hand-off trail." },
        },
        required: ["agent_id", "reason"],
      },
      execute: handOffToAgent,
    },
    {
      name: "hand_back_to_concierge",
      description:
        "Hand this conversation back to the Global concierge agent -- the router this person " +
        "originally started with. Use this as soon as you've wrapped up what you were brought in " +
        "for: you answered their question, finished the task, hit something outside your scope, or " +
        "they signal they're done / want something else. Don't wait to be asked -- a person who has " +
        "to explicitly request 'take me back to the concierge' is a failure of this tool's whole " +
        "point. Same mechanics as hand_off_to_agent: you stay in the room silently, and you'll be " +
        "asked to write a briefing right after. AUTO-mode hand-off chats only -- in MANUAL mode, " +
        "tell the person they can jump back to the concierge from chat info themselves.",
      schema: {
        type: "object",
        properties: { reason: { type: "string", description: "One line on why you're handing back -- shown in the hand-off trail." } },
        required: ["reason"],
      },
      execute: handBackToConcierge,
    },
    {
      name: "offer_handoff_choices",
      description:
        "MANUAL-mode hand-off: post an interactive picker into this chat with 2-4 candidate " +
        "agents, and let the PERSON choose who takes over (tapping performs the hand-off " +
        "server-side; you don't). Pick candidates via list_salt_agents first and give each a " +
        "one-line reason tailored to what the person actually needs. Only the human can tap the buttons.",
      schema: {
        type: "object",
        properties: {
          candidates: {
            type: "array",
            description: "2-4 entries: {agent_id, why} -- `why` is your one-line pitch for this candidate.",
            items: {
              type: "object",
              properties: { agent_id: { type: "integer" }, why: { type: "string" } },
              required: ["agent_id", "why"],
            },
          },
        },
        required: ["candidates"],
      },
      execute: offerHandoffChoices,
    },
  ];

  const byName = new Map(definitions.map((d) => [d.name, d]));

  async function execute(name: string, input: unknown, caller: AgentIdentity, ctx: ActionContext): Promise<unknown> {
    const definition = byName.get(name);
    if (!definition) throw new Error(`Unknown action: ${name}`);
    // One capture per action a model invokes -- just the name, no
    // arguments (those can contain content). Fire-and-forget.
    client.trackEvent(caller.apiKey, "tool_used", { tool: name });
    return definition.execute(caller, input, ctx);
  }

  return { definitions, execute, myWalletId, provisionWallet };
}

// --- provider adapters -------------------------------------------------

/** Anthropic Messages API tool format: {name, description, input_schema}. */
export function toAnthropicTools(definitions: ActionDefinition[]): Array<{ name: string; description: string; input_schema: JsonSchema }> {
  return definitions.map((d) => ({ name: d.name, description: d.description, input_schema: d.schema }));
}

/** OpenAI-style function-calling tool format: {type:"function", function:{name, description, parameters}}. */
export function toOpenAITools(
  definitions: ActionDefinition[]
): Array<{ type: "function"; function: { name: string; description: string; parameters: JsonSchema } }> {
  return definitions.map((d) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.schema } }));
}
