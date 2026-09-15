// Lets a hosted identity ask the person it's chatting with for personal
// facts from Lattice -- their private, on-device knowledge graph -- and get
// an answer back over a real Salt message, the same way delegations.ts gets
// a reply from another agent. See ../../salt-lattice/docs/PROTOCOL.md for
// the wire contract this implements; nothing here decides WHETHER a fact is
// released (that is entirely the phone's own grant evaluation, offline and
// invisible to the server) -- this module only builds the outgoing
// markers, parses the incoming one, and matches a release back to the
// request it answers.
//
// Three message shapes ride inside encrypted plaintext, one line then a
// JSON body, exactly like [[SALT-DELEGATION]]:
//   [[SALT-LATTICE-REQUEST id=<ulid>]]                        agent -> person, asking
//   [[SALT-LATTICE-RELEASE id=<ulid> [standing=<grant id>]]]  person's phone -> agent, answering
//   [[SALT-LATTICE-PROPOSE id=<ulid>]]                        agent -> person's phone, suggesting a fact
//
// A release is matched back to its request by `request_id` IN ITS JSON BODY
// -- never by the release's own `id`, which only identifies that one
// disclosure for the log. Two kinds of release never correspond to a live
// wait:
//   - late: the request already timed out (register()'s promise rejected
//     and the pending entry was cleared) before the phone answered -- the
//     app only answers when it is next opened, which can be well after
//     LATTICE_REQUEST_TIMEOUT_MS.
//   - standing: an opt-in per-grant push of `auto` fields the agent never
//     asked for this turn (PROTOCOL.md's "Standing push"). It carries a
//     `grant_id`, not a `request_id`, so it can never match a pending wait.
// Both reach onRelease() instead of being silently dropped.

import { newUlid, ULID_RE } from "./ids.js";

/** Fresh releases arrive well within this when the person's phone is
 *  already open; 15s stays comfortably under Salt's 20s webhook delivery
 *  timeout so the calling agent's own reply cycle doesn't stall its host
 *  into a retry. A "pending" result past this is normal, not an error --
 *  see actions.ts's request_personal_data. */
export const LATTICE_REQUEST_TIMEOUT_MS = 15_000;

// Embed ULID_RE's character class without its ^...$ anchors, so the id
// group inside each marker regex stays in lock-step with what newUlid()
// actually produces.
const ULID_SRC = ULID_RE.source.slice(1, -1);

export const REQUEST_MARKER_RE = new RegExp(`^\\[\\[SALT-LATTICE-REQUEST id=(${ULID_SRC})\\]\\]\\n`, "i");
export const RELEASE_MARKER_RE = new RegExp(`^\\[\\[SALT-LATTICE-RELEASE id=(${ULID_SRC})(?: standing=(\\S+))?\\]\\]\\n`, "i");
export const PROPOSE_MARKER_RE = new RegExp(`^\\[\\[SALT-LATTICE-PROPOSE id=(${ULID_SRC})\\]\\]\\n`, "i");

export interface LatticeFact {
  path: string;
  type: string;
  field: string;
  value: unknown;
  /** "you" or "agent" -- WHICH agent wrote it is deliberately never disclosed (PROTOCOL.md). */
  author: "you" | "agent";
  updated: number;
}

/** The JSON body of a [[SALT-LATTICE-RELEASE]] message, either shape (a
 *  reply to one request, or a standing push -- see the module comment). */
export interface ReleaseBody {
  facts: LatticeFact[];
  /** Present on an ordinary reply to a request; absent on a standing push. */
  request_id?: string;
  /** Present only on a standing push. */
  grant_id?: string;
  /** Present only on a standing push: facts changed since this sequence number. */
  since_seq?: number;
}

export interface LatticeRelease {
  /** The release message's own id (for the disclosure log) -- NOT the request id it answers. */
  id: string;
  /** Set to a grant id for a standing push; absent for an ordinary reply. */
  standing?: string;
  body: ReleaseBody;
}

export interface BuildRequestInput {
  /** One plain sentence, shown to the person before they decide -- PROTOCOL.md's Request. */
  purpose: string;
  /** Selectors, e.g. "preferences.food.cuisine.*" -- only what the agent's grant names is ever released; asking for more is not an error. */
  asks: string[];
}

/**
 * Mints a fresh request id and its wire text. Send `text` as an ordinary
 * encrypted chat message into the current chat (or the agent's private
 * lane); the phone answers it -- in a group, inside a sidechain it opens
 * with this agent, never in the room (PROTOCOL.md R6).
 */
export function buildRequest(input: BuildRequestInput): { id: string; text: string } {
  const id = newUlid();
  const body = JSON.stringify({ purpose: input.purpose, asks: input.asks });
  return { id, text: `[[SALT-LATTICE-REQUEST id=${id}]]\n${body}` };
}

export interface LatticeProposalInput {
  /** A closed-schema type name (PROTOCOL.md) -- an unknown type or field is silently dropped on the phone, never an error here or there. */
  type: string;
  parent_name?: string;
  fields: Record<string, unknown>;
}

