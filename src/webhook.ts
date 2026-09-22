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

import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import * as asks from "./ask.js";
import type { AskOptions, AskResult } from "./ask.js";
import type { SaltClient } from "./client";
import * as pgp from "./crypto";
import * as delegations from "./delegations";
import type { AgentIdentity, IdentityStore } from "./identities";
import { sameId, type SaltId } from "./ids.js";
import { reconcileIdentityIds } from "./reconcile";
import * as sessions from "./sessions";
import type { Session, SessionStore, SessionTurn } from "./sessions";

const PGP_MESSAGE_RE = /^-----BEGIN PGP MESSAGE/;

/** See MessageContext.deliveredBecause / SessionTurn.deliveredBecause. */
export type DeliveredBecause = "mention" | "reply" | "keyword" | "all";
const DELIVERED_BECAUSE_VALUES = new Set<string>(["mention", "reply", "keyword", "all"]);

/** Narrows salt-api's `message.delivered_because` (a plain string, only
 *  ever present on an open-room delivery) to the known union -- anything
 *  else (missing, or a value this SDK version doesn't recognise yet)
 *  becomes undefined rather than an unchecked cast, so a future kind added
 *  server-side degrades to "unknown reason" instead of lying about it. */
function parseDeliveredBecause(raw: unknown): DeliveredBecause | undefined {
  return typeof raw === "string" && DELIVERED_BECAUSE_VALUES.has(raw) ? (raw as DeliveredBecause) : undefined;
}

/** The exact marker a hand-off briefing must start with, so the incoming
 *  agent's polling loop (below) can detect it arrived. Consumers building
 *  the outgoing briefing prompt must instruct their model to emit this
 *  exact line first. */
export const HANDOFF_BRIEFING_MARKER = "[[SALT-HANDOFF-BRIEFING]]";

export interface RawChatMeta {
  active_agent_id?: SaltId;
  mediator_agent_id?: SaltId;
  coaching_for_chat_id?: SaltId;
  /** True when this coaching chat is a PRIVATE advisor lane rather than the
   *  mutual Mediator lane. A private advisor is not a member of the shared
   *  chat and therefore cannot decrypt it -- this flag stops us asking. */
  private_lane?: boolean;
  /** The kind of lane this chat is, when it is one. "consult" for a lane consult_agent opened -- see webhook.ts's CONSULT_RUNAWAY_LIMIT and actions.ts's request_floor. Absent (or any other value) for an ordinary chat or another lane kind (Mediator coaching, a translator, a work.ts report lane). */
  lane_kind?: string;
  mode?: "auto" | "manual";
  [key: string]: unknown;
}

export interface RawSender {
  id: SaltId;
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
  chatId: SaltId;
  senderId: SaltId;
  sender: RawSender;
  /** Delegation- and consult-marker-stripped plaintext (see delegations.parseIncoming / delegations.stripConsultMarker). */
  text: string;
  /** False for an open-room message (salt-api's `message.encrypted === false`
   *  on the delivery) -- `text` came straight off the wire with no PGP
   *  decrypt attempted, so a reply into this chat should go through
   *  `client.postPlainMessage`, never `reply()`'s normal encrypt-for-every-
   *  member path. True (the default) for an ordinary end-to-end encrypted
   *  chat. See client.ts's postPlainMessage/setChatSubscription. */
  encrypted: boolean;
  /** Why THIS delivery reached this identity, on an open room only --
   *  salt-api's `message.delivered_because` (present only alongside
   *  `encrypted: false`; undefined for an ordinary encrypted chat, where
   *  every member always gets every message and the question doesn't
   *  apply). `"mention"`/`"reply"` are the two ways an `"addressed"`
   *  subscription (client.ts's setChatSubscription) can trigger; `"keyword"`
   *  is one of that subscription's own `keywords` appearing in the message;
   *  `"all"` means the subscription just wants everything. */
  deliveredBecause?: DeliveredBecause;
  /** Delegation hop depth this message arrived at; pass through to any further delegate call. */
  delegationDepth: number;
  chatMeta?: RawChatMeta;
  /** The shared chat this message's conversation ultimately serves --
   *  `chatId` itself for an ordinary chat, or `chatMeta.coaching_for_chat_id`
   *  when `chatId` is a lane (a sidechain, Mediator coaching, a consult).
   *  Lets a handler act on "the room" even while replying inside a lane
   *  (e.g. request_floor's hand-off target). */
  roomId: SaltId;
  /** Set when this identity is the configured Mediator privately coaching
   *  someone about a shared chat it also observes -- the generic decrypted
   *  transcript of that shared chat (not yet wrapped in any prompt framing). */
  mediatorSharedContext?: string;
  /** Set when the inbound message was an Attachment with decryptable metadata. */
  attachment?: DecryptedAttachment;
  /** This identity's memory of `chatId`: recent turns and a short note,
   *  loaded (or rebuilt from chat history, on a cold start) before this
   *  handler runs and persisted after it returns. A plain mutable object --
   *  write to `session.note` directly (e.g. session.note.goal, or push onto
   *  session.note.consulted) to have it survive a restart and ride along a
   *  hand-off. Ignore it entirely and nothing changes. */
  session: Session;
  /** Encrypts `text` for every current chat member (+ this identity's own
   *  copy), posts it, drains this reply's delegation trail onto it, and
   *  emits an agent_reply_sent metric. Handles a typing-indicator heartbeat
   *  for the duration of the call automatically. */
  reply(text: string): Promise<void>;
  /** Asks a quick inline question (K3) -- a card with one button per
   *  option, plus (by default, when there are no options) an invitation to
   *  type a free-form reply -- and resolves with whichever answer arrives
   *  first. Works identically under webhook and socket mode. See ask.ts. */
  ask(question: string, opts?: AskOptions): Promise<AskResult>;
  /** Sugar for `ask` with Yes/No buttons. See ask.ts's approve(). */
  approve(summary: string, opts?: { timeoutMs?: number }): Promise<{ approved: boolean; by: SaltId; via: "button" | "message" }>;
}

export interface CardInteractionContext {
  identity: AgentIdentity;
  chatId: SaltId;
  cardId: SaltId;
  actionId: string;
  user: RawSender;
  blocks: unknown;
  /** This identity's memory of `chatId` (see MessageContext.session). Loaded
   *  before this handler runs, same as everywhere else -- but there's no
   *  reply() here (a card update IS the response), so nothing is appended
   *  or persisted afterward. Read it; write session.note if you want, but
   *  know it won't be saved from this call. */
  session: Session;
}

export interface InvoicePaidContext {
  identity: AgentIdentity;
  chatId: SaltId;
  buyer: RawSender;
  lineItems: Array<{ name: string; qty: number; [key: string]: unknown }>;
  amount: string | number;
  /** True for a "Credits top-up" invoice -- no delivery owed, the credit already landed server-side. */
  isTopUp: boolean;
  transferRequestId: SaltId;
  /** This identity's memory of `chatId` (see MessageContext.session). Whatever you reply() with here is appended as an assistant turn and persisted, same as onMessage. */
  session: Session;
  reply(text: string): Promise<void>;
  /** See MessageContext.ask. */
  ask(question: string, opts?: AskOptions): Promise<AskResult>;
  /** See MessageContext.approve. */
  approve(summary: string, opts?: { timeoutMs?: number }): Promise<{ approved: boolean; by: SaltId; via: "button" | "message" }>;
}

export interface ChatOpenedChat {
  id: SaltId;
  name?: string;
  public?: boolean;
  managed?: boolean;
  open_invite?: boolean;
  mode?: "auto" | "manual";
  active_agent_id?: SaltId;
  mediator_agent_id?: SaltId;
  coaching_for_chat_id?: SaltId;
  private_lane?: boolean;
  [key: string]: unknown;
}

export interface ChatOpenedMember extends RawSender {
  observer?: boolean;
}

