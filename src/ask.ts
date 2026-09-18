// ctx.ask (K3): an agent asks a person a quick question INLINE and waits
// for whichever answer arrives first -- a tap on one of the buttons this
// posts as a card, or the next plain message from a human member of the
// chat. Built on the existing card machinery (client.postCard/updateCard,
// the same block vocabulary actions.ts's BLOCKS_SCHEMA documents), so it
// needs nothing new from salt-api.
//
// Wiring: resolveCardInteraction/resolveMessage are called from
// webhook.ts's createDispatcher, the ONE place both delivery modes
// (webhook POST and the K2 socket long-poll/Cable envelope) end up --
// see socket.ts, which drains the same dispatcher. That's what makes
// `ctx.ask` behave identically under either mode with no extra wiring at
// the call site: register a pending wait here, and whichever transport
// happens to deliver the reply resolves it.
//
// Mirrors delegations.ts's register/resolveIfPending shape on purpose (one
// pending wait per chat, a timer, resolve/reject) -- same problem, a
// different kind of reply.

import { randomUUID } from "node:crypto";
import type { CardBlock, SaltClient } from "./client";
import type { AgentIdentity } from "./identities";
import { sameId, type SaltId } from "./ids.js";

export interface AskOptions {
  /** Button labels, one row of buttons. Omit for a free-text-only question. */
  options?: string[];
  /** Also accept a plain typed reply as the answer. Defaults to true when
   *  `options` is omitted (there'd be no other way to answer), false when
   *  `options` is given (buttons only, unless set explicitly). */
  freeText?: boolean;
  /** Defaults to 10 minutes -- the person asking may not be looking right now. */
  timeoutMs?: number;
}

export interface AskResult {
  answer: string;
  by: SaltId;
  via: "button" | "message";
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const mapKey = (id: SaltId): string => String(id).toLowerCase();

interface PendingAsk {
  cardId: SaltId | null;
  /** action_id -> button label, so a resolving tap can report back which label it was. */
  optionLabels: Map<string, string>;
  freeText: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: AskResult) => void;
  reject: (err: Error) => void;
}

// One pending ask per chat, like delegations.ts's `pending` -- a second
// concurrent ask() in the same chat is a clear synchronous error rather
// than an ambiguous race over which reply answers which question.
const pendingByChat = new Map<string, PendingAsk>();

function buildBlocks(question: string, options: string[], freeText: boolean, optionLabels?: Map<string, string>): CardBlock[] {
  const blocks: CardBlock[] = [{ type: "section", text: question }];
  if (options.length > 0) {
    const elements = options.map((label, i) => {
      const actionId = `ask_${i}_${randomUUID().slice(0, 8)}`;
      optionLabels?.set(actionId, label);
      return { type: "button", action_id: actionId, label };
    });
    blocks.push({ type: "actions", elements });
  }
  if (freeText) {
    blocks.push({ type: "section", text: options.length > 0 ? "Or just reply with your own answer." : "Reply to answer." });
  }
  return blocks;
}

/**
 * Posts the question as a card and waits for an answer. Resolves with
 * `{answer, by, via}` -- `via: "button"` when a listed option was tapped
 * (`answer` is that option's label), `via: "message"` when a plain reply
 * answered it instead (`answer` is that message's text). Rejects if
 * `timeoutMs` elapses first, or synchronously if this chat already has a
 * pending ask.
 *
 * On resolution, the card is updated in place to show the chosen answer
 * (best-effort -- a failure to update it never fails the already-settled
 * answer).
 */
