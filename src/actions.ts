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
import { SaltApiError, type SaltClient } from "./client";
import * as pgp from "./crypto";
import { encryptWalletPayload } from "./crypto";
import * as delegations from "./delegations";
import { createWorkReporter, newWorkId, WORK_STATUSES, type WorkReport, type WorkStatus } from "./work";
import type { AgentIdentity, IdentityStore } from "./identities";
import { sameId, type SaltId } from "./ids.js";

export type JsonSchema = Record<string, unknown>;

export interface ActionContext {
  /** Delegation hop depth of the message this action is being taken in service of (0 for a direct turn). */
  depth: number;
  /** The chat this action should act on, or null when not currently replying in a chat (e.g. a background job). */
  mainChatId: SaltId | null;
  /**
   * The PERSON whose message this turn answers, when it answers one. Work
   * reports (work.ts) go to them privately: delegate_to_agent reports itself,
   * and report_progress is only available with one. Leave it unset for an
   * agent sender, a background job, or a delegated hop.
   */
  requesterId?: SaltId | null;
  /**
   * `mainChatId`'s `lane_kind`, when known -- "consult" for a lane
   * consult_agent opened (see webhook.ts's MessageContext.chatMeta). Pass
   * `ctx.chatMeta?.lane_kind` through from onMessage. request_floor uses
   * this to refuse outside a consult lane; leave unset anywhere else.
   */
  laneKind?: string | null;
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
  /** The concierge -- this process's configured front door agent. */
  conciergeAgentId?: SaltId;
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
  const { client, identities, pgpPassphrase, publicWebhookUrl, walletMasterKey, conciergeAgentId } = options;
  const replyTransform = options.replyTransform ?? ((text: string) => text);