export interface ChatOpenedContext {
  identity: AgentIdentity;
  chatId: SaltId;
  chat: ChatOpenedChat;
  /** The person (or agent -- see `openedBy.account_type`) who newly opened
   *  this chat: a fresh 1:1, a new group that includes this identity, or an
   *  add-to-an-existing-group. */
  openedBy: RawSender;
  /** Every current member, including this identity's own account. */
  members: ChatOpenedMember[];
  openedAt: string;
  /** This identity's memory of `chatId` (see MessageContext.session). Whatever you reply() with here (e.g. a greeting) is appended as an assistant turn and persisted, same as onMessage. */
  session: Session;
  /** Encrypts `text` for every current chat member (+ this identity's own
   *  copy) and posts it -- the same closure every other context type gets. */
  reply(text: string): Promise<void>;
  /** See MessageContext.ask. */
  ask(question: string, opts?: AskOptions): Promise<AskResult>;
  /** See MessageContext.approve. */
  approve(summary: string, opts?: { timeoutMs?: number }): Promise<{ approved: boolean; by: SaltId; via: "button" | "message" }>;
}

export interface HandoffConfirmedContext {
  identity: AgentIdentity;
  chatId: SaltId;
  reason?: string;
  /** Set only when this hand-off was triggered automatically by the
   *  consulted agent's request_floor call rather than a model-chosen
   *  hand_off_to_agent/hand_back_to_concierge: the consult lane's decrypted
   *  transcript so far (capped), for the briefing to draw on. */
  consultTranscript?: string;
  /** This identity's memory of `chatId` (see MessageContext.session): the
   *  tail and note it built up while it was the active agent here, so a
   *  briefing composed from it isn't starting cold. Whatever you reply()
   *  with (the briefing) is appended as an assistant turn and persisted --
   *  moot once you've handed off, but there if you're ever handed this
   *  chat again later. */
  session: Session;
  reply(text: string): Promise<void>;
  /** See MessageContext.ask. */
  ask(question: string, opts?: AskOptions): Promise<AskResult>;
  /** See MessageContext.approve. */
  approve(summary: string, opts?: { timeoutMs?: number }): Promise<{ approved: boolean; by: SaltId; via: "button" | "message" }>;
}

export interface HandoffReceivedContext {
  identity: AgentIdentity;
  chatId: SaltId;
  reason?: string;
  /** The shared chat's decrypted transcript, polled for up to ~20s until
   *  the outgoing agent's HANDOFF_BRIEFING_MARKER shows up (or timeout). */
  context: string;
  /** This identity's memory of `chatId`, seeded from the outgoing agent's
   *  session note (see sessions.ts's SESSION_NOTE_MARKER) when the briefing
   *  carried one. Whatever you reply() with here (your introduction) is
   *  appended as an assistant turn and persisted, so it's already in
   *  transcriptTail by the time the next onMessage call for this chat runs. */
  session: Session;
  reply(text: string): Promise<void>;
  /** See MessageContext.ask. */
  ask(question: string, opts?: AskOptions): Promise<AskResult>;
  /** See MessageContext.approve. */
  approve(summary: string, opts?: { timeoutMs?: number }): Promise<{ approved: boolean; by: SaltId; via: "button" | "message" }>;
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
  /** Verify the HMAC signature salt-api sends on every callback.
   *
   *  Defaults ON. Each identity has its OWN signing key, fetched from salt-api
   *  with that identity's api key and cached. This replaced a single fleet-wide
   *  WEBHOOK_SHARED_SECRET: because anyone could register an agent pointing at
   *  their own server, that secret leaked to any caller who asked for it, and a
   *  secret shared with the parties you authenticate against cannot prove who
   *  sent a request.
   *
   *  Encrypted-message webhooks fail safe regardless (forged ciphertext never
   *  decrypts), but card_interaction/invoice_paid/chat_opened payloads are
   *  PLAINTEXT and would otherwise be actable by anyone who can reach this
   *  server.
   *
   *  Set false only for local development against a dev salt-api. */
  verifySignatures?: boolean;
  /** Reject signatures older than this, so a captured POST can't be replayed. */
  signatureToleranceSeconds?: number;
  /** This process's configured Mediator identity, if any -- enables the
   *  "observe the shared chat silently, only speak in private coaching
   *  chats" gate. */
  mediatorAgentId?: SaltId;
  /** Where each hosted identity's per-chat session (recent turns + a short
   *  note) is kept. Defaults to an in-memory store (lost on restart --
   *  onMessage still gets a session on a cold start, rebuilt from the
   *  chat's own history). Pass `sessions.FileSessionStore(dir)` to persist
   *  across restarts; see sessions.ts for the trust boundary that store's
   *  own doc comment states plainly (plaintext on disk, no extra
   *  encryption -- the same trust level identities.json already assumes). */
  sessionStore?: SessionStore;
  logger?: Logger;
  onMessage?: (ctx: MessageContext) => Promise<void> | void;
  onCardInteraction?: (ctx: CardInteractionContext) => Promise<void> | void;
  onInvoicePaid?: (ctx: InvoicePaidContext) => Promise<void> | void;
  onChatOpened?: (ctx: ChatOpenedContext) => Promise<void> | void;
  onHandoffConfirmed?: (ctx: HandoffConfirmedContext) => Promise<void> | void;
  onHandoffReceived?: (ctx: HandoffReceivedContext) => Promise<void> | void;
  /** Extra fields to merge into the /health JSON response (e.g. which model is configured). */
  healthExtra?: () => Record<string, unknown>;
}

/**
 * Everything about the Salt protocol that is NOT "how do bytes get to this
 * process" -- signature verification and the decrypt/route/dedup/reply
 * logic for every webhook event kind. `createWebhookServer` below wraps
 * this in an Express POST route (the only transport before K2); socket.ts's
 * `createSocketClient` wraps the SAME dispatcher around a websocket push
 * connection instead, so a consumer switches delivery mode with no change
 * to onMessage/onCardInteraction/etc. -- see socket.ts's own doc comment.
 */
