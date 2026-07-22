// The webhook server: receives salt-api's callbacks, decides WHETHER and to
// WHOM a reply is owed (dedup, GACM silence, mediator observe-gating,
// agent-to-agent loop capping, delegation-reply short-circuiting, identity
// resolution by trial-decryption), and hands off a clean, already-decrypted
// context to the consumer's callback for the one decision that's actually
// theirs: WHAT to say. Everything about the Salt protocol mechanics stays
// here; nothing about any particular model/agent-loop does.
//
// Extracted from salt-claude-agent/src/index.js, which mixed both concerns
// together. Prompt-string construction (hand-off mode notes, mediator
// coaching prefixes, card-interaction/invoice-paid instructions) is
// deliberately NOT here -- that's reference-implementation territory built
// on top of this module, since it's specific to how one particular model
// wants a situation framed.

import express, { type Express } from "express";
import type { SaltClient } from "./client";
import * as pgp from "./crypto";
import * as delegations from "./delegations";
import type { AgentIdentity, IdentityStore } from "./identities";

const PGP_MESSAGE_RE = /^-----BEGIN PGP MESSAGE/;

/** The exact marker a hand-off briefing must start with, so the incoming
 *  agent's polling loop (below) can detect it arrived. Consumers building
 *  the outgoing briefing prompt must instruct their model to emit this
 *  exact line first. */
export const HANDOFF_BRIEFING_MARKER = "[[SALT-HANDOFF-BRIEFING]]";

export interface RawChatMeta {
  active_agent_id?: number | string;
  mediator_agent_id?: number | string;
  coaching_for_chat_id?: number | string;
  mode?: "auto" | "manual";
  [key: string]: unknown;
}

export interface RawSender {
  id: number | string;
  display_name?: string;
  account_type?: "User" | "Agent";
  [key: string]: unknown;
}

export interface DecryptedAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Present only when contentType starts with "image/" -- the SDK doesn't
   *  know how to represent other file types beyond a note in `unsupportedNote`. */
  data?: Buffer;
  unsupportedNote?: string;
}

export interface MessageContext {
  identity: AgentIdentity;
  chatId: number;
  senderId: number;
  sender: RawSender;
  /** Delegation-marker-stripped plaintext (see delegations.parseIncoming). */
  text: string;
  /** Delegation hop depth this message arrived at; pass through to any further delegate call. */
  delegationDepth: number;
  chatMeta?: RawChatMeta;
  /** Set when this identity is the configured Mediator privately coaching
   *  someone about a shared chat it also observes -- the generic decrypted
   *  transcript of that shared chat (not yet wrapped in any prompt framing). */
  mediatorSharedContext?: string;
  /** Set when the inbound message was an Attachment with decryptable metadata. */
  attachment?: DecryptedAttachment;
  /** Encrypts `text` for every current chat member (+ this identity's own
   *  copy), posts it, drains this reply's delegation trail onto it, and
   *  emits an agent_reply_sent metric. Handles a typing-indicator heartbeat
   *  for the duration of the call automatically. */
  reply(text: string): Promise<void>;
}

export interface CardInteractionContext {
  identity: AgentIdentity;
  chatId: number;
  cardId: number | string;
  actionId: string;
  user: RawSender;
  blocks: unknown;
}

export interface InvoicePaidContext {
  identity: AgentIdentity;
  chatId: number;
  buyer: RawSender;
  lineItems: Array<{ name: string; qty: number; [key: string]: unknown }>;
  amount: string | number;
  /** True for a "Credits top-up" invoice -- no delivery owed, the credit already landed server-side. */
  isTopUp: boolean;
  transferRequestId: number | string;
  reply(text: string): Promise<void>;
}

export interface HandoffConfirmedContext {
  identity: AgentIdentity;
  chatId: number;
  reason?: string;
  reply(text: string): Promise<void>;
}

