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
// disclosure for the log -- AND by the chat and sender it was actually
// registered against (see register()/classifyRelease()). A request's
// plaintext id is visible to every current member of whatever chat it was
// sent into (see actions.ts's request_personal_data), so a request id alone
// is not a secret; the chat+sender binding is what stops a bystander who
// merely SAW that id from forging a release and having it accepted as the
// real recipient's answer.
//
// Three outcomes a release-shaped message can produce, besides "not a
// release at all" (see ReleaseOutcome/classifyRelease):
//   - matched: chat and sender agree with what register() bound to this
//     request id. Resolves that wait's promise directly; nothing else to do.
//   - refused: names a request id this process really is waiting on, but
//     the chat or the sender don't match the binding -- a forged or
//     misdirected release. The live wait keeps waiting; this message is
//     left for the caller to fall through as ordinary (harmless) text.
//   - unmatched (late or standing): a genuine release with no live wait to
//     resolve -- either the request already timed out (the phone only
//     answers when the app is next open, which routinely outlasts one
//     webhook round-trip) or it's an opted-in standing push, which never
//     had a request to begin with. Reaches onRelease() (and, via
//     webhook.ts's onLatticeRelease option, a consumer's own follow-up
//     logic) instead of being silently dropped.

import { newUlid, sameId, ULID_RE, type SaltId } from "./ids.js";

/**
 * How long request_personal_data waits for a release before reporting
 * "pending" instead of "released". This bounds how long ONE chat turn keeps
 * whoever's waiting on the agent hanging -- it is NOT protecting against
 * Salt's own webhook delivery timeout: webhook.ts acknowledges salt-api's
 * POST before ever calling dispatch(), so nothing here is on the clock for
 * that deadline. A "pending" result past this is the normal case, not an
 * error -- see actions.ts's request_personal_data and onRelease/
 * onLatticeRelease for what happens when the answer arrives afterward.
 */
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
  /** A JSON primitive (string/number/boolean/null) -- normalizeFact rejects an object or array here. */
  value: string | number | boolean | null;
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
  /** The chat and sender this release actually arrived from (Salt-authenticated, not attacker-controlled). */
  chatId: SaltId;
  senderId: SaltId;
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

const FACT_AUTHORS = new Set(["you", "agent"]);

// PROTOCOL.md's exact fact shape. Validated field-by-field, not just "facts
// is an array": a forged or buggy release could otherwise hand a model
// whatever shape it likes under `facts[]`, and (pre-binding-fix) that used
// to reach a calling tool's "released" result unfiltered. One malformed
// entry rejects the WHOLE body (returns null), the same fail-closed
// convention as an unparseable body -- a partially-trusted release is worse
// than a dropped one.
function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function normalizeFact(raw: unknown): LatticeFact | null {
  if (!raw || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.path !== "string" || typeof f.type !== "string" || typeof f.field !== "string") return null;
  if (typeof f.author !== "string" || !FACT_AUTHORS.has(f.author)) return null;
  if (typeof f.updated !== "number") return null;
  if (!isPrimitive(f.value)) return null;
  return { path: f.path, type: f.type, field: f.field, value: f.value, author: f.author as "you" | "agent", updated: f.updated };
}

function normalizeReleaseBody(parsed: unknown): ReleaseBody | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.facts)) return null;
  const facts: LatticeFact[] = [];
  for (const raw of obj.facts) {
    const fact = normalizeFact(raw);
    if (!fact) return null;
    facts.push(fact);
  }
  const body: ReleaseBody = { facts };
  if (typeof obj.request_id === "string") body.request_id = obj.request_id;
  if (typeof obj.grant_id === "string") body.grant_id = obj.grant_id;
  if (typeof obj.since_seq === "number") body.since_seq = obj.since_seq;
  return body;
}

/**
 * Splits an incoming plaintext into its release marker's id, optional
 * standing grant id, and parsed JSON body -- or null when `plaintext` isn't
 * a (well-formed, in-protocol) lattice release at all. Returns null for an
 * unparseable or malformed body, and also for a body that is neither an
 * ordinary reply (`request_id`) nor a standing push (`standing=` on the
 * marker line AND `grant_id` in the body) -- PROTOCOL.md says a release is
 * "always a reply to a request id" unless it's a standing push, so anything
 * else is out-of-protocol. Deliberate in all these cases: it's safer to let
 * a corrupt or nonsensical release fall through as ordinary (harmless)
 * message text than to silently act on it.
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
  if (standing) {
    if (!body.grant_id) return null;
    return { id, standing, body };
  }
  if (!body.request_id) return null;
  return { id, body };
}

interface PendingEntry {
  /** The chat and person this request was actually sent to -- see register()'s doc comment. */
  chatId: SaltId;
  senderId: SaltId;
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
//
// Lowercased on every store/lookup -- like delegations.ts's own `mapKey` and
// ids.ts's `sameId`, whose comments say why: an id can cross this SDK's
// boundary (webhook body, REST response, a phone's own JSON) without a
// casing guarantee, and RELEASE_MARKER_RE already matches either case
// (ULID_RE's `/i` flag), so the map lookup that follows it must too.
const pending = new Map<string, PendingEntry>();
const mapKey = (id: string): string => id.toLowerCase();

export function hasPending(id: string): boolean {
  return pending.has(mapKey(id));
}

export interface RegisterBinding {
  /** The chat the request was actually sent into. */
  chatId: SaltId;
  /** The person the request was actually addressed to -- see actions.ts's request_personal_data, which resolves this to one specific chat member even in a group. */
  senderId: SaltId;
  timeoutMs: number;
}