export async function ask(client: SaltClient, caller: AgentIdentity, chatId: SaltId, question: string, opts: AskOptions = {}): Promise<AskResult> {
  const key = mapKey(chatId);
  if (pendingByChat.has(key)) {
    throw new Error("Already waiting on an answer in this chat -- wait for that to finish first.");
  }
  const options = opts.options ?? [];
  const freeText = opts.freeText ?? options.length === 0;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const optionLabels = new Map<string, string>();
  const blocks = buildBlocks(question, options, freeText, optionLabels);

  const settle = new Promise<AskResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingByChat.delete(key);
      reject(new Error(`No answer within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    pendingByChat.set(key, { cardId: null, optionLabels, freeText, timer, resolve, reject });
  });

  // Captured here, before the wait resolves (which deletes the registry
  // entry) -- this is the only place cardId is readable after that point,
  // for updating the card once an answer comes in.
  let cardId: SaltId | null = null;
  try {
    const posted = await client.postCard(caller.apiKey, chatId, blocks, question);
    cardId = (posted as { id?: SaltId } | null)?.id ?? null;
    const entry = pendingByChat.get(key);
    // The wait may already have settled between posting and this line (a
    // very fast reply, or a near-zero timeoutMs in a test) -- if so there's
    // no entry left to attach the id to, and a stale card's buttons simply
    // stay inert (resolveCardInteraction has nothing to match them against).
    if (entry) entry.cardId = cardId;
  } catch (err) {
    // The card itself failed to post -- nothing will ever resolve this
    // wait, so clear the registry entry and surface the real failure
    // instead of a timeout many minutes later.
    const entry = pendingByChat.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      pendingByChat.delete(key);
    }
    throw err;
  }

  const result = await settle;
  if (cardId) {
    try {
      await client.updateCard(caller.apiKey, cardId, [{ type: "section", text: question }, { type: "section", text: `Answered: ${result.answer}` }]);
    } catch {
      // Best-effort: the answer is already settled either way.
    }
  }
  return result;
}

/**
 * Sugar for a yes/no `ask`: two buttons, and a plain "yes"/"no"-ish typed
 * reply also counts (anything not recognisably affirmative resolves
 * `approved: false`, same as tapping "No").
 */
export async function approve(
  client: SaltClient,
  caller: AgentIdentity,
  chatId: SaltId,
  summary: string,
  opts: { timeoutMs?: number } = {}
): Promise<{ approved: boolean; by: SaltId; via: "button" | "message" }> {
  const result = await ask(client, caller, chatId, summary, { options: ["Yes", "No"], freeText: true, timeoutMs: opts.timeoutMs });
  return { approved: /^y(es)?\b/i.test(result.answer.trim()), by: result.by, via: result.via };
}

/**
 * Called from webhook.ts's handleCardInteraction, BEFORE the consumer's own
 * onCardInteraction runs -- a tap answering one of THIS module's cards is
 * wire-level bookkeeping for ctx.ask, never something the consumer's own
 * card-interaction handler should also see. Returns true when this tap was
 * consumed (matched a pending ask's card and a real option on it).
 */
export function resolveCardInteraction(chatId: SaltId, cardId: SaltId | undefined, actionId: string, user: { id: SaltId }): boolean {
  const entry = pendingByChat.get(mapKey(chatId));
  if (!entry || !entry.cardId || cardId === undefined || !sameId(entry.cardId, cardId)) return false;
  const label = entry.optionLabels.get(actionId);
  if (label === undefined) return false;
  clearTimeout(entry.timer);
  pendingByChat.delete(mapKey(chatId));
  entry.resolve({ answer: label, by: user.id, via: "button" });
  return true;
}

/**
 * Called from webhook.ts's handleMessage, alongside delegations.resolveIfPending
 * -- same shape: if this chat has a pending free-text-eligible ask and the
 * sender is a human, this message IS the answer, and the caller should stop
 * processing it as a fresh prompt. `text` is the raw decrypted plaintext
 * (before delegation-depth/consult-marker stripping), matching what
 * delegations.resolveIfPending is handed at the same call site.
 */
export function resolveMessage(chatId: SaltId, senderId: SaltId, senderIsHuman: boolean, text: string): boolean {
  if (!senderIsHuman) return false;
  const key = mapKey(chatId);
  const entry = pendingByChat.get(key);
  if (!entry || !entry.freeText) return false;
  clearTimeout(entry.timer);
  pendingByChat.delete(key);
  entry.resolve({ answer: text, by: senderId, via: "message" });
  return true;
}