/**
 * Builds a [[SALT-LATTICE-PROPOSE]] message suggesting new facts. Always
 * lands `pending` on the phone unless the agent's grant trusts its writes
 * to that compartment (PROTOCOL.md R3) -- there is no reply to wait for,
 * so unlike buildRequest this returns only the wire text.
 */
export function buildProposal(proposals: LatticeProposalInput[]): string {
  const id = newUlid();
  const body = JSON.stringify({ proposals });
  return `[[SALT-LATTICE-PROPOSE id=${id}]]\n${body}`;
}

function normalizeReleaseBody(parsed: unknown): ReleaseBody | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.facts)) return null;
  const body: ReleaseBody = { facts: obj.facts as LatticeFact[] };
  if (typeof obj.request_id === "string") body.request_id = obj.request_id;
  if (typeof obj.grant_id === "string") body.grant_id = obj.grant_id;
  if (typeof obj.since_seq === "number") body.since_seq = obj.since_seq;
  return body;
}

/**
 * Splits an incoming plaintext into its release marker's id, optional
 * standing grant id, and parsed JSON body -- or null when `plaintext` isn't
 * a (well-formed) lattice release at all. A marker line with an
 * unparseable or malformed body also returns null, deliberately: it's
 * safer to let a corrupt release fall through as ordinary (harmless)
 * message text than to silently swallow it.
 */
export function parseRelease(plaintext: string): { id: string; standing?: string; body: ReleaseBody } | null {
  const match = RELEASE_MARKER_RE.exec(plaintext);
  if (!match) return null;
  const [full, id, standing] = match;
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.slice(full.length));
  } catch {
    return null;
  }
  const body = normalizeReleaseBody(parsed);
  if (!body) return null;
  return standing ? { id, standing, body } : { id, body };
}

interface PendingEntry {
  resolve: (body: ReleaseBody) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Keyed by REQUEST id (the id a request_personal_data call minted and put
// in the marker it sent) -- NOT by chat, unlike delegations.ts's registry,
// which is chat-scoped because a chat can only be mid-delegation with one
// target at a time. A person can plausibly be asked several independent
// things in parallel (different tool calls, possibly from different hosted
// identities sharing this process), so the request id is what safely tells
// two pending waits apart.
const pending = new Map<string, PendingEntry>();

export function hasPending(id: string): boolean {
  return pending.has(id);
}

/**
 * Registers a wait for the release answering request `id`. Resolves with
 * that release's parsed body, or rejects once `timeoutMs` elapses --
 * rejecting is an expected outcome, not a protocol error: PROTOCOL.md says
 * the phone only answers when the app is next open, which routinely
 * outlasts one webhook round-trip. Throws synchronously (before any caller
 * does anything else) if `id` already has a pending wait.
 */
export function register(id: string, opts: { timeoutMs: number }): Promise<ReleaseBody> {
  if (pending.has(id)) {
    throw new Error("Already waiting on a release for this request.");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`No release within ${Math.round(opts.timeoutMs / 1000)}s.`));
    }, opts.timeoutMs);
    pending.set(id, { resolve, reject, timer });
  });
}

/**
 * Clears a pending wait without settling its promise -- used when sending
 * the request message itself fails right after register() ran, so the
 * registry entry doesn't leak (the caller throws its own error instead).
 */
export function cancel(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
}

type ReleaseHandler = (release: LatticeRelease) => void;
const releaseHandlers = new Set<ReleaseHandler>();

/**
 * Subscribes to releases that arrive with nothing waiting on them: a late
 * reply (the request already timed out) or a standing push (there was
 * never a request to begin with). Returns an unsubscribe function. Handler
 * errors are swallowed -- like every other fire-and-forget hook in this
 * SDK, a bug in a consumer's handler must not take down webhook processing.
 */
export function onRelease(handler: ReleaseHandler): () => void {
  releaseHandlers.add(handler);
  return () => releaseHandlers.delete(handler);
}

function fireOnRelease(release: LatticeRelease): void {
  for (const handler of releaseHandlers) {
    try {
      handler(release);
    } catch {
      // see onRelease's doc comment
    }
  }
}

/**
 * Call right after decrypting an inbound message, before deciding whether
 * to run a fresh reply cycle -- the same spot webhook.ts calls
 * delegations.resolveIfPending. Returns true when `plaintext` was a
 * lattice release, whether it resolved a pending register() wait or (for a
 * late or standing release) was handed to onRelease -- either way the
 * caller must stop processing this message as a new prompt. Returns false
 * for everything else, including this identity's own outgoing
 * requests/proposals (which never match RELEASE_MARKER_RE) and any
 * genuinely unrelated message.
 */
export function resolveIfPending(plaintext: string): boolean {
  const parsed = parseRelease(plaintext);
  if (!parsed) return false;

  if (!parsed.standing && parsed.body.request_id && pending.has(parsed.body.request_id)) {
    const entry = pending.get(parsed.body.request_id)!;
    clearTimeout(entry.timer);
    pending.delete(parsed.body.request_id);
    entry.resolve(parsed.body);
    return true;
  }

  fireOnRelease({ id: parsed.id, standing: parsed.standing, body: parsed.body });
  return true;
}