/**
 * Registers a wait for the release answering request `id`, bound to the
 * exact chat and person it was sent to. Only a release arriving from THAT
 * chat and THAT sender can resolve it (see classifyRelease) -- a request's
 * plaintext id is visible to every current member of the chat it's sent
 * into (see actions.ts), so the id alone must never be sufficient to claim
 * a release.
 *
 * Resolves with that release's parsed body, or rejects once `timeoutMs`
 * elapses -- rejecting is an expected outcome, not a protocol error:
 * PROTOCOL.md says the phone only answers when the app is next open, which
 * routinely outlasts one webhook round-trip. Throws synchronously (before
 * any caller does anything else) if `id` already has a pending wait.
 */
export function register(id: string, binding: RegisterBinding): Promise<ReleaseBody> {
  const key = mapKey(id);
  if (pending.has(key)) {
    throw new Error("Already waiting on a release for this request.");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error(`No release within ${Math.round(binding.timeoutMs / 1000)}s.`));
    }, binding.timeoutMs);
    pending.set(key, { chatId: binding.chatId, senderId: binding.senderId, resolve, reject, timer });
  });
}

/**
 * Clears a pending wait without settling its promise -- used when sending
 * the request message itself fails right after register() ran, so the
 * registry entry doesn't leak (the caller throws its own error instead).
 */
export function cancel(id: string): void {
  const key = mapKey(id);
  const entry = pending.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(key);
}

type ReleaseHandler = (release: LatticeRelease) => void | Promise<void>;
const releaseHandlers = new Set<ReleaseHandler>();

/**
 * Subscribes to releases that arrive with nothing waiting on them: a late
 * reply (the request already timed out) or a standing push (there was
 * never a request to begin with). Returns an unsubscribe function.
 *
 * A handler may be async. Either a synchronous throw or a rejected promise
 * is swallowed -- like every other fire-and-forget hook in this SDK, a bug
 * in a consumer's handler must not take down webhook processing (an
 * unhandled rejection crashes the process on modern Node defaults).
 */
export function onRelease(handler: ReleaseHandler): () => void {
  releaseHandlers.add(handler);
  return () => releaseHandlers.delete(handler);
}

function fireOnRelease(release: LatticeRelease): void {
  for (const handler of releaseHandlers) {
    Promise.resolve()
      .then(() => handler(release))
      .catch(() => {
        // see onRelease's doc comment
      });
  }
}

export type ReleaseOutcome =
  | { kind: "not-a-release" }
  | { kind: "matched" }
  | { kind: "refused" }
  | { kind: "unmatched"; release: LatticeRelease };

/**
 * Call right after decrypting an inbound message, before deciding whether
 * to run a fresh reply cycle -- the same spot webhook.ts calls
 * delegations.resolveIfPending (and what webhook.ts itself calls, to also
 * learn about an "unmatched" release for its onLatticeRelease option).
 *
 * - "not-a-release": `plaintext` isn't lattice wire protocol at all --
 *   including this identity's own outgoing requests/proposals, which never
 *   match RELEASE_MARKER_RE, and any genuinely unrelated message.
 * - "matched": `chatId`/`senderId` agree with a live register() wait for
 *   this release's `request_id` -- that wait's promise is resolved directly;
 *   there is nothing further for a caller to do.
 * - "refused": this release names a request id a wait IS pending for, but
 *   `chatId`/`senderId` don't match what register() bound it to -- e.g. a
 *   bystander who merely saw the plaintext request id (see
 *   RegisterBinding's doc comment) replaying it as a forged release. The
 *   live wait is untouched (still running, still resolvable by the real
 *   answer); this message is left for the caller to process as ordinary,
 *   harmless text -- it must NOT be treated as Lattice traffic.
 * - "unmatched": a genuine late reply or standing push -- fired to
 *   onRelease() before this returns.
 */
export function classifyRelease(chatId: SaltId, senderId: SaltId, plaintext: string): ReleaseOutcome {
  const parsed = parseRelease(plaintext);
  if (!parsed) return { kind: "not-a-release" };

  if (!parsed.standing) {
    const key = mapKey(parsed.body.request_id!); // parseRelease guarantees request_id is set for a non-standing release
    const entry = pending.get(key);
    if (entry) {
      if (sameId(entry.chatId, chatId) && sameId(entry.senderId, senderId)) {
        clearTimeout(entry.timer);
        pending.delete(key);
        entry.resolve(parsed.body);
        return { kind: "matched" };
      }
      return { kind: "refused" };
    }
  }

  const release: LatticeRelease = { id: parsed.id, standing: parsed.standing, chatId, senderId, body: parsed.body };
  fireOnRelease(release);
  return { kind: "unmatched", release };
}

/**
 * Boolean convenience wrapper over classifyRelease, mirroring
 * delegations.resolveIfPending(chatId, senderId, plaintext)'s shape for a
 * simple caller that doesn't need an "unmatched" release's details (e.g. a
 * custom integration built directly on lattice.ts, without webhook.ts).
 * True for "matched" and "unmatched" (don't treat `plaintext` as a fresh
 * prompt); false for "not-a-release" AND "refused" (a forged/misdirected
 * release is left to fall through exactly like ordinary text, same as
 * "not-a-release" -- see classifyRelease's doc comment).
 *
 * webhook.ts itself calls classifyRelease directly instead of this, since
 * it also needs an "unmatched" release's details (chat/sender/body) to
 * offer to its own onLatticeRelease option.
 */
export function resolveIfPending(chatId: SaltId, senderId: SaltId, plaintext: string): boolean {
  const outcome = classifyRelease(chatId, senderId, plaintext);
  return outcome.kind === "matched" || outcome.kind === "unmatched";
}