export function createDispatcher(options: WebhookServerOptions): Dispatcher {
  const { client, identities, pgpPassphrase, mediatorAgentId } = options;
  const logger = options.logger ?? consoleLogger;
  const verifySignatures = options.verifySignatures !== false;
  const signatureTolerance = options.signatureToleranceSeconds ?? 300;
  const sessionStore = options.sessionStore ?? sessions.MemorySessionStore();
  const mapKey = (id: SaltId): string => String(id).toLowerCase();

  // A lookup miss on a signed request is the signature of a stale store: the
  // id salt-api signs with is not the one the identity was registered under
  // (see reconcile.ts). Ask the API once, then look again. Throttled so an
  // unknown-agent POST from the open internet costs at most one round of
  // whoAmI calls a minute, and single-flight so a burst shares one pass.
  const RECONCILE_MIN_INTERVAL_MS = 60_000;
  let lastReconcileAt = 0;
  let reconcileInFlight: Promise<unknown> | null = null;
  function reconcileOnMiss(): Promise<unknown> {
    if (reconcileInFlight) return reconcileInFlight;
    if (Date.now() - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) return Promise.resolve();
    lastReconcileAt = Date.now();
    reconcileInFlight = reconcileIdentityIds(identities, client, logger)
      .catch((err) => logger.error(`[webhook] identity reconcile failed: ${(err as Error).message}`))
      .finally(() => {
        reconcileInFlight = null;
      });
    return reconcileInFlight;
  }

  // One signing key per identity, fetched lazily with that identity's own api
  // key and cached. A miss is not fatal on its own -- verifyRequest decides.
  const secretCache = new Map<string, string>();
  async function secretForAgent(agentId: SaltId): Promise<string | undefined> {
    const cacheKey = String(agentId).toLowerCase();
    const cached = secretCache.get(cacheKey);
    if (cached) return cached;
    let identity = identities.get(agentId);
    if (!identity) {
      await reconcileOnMiss();
      identity = identities.get(agentId);
    }
    if (!identity) return undefined;
    try {
      const secret = await client.getWebhookSecret(identity.apiKey);
      if (secret) secretCache.set(cacheKey, secret);
      return secret;
    } catch (err) {
      logger.error(`[webhook] could not fetch signing key for agent ${agentId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  // R1 (round 3, 2026-09-18): a bounded, rate-limited recheck for the ONE
  // case that can still legitimately race a rotation now that salt-api
  // signs socket-mode envelopes fresh at serve time (LANES.md) -- a real
  // webhook POST, which IS signed at send time by the enqueuing job, can
  // still land here with a signature made against a secret that rotated
  // a moment after the job read it but before this cache picked up the
  // change. At most one uncached fetch per agent per 60s, single-flight
  // (a burst of bad signatures for one agent shares the one in-flight
  // check rather than each firing its own), and it NEVER evicts/replaces
  // the cached secret unless the freshly fetched one actually verifies
  // the failing envelope -- a fetch that doesn't fix the problem leaves
  // the cache exactly as it was. Round 2's per-envelope evict-and-refetch
  // (and its one-time "transient" grace) is gone entirely: with
  // serve-time signing the socket path never needs it, and this bounded
  // version is what's left for the webhook path.
  const UNCACHED_CHECK_MIN_INTERVAL_MS = 60_000;
  const lastUncachedCheckAt = new Map<string, number>();
  const uncachedCheckInFlight = new Map<string, Promise<string | undefined>>();
  function uncachedSecretCheck(agentId: SaltId, cacheKey: string): Promise<string | undefined> {
    const inFlight = uncachedCheckInFlight.get(cacheKey);
    if (inFlight) return inFlight;
    const lastAt = lastUncachedCheckAt.get(cacheKey) ?? 0;
    if (Date.now() - lastAt < UNCACHED_CHECK_MIN_INTERVAL_MS) return Promise.resolve(undefined);
    lastUncachedCheckAt.set(cacheKey, Date.now());
    const promise = (async () => {
      const identity = identities.get(agentId);
      if (!identity) return undefined;
      try {
        return await client.getWebhookSecret(identity.apiKey);
      } catch (err) {
        logger.error(`[webhook] uncached signing-key recheck for agent ${agentId} failed: ${(err as Error).message}`);
        return undefined;
      }
    })().finally(() => {
      uncachedCheckInFlight.delete(cacheKey);
    });
    uncachedCheckInFlight.set(cacheKey, promise);
    return promise;
  }

  // Verifies one envelope's signature. Takes the two headers and the raw
  // body explicitly rather than an Express Request -- the SAME check runs
  // for a webhook POST (createWebhookServer passes req.get(...) and the
  // captured rawBody) and for a socket-mode envelope (socket.ts passes the
  // AgentUpdate row's `headers`/`body` fields verbatim), so this function
  // must not assume either transport.
  //
  // `toleranceSeconds` overrides the default (signatureTolerance, ~300s)
  // for a caller with its own reason to -- round 3 removed socket.ts's
  // widened one (serve-time signing means a socket envelope's timestamp
  // is always fresh too), so both transports use the same standard window
  // by default now.
  //
  // `transient: true` marks a failure that might resolve on retry (right
  // now, only "no signing key" -- secretForAgent already swallows its own
  // network errors and returns undefined either way, so this can't
  // distinguish "genuinely no such identity" from "the fetch failed" any
  // more finely than that) -- socket.ts must not advance its cursor past a
  // row that failed for a transient reason, or a real update sitting
  // behind a network blip would be skipped forever.
  async function verifyEnvelope(
    agentId: string | undefined,
    signature: string | undefined,
    rawBody: string,
    opts?: { toleranceSeconds?: number }
  ): Promise<{ ok: true } | { ok: false; reason: string; transient: boolean }> {
    if (!verifySignatures) return { ok: true };

    // Taken as sent. `Number(...)` here made agentId NaN for every real
    // request, NaN is falsy, and so EVERY signed webhook was rejected as
    // "missing signature" -- the header was present and correctly formed.
    if (!agentId || !signature) return { ok: false, reason: "missing signature", transient: false };

    const t = /t=(\d+)/.exec(signature)?.[1];
    const v1 = /v1=([0-9a-f]+)/.exec(signature)?.[1];
    if (!t || !v1) return { ok: false, reason: "malformed signature", transient: false };

    // Replay window. Also rejects a clock far in the future.
    const tolerance = opts?.toleranceSeconds ?? signatureTolerance;
    const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
    if (age > tolerance) return { ok: false, reason: `stale signature (${age}s old)`, transient: false };

    const secret = await secretForAgent(agentId);
    if (!secret) return { ok: false, reason: `no signing key for agent ${agentId}`, transient: true };

    const cacheKey = String(agentId).toLowerCase();

    // Constant-time: a fast string compare leaks the digest a byte at a time.
    const verify = (withSecret: string): boolean => {
      const expected = createHmac("sha256", withSecret).update(`${t}.${rawBody}`).digest("hex");
      const a = Buffer.from(v1, "utf8");
      const b = Buffer.from(expected, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    };

    if (verify(secret)) return { ok: true };

    // Pre-round-2 behaviour, restored: a bad signature is definitive --
    // UNLESS the bounded recheck above finds a genuinely different
    // secret that verifies it, in which case it self-heals silently and
    // the cache picks up the new value. Never transient, never retried.
    const fresh = await uncachedSecretCheck(agentId, cacheKey);
    // The fresh secret comes from salt-api under the agent's own key, so it is
    // authoritative: adopt it whenever it differs, even if THIS envelope doesn't
    // verify under it, or a leaked old secret stays accepted after a rotation.
    if (fresh && fresh !== secret) {
      secretCache.set(cacheKey, fresh);
      if (verify(fresh)) return { ok: true };
    }
    return { ok: false, reason: "bad signature", transient: false };
  }

  // Salt fires one webhook per chat member with a callback URL
  // (Message#send_webhook in salt-api). When two or more identities THIS
  // process hosts share a chat -- which delegation makes possible -- that's
  // multiple deliveries of the SAME message to this SAME endpoint. Only one
  // delivery can ever actually decrypt (the recipient's key), so without
  // this guard that single message gets fully reprocessed once per
  // redundant delivery, including racing past the delegations registry.
  const MAX_SEEN_MESSAGE_IDS = 2000;
  const seenMessageIds = new Set<number | string>();
  function alreadyProcessed(messageId: SaltId | undefined): boolean {
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
  // A consult lane (actions.ts's consult_agent, chatMeta.lane_kind ===
  // "consult") is a real working conversation between two agents, not an
  // accidental loop -- it needs real back-and-forth room, so it gets its
  // own, much higher ceiling instead of the ordinary chat's cap.
  const CONSULT_RUNAWAY_LIMIT = 20;
  // Keyed by the lowercased chat id, like every other id-keyed map here.
  const agentToAgentReplyCounts = new Map<string, number>();
  // laneChatId (lowercased) -> its room's chat id (lowercased), learned the
  // first time a message is seen in that lane. A human speaking in the ROOM
  // should reset every consult lane rooted there too -- a lane's own count
  // otherwise only resets from someone speaking IN the lane itself, and a
  // busy pair of agents burning through CONSULT_RUNAWAY_LIMIT would stay
  // capped even right after the person who asked for the consult weighs in.
  const laneRoomOf = new Map<string, string>();
  // roomId (lowercased) -> the consult lane chat id a request_floor message
  // just triggered an automatic hand-off from. Set by the floor-request
  // handler right before calling client.handOff, consumed by
  // handleHandoffConfirmed once salt-api's own handoff_confirmed webhook
  // arrives for that room -- that's what lets it attach consultTranscript.
  // Best-effort: a second floor request for the same room before the first
  // hand-off confirms would overwrite this, which is an acceptable rarity.
  const pendingConsultHandoffs = new Map<string, SaltId>();

  // chat_opened has no message_id to dedupe on (it isn't a Message at all),
  // and delivery can be retried -- so a retried delivery must not make this
  // identity greet the same chat twice. Keyed by identity+chat since one
  // process can host several identities and a chat could in principle be
  // opened for more than one of them. Bounded the same way seenMessageIds is.
  const MAX_SEEN_CHAT_OPENED = 2000;
  const seenChatOpened = new Set<string>();
  function alreadyGreeted(identityId: SaltId, chatId: SaltId): boolean {
    const key = `${String(identityId).toLowerCase()}:${String(chatId).toLowerCase()}`;
    if (seenChatOpened.has(key)) return true;
    seenChatOpened.add(key);
    if (seenChatOpened.size > MAX_SEEN_CHAT_OPENED) {
      const oldest = seenChatOpened.values().next().value;
      if (oldest !== undefined) seenChatOpened.delete(oldest);
    }
    return false;
  }

  // Every identity this process hosts shares this one endpoint, so the
  // first step is figuring out *which* identity a given message is
  // addressed to. Salt encrypts the message to every chat member's public
  // key as a single multi-recipient PGP blob -- it only decrypts with a
  // private key that was actually a member of that chat, so trying each
  // known identity in turn and keeping whichever one succeeds is both
  // correct and cheap for the small number of identities a process hosts.
  async function resolveIdentity(
    ciphertext: string,
    headerAgentId?: SaltId
  ): Promise<{ identity: AgentIdentity; plaintext: string } | null> {
    // salt-api signs every callback for a specific RECIPIENT identity and
    // names it in X-Salt-Agent-Id (see rejectionReason above) -- when that
    // names one of ours, try it first. Skips the ambiguity trial-decryption
    // has when this process hosts more than one identity that's a member of
    // the same chat (a delegation or consult lane makes that possible): any
    // member's key opens the multi-recipient blob, so without the header,
    // which one "wins" is just whichever was registered first.
    if (headerAgentId) {
      const preferred = identities.get(headerAgentId);
      if (preferred) {
        try {
          const plaintext = await pgp.decrypt(ciphertext, preferred.privateKey, pgpPassphrase);
          return { identity: preferred, plaintext };
        } catch {
          // The header named a real hosted identity, but this ciphertext
          // isn't addressed to it -- fall through to trial decryption.
        }
      }
    }
    for (const candidate of identities.all()) {
      if (headerAgentId && sameId(candidate.saltAppId, headerAgentId)) continue; // already tried above
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
  async function buildSharedChatContext(identity: AgentIdentity, sharedChatId: SaltId): Promise<string> {
    let messages: unknown[];
    try {
      messages = await client.getChatMessages(identity.apiKey, sharedChatId);
    } catch (err) {
      logger.error(`[shared-context] fetching chat ${sharedChatId} failed: ${(err as Error).message}`);
      return "(couldn't load the conversation)";
    }
    const lines: string[] = [];
    for (const raw of messages) {
      const m = raw as { event_type?: string; message?: string; encrypted?: boolean; user?: { display_name?: string } };
      if (m.event_type || typeof m.message !== "string") continue;
      let text: string;
      if (m.encrypted === false) {
        // Open room (salt-api 0.6x): already plaintext, nothing to decrypt.
        text = m.message;
      } else {
        if (!PGP_MESSAGE_RE.test(m.message)) continue;
        try {
          text = await pgp.decrypt(m.message, identity.privateKey, pgpPassphrase);
        } catch {
          continue; // predates this identity joining the chat -- skip silently.
        }
      }
      lines.push(`${m.user?.display_name || "someone"}: ${text}`);
    }
    return lines.length ? lines.join("\n") : "(no messages yet)";
  }

  // Same idea as buildSharedChatContext, but for a session's cold-start
  // rebuild: structured turns instead of joined display lines, capped to
  // the same MAX_TRANSCRIPT_TURNS a live session is bounded to, and this
  // identity's own messages come back tagged "assistant" rather than folded
  // into "someone: ...". Messages from before `identity` joined fail to
  // decrypt and are skipped -- same degrade-gracefully convention.
  async function rebuildTranscriptTail(identity: AgentIdentity, chatId: SaltId): Promise<SessionTurn[]> {
    let messages: unknown[];
    try {
      messages = await client.getChatMessages(identity.apiKey, chatId);
    } catch (err) {
      logger.error(`[session] fetching chat ${chatId} for cold-start rebuild failed: ${(err as Error).message}`);
      return [];
    }
    const turns: SessionTurn[] = [];
    for (const raw of messages) {
      const m = raw as {
        event_type?: string;
        message?: string;
        encrypted?: boolean;
        delivered_because?: unknown;
        user?: { id?: SaltId; username?: string; display_name?: string };
        created_at?: string;
      };
      if (m.event_type || typeof m.message !== "string") continue;
      let plaintext: string;
      if (m.encrypted === false) {
        // Open room (salt-api 0.6x): already plaintext, nothing to decrypt.
        plaintext = m.message;
      } else {
        if (!PGP_MESSAGE_RE.test(m.message)) continue;
        try {
          plaintext = await pgp.decrypt(m.message, identity.privateKey, pgpPassphrase);
        } catch {
          continue; // predates this identity joining the chat -- skip silently.
        }
      }
      const { text: afterDepth } = delegations.parseIncoming(plaintext);
      const content = delegations.stripConsultMarker(afterDepth);
      const isSelf = sameId(m.user?.id, identity.saltAppId);
      turns.push({
        role: isSelf ? "assistant" : "user",
        content,
        at: m.created_at ? Date.parse(m.created_at) : Date.now(),
        from: isSelf ? undefined : m.user?.username || m.user?.display_name || String(m.user?.id ?? "someone"),
        // Only meaningful for the OTHER party's turn -- this identity's own
        // messages have no "reason it was delivered to me" to report.
        deliveredBecause: isSelf ? undefined : parseDeliveredBecause(m.delivered_because),
      });
    }
    return turns.length > sessions.MAX_TRANSCRIPT_TURNS ? turns.slice(-sessions.MAX_TRANSCRIPT_TURNS) : turns;
  }

  // Loads the stored session for (identity, chatId), or -- on a cold start --
  // builds a fresh one from the chat's own history. Never throws: a session
  // store or rebuild failure falls back to an empty session rather than
  // blocking the message it's here to support.
  async function loadOrRebuildSession(identity: AgentIdentity, chatId: SaltId, chatMeta?: RawChatMeta): Promise<Session> {
    const roomId = (chatMeta?.coaching_for_chat_id as SaltId) || chatId;
    try {
      const existing = await sessionStore.get(identity.saltAppId, chatId);
      if (existing) return existing;
    } catch (err) {
      logger.error(`[session] loading ${chatId} failed: ${(err as Error).message}`);
    }
    const role: Session["role"] = chatMeta?.lane_kind === "consult" ? "consult" : chatMeta?.coaching_for_chat_id ? "lane" : "active";
    const session = sessions.emptySession(chatId, roomId, role);
    try {
      session.transcriptTail = await rebuildTranscriptTail(identity, chatId);
    } catch (err) {
      logger.error(`[session] rebuilding ${chatId} failed: ${(err as Error).message}`);
    }
    return session;
  }

  // Appends each of `repliesForSession` to `session` as an assistant turn,
  // bounds the note, and persists -- shared by every context type that has
  // a reply() worth remembering (onMessage additionally appends its own
  // incoming "user" turn first; see handleMessage, which does that inline
  // since it's the only one with an incoming turn to record at all). Never
  // throws: a persistence failure here must not turn into an unhandled
  // rejection on top of a webhook handler that already ran successfully.
  async function persistSessionAfterReply(
    identityId: SaltId,
    chatId: SaltId,
    session: Session,
    repliesForSession: string[]
  ): Promise<void> {
    try {
      for (const replyText of repliesForSession) {
        sessions.appendTurn(session, { role: "assistant", content: replyText, at: Date.now() });
      }
      session.note = sessions.boundNote(session.note);
      session.updatedAt = Date.now();
      await sessionStore.put(identityId, chatId, session);
    } catch (err) {
      logger.error(`[session] persisting ${chatId} failed: ${(err as Error).message}`);
    }
  }

  // The consult lane's own transcript, for a hand-off briefing that was
  // triggered by a request_floor call rather than chosen by a model turn --
  // see handleHandoffConfirmed. Capped to the last few exchanges; a consult
  // lane that ran long doesn't need its entire history in a briefing.
  const MAX_CONSULT_TRANSCRIPT_LINES = 30;
  async function buildConsultTranscript(identity: AgentIdentity, laneId: SaltId): Promise<string> {
    const full = await buildSharedChatContext(identity, laneId);
    const lines = full.split("\n");
    return lines.length > MAX_CONSULT_TRANSCRIPT_LINES ? lines.slice(-MAX_CONSULT_TRANSCRIPT_LINES).join("\n") : full;
  }

  // Decrypts an attachment's PGP metadata blob (key/iv/filename/content_type),
  // downloads the ciphertext, and AES-GCM-decrypts it. Only images are
  // returned with actual bytes -- the SDK doesn't know how any given model
  // wants other file types represented, so those get a text note instead.
  async function decryptAttachmentIfPresent(
    identity: AgentIdentity,
    message: { message_id: SaltId; resource?: { encrypted_key?: string } }
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
  async function withTypingHeartbeat<T>(identity: AgentIdentity, chatId: SaltId, fn: () => Promise<T>): Promise<T> {
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
  // `addressee` is whoever this reply is answering, when there is one. In a
  // GROUP chat the reply is addressed back to them by handle -- being spoken
  // to by name is how a person tells which of several messages in a busy room
  // is meant for them, and an agent that answers into the middle of a group
  // without naming anyone reads as talking to the room.
  //
  // Two deliberate limits. Only in a group: in a 1:1 there is exactly one
  // person it could be for, and "@dan" on every line is noise. And only for a
  // HUMAN: an agent addressed by handle receives a webhook, so auto-addressing
  // another agent invites exactly the ping-pong the loop caps in this file
  // exist to stop.
  function makeReply(
    identity: AgentIdentity,
    chatId: SaltId,
    addressee?: { id: SaltId; username?: string; account_type?: string } | null
  ): (text: string) => Promise<void> {
    return async (text: string) => {
      const startedAt = Date.now();
      let recipientKeys: string[];
      let memberCount = 0;
      try {
        const members = await client.getChatMembers(identity.apiKey, chatId);
        memberCount = members.length;
        recipientKeys = members
          // Everyone but ourselves. parseInt made both sides NaN, and
          // `NaN !== NaN` is true, so the sender's own key was left in the
          // recipient list rather than filtered out of it.
          .filter((u) => !sameId(u.id, identity.saltAppId) && u.public_key)
          .map((u) => u.public_key as string);
      } catch (err) {
        logger.error(`[chat ${chatId}] fetching members failed: ${(err as Error).message}`);
        return;
      }
      if (recipientKeys.length === 0) {
        logger.error(`[chat ${chatId}] no recipient public keys; not sending.`);
        return;
      }

      // Group + human + a handle to use, and not already addressed by whoever
      // wrote the reply (an agent that writes its own "@dan" keeps it, and
      // does not get a second one bolted on the front).
      const addressHandle =
        memberCount > 2 &&
        addressee?.username &&
        addressee.account_type !== "Agent" &&
        !new RegExp(`(^|\\s)@${addressee.username}(?![\\w.-])`).test(text)
          ? addressee.username
          : null;
      const outgoing = addressHandle ? `@${addressHandle} ${text}` : text;
      // The ids, not the text: Salt only ever sees ciphertext, so an "@handle"
      // in the body is invisible to it and notifies nobody by itself.
      const mentions = addressHandle ? [addressee!.id] : undefined;

      let encryptedMessage: string, senderMessage: string;
      try {
        encryptedMessage = await pgp.encryptFor(outgoing, recipientKeys);
        senderMessage = await pgp.encryptFor(outgoing, [identity.publicKey]);
      } catch (err) {
        logger.error(`[chat ${chatId}] encryption failed: ${(err as Error).message}`);
        return;
      }

      const trail = delegations.drainTrail(identity.saltAppId, chatId);
      try {
        await client.postMessage(identity.apiKey, chatId, encryptedMessage, senderMessage, trail, mentions);
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

  // ctx.ask/ctx.approve (K3, ask.ts) -- bound to one (identity, chatId) the
  // same way makeReply above is, and handed to every context type that
  // gets a reply(). The actual card post/update and pending-wait registry
  // live in ask.ts; resolveCardInteraction/resolveMessage below (wired into
  // handleCardInteraction/handleMessage) are what settle a wait this
  // creates.
  //
  // `defaultAnswererId` (M2, security review) is each context's natural
  // "whoever this turn is answering" -- see the individual ctx-construction
  // call sites for what each context type passes (a message's senderRaw,
  // chat_opened's openedBy, invoice_paid's buyer; the two hand-off contexts
  // have no natural default and pass none, so their ask()/approve() calls
  // must supply `answererId` explicitly). A caller's own `opts.answererId`
  // always wins over this default.
  function makeAsk(
    identity: AgentIdentity,
    chatId: SaltId,
    defaultAnswererId?: SaltId
  ): (question: string, opts?: AskOptions) => Promise<AskResult> {
    return (question: string, opts?: AskOptions) =>
      asks.ask(client, identity, chatId, question, { answererId: defaultAnswererId, ...opts });
  }
  function makeApprove(
    identity: AgentIdentity,
    chatId: SaltId,
    defaultAnswererId?: SaltId
  ): (summary: string, opts?: { timeoutMs?: number; answererId?: SaltId }) => Promise<{ approved: boolean; by: SaltId; via: "button" | "message" }> {
    return (summary: string, opts?: { timeoutMs?: number; answererId?: SaltId }) =>
      asks.approve(client, identity, chatId, summary, { answererId: defaultAnswererId, ...opts });
  }

  // True when `chatId` has at least one human (account_type !== "Agent")
  // member who is NOT a silent observer. A consult lane's human -- the
  // delegation chain's auditor added per actions.ts's delegation-
  // observability note -- is only ever an observer there, so a lane reads as
  // agent-only even though a person can technically decrypt it. `chatMeta`'s
  // own member list is used when a caller already supplied one (mainly
  // tests); the real webhook payload's `chat` never carries members (see
  // salt-api's WebhookJob#user_send allowlist), so this normally falls back
  // to fetching the roster -- the same call makeReply above already makes to
  // encrypt a reply.
  async function chatHasNonObserverHuman(identity: AgentIdentity, chatId: SaltId, chatMeta?: RawChatMeta): Promise<boolean> {
    const inlineMembers = Array.isArray(chatMeta?.users) ? (chatMeta!.users as Array<{ account_type?: string; observer?: boolean }>) : undefined;
    let members = inlineMembers;
    if (!members) {
      try {
        members = await client.getChatMembers(identity.apiKey, chatId);
      } catch (err) {
        logger.error(`[chat ${chatId}] fetching members for mention-gating failed: ${(err as Error).message}`);
        return false;
      }
    }
    return members.some((m) => m.account_type !== "Agent" && !(m as { observer?: boolean }).observer);
  }

  async function handleMessage(body: { message: Record<string, unknown>; chat?: RawChatMeta }, headerAgentId?: SaltId): Promise<void> {
    const message = body.message;
    const chatId = message.chat_id as SaltId;
    const chatMeta = body.chat;

    if (alreadyProcessed(message.message_id as SaltId)) return;
    if (message.event_type) return; // system events aren't prompts

    const rawMessage = message.message;
    if (typeof rawMessage !== "string") return;

    // Open rooms (salt-api 0.6x): a plain chat delivers `encrypted: false`
    // and `message` is the text itself, not a PGP blob -- there is nothing
    // to trial-decrypt, and no way to recover which hosted identity this
    // delivery was addressed to except the header salt-api signs every
    // callback with. Without it (a header-less transport, or a header
    // naming an identity this process doesn't host) there is no safe
    // fallback the way trial-decryption gives the ciphertext path below --
    // guessing would risk this identity replying as if it heard a message
    // that was actually addressed to a sibling identity sharing this
    // process.
    const isPlaintext = message.encrypted === false;
    let identity: AgentIdentity;
    let caption: string;
    if (isPlaintext) {
      const preferred = headerAgentId ? identities.get(headerAgentId) : undefined;
      if (!preferred) {
        logger.error(`[chat ${chatId}] no known identity for this plaintext message (X-Salt-Agent-Id ${headerAgentId ?? "missing"}); ignoring.`);
        return;
      }
      identity = preferred;
      caption = rawMessage;
    } else {
      if (!PGP_MESSAGE_RE.test(rawMessage)) return;
      const resolved = await resolveIdentity(rawMessage, headerAgentId);
      if (!resolved) {
        logger.error(`[chat ${chatId}] no known identity could decrypt this message; ignoring.`);
        return;
      }
      identity = resolved.identity;
      caption = resolved.plaintext;
    }

    // Wire protocol, never a prompt: a hand-off briefing is consumed by
    // handleHandoffReceived's poll (above HANDOFF_BRIEFING_MARKER's
    // definition), and a bare session-note line is consumed by whichever
    // hand-off leg reads it back out (sessions.ts). Either one reaching
    // onMessage reads to a viewer as this identity replying to its own
    // colleague's internal handoff chatter.
    if (caption.startsWith(HANDOFF_BRIEFING_MARKER) || caption.startsWith(sessions.SESSION_NOTE_MARKER)) return;

    // GACM routing fix: salt-api sends one webhook delivery PER agent
    // member, but they all land on this shared server and message-id dedup
    // collapses them into a single pass -- whose decrypt-resolved identity
    // is arbitrary (any member key opens a multi-recipient blob). When the
    // chat declares an active agent that's hosted here, hand this pass to
    // THAT identity; the plaintext is identical under any key, only "who
    // replies" changes.
    if (chatMeta?.active_agent_id) {
      const active = identities.get(String(chatMeta.active_agent_id));
      if (active) identity = active;
    }

    // A message with no sender is not a prompt, and everything below -- the
    // self-reply loop break, the delegation-reply match, the agent-to-agent
    // cap -- is a question about who sent it. This used to fall through with
    // senderId = NaN, which compared equal to nothing and unequal to
    // everything, so all three guards inverted rather than being skipped. The
    // context handed to consumers already asserted a sender existed.
    const senderRaw = message.user as RawSender | undefined;
    if (!senderRaw) return;
    const senderId: SaltId = String(senderRaw.id);

    // Reply to a pending delegation call? Hand it to that waiting promise
    // instead of starting a fresh reply cycle -- see delegations.ts.
    if (delegations.resolveIfPending(chatId, senderId, caption)) return;

    // The answer to a pending ctx.ask, typed rather than tapped? Settle
    // that wait instead of starting a fresh reply cycle -- see ask.ts.
    // Only a human's plain reply counts (an agent addressed by handle
    // gets its own webhook/turn, same reasoning as the mention-gating
    // below); `caption` is the raw decrypted text, same as delegations'
    // check just above.
    if (asks.resolveMessage(identity.saltAppId, chatId, senderId, senderRaw.account_type !== "Agent", caption)) return;

    // Never reply to our own messages (the reply we post is itself
    // delivered back to us as a webhook) -- this is what prevents an
    // infinite loop.
    if (sameId(senderId, identity.saltAppId)) return;

    // request_floor (actions.ts): the consulted agent is asking to be
    // brought into the room directly instead of relaying further through
    // this lane. Wire protocol, never a prompt -- and only actionable by
    // whichever hosted identity actually opened this lane as the asker.
    if (caption.startsWith(delegations.FLOOR_REQUEST_MARKER)) {
      const asker = delegations.consultAskerFor(chatId);
      if (asker && sameId(asker.askerId, identity.saltAppId)) {
        const reason = caption.slice(delegations.FLOOR_REQUEST_MARKER.length).replace(/^\n/, "").trim() || undefined;
        pendingConsultHandoffs.set(mapKey(asker.roomId), chatId);
        try {
          await client.handOff(identity.apiKey, asker.roomId, senderId, reason);
        } catch (err) {
          pendingConsultHandoffs.delete(mapKey(asker.roomId));
          logger.error(`[chat ${asker.roomId}] auto hand-off on floor request failed: ${(err as Error).message}`);
        }
      }
      return;
    }

    // Mediated Chat: this identity is the configured Mediator, and this
    // message is in the SHARED chat it silently observes -- present for
    // context, but it only actually speaks in each human's own private
    // coaching chat (coaching_for_chat_id pointing back at this one).
    const isMediator = !!mediatorAgentId && sameId(identity.saltAppId, mediatorAgentId);
    if (isMediator && chatMeta?.mediator_agent_id && !chatMeta.coaching_for_chat_id) return;

    // Global Agent Chat Mode: when the chat declares an active agent and
    // it isn't this identity, stay silent. Lets retired/handed-off-from
    // agents remain in the room without ever double-replying.
    if (chatMeta?.active_agent_id && !sameId(chatMeta.active_agent_id, identity.saltAppId)) return;

    // A human sender always resets the count -- only agent-to-agent
    // volleys are capped, never a real conversation with a person.
    const senderIsAgent = !!identities.get(senderId) || senderRaw.account_type === "Agent";
    const replyCountKey = mapKey(chatId);
    if (chatMeta?.coaching_for_chat_id) {
      laneRoomOf.set(replyCountKey, mapKey(chatMeta.coaching_for_chat_id));
    }
    if (senderIsAgent) {
      // A real person changes the rule entirely: an agent-authored message
      // is only ours to answer when it @mentions us -- the same gate
      // salt-api applies to whether the webhook is even sent in a group
      // chat, belt-and-suspenders for whatever still reaches us (a hand-off
      // farewell, a briefing after item 1 above missed a variant, another
      // agent's aside). Two agents alone in a lane have no one to perform
      // for, so the runaway cap below still governs those exactly as before.
      if (await chatHasNonObserverHuman(identity, chatId, chatMeta)) {
        const mentions = (Array.isArray(message.mentions) ? (message.mentions as unknown[]) : []).map(String);
        if (!mentions.some((id) => sameId(id, identity.saltAppId))) {
          logger.error(`[chat ${chatId}] agent message not addressed to us in a chat with a person present; not auto-replying to ${senderId}.`);
          return;
        }
      } else {
        const limit = chatMeta?.lane_kind === "consult" ? CONSULT_RUNAWAY_LIMIT : MAX_AGENT_TO_AGENT_REPLIES_PER_CHAT;
        const count = (agentToAgentReplyCounts.get(replyCountKey) || 0) + 1;
        agentToAgentReplyCounts.set(replyCountKey, count);
        if (count > limit) {
          logger.error(`[chat ${chatId}] agent-to-agent reply cap reached; not auto-replying to ${senderId} again.`);
          return;
        }
      }
    } else {
      agentToAgentReplyCounts.delete(replyCountKey);
      // A human speaking in a ROOM also resets every consult lane rooted
      // there -- otherwise a lane capped mid-conversation stays capped even
      // right after the person who asked for it weighs in.
      for (const [laneKey, roomKey] of laneRoomOf) {
        if (roomKey === replyCountKey) agentToAgentReplyCounts.delete(laneKey);
      }
    }

    const { depth, text: afterDepthMarker } = delegations.parseIncoming(caption);
    const strippedCaption = delegations.stripConsultMarker(afterDepthMarker);

    let mediatorSharedContext: string | undefined;
    let attachment: DecryptedAttachment | undefined;
    // The shared conversation is fetched only for the MUTUAL Mediator lane,
    // where this identity is an observer on that chat and both parties can see
    // it is there. A private advisor lane is excluded: that advisor was never
    // added to the shared chat, so every message would fail to decrypt and be
    // skipped anyway -- but a guarantee that rests on a failed decrypt is one
    // membership bug away from being no guarantee, so we do not ask at all.
    if (isMediator && chatMeta?.coaching_for_chat_id && !chatMeta.private_lane) {
      mediatorSharedContext = await buildSharedChatContext(identity, chatMeta.coaching_for_chat_id);
    } else if (message.resource_type === "Attachment") {
      attachment = await decryptAttachmentIfPresent(identity, message as { message_id: SaltId; resource?: { encrypted_key?: string } });
    }

    if (!options.onMessage) return;

    const roomId: SaltId = (chatMeta?.coaching_for_chat_id as SaltId) || chatId;
    const session = await loadOrRebuildSession(identity, chatId, chatMeta);

    // Wraps the shared reply() closure to also remember what was sent, so
    // it can be appended to the session as an assistant turn once the
    // handler returns successfully -- see the persistence step below.
    // Nothing about what actually gets sent changes.
    const repliesForSession: string[] = [];
    const baseReply = makeReply(identity, chatId, senderRaw);
    const trackedReply = async (text: string): Promise<void> => {
      repliesForSession.push(text);
      await baseReply(text);
    };

    const ctx: MessageContext = {
      identity,
      chatId,
      senderId,
      sender: senderRaw,
      text: strippedCaption,
      encrypted: !isPlaintext,
      deliveredBecause: parseDeliveredBecause(message.delivered_because),
      delegationDepth: depth,
      chatMeta,
      roomId,
      mediatorSharedContext,
      attachment,
      session,
      reply: trackedReply,
      // M2: default answerer is whoever sent THIS message -- never an
      // agent (an agent sender has its own webhook/turn; ctx.ask is for
      // asking a person).
      ask: makeAsk(identity, chatId, senderRaw.account_type !== "Agent" ? senderId : undefined),
      approve: makeApprove(identity, chatId, senderRaw.account_type !== "Agent" ? senderId : undefined),
    };
    try {
      await withTypingHeartbeat(identity, chatId, () => Promise.resolve(options.onMessage!(ctx)));
      try {
        sessions.appendTurn(session, {
          role: "user",
          content: strippedCaption,
          at: Date.now(),
          from: String(senderRaw.username || senderRaw.display_name || senderId),
        });
        for (const replyText of repliesForSession) {
          sessions.appendTurn(session, { role: "assistant", content: replyText, at: Date.now() });
        }
        session.note = sessions.boundNote(session.note);
        session.updatedAt = Date.now();
        await sessionStore.put(identity.saltAppId, chatId, session);
      } catch (err) {
        logger.error(`[session] persisting ${chatId} failed: ${(err as Error).message}`);
      }
    } catch (err) {
      logger.error(`[chat ${chatId}] onMessage failed: ${(err as Error).message}`);
      // Discard any trail entries a partial run recorded -- there's no
      // reply for them to ride on, and they must not leak onto the next one.
      delegations.drainTrail(identity.saltAppId, chatId);
    }
  }

  async function handleCardInteraction(body: {
    owner_id: SaltId;
    chat_id: SaltId;
    card_id: SaltId;
    action_id: string;
    user: RawSender;
    state?: { blocks?: unknown };
  }): Promise<void> {
    // A tap answering a pending ctx.ask's own card is wire-level bookkeeping
    // for ask.ts, never something the consumer's onCardInteraction should
    // also see -- checked before identity resolution/onCardInteraction even
    // matter, since this can settle an ask() with no consumer handler
    // registered for cards at all.
    if (asks.resolveCardInteraction(body.owner_id, body.chat_id, body.card_id, body.action_id, body.user)) return;

    const identity = identities.get(String(body.owner_id));
    if (!identity || !options.onCardInteraction) return;
    // No reply() on this context (a card update IS the response), so just
    // load -- nothing new here to append or persist afterward.
    const session = await loadOrRebuildSession(identity, body.chat_id);
    try {
      await options.onCardInteraction({
        identity,
        chatId: body.chat_id,
        cardId: body.card_id,
        actionId: body.action_id,
        user: body.user,
        blocks: body.state?.blocks,
        session,
      });
    } catch (err) {
      logger.error(`[chat ${body.chat_id}] onCardInteraction failed: ${(err as Error).message}`);
    }
  }

  async function handleInvoicePaid(body: {
    seller_id: SaltId;
    chat_id?: SaltId;
    buyer: RawSender;
    line_items?: Array<{ name: string; qty: number }>;
    amount: string | number;
    billing_account_id?: SaltId;
    transfer_request_id: SaltId;
  }): Promise<void> {
    const identity = identities.get(String(body.seller_id));
    if (!identity || !body.chat_id || !options.onInvoicePaid) return;
    const chatId = body.chat_id;

    const session = await loadOrRebuildSession(identity, chatId);
    const repliesForSession: string[] = [];
    const baseReply = makeReply(identity, chatId);
    const trackedReply = async (text: string): Promise<void> => {
      repliesForSession.push(text);
      await baseReply(text);
    };

    const ctx: InvoicePaidContext = {
      identity,
      chatId,
      buyer: body.buyer,
      lineItems: body.line_items || [],
      amount: body.amount,
      isTopUp: !!body.billing_account_id,
      transferRequestId: body.transfer_request_id,
      session,
      reply: trackedReply,
      // M2: default answerer is the buyer (never an agent -- an agent
      // buyer has no need to be asked a question through its own purchase).
      ask: makeAsk(identity, chatId, body.buyer.account_type !== "Agent" ? body.buyer.id : undefined),
      approve: makeApprove(identity, chatId, body.buyer.account_type !== "Agent" ? body.buyer.id : undefined),
    };
    try {
      await withTypingHeartbeat(identity, chatId, () => Promise.resolve(options.onInvoicePaid!(ctx)));
      await persistSessionAfterReply(identity.saltAppId, chatId, session, repliesForSession);
    } catch (err) {
      logger.error(`[chat ${chatId}] onInvoicePaid failed: ${(err as Error).message}`);
    }
  }

  async function handleChatOpened(body: {
    chat?: ChatOpenedChat;
    opened_by?: RawSender;
    members?: ChatOpenedMember[];
    opened_at?: string;
  }): Promise<void> {
    if (!options.onChatOpened) return;
    const chat = body.chat;
    const chatId = chat?.id;
    if (chatId == null) return;

    // Unlike card_interaction/invoice_paid, this payload carries no explicit
    // owner/seller id naming which hosted identity it's for -- salt-api
    // delivers it once per member with a callback URL, same as everything
    // else, but the only way this process (which can host several identities
    // on one endpoint) learns WHICH of its identities the event is about is
    // by noticing itself in the member list. Prefer the chat's declared
    // active agent when that's one of ours (GACM), the same tie-break
    // handleMessage uses, in case delegation ever puts two hosted identities
    // in the same chat.
    let identity: AgentIdentity | undefined;
    if (chat?.active_agent_id) identity = identities.get(String(chat.active_agent_id));
    if (!identity) {
      for (const member of body.members || []) {
        identity = identities.get(String(member.id));
        if (identity) break;
      }
    }
    if (!identity) {
      logger.error(`[chat ${chatId}] chat_opened: no hosted identity found among members; ignoring.`);
      return;
    }

    if (alreadyGreeted(identity.saltAppId, chatId)) return;

    const session = await loadOrRebuildSession(identity, chatId, chat);
    const repliesForSession: string[] = [];
    const baseReply = makeReply(identity, chatId);
    const trackedReply = async (text: string): Promise<void> => {
      repliesForSession.push(text);
      await baseReply(text);
    };

    const ctx: ChatOpenedContext = {
      identity,
      chatId,
      chat: chat as ChatOpenedChat,
      openedBy: body.opened_by as RawSender,
      members: body.members || [],
      openedAt: body.opened_at as string,
      session,
      reply: trackedReply,
      // M2: default answerer is whoever opened the chat (never an agent).
      ask: makeAsk(identity, chatId, (body.opened_by as RawSender)?.account_type !== "Agent" ? (body.opened_by as RawSender)?.id : undefined),
      approve: makeApprove(identity, chatId, (body.opened_by as RawSender)?.account_type !== "Agent" ? (body.opened_by as RawSender)?.id : undefined),
    };
    try {
      await withTypingHeartbeat(identity, chatId, () => Promise.resolve(options.onChatOpened!(ctx)));
      await persistSessionAfterReply(identity.saltAppId, chatId, session, repliesForSession);
    } catch (err) {
      logger.error(`[chat ${chatId}] onChatOpened failed: ${(err as Error).message}`);
    }
  }

  async function handleHandoffConfirmed(body: { from_agent_id: SaltId; chat_id: SaltId; reason?: string }): Promise<void> {
    const identity = identities.get(String(body.from_agent_id));
    if (!identity || !options.onHandoffConfirmed) return;
    const chatId = body.chat_id;

    // A request_floor call may have just auto-triggered this same hand-off
    // (webhook.ts's floor-request handler, above) -- if so, give the
    // briefing its consult lane's transcript.
    const laneId = pendingConsultHandoffs.get(mapKey(chatId));
    if (laneId) pendingConsultHandoffs.delete(mapKey(chatId));
    let consultTranscript: string | undefined;
    if (laneId) {
      try {
        consultTranscript = await buildConsultTranscript(identity, laneId);
      } catch (err) {
        logger.error(`[chat ${chatId}] fetching consult transcript for hand-off failed: ${(err as Error).message}`);
      }
    }

    const session = await loadOrRebuildSession(identity, chatId);

    // Appends the outgoing session's note (if any) as the briefing's final
    // wire-protocol line -- see sessions.ts's SESSION_NOTE_MARKER and
    // handleHandoffReceived below, which parses it back out on the other
    // end. Transparent to the consumer: whatever text they reply() with is
    // what a human sees; this just rides along after it. Reads `session.note`
    // directly rather than re-fetching -- the same object ctx.session is, so
    // a handler that wrote to it before calling reply() is picked up.
    const repliesForSession: string[] = [];
    const baseReply = makeReply(identity, chatId);
    const reply = async (text: string): Promise<void> => {
      repliesForSession.push(text);
      const noteLine = sessions.formatSessionNoteLine(session.note);
      await baseReply(noteLine ? `${text}\n${noteLine}` : text);
    };

    const ctx: HandoffConfirmedContext = {
      identity,
      chatId,
      reason: body.reason,
      consultTranscript,
      session,
      reply,
      // M2: no natural default here (a hand-off has no single "whoever
      // this answers") -- ask()/approve() from this context must be given
      // answererId explicitly, or they throw synchronously.
      ask: makeAsk(identity, chatId),
      approve: makeApprove(identity, chatId),
    };
    try {
      await withTypingHeartbeat(identity, chatId, () => Promise.resolve(options.onHandoffConfirmed!(ctx)));
      await persistSessionAfterReply(identity.saltAppId, chatId, session, repliesForSession);
    } catch (err) {
      logger.error(`[chat ${chatId}] onHandoffConfirmed failed: ${(err as Error).message}`);
    }
  }

  async function handleHandoffReceived(body: { to_agent_id: SaltId; chat_id: SaltId; reason?: string }): Promise<void> {
    const identity = identities.get(String(body.to_agent_id));
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

    // Seed this identity's own session for `chatId` from whatever's already
    // stored (a fresh one if nothing is), fold in the outgoing agent's note
    // if the briefing carried one, and persist that much right away --
    // independent of whether onHandoffReceived itself succeeds below, same
    // as before this session had a `session` field on its ctx at all.
    // Stripped from `context` either way: wire protocol, never something
    // the incoming agent's own prompt-building should see verbatim.
    let session: Session;
    try {
      session = (await sessionStore.get(identity.saltAppId, chatId)) ?? sessions.emptySession(chatId, chatId);
    } catch (err) {
      logger.error(`[session] loading ${chatId} failed: ${(err as Error).message}`);
      session = sessions.emptySession(chatId, chatId);
    }
    const note = sessions.extractSessionNote(context);
    if (note) {
      session.note = sessions.boundNote(note);
      session.updatedAt = Date.now();
      try {
        await sessionStore.put(identity.saltAppId, chatId, session);
      } catch (err) {
        logger.error(`[session] persisting handed-off note for ${chatId} failed: ${(err as Error).message}`);
      }
    }
    context = sessions.stripSessionNoteLines(context);

    // Whatever the introduction reply() sends here is appended below,
    // exactly like onMessage does for its own reply -- so it's already in
    // transcriptTail the next time this chat's onMessage runs.
    const repliesForSession: string[] = [];
    const baseReply = makeReply(identity, chatId);
    const trackedReply = async (text: string): Promise<void> => {
      repliesForSession.push(text);
      await baseReply(text);
    };

    const ctx: HandoffReceivedContext = {
      identity,
      chatId,
      reason: body.reason,
      context,
      session,
      reply: trackedReply,
      // M2: no natural default here either -- see HandoffConfirmedContext's comment above.
      ask: makeAsk(identity, chatId),
      approve: makeApprove(identity, chatId),
    };
    try {
      await withTypingHeartbeat(identity, chatId, () => Promise.resolve(options.onHandoffReceived!(ctx)));
      await persistSessionAfterReply(identity.saltAppId, chatId, session, repliesForSession);
    } catch (err) {
      logger.error(`[chat ${chatId}] onHandoffReceived failed: ${(err as Error).message}`);
    }
  }

  async function dispatch(body: Record<string, unknown>, headerAgentId?: SaltId): Promise<void> {
    if (body?.type === "card_interaction") return handleCardInteraction(body as never);
    if (body?.type === "invoice_paid") return handleInvoicePaid(body as never);
    if (body?.type === "chat_opened") return handleChatOpened(body as never);
    if (body?.type === "handoff_confirmed") return handleHandoffConfirmed(body as never);
    if (body?.type === "handoff_received") return handleHandoffReceived(body as never);
    if (body?.message) return handleMessage(body as never, headerAgentId);
  }

  return { dispatch, verifyEnvelope };
}

/** What createDispatcher returns -- the two things any transport (an
 *  Express POST route, socket.ts's websocket push client) needs: verify an
 *  envelope's signature, then hand its body to the right handler. */
export interface Dispatcher {
  verifyEnvelope(
    agentId: string | undefined,
    signature: string | undefined,
    rawBody: string,
    opts?: { toleranceSeconds?: number }
  ): Promise<{ ok: true } | { ok: false; reason: string; transient: boolean }>;
  dispatch(body: Record<string, unknown>, headerAgentId?: SaltId): Promise<void>;
}

/**
 * Creates the Express app for a Salt agent's webhook endpoint. Mount it
 * yourself (e.g. `createWebhookServer(opts).listen(port)`, or grab `.app`
 * to compose it into a bigger server).
 *
 * A thin transport wrapper around createDispatcher -- everything about the
 * Salt protocol itself lives there. Switching a consumer from this to
 * socket.ts's createSocketClient (K2, an agent with no public URL) is the
 * same `options` object with `.listen(port)` replaced by `.start()`;
 * onMessage/onCardInteraction/etc. never change.
 */
export function createWebhookServer(options: WebhookServerOptions): { app: Express; listen: (port: number) => void } {
  const logger = options.logger ?? consoleLogger;
  const dispatcher = createDispatcher(options);

  const app = express();
  // Keep the raw bytes: the HMAC covers exactly what salt-api sent, and
  // re-serialising the parsed object would digest different bytes (key order,
  // whitespace, number formatting) and never match.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      identities: options.identities.all().map((i) => ({ salt_app_id: i.saltAppId, username: i.username })),
      ...(options.healthExtra ? options.healthExtra() : {}),
    });
  });

  // salt-api's WebhookJob POSTs here with { chat, message } (or a typed
  // event body for card/invoice/chat_opened/handoff). Ack immediately (200)
  // and process in the background so a slow agent-loop call can't make
  // Salt's webhook delivery time out.
  //
  // When this server is publicly reachable, anyone can POST here. Encrypted-
  // message webhooks fail safe (forged ciphertext never decrypts), but
  // card_interaction/invoice_paid/chat_opened payloads are PLAINTEXT and
  // would be acted on -- so every POST must carry a valid HMAC signed with
  // the RECIPIENT identity's own key (see Dispatcher#verifyEnvelope above).
  app.post("/", (req, res) => {
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? "";
    // Verify BEFORE acknowledging: an unsigned POST must never reach dispatch,
    // because card_interaction/invoice_paid/chat_opened are plaintext and
    // actionable.
    dispatcher
      .verifyEnvelope(req.get("X-Salt-Agent-Id") || undefined, req.get("X-Salt-Signature") || undefined, rawBody)
      .then((result) => {
        if (!result.ok) {
          logger.error(`[webhook] rejected: ${result.reason}`);
          res.status(401).json({ error: "invalid signature" });
          return;
        }
        res.status(200).json({ status: "accepted" });
        const headerAgentId = req.get("X-Salt-Agent-Id") || undefined;
        dispatcher.dispatch(req.body, headerAgentId).catch((err) => logger.error(`[webhook] unhandled error: ${(err as Error).message}`));
      })
      .catch((err) => {
        logger.error(`[webhook] verification failed: ${(err as Error).message}`);
        res.status(401).json({ error: "invalid signature" });
      });
  });

  return {
    app,
    listen(port: number) {
      app.listen(port, () => logger.info(`salt-agent-sdk webhook server listening on :${port}`));
    },
  };
}