export interface HandoffReceivedContext {
  identity: AgentIdentity;
  chatId: number;
  reason?: string;
  /** The shared chat's decrypted transcript, polled for up to ~20s until
   *  the outgoing agent's HANDOFF_BRIEFING_MARKER shows up (or timeout). */
  context: string;
  reply(text: string): Promise<void>;
}

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

export interface WebhookServerOptions {
  client: SaltClient;
  identities: IdentityStore;
  pgpPassphrase: string;
  /** Required in production: must match the X-Salt-Webhook-Secret header
   *  salt-api's jobs send. Unset (local dev) skips the check entirely --
   *  encrypted-message webhooks fail safe regardless (forged ciphertext
   *  never decrypts), but card_interaction/invoice_paid payloads are
   *  plaintext and would otherwise be actable by anyone who can reach this server. */
  webhookSharedSecret?: string;
  /** This process's configured Mediator identity, if any -- enables the
   *  "observe the shared chat silently, only speak in private coaching
   *  chats" gate. */
  mediatorAgentId?: number;
  logger?: Logger;
  onMessage?: (ctx: MessageContext) => Promise<void> | void;
  onCardInteraction?: (ctx: CardInteractionContext) => Promise<void> | void;
  onInvoicePaid?: (ctx: InvoicePaidContext) => Promise<void> | void;
  onHandoffConfirmed?: (ctx: HandoffConfirmedContext) => Promise<void> | void;
  onHandoffReceived?: (ctx: HandoffReceivedContext) => Promise<void> | void;
}

/**
 * Creates the Express app for a Salt agent's webhook endpoint. Mount it
 * yourself (e.g. `createWebhookServer(opts).listen(port)`, or grab `.app`
 * to compose it into a bigger server).
 */