  // Progress reports to the person a turn is for (work.ts). Only a turn that
  // answers a person in a chat has anyone to report to; everything else is a
  // quiet no-op, so a delegation made by a background job or a delegated hop
  // behaves exactly as it did before reports existed.
  const workReporter = createWorkReporter(client);
  const reportTarget = (ctx: ActionContext) =>
    ctx.mainChatId != null && ctx.requesterId != null && ctx.depth === 0
      ? { chatId: ctx.mainChatId, requesterId: ctx.requesterId }
      : null;
  async function reportWork(caller: AgentIdentity, ctx: ActionContext, report: WorkReport): Promise<boolean> {
    const target = reportTarget(ctx);
    if (!target) return false;
    return workReporter.report(caller, target, report);
  }

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
    }) as Promise<{ id: SaltId; chain: string; testnet: boolean; public_address: string }>;
  }

  async function myWalletId(caller: AgentIdentity): Promise<SaltId> {
    const wallets = (await client.listWallets(caller.apiKey)) as Array<{ id: SaltId; deleted_at?: string | null }>;
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
    //
    // Key custody (salt-api docs/KEY_CUSTODY.md Phase 5): keys.privateKey is
    // deliberately never sent. Salt now rejects a plaintext private_key on
    // create outright, and there is no vault to wrap one under here -- this
    // process, not Salt, is the key's only custodian. It is registered below
    // via identities.register, which is where it actually lives.
    const created = await client.createAgent(creator.apiKey, {
      display_name: input.display_name,
      username: input.username,
      description: input.description,
      webhook: publicWebhookUrl,
      category: input.category,
      public_key: keys.publicKey,
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
    let filtered = agents.filter((a) => !sameId(a.id, caller.saltAppId));

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
    input: { target_agent_id: SaltId; task: string },
    ctx: ActionContext
  ) {
    // Ids arrive here from a model's tool call, so they are taken as written
    // and never parsed. `Number(...)` made every real id NaN, which is falsy,
    // so the required-argument check below rejected every valid delegation --
    // and the self-delegation guard, comparing NaN, could never fire.
    const targetId = String(input.target_agent_id || "").trim();
    const task = (input.task || "").trim();
    if (!targetId || !task) throw new Error("target_agent_id and task are both required.");
    if (sameId(targetId, caller.saltAppId)) throw new Error("You can't delegate to yourself.");
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

    const chat = (await client.createOrGetChat(caller.apiKey, targetId)) as { id: SaltId; users?: Array<Record<string, any>> };
    const targetMember = (chat.users || []).find((u) => sameId(u.id, targetId));
    if (!targetMember || !targetMember.public_key) {
      throw new Error(`Agent ${targetId} has no usable public key; can't message it securely.`);
    }

    // Encrypt for every non-self member with a key, not just the target --
    // delegation chats carry a silent human observer (the caller's root
    // owner, added server-side) whose key must be a recipient for the
    // conversation to be auditable. Falls out naturally from the member list.
    const recipientKeys = (chat.users || [])
      .filter((u) => !sameId(u.id, caller.saltAppId) && u.public_key)
      .map((u) => u.public_key as string);

    const marked = delegations.wrap(ctx.depth + 1, task);
    const recipientMessage = await pgp.encryptFor(marked, recipientKeys);
    const senderMessage = await pgp.encryptFor(marked, [caller.publicKey]);

    // The person this turn is for sees the delegation as it happens, in their
    // Tasks panel: who was asked, what, and how it ended. Awaited so the
    // reports land in order; a report that fails never fails the delegation.
    // Each step carries its own detail (0.6.1): the ask on the way out, the
    // reply's first line on the way back, the reason on a failure. One detail
    // reused for every step made a finished delegation repeat the question.
    const firstLine = (s: string) => (s || "").split("\n").find((l) => l.trim()) || "";
    const work: Omit<WorkReport, "status" | "title" | "detail"> = {
      id: newWorkId(),
      kind: "delegation",
      with: target.username,
    };
    const handle = target.username ? `@${target.username}` : target.display_name || "another agent";

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
    await reportWork(caller, ctx, { ...work, status: "running", title: `Asking ${handle}`, detail: firstLine(task) });

    let rawReplyText: string;
    try {
      rawReplyText = await waitForReply; // rejects with a timeout Error if nothing arrives in time
    } catch (err) {
      await reportWork(caller, ctx, { ...work, status: "failed", title: `No answer from ${handle}`, detail: `No reply within ${Math.round(delegations.DELEGATION_TIMEOUT_MS / 1000)} s.` });
      throw err;
    }
    const replyText = replyTransform(rawReplyText);
    await reportWork(caller, ctx, { ...work, status: "done", title: `${handle} answered`, detail: firstLine(replyText) });

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
      // Seen live (2026-09-15): after consulting Faucet, the Concierge told the
      // person "They're in this chat now -- you can message them directly."
      // They were not. Say so in the result the model reads.
      note: `${target.display_name || target.username} answered YOU in a separate chat and is NOT a member of the chat you are replying in. The person cannot message them here. Give them the answer yourself; if they should talk to that agent directly, use hand_off_to_agent, which actually brings it in.`,
    };
  }

  // --- consult_agent -------------------------------------------------------
  //
  // Unlike delegate_to_agent (a separate 1:1, the target never in this
  // chat), consult_agent stays inline: it opens a lane off the CURRENT chat
  // with a fellow member who's already here, and later messages from that
  // agent ride the ordinary onMessage path in that lane (ctx.roomId points
  // back here) rather than needing another tool call. Reply-matching reuses
  // the exact same delegations registry delegate_to_agent does.

  async function consultAgent(
    caller: AgentIdentity,
    input: { handle: string; briefing?: string; question: string },
    ctx: ActionContext
  ) {
    if (ctx.mainChatId == null) throw new Error("consult_agent is only available while replying in a chat.");
    const handle = (input.handle || "").replace(/^@/, "").trim();
    const briefing = (input.briefing || "").trim();
    const question = (input.question || "").trim();
    if (!handle || !question) throw new Error("handle and question are both required.");

    const members = (await client.getChatMembers(caller.apiKey, ctx.mainChatId)) as Array<Record<string, any>>;
    const target = members.find((m) => m.username === handle);
    if (!target) {
      throw new Error(`No chat member named @${handle} -- consult_agent only reaches someone already in this chat (use delegate_to_agent for anyone else).`);
    }
    if (sameId(target.id, caller.saltAppId)) throw new Error("You can't consult yourself.");
    if (target.account_type !== "Agent") throw new Error(`@${handle} isn't an agent -- consult_agent only targets other agents.`);
    if (!target.public_key) throw new Error(`@${handle} has no usable public key; can't message them securely.`);

    const lane = (await client.openConsultLane(caller.apiKey, ctx.mainChatId, target.id)) as {
      session: { id: SaltId; users?: Array<Record<string, any>> };
    };
    const recipientKeys = (lane.session.users || [])
      .filter((u) => !sameId(u.id, caller.saltAppId) && u.public_key)
      .map((u) => u.public_key as string);
    if (recipientKeys.length === 0) throw new Error(`@${handle} has no usable public key in the lane; can't message them securely.`);

    const body = briefing ? `${briefing}\n\n${question}` : question;
    const marked = delegations.wrapConsult(ctx.mainChatId, body);
    const recipientMessage = await pgp.encryptFor(marked, recipientKeys);
    const senderMessage = await pgp.encryptFor(marked, [caller.publicKey]);

    // So webhook.ts's own floor-request handler knows, later, that WE are
    // the one who should hand off if @handle asks for the floor in this lane.
    delegations.registerConsultAsker(lane.session.id, caller.saltAppId, ctx.mainChatId);

    const firstLine = (s: string) => (s || "").split("\n").find((l) => l.trim()) || "";
    const work: Omit<WorkReport, "status" | "title" | "detail"> = { id: newWorkId(), kind: "delegation", with: target.username };
    const atHandle = `@${target.username}`;

    const waitForReply = delegations.register(lane.session.id, target.id, delegations.DELEGATION_TIMEOUT_MS);
    try {
      await client.postMessage(caller.apiKey, lane.session.id, recipientMessage, senderMessage);
    } catch (err) {
      delegations.cancel(lane.session.id);
      throw err;
    }
    await reportWork(caller, ctx, { ...work, status: "running", title: `Asking ${atHandle}`, detail: firstLine(question) });

    let rawReplyText: string;
    try {
      rawReplyText = await waitForReply; // rejects with a timeout Error if nothing arrives in time
    } catch (err) {
      await reportWork(caller, ctx, {
        ...work,
        status: "failed",
        title: `No answer from ${atHandle}`,
        detail: `No reply within ${Math.round(delegations.DELEGATION_TIMEOUT_MS / 1000)} s.`,
      });
      throw err;
    }
    const replyText = replyTransform(rawReplyText);
    await reportWork(caller, ctx, { ...work, status: "done", title: `${atHandle} answered`, detail: firstLine(replyText) });

    client.trackEvent(caller.apiKey, "consult_made", { to_agent_username: target.username });

    return {
      consulted: true,
      target: { id: target.id, username: target.username, display_name: target.display_name },
      lane_chat_id: lane.session.id,
      reply: replyText,
      note:
        `${target.display_name || target.username} is answering you in a separate private lane off this chat -- ` +
        "the person here cannot see it. Later messages from them arrive as ordinary turns in that lane (you " +
        "don't need to call consult_agent again to keep talking); if they ask for the floor, you'll be handed off automatically.",
    };
  }

  // --- request_floor ---------------------------------------------------------

  async function requestFloor(caller: AgentIdentity, input: { reason?: string }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("request_floor is only available while replying in a chat.");
    if (ctx.laneKind !== "consult") {
      throw new Error("request_floor is only available inside a consult lane (the chat a consult_agent call opened with you) -- not in an ordinary chat.");
    }
    const reason = (input.reason || "").trim();
    const marker = reason ? `${delegations.FLOOR_REQUEST_MARKER}\n${reason}` : delegations.FLOOR_REQUEST_MARKER;

    const members = (await client.getChatMembers(caller.apiKey, ctx.mainChatId)) as Array<Record<string, any>>;
    const recipientKeys = members.filter((u) => !sameId(u.id, caller.saltAppId) && u.public_key).map((u) => u.public_key as string);
    if (recipientKeys.length === 0) throw new Error("No one in this lane to ask for the floor.");

    const message = await pgp.encryptFor(marker, recipientKeys);
    const senderMessage = await pgp.encryptFor(marker, [caller.publicKey]);
    await client.postMessage(caller.apiKey, ctx.mainChatId, message, senderMessage);

    return {
      requested: true,
      note: "Sent. If they hand off, you'll be brought into the room directly and prompted separately to introduce yourself.",
    };
  }

  // --- report_progress --------------------------------------------------

  async function reportProgress(
    caller: AgentIdentity,
    input: { id?: string; status: WorkStatus; title: string; detail?: string; evidence?: { transfer_id?: SaltId } },
    ctx: ActionContext
  ) {
    if (!reportTarget(ctx)) {
      throw new Error("report_progress is only available while answering a person in a chat.");
    }
    if (!WORK_STATUSES.includes(input.status)) {
      throw new Error(`status must be one of ${WORK_STATUSES.join(", ")}.`);
    }
    const title = (input.title || "").trim();
    if (!title) throw new Error("title is required -- one short line saying what is happening.");

    // Money evidence: claiming money work "done" is only trusted with a
    // real, CONFIRMED transfer behind it -- otherwise a report is just the
    // model's own say-so. Only checked when evidence is actually supplied
    // (most 'done' reports aren't about money at all); the tool description
    // is what tells the model money work needs this.
    const transferId = input.evidence?.transfer_id ? String(input.evidence.transfer_id).trim() : undefined;
    if (input.status === "done" && transferId) {
      let transfer: { status?: string };
      try {
        transfer = await client.getTransfer(caller.apiKey, transferId);
      } catch (err) {
        throw new Error(`Could not verify transfer ${transferId}: ${(err as Error).message}`);
      }
      if (transfer.status !== "Confirmed") {
        throw new Error(
          `Transfer ${transferId} has not confirmed on-chain yet (status: ${transfer.status || "unknown"}) -- ` +
            "report 'done' only once it has; use 'running' (or 'failed', if it failed) until then."
        );
      }
    }

    const id = input.id && /^[A-Za-z0-9_-]{1,64}$/.test(input.id) ? input.id : newWorkId();
    const reported = await reportWork(caller, ctx, { id, status: input.status, kind: "task", title, detail: input.detail });
    return reported
      ? { reported: true, id, note: "Only they can see this, in their Tasks panel for this chat." }
      : { reported: false, id, note: "The report could not be delivered; carry on with the work." };
  }

  // --- post_card / update_card ------------------------------------------

  async function postCard(caller: AgentIdentity, input: { text?: string; blocks: unknown[] }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("post_card is only available while replying in a chat.");
    const result = (await client.postCard(caller.apiKey, ctx.mainChatId, input.blocks as never, input.text || "")) as {
      resource_id: SaltId;
      message_id: SaltId;
    };
    return { posted: true, card_id: result.resource_id, message_id: result.message_id };
  }

  async function updateCard(caller: AgentIdentity, input: { card_id: SaltId; blocks: unknown[] }) {
    const cardId = String(input.card_id || "").trim();
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

  async function listProducts(caller: AgentIdentity, input: { seller_id?: SaltId } = {}) {
    const products = await client.listProducts(caller.apiKey, input.seller_id);
    return { products };
  }

  async function offerProduct(caller: AgentIdentity, input: { product_id: SaltId }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("offer_product is only available while replying in a chat.");
    const productId = String(input.product_id || "").trim();
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
      const others = members.filter((m) => !sameId(m.id, caller.saltAppId) && !m.observer);
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
    })) as { id: SaltId };
    return { sent: true, invoice_id: invoice.id, amount };
  }

  async function addUsage(caller: AgentIdentity, input: { product_id: SaltId; qty?: string; description?: string }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("add_usage is only available while replying in a chat.");
    const productId = String(input.product_id || "").trim();
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

  async function handOffToAgent(caller: AgentIdentity, input: { agent_id: SaltId; reason?: string }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("hand_off_to_agent is only available while replying in a chat.");
    const agentId = String(input.agent_id || "").trim();
    if (!agentId) throw new Error("agent_id is required.");
    if (sameId(agentId, caller.saltAppId)) throw new Error("You can't hand off to yourself.");

    const target = await client.getAgent(caller.apiKey, agentId);
    if (!target || target.account_type !== "Agent") throw new Error(`${agentId} isn't an agent.`);
    const handle = target.username ? `@${target.username}` : target.display_name || "another agent";

    try {
      await client.handOff(caller.apiKey, ctx.mainChatId, agentId, input.reason);
    } catch (err) {
      // A refused hand-off (Salt says no, for whatever reason it has) is not
      // a bug in this tool call -- it's an answer. Hand it back as a normal
      // RESULT, not a throw, so the model gets one consistent instruction
      // instead of three different guesses at what a raw error meant.
      if (!(err instanceof SaltApiError) || (err.status !== 403 && err.status !== 422)) throw err;
      const reason =
        err.body && typeof err.body === "object" && typeof (err.body as { error?: unknown }).error === "string"
          ? (err.body as { error: string }).error
          : err.message;
      return {
        ok: false,
        refused: true,
        reason,
        next_step: `Tell the person they can open ${handle} from Salt's agent directory and message them directly.`,
      };
    }
    return {
      handed_off: true,
      handedOff: true,
      to: { id: target.id, username: target.username, display_name: target.display_name },
      note: "They're live in this chat now; you'll be prompted SEPARATELY to write them a briefing -- do NOT include any briefing or summary in your current reply. Write nothing else this turn: the hand-off itself and the briefing you're about to write are the whole goodbye, and anything else you write now is sent to nobody.",
    };
  }

  async function handBackToConcierge(caller: AgentIdentity, input: { reason?: string }, ctx: ActionContext) {
    if (ctx.mainChatId == null) throw new Error("hand_back_to_concierge is only available while replying in a chat.");

    // A real one step back: whoever handed THIS chat to you, which on a
    // Concierge -> A -> B chain is A, not the fixed concierge id -- a fixed
    // destination would skip A entirely. Only when there is no previous hop
    // (this identity is the FIRST agent in the chat, or the trail runs out)
    // does salt-api answer 422, and only then do we fall back to a fixed
    // destination at all.
    try {
      await client.handBack(caller.apiKey, ctx.mainChatId);
      return {
        handed_off: true,
        handedOff: true,
        to: "previous",
        note: "They're live in this chat now; you'll be prompted SEPARATELY to write them a briefing -- do NOT include any briefing or summary in your current reply. Write nothing else this turn: the hand-off itself and the briefing you're about to write are the whole goodbye, and anything else you write now is sent to nobody.",
      };
    } catch (err) {
      if (!(err instanceof SaltApiError) || err.status !== 422) throw err;
      // "Already at the start of this conversation." -- nowhere further
      // back to go, so fall through to the configured front door below.
    }

    if (!conciergeAgentId) throw new Error("No concierge is configured on this server.");
    if (sameId(conciergeAgentId, caller.saltAppId)) throw new Error("You already are the concierge.");

    await client.handOff(caller.apiKey, ctx.mainChatId, conciergeAgentId, input.reason);
    return {
      handed_off: true,
      handedOff: true,
      to: "concierge",
      note: "The concierge is live in this chat now; you'll be prompted SEPARATELY to write them a briefing -- do NOT include any briefing or summary in your current reply. Write nothing else this turn: the hand-off itself and the briefing you're about to write are the whole goodbye, and anything else you write now is sent to nobody.",
    };
  }

  async function offerHandoffChoices(
    caller: AgentIdentity,
    input: { candidates: Array<{ agent_id: SaltId; why?: string }> },
    ctx: ActionContext
  ) {
    if (ctx.mainChatId == null) throw new Error("offer_handoff_choices is only available while replying in a chat.");
    const candidates = (Array.isArray(input.candidates) ? input.candidates : []).slice(0, 4);
    if (candidates.length === 0) throw new Error("candidates is required.");

    const [directory, members] = await Promise.all([
      client.listAgents(caller.apiKey) as Promise<Array<Record<string, any>>>,
      client.getChatMembers(caller.apiKey, ctx.mainChatId) as Promise<Array<Record<string, any>>>,
    ]);
    // These become the button's `restricted_to` allowlist. parseInt turned
    // every one into NaN, which serialises to null and matches nobody -- so
    // "only these humans may press this" silently meant "nobody may".
    const humanIds = members.filter((m) => m.account_type !== "Agent" && !m.observer).map((m) => String(m.id));
    if (humanIds.length === 0) throw new Error("No human member to offer choices to.");

    const blocks: Array<Record<string, unknown>> = [{ type: "section", text: "Who should take this over? Pick one:" }];
    for (const c of candidates) {
      const agent = directory.find((a) => sameId(a.id, c.agent_id));
      if (!agent || sameId(agent.id, caller.saltAppId)) continue;
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
      card_id?: SaltId;
      id?: SaltId;
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
        "delegation happen. The target joins THAT chat, never the one you are replying in -- the person " +
        "you are helping cannot message it there, so never tell them it is 'in this chat' (use " +
        "hand_off_to_agent when they should talk to it directly). Anyone who opens the delegation chat can see the " +
        "delegation happen. Use list_salt_agents first to pick a suitable, well-rated target rather " +
        "than guessing an id. Only delegate work the other agent is plausibly better positioned for " +
        "-- don't delegate something you can already just answer yourself. You can't delegate to " +
        "yourself, and delegation depth is limited, so don't chain delegations further than the " +
        "task actually needs.",
      schema: {
        type: "object",
        properties: {
          target_agent_id: { type: "string", description: "The Salt user id of the agent to delegate to (from list_salt_agents)." },
          task: { type: "string", description: "The sub-task or question to send, written as a clear, self-contained request -- the target agent has no other context about your conversation." },
        },
        required: ["target_agent_id", "task"],
      },
      execute: delegateToAgent,
    },
    {
      name: "report_progress",
      description:
        "Keep the person you are answering up to date on work that takes a while, privately. Salt " +
        "shows the report in that person's Tasks panel for this chat -- never in the conversation, " +
        "and nobody else in the chat can see it. Use status 'running' when you start something that " +
        "will take more than a few seconds, and again with the same id when the step changes; " +
        "'waiting' when you cannot continue without something from them (they are notified and can " +
        "answer you privately); 'done' or 'failed' when it ends. Keep one id for one piece of work: " +
        "omit id to start a new one and reuse the id you get back. Delegations through " +
        "delegate_to_agent/consult_agent are reported for you -- do not report those again. Do not " +
        "report quick answers; just answer. MONEY WORK: report 'done' on a payment only with " +
        "evidence: {transfer_id} -- it is verified as actually confirmed on-chain before the report " +
        "is delivered, and refused otherwise.",
      schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id returned by an earlier report of the same work. Omit to start a new piece of work." },
          status: { type: "string", enum: ["running", "waiting", "done", "failed"], description: "Where the work stands now." },
          title: { type: "string", description: 'One short line, e.g. "Comparing three flights" or "I need your departure date".' },
          detail: { type: "string", description: "Optional: a sentence or two more, e.g. what you found so far or exactly what you need." },
          evidence: {
            type: "object",
            description:
              "Required to report 'done' on money work: {transfer_id}. Verified against the real " +
              "transfer (must have actually confirmed) before the report is delivered -- claiming a " +
              "payment is done without this, or before it confirms, is refused.",
            properties: { transfer_id: { type: "string", description: "The Transfer id (e.g. from send_invoice's payment, once paid)." } },
          },
        },
        required: ["status", "title"],
      },
      execute: reportProgress,
    },
    {
      name: "consult_agent",
      description:
        "Ask a fellow member of THIS chat -- someone already in the room, human-visible as a " +
        "participant -- a question in a private lane off it, and wait for their reply, which is " +
        "returned to you to use. Unlike delegate_to_agent (a separate 1:1 the target never joins), " +
        "the consulted agent stays inline: their later messages arrive in your ordinary onMessage " +
        "flow, in that lane, without you calling this again. Use this instead of delegate_to_agent " +
        "specifically when the agent you want is already a member of the current chat. They can ask " +
        "to be brought into the room directly instead (request_floor); you'll be handed off to them " +
        "automatically if so.",
      schema: {
        type: "object",
        properties: {
          handle: { type: "string", description: "Username (without @) of the agent to consult -- must already be a member of this chat." },
          briefing: { type: "string", description: "Optional short context the target has no other way to get (they can't see this chat)." },
          question: { type: "string", description: "The question to ask." },
        },
        required: ["handle", "question"],
      },
      execute: consultAgent,
    },
    {
      name: "request_floor",
      description:
        "From INSIDE a consult lane only (one someone opened with you via consult_agent): ask the " +
        "asking agent to bring you into the room directly instead of continuing to relay your " +
        "answers through this lane. If they do, you'll be handed off into the room and prompted " +
        "separately to introduce yourself. Use this when the conversation would go faster with you " +
        "talking to the person directly rather than through an intermediary.",
      schema: {
        type: "object",
        properties: { reason: { type: "string", description: "One line on why you'd rather join directly." } },
      },
      execute: requestFloor,
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
          card_id: { type: "string", description: "The card's id (from post_card's result or the card_interaction event)." },
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
        properties: { seller_id: { type: "string", description: "Omit for your own products." } },
      },
      execute: listProducts,
    },
    {
      name: "offer_product",
      description: "Share one of YOUR products into the current chat as a bubble with a real Buy button. Buying drops an invoice the buyer pays on Salt's normal rail -- you never handle the money.",
      schema: {
        type: "object",
        properties: { product_id: { type: "string" } },
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
          product_id: { type: "string" },
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
        "well-rated match). Never use this in MANUAL mode -- offer_handoff_choices is for that. On " +
        "success, Salt itself posts a visible line naming the hand-off -- that seam plus the " +
        "briefing you're asked for next ARE the goodbye, so write nothing else this turn: say " +
        "whatever the person needs to know BEFORE calling this, in an earlier reply, never after -- " +
        "any text you write in the same turn as a successful call is never sent. If Salt refuses " +
        "the hand-off, this returns a plain result ({ok: false, refused: true, reason, next_step}) " +
        "instead of an error -- say the reason in one sentence and follow next_step; don't call it a " +
        "technical issue or guess at a cause.",
      schema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "The agent taking over (from list_salt_agents)." },
          reason: { type: "string", description: "One line on why -- shown in the hand-off trail." },
        },
        required: ["agent_id", "reason"],
      },
      execute: handOffToAgent,
    },
    {
      name: "hand_back_to_concierge",
      description:
        "Hand this conversation back to whoever handed it over to you -- usually the Global " +
        "concierge agent, the router this person originally started with, but exactly whoever " +
        "handed off to you if that was someone else. Use this as soon as you've wrapped up what " +
        "you were brought in for: you answered their question, finished the task, hit something " +
        "outside your scope, or they signal they're done / want something else. Don't wait to be " +
        "asked -- a person who has to explicitly request 'take me back' is a failure of this tool's " +
        "whole point. Same mechanics as hand_off_to_agent: you stay in the room silently, you'll be " +
        "asked to write a briefing right after, and that briefing plus Salt's own visible hand-off " +
        "line are the whole goodbye -- write nothing else this turn; any text you write in the same " +
        "turn as a successful call is never sent, so say anything the person needs to hear BEFORE " +
        "calling this, in an earlier reply. AUTO-mode hand-off chats only -- in MANUAL mode, tell the " +
        "person they can jump back to the concierge from chat info themselves.",
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
              properties: { agent_id: { type: "string" }, why: { type: "string" } },
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
