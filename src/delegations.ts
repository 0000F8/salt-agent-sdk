// Lets one hosted identity ask another Salt agent for help and wait for its
// reply, entirely over real Salt chat messages. Ported from
// salt-claude-agent/src/delegations.js. Two problems only this module solves:
//
// 1. The target's reply comes back through the exact same webhook path as
//    any ordinary inbound message. In a 1:1 chat, Salt webhooks EVERY member
//    for EVERY message (no @mention gating -- that's group-chat only), so
//    without this registry the delegator would treat the target's reply as a
//    brand-new prompt and answer it back into the same chat, which the
//    target would then also treat as new, forever. `register`/`resolveIfPending`
//    let a webhook handler recognize "this inbound message is the reply I'm
//    waiting on" and resolve it before the agent's own reply logic ever
//    sees it.
// 2. Nothing else bounds how many hops a delegation chain can take (an agent
//    asked could itself try to delegate further) or how long one hop can
//    take. `wrap`/`parseIncoming` carry a hop counter across the wire (the
//    only channel available between two separately-hosted agents is the
//    message text itself), and `register`'s timeout bounds each hop.

/** depth counts hops already taken; a call at depth >= this is refused, so a
 *  chain reaches at most MAX_DELEGATION_DEPTH+1 agents before the last one
 *  is forced to answer directly instead of delegating further. */
export const MAX_DELEGATION_DEPTH = 3;

/** observed single search-heavy replies take up to ~30s; a delegate's own
 *  reply can itself involve tool rounds (including one more delegation
 *  hop), so this gives ~3x headroom per hop. */
export const DELEGATION_TIMEOUT_MS = 90_000;

const MARKER_RE = /^\[\[SALT-DELEGATION depth=(\d+)\]\]\n/;

/**
 * Prefixes an outbound delegation message with its hop depth. Stripped by
 * parseIncoming on the receiving end before the task text ever reaches that
 * identity's agent logic -- the marker is wire protocol, not conversational
 * content.
 */
export function wrap(depth: number, text: string): string {
  return `[[SALT-DELEGATION depth=${depth}]]\n${text}`;
}

/**
 * Splits an incoming plaintext into { depth, text }. Ordinary,
 * non-delegated messages (the overwhelming majority -- anything from a
 * human, or an agent message with no marker) have no prefix and come back
 * as { depth: 0, text: plaintext } unchanged, so this is a no-op on the
 * existing message path.
 */
export function parseIncoming(plaintext: string): { depth: number; text: string } {
  const match = MARKER_RE.exec(plaintext);
  if (!match) return { depth: 0, text: plaintext };
  return { depth: parseInt(match[1], 10), text: plaintext.slice(match[0].length) };
}

interface PendingEntry {
  targetId: number;
  resolve: (plaintext: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// chatId -> pending wait. One pending wait per chat at a time -- a second
// concurrent delegation call into the same chat is a clean error (see
// register below) rather than an ambiguous race over which reply belongs
// to which caller.
const pending = new Map<number, PendingEntry>();

export function hasPending(chatId: number): boolean {
  return pending.has(chatId);
}

/**
 * Registers a wait for the next reply in `chatId` from `targetId`, and
 * returns a Promise that resolves with the reply's plaintext, or rejects if
 * `timeoutMs` elapses first. Throws synchronously (before any network call)
 * if this chat already has a pending wait.
 */
export function register(chatId: number, targetId: number, timeoutMs: number): Promise<string> {
  if (pending.has(chatId)) {
    throw new Error("Already waiting on a reply from this agent in this chat -- wait for that to finish first.");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(chatId);
      reject(new Error(`No reply within ${Math.round(timeoutMs / 1000)}s -- the agent may be offline or slow.`));
    }, timeoutMs);
    pending.set(chatId, { targetId, resolve, reject, timer });
  });
}

/**
 * Clears a pending wait without settling its promise -- used when sending
 * the delegation message itself fails after register() already ran, so the
 * registry entry doesn't leak (the caller throws its own error instead).
 */
export function cancel(chatId: number): void {
  const entry = pending.get(chatId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(chatId);
}

/**
 * Call right after decrypting an inbound message, before deciding whether
 * to run a fresh reply cycle. If `chatId` has a pending wait AND `senderId`
 * is the identity it's waiting on, resolves that wait with `plaintext` and
 * returns true (caller should stop processing this message as a new
 * prompt). Returns false for everything else -- including a delegation
 * TARGET's very first inbound request, which by definition has no pending
 * entry on its own server.
 */
export function resolveIfPending(chatId: number, senderId: number, plaintext: string): boolean {
  const entry = pending.get(chatId);
  if (!entry || entry.targetId !== senderId) return false;
  clearTimeout(entry.timer);
  pending.delete(chatId);
  entry.resolve(plaintext);
  return true;
}

// --- Delegation trail (provenance) -------------------------------------

export interface DelegationTrailEntry {
  agent_id: number;
  chat_id: number;
  username: string;
}

// While an identity is composing ONE reply, each successful delegation
// records who was consulted here. When the reply is posted back to the
// originating chat, the caller drains this and attaches it as the
// message's `delegations` metadata -- powering the "consulted @agent"
// expander a human sees on that reply. Keyed by identity + originating
// chat so concurrent replies (different chats, or different hosted
// identities) never mix their trails.
const trails = new Map<string, DelegationTrailEntry[]>();

function trailKey(identityId: number, mainChatId: number): string {
  return `${identityId}:${mainChatId}`;
}

export function recordTrail(identityId: number, mainChatId: number, entry: DelegationTrailEntry): void {
  const key = trailKey(identityId, mainChatId);
  if (!trails.has(key)) trails.set(key, []);
  trails.get(key)!.push(entry);
}

export function drainTrail(identityId: number, mainChatId: number): DelegationTrailEntry[] {
  const key = trailKey(identityId, mainChatId);
  const entries = trails.get(key) || [];
  trails.delete(key);
  return entries;
}