export function createWebhookServer(options: WebhookServerOptions): { app: Express; listen: (port: number) => void } {
  const { client, identities, pgpPassphrase, webhookSharedSecret, mediatorAgentId } = options;
  const logger = options.logger ?? consoleLogger;

  const app = express();
  app.use(express.json());

  // Salt fires one webhook per chat member with a callback URL
  // (Message#send_webhook in salt-api). When two or more identities THIS
  // process hosts share a chat -- which delegation makes possible -- that's
  // multiple deliveries of the SAME message to this SAME endpoint. Only one
  // delivery can ever actually decrypt (the recipient's key), so without
  // this guard that single message gets fully reprocessed once per
  // redundant delivery, including racing past the delegations registry.
  const MAX_SEEN_MESSAGE_IDS = 2000;
  const seenMessageIds = new Set<number | string>();
  function alreadyProcessed(messageId: number | string | undefined): boolean {
    if (messageId == null) return false;
    if (seenMessageIds.has(messageId)) return true;
    seenMessageIds.add(messageId);
    if (seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      const oldest = seenMessageIds.values().next().value;
      if (oldest !== undefined) seenMessageIds.delete(oldest);
    }
    return false;
  }

  // A second, independent safety net beyond delegations.ts's depth limit --
  // that only bounds explicit delegate-call recursion, not two hosted
  // agents just organically replying to each other's plain messages once a
  // conversation starts. Cap it hard: once a chat between two identities
  // THIS process hosts crosses this many auto-replies, the receiving
  // identity just stops answering the other one there, until a human sends
  // something new (which resets the count).
  const MAX_AGENT_TO_AGENT_REPLIES_PER_CHAT = 2;
  const agentToAgentReplyCounts = new Map<number, number>();

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      identities: identities.all().map((i) => ({ salt_app_id: i.saltAppId, username: i.username })),
    });
  });

  // Every identity this process hosts shares this one endpoint, so the
  // first step is figuring out *which* identity a given message is
  // addressed to. Salt encrypts the message to every chat member's public
  // key as a single multi-recipient PGP blob -- it only decrypts with a
  // private key that was actually a member of that chat, so trying each
  // known identity in turn and keeping whichever one succeeds is both
  // correct and cheap for the small number of identities a process hosts.
  async function resolveIdentity(ciphertext: string): Promise<{ identity: AgentIdentity; plaintext: string } | null> {
    for (const candidate of identities.all()) {
      try {
        const plaintext = await pgp.decrypt(ciphertext, candidate.privateKey, pgpPassphrase);
        return { identity: candidate, plaintext };
      } catch {
        // Not addressed to this identity -- try the next one.
      }
    }
    return null;
  }

  // Fetches + decrypts a chat's recent messages with `identity`'s own key.
  // Correct for any genuine member (including a silent observer): every
  // message posted since joining was multi-recipient-encrypted to include
  // that key. Messages from before joining simply fail to decrypt and are
  // skipped -- the same degrade-gracefully convention Salt's own clients use.
  async function buildSharedChatContext(identity: AgentIdentity, sharedChatId: number | string): Promise<string> {
    let messages: unknown[];
    try {
      messages = await client.getChatMessages(identity.apiKey, sharedChatId);
    } catch (err) {
      logger.error(`[shared-context] fetching chat ${sharedChatId} failed: ${(err as Error).message}`);
      return "(couldn't load the conversation)";
    }
    const lines: string[] = [];
    for (const raw of messages) {
      const m = raw as { event_type?: string; message?: string; user?: { display_name?: string } };
      if (m.event_type || typeof m.message !== "string" || !PGP_MESSAGE_RE.test(m.message)) continue;
      try {
        const text = await pgp.decrypt(m.message, identity.privateKey, pgpPassphrase);
        lines.push(`${m.user?.display_name || "someone"}: ${text}`);
      } catch {
        // Predates this identity joining the chat -- skip silently.
      }
    }
    return lines.length ? lines.join("\n") : "(no messages yet)";
  }

  // Decrypts an attachment's PGP metadata blob (key/iv/filename/content_type),
  // downloads the ciphertext, and AES-GCM-decrypts it. Only images are
  // returned with actual bytes -- the SDK doesn't know how any given model
  // wants other file types represented, so those get a text note instead.
  async function decryptAttachmentIfPresent(
    identity: AgentIdentity,
    message: { message_id: number | string; resource?: { encrypted_key?: string } }
  ): Promise<DecryptedAttachment | undefined> {
    if (!message.resource?.encrypted_key) return undefined;
    try {
      const metaJson = await pgp.decrypt(message.resource.encrypted_key, identity.privateKey, pgpPassphrase);
      const meta = JSON.parse(metaJson) as { filename: string; content_type?: string; size: number; key: string; iv: string };

      if (!meta.content_type?.startsWith("image/")) {
        return {
          filename: meta.filename,
          contentType: meta.content_type || "unknown",
          size: meta.size,
          unsupportedNote: `attached file: ${meta.filename}, ${meta.content_type || "unknown type"}, ${meta.size} bytes -- not viewable, only images are.`,
        };
      }
      const ciphertextBytes = await client.getAttachment(identity.apiKey, message.message_id);
      const plaintext = pgp.decryptAttachment(ciphertextBytes, meta.key, meta.iv);
      return { filename: meta.filename, contentType: meta.content_type, size: meta.size, data: plaintext };
    } catch (err) {
      logger.error(`[attachment] failed to decrypt: ${(err as Error).message}`);
      return undefined;
    }
  }

  // Pings the typing indicator for the duration of `fn` -- callers wrap the
  // WHOLE "decide what to say, then say it" arc with this (not just the
  // final post), since that first part (asking a model) is almost always
  // the slow one and is exactly when a human benefits from seeing
  // "X is typing...". Rides the existing ephemeral typing channel
  // (content-free, receivers self-expire after ~4s) on the same 2.5s
  // cadence the human composer uses.
  async function withTypingHeartbeat<T>(identity: AgentIdentity, chatId: number, fn: () => Promise<T>): Promise<T> {
    void client.signalTyping(identity.apiKey, chatId);
    const timer = setInterval(() => void client.signalTyping(identity.apiKey, chatId), 2500);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }

  // Builds the reply() closure shared by every context type:
  // encrypt-for-every-recipient + post + drain this reply's delegation
  // trail onto it + fire-and-forget metrics. Does NOT itself manage the
  // typing indicator -- see withTypingHeartbeat, which wraps the whole
  // callback (including whatever happens before reply() is even called).
  function makeReply(identity: AgentIdentity, chatId: number): (text: string) => Promise<void> {
    return async (text: string) => {
      const startedAt = Date.now();
      let recipientKeys: string[];
      try {
        const members = await client.getChatMembers(identity.apiKey, chatId);
        recipientKeys = members
          .filter((u) => parseInt(String(u.id), 10) !== identity.saltAppId && u.public_key)
          .map((u) => u.public_key as string);
      } catch (err) {
        logger.error(`[chat ${chatId}] fetching members failed: ${(err as Error).message}`);
        return;
      }
      if (recipientKeys.length === 0) {
        logger.error(`[chat ${chatId}] no recipient public keys; not sending.`);
        return;
      }

      let encryptedMessage: string, senderMessage: string;
      try {
        encryptedMessage = await pgp.encryptFor(text, recipientKeys);
        senderMessage = await pgp.encryptFor(text, [identity.publicKey]);
      } catch (err) {
        logger.error(`[chat ${chatId}] encryption failed: ${(err as Error).message}`);
        return;
      }

      const trail = delegations.drainTrail(identity.saltAppId, chatId);
      try {
        await client.postMessage(identity.apiKey, chatId, encryptedMessage, senderMessage, trail);
      } catch (err) {
        logger.error(`[chat ${chatId}] posting reply failed: ${(err as Error).message}`);
        return;
      }
      client.trackEvent(identity.apiKey, "agent_reply_sent", {
        chat_id: chatId,
        latency_ms: Date.now() - startedAt,
        delegation_count: (trail || []).length,
      });
    };
  }

  async function handleMessage(body: { message: Record<string, unknown>; chat?: RawChatMeta }): Promise<void> {
    const message = body.message;
    const chatId = message.chat_id as number;
    const chatMeta = body.chat;

    if (alreadyProcessed(message.message_id as number | string)) return;
    if (message.event_type) return; // system events aren't prompts

    const ciphertext = message.message;
    if (typeof ciphertext !== "string" || !PGP_MESSAGE_RE.test(ciphertext)) return;

    const resolved = await resolveIdentity(ciphertext);
    if (!resolved) {
      logger.error(`[chat ${chatId}] no known identity could decrypt this message; ignoring.`);
      return;
    }
    let { identity, plaintext: caption } = resolved;

    // GACM routing fix: salt-api sends one webhook delivery PER agent
    // member, but they all land on this shared server and message-id dedup
    // collapses them into a single pass -- whose decrypt-resolved identity
    // is arbitrary (any member key opens a multi-recipient blob). When the
    // chat declares an active agent that's hosted here, hand this pass to
    // THAT identity; the plaintext is identical under any key, only "who
    // replies" changes.
    if (chatMeta?.active_agent_id) {
      const active = identities.get(parseInt(String(chatMeta.active_agent_id), 10));
      if (active) identity = active;
    }

    const senderRaw = message.user as RawSender | undefined;
    const senderId = senderRaw ? parseInt(String(senderRaw.id), 10) : NaN;

    // Reply to a pending delegation call? Hand it to that waiting promise
    // instead of starting a fresh reply cycle -- see delegations.ts.
    if (delegations.resolveIfPending(chatId, senderId, caption)) return;

    // Never reply to our own messages (the reply we post is itself
    // delivered back to us as a webhook) -- this is what prevents an
    // infinite loop.
    if (senderId === identity.saltAppId) return;

    // Mediated Chat: this identity is the configured Mediator, and this
    // message is in the SHARED chat it silently observes -- present for
    // context, but it only actually speaks in each human's own private
    // coaching chat (coaching_for_chat_id pointing back at this one).
    const isMediator = !!mediatorAgentId && identity.saltAppId === mediatorAgentId;
    if (isMediator && chatMeta?.mediator_agent_id && !chatMeta.coaching_for_chat_id) return;

    // Global Agent Chat Mode: when the chat declares an active agent and
    // it isn't this identity, stay silent. Lets retired/handed-off-from
    // agents remain in the room without ever double-replying.
    if (chatMeta?.active_agent_id && String(chatMeta.active_agent_id) !== String(identity.saltAppId)) return;

    // A human sender always resets the count -- only agent-to-agent
    // volleys are capped, never a real conversation with a person.
    const senderIsAgent = !!identities.get(senderId) || senderRaw?.account_type === "Agent";
    if (senderIsAgent) {
      const count = (agentToAgentReplyCounts.get(chatId) || 0) + 1;
      agentToAgentReplyCounts.set(chatId, count);
      if (count > MAX_AGENT_TO_AGENT_REPLIES_PER_CHAT) {
        logger.error(`[chat ${chatId}] agent-to-agent reply cap reached; not auto-replying to ${senderId} again.`);
        return;
      }
    } else {
      agentToAgentReplyCounts.delete(chatId);
    }

    const { depth, text: strippedCaption } = delegations.parseIncoming(caption);

    let mediatorSharedContext: string | undefined;
    let attachment: DecryptedAttachment | undefined;
    if (isMediator && chatMeta?.coaching_for_chat_id) {
      mediatorSharedContext = await buildSharedChatContext(identity, chatMeta.coaching_for_chat_id);
    } else if (message.resource_type === "Attachment") {
      attachment = await decryptAttachmentIfPresent(identity, message as { message_id: number; resource?: { encrypted_key?: string } });
    }

    if (!options.onMessage) return;
    const ctx: MessageContext = {
      identity,
      chatId,
      senderId,
      sender: senderRaw as RawSender,
      text: strippedCaption,
      delegationDepth: depth,
      chatMeta,
      mediatorSharedContext,
      attachment,
      reply: makeReply(identity, chatId),
    };
    try {
      await withTypingHeartbeat(identity, chatId, () => Promise.resolve(options.onMessage!(ctx)));
    } catch (err) {
      logger.error(`[chat ${chatId}] onMessage failed: ${(err as Error).message}`);
      // Discard any trail entries a partial run recorded -- there's no
      // reply for them to ride on, and they must not leak onto the next one.
      delegations.drainTrail(identity.saltAppId, chatId);
    }
  }

  async function handleCardInteraction(body: {
    owner_id: number | string;
    chat_id: number;
    card_id: number | string;
    action_id: string;
    user: RawSender;
    state?: { blocks?: unknown };
  }): Promise<void> {
    const identity = identities.get(parseInt(String(body.owner_id), 10));
    if (!identity || !options.onCardInteraction) return;
    try {
      await options.onCardInteraction({
        identity,
        chatId: body.chat_id,
        cardId: body.card_id,
        actionId: body.action_id,
        user: body.user,
        blocks: body.state?.blocks,
      });
    } catch (err) {
      logger.error(`[chat ${body.chat_id}] onCardInteraction failed: ${(err as Error).message}`);
    }
  }

  async function handleInvoicePaid(body: {
    seller_id: number | string;
    chat_id?: number;
    buyer: RawSender;
    line_items?: Array<{ name: string; qty: number }>;
    amount: string | number;
    billing_account_id?: number | string;
    transfer_request_id: number | string;
  }): Promise<void> {
    const identity = identities.get(parseInt(String(body.seller_id), 10));
    if (!identity || !body.chat_id || !options.onInvoicePaid) return;
    const chatId = body.chat_id;
    const ctx: InvoicePaidContext = {
      identity,
      chatId,
      buyer: body.buyer,
      lineItems: body.line_items || [],
      amount: body.amount,
      isTopUp: !!body.billing_account_id,
      transferRequestId: body.transfer_request_id,
      reply: makeReply(identity, chatId),
    };
    try {
      await withTypingHeartbeat(identity, chatId, () => Promise.resolve(options.onInvoicePaid!(ctx)));
    } catch (err) {
      logger.error(`[chat ${chatId}] onInvoicePaid failed: ${(err as Error).message}`);
    }
  }

  async function handleHandoffConfirmed(body: { from_agent_id: number | string; chat_id: number; reason?: string }): Promise<void> {
    const identity = identities.get(parseInt(String(body.from_agent_id), 10));
    if (!identity || !options.onHandoffConfirmed) return;
    const chatId = body.chat_id;
    const ctx: HandoffConfirmedContext = { identity, chatId, reason: body.reason, reply: makeReply(identity, chatId) };
    try {
      await withTypingHeartbeat(identity, chatId, () => Promise.resolve(options.onHandoffConfirmed!(ctx)));
    } catch (err) {
      logger.error(`[chat ${chatId}] onHandoffConfirmed failed: ${(err as Error).message}`);
    }
  }

  async function handleHandoffReceived(body: { to_agent_id: number | string; chat_id: number; reason?: string }): Promise<void> {
    const identity = identities.get(parseInt(String(body.to_agent_id), 10));
    if (!identity || !options.onHandoffReceived) return;
    const chatId = body.chat_id;

    // handoff_confirmed and handoff_received fire at the same moment, but
    // the outgoing agent still has to COMPOSE its briefing -- introduce too
    // fast and there's nothing to ground it in yet. Poll until the
    // HANDOFF_BRIEFING_MARKER shows up (or ~20s passes, e.g. the outgoing
    // agent isn't hosted anywhere reachable / errored).
    let context = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      context = await buildSharedChatContext(identity, chatId);
      if (context.includes(HANDOFF_BRIEFING_MARKER)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const ctx: HandoffReceivedContext = { identity, chatId, reason: body.reason, context, reply: makeReply(identity, chatId) };
    try {
      await withTypingHeartbeat(identity, chatId, () => Promise.resolve(options.onHandoffReceived!(ctx)));
    } catch (err) {
      logger.error(`[chat ${chatId}] onHandoffReceived failed: ${(err as Error).message}`);
    }
  }

  async function dispatch(body: Record<string, unknown>): Promise<void> {
    if (body?.type === "card_interaction") return handleCardInteraction(body as never);
    if (body?.type === "invoice_paid") return handleInvoicePaid(body as never);
    if (body?.type === "handoff_confirmed") return handleHandoffConfirmed(body as never);
    if (body?.type === "handoff_received") return handleHandoffReceived(body as never);
    if (body?.message) return handleMessage(body as never);
  }

  // salt-api's WebhookJob POSTs here with { chat, message } (or a typed
  // event body for card/invoice/handoff). Ack immediately (200) and process
  // in the background so a slow agent-loop call can't make Salt's webhook
  // delivery time out.
  //
  // WEBHOOK_SHARED_SECRET: when this server is publicly reachable, anyone
  // can POST here. Encrypted-message webhooks fail safe (forged ciphertext
  // never decrypts), but card_interaction/invoice_paid payloads are
  // PLAINTEXT and would be acted on -- so when the secret is configured
  // (production), every POST must carry the matching header salt-api's
  // jobs send. Unset (local dev), the check is skipped entirely.
  app.post("/", (req, res) => {
    if (webhookSharedSecret && req.get("X-Salt-Webhook-Secret") !== webhookSharedSecret) {
      res.status(401).json({ error: "invalid webhook secret" });
      return;
    }
    res.status(200).json({ status: "accepted" });
    dispatch(req.body).catch((err) => logger.error(`[webhook] unhandled error: ${(err as Error).message}`));
  });

  return {
    app,
    listen(port: number) {
      app.listen(port, () => logger.info(`salt-agent-sdk webhook server listening on :${port}`));
    },
  };
}
