// K2 socket mode (design-fleet/runs/2026-09-17-distribution/LANES.md
// "Socket mode contract"), now PUSH, not poll (2026-09-22, owner: "DO NOT
// USE POLLING as a mechanic EVER"): an agent with no public URL -- OpenClaw,
// a local LangGraph script, Claude Code on a laptop -- can't receive a
// webhook POST. `createSocketClient` opens a real websocket to salt-api's
// Action Cable (`AgentUpdatesChannel`) and stays connected; salt-api PUSHES
// each envelope the instant it's written. An idle, caught-up agent makes
// ZERO requests -- there is no interval timer anywhere in this file.
//
// "The same handlers" is not a promise made by convention -- it's
// createDispatcher (webhook.ts), the one place both createWebhookServer and
// createSocketClient end up. A consumer switches an identity from webhook
// to socket mode by:
//   1. calling PATCH /api/v1/agents/delivery {mode:"socket"} once (or just
//      leaving that identity's callback blank -- salt-api treats a blank
//      callback as socket mode regardless of this setting), and
//   2. replacing `createWebhookServer(options).listen(port)` with
//      `createSocketClient({...options, host, apiKey, agentId}).start()`.
// onMessage/onCardInteraction/onInvoicePaid/onChatOpened/onHandoffConfirmed/
// onHandoffReceived never change.
//
// WIRE PROTOCOL (Action Cable, `wss://<host>/cable`, the agent's own
// `api-key` on the handshake HEADER -- never a query param, the same
// ALB/CloudWatch-access-log-leak reasoning the REST api-key path already
// documents -- see salt-api's ApplicationCable::Connection and
// AgentUpdatesChannel):
//   1. Connect. Server sends {type:"welcome"}.
//   2. Subscribe: {command:"subscribe", identifier: JSON.stringify({channel:
//      "AgentUpdatesChannel", after: <local cursor>})} -- `after` OMITTED
//      entirely (not sent as 0) when there is no local cursor yet, so
//      salt-api's own server-side ack applies instead of replaying from
//      scratch (same convention the old poll client used).
//   3. Server replies {type:"confirm_subscription", identifier} or
//      {type:"reject_subscription", identifier}, then REPLAYS the backlog
//      from the resolved cursor as ordinary envelope frames -- the same
//      shape as a poll row, wrapped as {identifier, message: {id,
//      delivery_id, event, headers, body, created_at}} -- ending with
//      {identifier, message: {type:"replay_done", cursor, more?}}. Live
//      broadcasts arrive as that identical envelope shape, interleaved with
//      (and continuing after) the replay.
//   4. {type:"ping", message:<unix ts>} arrives roughly every 3s -- the
//      liveness signal. No ping for 30s means the connection is dead (a
//      half-open TCP socket may never emit its own 'close') -- terminate
//      and reconnect.
//   5. {type:"disconnect", reason, reconnect} means salt-api is closing this
//      connection on purpose (e.g. a deploy) -- always reconnect regardless
//      of the `reconnect` value; salt-api never asks a client to stay down
//      for good.
//
// CURSOR PERSISTENCE (LANES.md, fix N8): the local cursorStore is written
// ONLY from a real poll-shaped response -- a `replay_done` frame's
// `cursor`, a backfill GET page's `cursor`, or the ack GET's `cursor` --
// NEVER from a live envelope frame's own `id` directly. Two different live
// broadcasts for the same agent have no cross-broadcast ordering guarantee
// (they can originate from two different Puma processes/transactions), so
// persisting from whichever arrived first risks writing a cursor that's
// ahead of one still in flight; on a later reconnect that row would never
// be replayed again (the server's ack only ever moves forward, never
// rewinds). Live frames are still DISPATCHED the moment they arrive (once
// this connection has caught up) -- this restriction is only about what
// gets written to disk / used to resume, never about delivering a message
// to onMessage.
//
// A ROW THAT FAILS VERIFICATION TRANSIENTLY (a network error fetching the
// signing key -- never a bad signature) is a harder case here than it was
// for the poll client: a poll simply re-fetches the same un-advanced row on
// its next round trip, but a websocket replay happens exactly once per
// connection -- there is no "poll again" to retry a single bad row without
// re-processing everything after it too. So this client does NOT halt the
// rest of the stream on a transient failure (that would block every later,
// perfectly good message behind one hiccup); instead it remembers the
// LOWEST id that failed transiently (pendingFailureId, below) and clamps
// every cursor persistence to stop just short of it, so the NEXT reconnect
// naturally re-replays from that row forward -- giving it another chance
// -- while dedupe silently no-ops whatever already succeeded the first
// time.
//
// ACK: after a batch of frames is processed (replay, backfill, or live),
// this client tells salt-api how far it got with a single, coalesced
// `GET /api/v1/agent/updates?after=<highest processed id>&timeout=0&limit=1`
// call -- there is no dedicated ack action on the channel; `after` on this
// endpoint already IS salt-api's ack (see AgentUpdatesController). This is
// event-driven: at most one ack in flight, and at most one more queued
// behind it for whatever arrived while it was out -- never a timer. Its
// only purpose is so a FRESH connection (a lost local cursorStore, or a
// process that has never held one) resumes near here instead of replaying
// up to 7 days of backlog; this client's own resume point still comes only
// from cursorStore, per the persistence rule above.
//
// BACKFILL: `replay_done.more: true` means AgentUpdatesChannel's own
// MAX_BACKLOG_REPLAY (500 rows) actually truncated the backlog. The socket
// alone cannot deliver more than that over the wire, so this client pages
// `GET /api/v1/agent/updates?after=<cursor>&timeout=0` (a real poll
// response has no such cap beyond its own `limit`) until a page comes back
// empty. This is the ONLY remaining use of the poll endpoint's `timeout`
// parameter, and it fires only when `more` says so -- never on an
// interval. Live frames that arrive WHILE backfill is running are buffered
// (never dropped) and drained -- in id order RELATIVE TO EACH OTHER, never
// interleaved with backfill's own dispatch order -- once the backfill loop
// empties out; DedupeStore makes any overlap between a buffered live frame
// and a backfilled row harmless either way.
//
// RECONNECT: on close (clean or not), a dead-ping timeout, or a rejected
// subscription, reconnect with exponential backoff (RECONNECT_MIN_DELAY_MS
// .. RECONNECT_MAX_DELAY_MS, jittered), resubscribing with whatever
// cursorStore now holds. A 429 on the handshake itself (the blanket
// api-key/ip ceiling in rack_attack.rb covers /cable the same as any other
// path) honours Retry-After exactly like the old poll client did,
// overriding the backoff for that one wait.
//
// verifyEnvelope/dispatch are unchanged from the poll-based client: every
// envelope, however it arrived (replay, backfill page, ack response, or a
// live frame), goes through the SAME signature check and the SAME
// dispatcher webhook.ts uses.

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { createDispatcher, type Logger, type WebhookServerOptions } from "./webhook.js";
import type { SaltId } from "./ids.js";

const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/** Lowercased, filesystem-safe form of an agent id -- used both for
 *  defaultStateDir's own directory name and (N9) to key individual files
 *  inside a directory that FileCursorStore/FileDedupeStore were given. */
function safeIdSegment(agentId: SaltId): string {
  return String(agentId).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
}

/** `~/.salt/agents/<agentId>` -- the default home for BOTH the cursor and
 *  dedupe files for one identity, unless the caller passes its own stores. */
function defaultStateDir(agentId: SaltId): string {
  return path.join(homedir(), ".salt", "agents", safeIdSegment(agentId));
}

// N2/N10 (second security review, 2026-09-18): directories 0700, files
// 0600 -- these are per-agent secrets-adjacent (a dedupe/cursor file
// mostly isn't sensitive on its own, but the directory convention is
// shared with sessions.ts's FileSessionStore, which DOES hold transcript
// content, so the permission discipline is enforced once, here, for
// every consumer of writeJsonAtomic rather than trusted to each caller).
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

async function writeJsonAtomic(target: string, data: unknown): Promise<void> {
  const dir = path.dirname(target);
  // L3 (round 3, 2026-09-18): mkdir's return value is the path of the
  // first directory it actually created, or undefined if the whole path
  // already existed -- only chmod when THIS call created it. A directory
  // that already existed is the caller's (or a previous run's) to manage;
  // forcing 0700 on it would silently tighten permissions on something
  // this SDK doesn't own.
  const created = await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (created) await fs.chmod(dir, DIR_MODE).catch(() => {});
  const tmp = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  // The temp file is always freshly created by this call, so it's always
  // ours to chmod.
  await fs.writeFile(tmp, JSON.stringify(data), { mode: FILE_MODE });
  await fs.chmod(tmp, FILE_MODE).catch(() => {});
  await fs.rename(tmp, target);
}

// Creates the default state directory (0700, and only chmod'd if THIS
// call created it -- L3, same reasoning as writeJsonAtomic above) and
// proves it's actually writable with a probe file. Throws on failure;
// see resolveDefaultStores below for what the caller does with that
// (round 2 treated this as fail-closed -- refuse to start at all; round 3
// relaxes it to a warning + in-memory fallback, since the server-side ack
// means a lost cursor/dedupe store is no longer a replay risk).
function ensureStateDirWritable(dir: string): void {
  try {
    const created = fsSync.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    if (created) {
      try {
        fsSync.chmodSync(dir, DIR_MODE);
      } catch {
        // Best-effort; an unwritable directory still fails the probe below.
      }
    }
    const probe = path.join(dir, `.writable-check-${process.pid}-${Math.random().toString(16).slice(2)}`);
    fsSync.writeFileSync(probe, "", { mode: FILE_MODE });
    fsSync.unlinkSync(probe);
  } catch (err) {
    throw new Error(`state directory ${dir} could not be created or is not writable: ${(err as Error).message}`);
  }
}

// Round 3 (2026-09-18): resolves the default file-backed stores for
// whichever of cursorStore/dedupeStore the caller didn't pass explicitly,
// falling back to in-memory stores with a clear warning log if the
// default directory can't be created/written -- rather than round 2's
// synchronous throw. Safe now because salt-api remembers this agent's
// last-acked cursor server-side (the Telegram-offset model): losing the
// local cursor/dedupe set on restart means re-fetching from the SERVER's
// ack, at worst a small amount of re-verification/re-dedupe work, never a
// skipped or endlessly-replayed update.
function resolveDefaultStores(stateDir: string, agentId: SaltId, logger: Logger): { cursorStore: CursorStore; dedupeStore: DedupeStore } {
  try {
    ensureStateDirWritable(stateDir);
    return { cursorStore: FileCursorStore(stateDir), dedupeStore: FileDedupeStore(stateDir) };
  } catch (err) {
    logger.error(
      `[socket ${agentId}] WARNING: ${(err as Error).message} -- falling back to IN-MEMORY cursor/dedupe stores for ` +
        `this run. This is safe: salt-api remembers this agent's last-acked position server-side and a subscribe/poll ` +
        `with no local cursor resumes from there. Pass cursorStore/dedupeStore explicitly to silence this, or fix the ` +
        `directory's permissions to restore persistence across restarts.`
    );
    return { cursorStore: MemoryCursorStore(), dedupeStore: MemoryDedupeStore() };
  }
}

// --- Cursor persistence ----------------------------------------------------

export interface CursorStore {
  /** The last-acked update id for this identity, or 0 for "never polled". */
  get(agentId: SaltId): Promise<number>;
  put(agentId: SaltId, cursor: number): Promise<void>;
}

/** In-memory cursor store. Lost on restart (a fresh process re-subscribes
 *  from cursor 0, which resumes from salt-api's own server-side ack --
 *  see this file's header comment). Opt in explicitly; the default is
 *  FileCursorStore -- see createSocketClient. */
export function MemoryCursorStore(): CursorStore {
  const cursors = new Map<string, number>();
  const key = (id: SaltId) => String(id).toLowerCase();
  return {
    async get(agentId) {
      return cursors.get(key(agentId)) ?? 0;
    },
    async put(agentId, cursor) {
      cursors.set(key(agentId), cursor);
    },
  };
}

/**
 * `<agentId>.cursor.json` inside `dir` -- written atomically (temp file +
 * rename), the same convention sessions.ts's FileSessionStore uses. `dir`
 * defaults to one identity's own directory (see defaultStateDir), but N9
 * (second security review, 2026-09-18) keys the FILENAME by agent id too:
 * a caller pointing several identities at one SHARED directory (rather
 * than createSocketClient's per-identity default) used to collide on the
 * same fixed `cursor.json` -- one agent's cursor silently clobbering
 * another's. Keying by id makes a shared directory safe the same way
 * sessions.ts's one-file-per-key convention already is.
 */
export function FileCursorStore(dir: string): CursorStore {
  const fileFor = (agentId: SaltId) => path.join(dir, `${safeIdSegment(agentId)}.cursor.json`);
  return {
    async get(agentId) {
      try {
        const raw = await fs.readFile(fileFor(agentId), "utf8");
        const parsed = JSON.parse(raw) as { cursor?: unknown };
        return typeof parsed.cursor === "number" && Number.isFinite(parsed.cursor) ? parsed.cursor : 0;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw err;
      }
    },
    async put(agentId, cursor) {
      await writeJsonAtomic(fileFor(agentId), { cursor });
    },
  };
}

// --- Delivery-id dedupe (M5/F3: replay protection without trusting the
// --- envelope's own timestamp) ----------------------------------------------

export interface DedupeStore {
  has(agentId: SaltId, deliveryId: string): Promise<boolean>;
  add(agentId: SaltId, deliveryId: string): Promise<void>;
}

export const DEFAULT_DEDUPE_MAX = 5000;

/** In-memory dedupe set, bounded to the last `max` delivery ids (oldest
 *  dropped first). Opt in explicitly; the default is FileDedupeStore. */
export function MemoryDedupeStore(max: number = DEFAULT_DEDUPE_MAX): DedupeStore {
  const seen = new Map<string, Set<string>>();
  const order = new Map<string, string[]>();
  const key = (id: SaltId) => String(id).toLowerCase();
  return {
    async has(agentId, deliveryId) {
      return seen.get(key(agentId))?.has(deliveryId) ?? false;
    },
    async add(agentId, deliveryId) {
      const k = key(agentId);
      const set = seen.get(k) ?? new Set<string>();
      const list = order.get(k) ?? [];
      if (!set.has(deliveryId)) {
        set.add(deliveryId);
        list.push(deliveryId);
        while (list.length > max) {
          const oldest = list.shift();
          if (oldest !== undefined) set.delete(oldest);
        }
      }
      seen.set(k, set);
      order.set(k, list);
    },
  };
}

/**
 * `<agentId>.seen.json` inside `dir` (an ordered array of the last `max`
 * delivery ids, oldest first) -- same atomic-write convention as
 * FileCursorStore. N9 (second security review, 2026-09-18): the filename
 * is keyed by agent id, same reasoning as FileCursorStore above -- a
 * shared `dir` across identities must not let one identity's dedupe set
 * clobber another's (or worse, let identity B's real deliveries appear
 * "already seen" because they share a delivery_id namespace collision
 * with identity A's file).
 */
export function FileDedupeStore(dir: string, max: number = DEFAULT_DEDUPE_MAX): DedupeStore {
  const fileFor = (agentId: SaltId) => path.join(dir, `${safeIdSegment(agentId)}.seen.json`);
  const cache = new Map<string, string[]>(); // mirrors each agent's file within one process so `has` doesn't re-read on every check

  async function load(agentId: SaltId): Promise<string[]> {
    const key = safeIdSegment(agentId);
    const cached = cache.get(key);
    if (cached) return cached;
    let list: string[];
    try {
      const raw = await fs.readFile(fileFor(agentId), "utf8");
      const parsed = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") list = [];
      else throw err;
    }
    cache.set(key, list);
    return list;
  }

  return {
    async has(agentId, deliveryId) {
      const list = await load(agentId);
      return list.includes(deliveryId);
    },
    async add(agentId, deliveryId) {
      const list = await load(agentId);
      if (list.includes(deliveryId)) return;
      list.push(deliveryId);
      while (list.length > max) list.shift();
      cache.set(safeIdSegment(agentId), list);
      await writeJsonAtomic(fileFor(agentId), list);
    },
  };
}

// --- The push client ---------------------------------------------------------

/** The wire shape of one envelope -- a channel frame's `message` (replay or
 *  live), or one row from GET /api/v1/agent/updates (backfill/ack). See
 *  this file's header comment for the full contract. */
interface RawAgentUpdate {
  id: number;
  delivery_id: string;
  event: string;
  headers: Record<string, string | undefined>;
  body: string;
  created_at: string;
}

interface RawAgentUpdatesResponse {
  updates: RawAgentUpdate[];
  cursor: number;
}

interface ReplayDoneFrame {
  type: "replay_done";
  cursor?: number;
  more?: boolean;
}

/** Exponential reconnect backoff bounds (jittered). Not a poll interval --
 *  these only govern the wait between one dropped/closed connection and
 *  the next connection attempt. */
export const RECONNECT_MIN_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 60_000;

/** No Action Cable ping for this long means the connection is presumed
 *  dead (a half-open TCP socket may never emit its own 'close'/'error'). */
export const PING_TIMEOUT_MS = 30_000;

export interface SocketClientOptions extends WebhookServerOptions {
  /** The salt-api deployment's origin, e.g. "https://saltapp.ai" (or
   *  "http://localhost:3000" in dev) -- rewritten to a ws(s):// `/cable`
   *  URL for the websocket, and used as-is for the backfill/ack HTTP
   *  calls. No trailing slash required either way. */
  host: string;
  /** This identity's OWN api-key, sent as the `api-key` header on the
   *  websocket handshake and on every backfill/ack HTTP call. Not the same
   *  thing as `identities`, which can hold several hosted identities for
   *  DECRYPT/ROUTE purposes -- a process draining more than one identity's
   *  outbox runs one createSocketClient per identity. */
  apiKey: string;
  /** That identity's Salt id -- the cursor/dedupe stores' default directory
   *  key, and used in log lines. */
  agentId: SaltId;
  /** Where the resume cursor is persisted across restarts/reconnects.
   *  Defaults to `FileCursorStore(~/.salt/agents/<agentId>)` -- pass
   *  `MemoryCursorStore()` explicitly to opt OUT of persistence instead. */
  cursorStore?: CursorStore;
  /** Persistent per-agent delivery_id dedupe (M5/F3) -- replay protection
   *  that doesn't rely on the envelope's own timestamp. Defaults to
   *  `FileDedupeStore(~/.salt/agents/<agentId>)`; pass `MemoryDedupeStore()`
   *  explicitly to opt out of persistence. */
  dedupeStore?: DedupeStore;
  /** Max rows per backfill page (only fetched when replay_done.more is
   *  true -- see this file's header comment). Defaults to 100. */
  limit?: number;
  /** Reconnect backoff bounds (ms), exponential + jittered. Also used for
   *  a failed backfill/ack HTTP call's own retry wait. Defaults to
   *  RECONNECT_MIN_DELAY_MS..RECONNECT_MAX_DELAY_MS (1s..60s). */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Override fetch (backfill/ack HTTP calls; tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the WebSocket implementation (tests). Defaults to `ws`'s WebSocket. */
  webSocketImpl?: typeof WebSocket;
  /** How long without an Action Cable ping before this connection is
   *  presumed dead and torn down for a reconnect. Defaults to
   *  PING_TIMEOUT_MS (30s) -- exposed mainly so tests don't have to wait
   *  out the real default. */
  pingTimeoutMs?: number;
}

export interface SocketClient {
  /** Starts the connection loop in the background. A no-op if already running. */
  start(): void;
  /** Stops the loop: terminates any open/connecting websocket and aborts
   *  any in-flight backfill/ack request immediately, and resolves once
   *  everything has actually settled (never mid-reconnect, never with a
   *  background ack still in flight). */
  stop(): Promise<void>;
}

type RowOutcome = "advance" | "transient";

// Honours Retry-After on a 429 -- from Rack::Attack's blanket api-key/ip
// ceiling on the /cable handshake, or from the backfill/ack HTTP calls'
// own throttles (N3's agent_updates_longpoll, or the blanket one on any
// other path). Carries the parsed wait (in ms, if any) alongside the
// thrown/returned error so the reconnect backoff can use the server's own
// authoritative figure instead of guessing with exponential backoff, which
// could easily be far shorter than the throttle window.
class PollHttpError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "PollHttpError";
    this.retryAfterMs = retryAfterMs;
  }
}

// L4 (round 3, 2026-09-18): a misconfigured or hostile Retry-After must
// not be able to park this client indefinitely -- clamp to 15 minutes,
// comfortably above every real throttle window in rack_attack.rb (the
// longest is the 5-minute blanket one) while still bounding the wait.
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

/** Rack::Attack (and HTTP generally) sends Retry-After as either a plain
 *  integer number of seconds or an HTTP-date; either is honoured, clamped
 *  to MAX_RETRY_AFTER_MS. Accepts the header value however the caller's
 *  transport hands it back (a single string, or the first of an array --
 *  Node's http.IncomingMessage can return either for a repeated header). */
function parseRetryAfterMs(value: string | string[] | null | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000)) : undefined;
  }
  const asDate = Date.parse(trimmed);
  return Number.isNaN(asDate) ? undefined : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, asDate - Date.now()));
}

function jitter(ms: number): number {
  // Half fixed, half random -- avoids a thundering herd of identical
  // reconnect timings without making the wait unpredictably short.
  return Math.round(ms / 2 + Math.random() * (ms / 2));
}

/**
 * Drains one identity's K2 socket-mode outbox by staying connected to
 * salt-api's `AgentUpdatesChannel` over Action Cable, verifying each
 * envelope with the exact same check createWebhookServer applies to a
 * webhook POST (createDispatcher's verifyEnvelope), and dispatching it to
 * the SAME onMessage/onCardInteraction/etc. handlers. See this file's
 * header comment for the full wire protocol, the one-line switch from
 * createWebhookServer, and the reasoning behind cursor persistence, the
 * ack call, backfill, and reconnect.
 */
export function createSocketClient(options: SocketClientOptions): SocketClient {
  const logger = options.logger ?? consoleLogger;
  const dispatcher = createDispatcher(options);
  const host = options.host.replace(/\/$/, "");
  const wsHost = host.replace(/^http/, "ws"); // http(s):// -> ws(s)://
  const fetchImpl = options.fetchImpl ?? fetch;
  const WS = options.webSocketImpl ?? WebSocket;
  const stateDir = defaultStateDir(options.agentId);
  // Resolved once, synchronously, right here -- only when at least one
  // default (file-backed) store is actually needed (a caller passing BOTH
  // cursorStore and dedupeStore explicitly has opted out of file
  // persistence entirely, and this directory is never touched on their
  // behalf). Never throws on an unwritable directory -- see
  // resolveDefaultStores.
  const needsStateDir = options.cursorStore === undefined || options.dedupeStore === undefined;
  const defaults = needsStateDir ? resolveDefaultStores(stateDir, options.agentId, logger) : undefined;
  const cursorStore = options.cursorStore ?? defaults!.cursorStore;
  const dedupeStore = options.dedupeStore ?? defaults!.dedupeStore;
  const limit = options.limit ?? 100;
  const pingTimeoutMs = options.pingTimeoutMs ?? PING_TIMEOUT_MS;
  const minBackoffMs = options.minBackoffMs ?? RECONNECT_MIN_DELAY_MS;
  const maxBackoffMs = options.maxBackoffMs ?? RECONNECT_MAX_DELAY_MS;
  const agentId = options.agentId;
  const apiKey = options.apiKey;

  let stopped = true;
  let loopPromise: Promise<void> | null = null;
  let currentSocket: WebSocket | null = null;
  let currentAbort: AbortController | null = null;
  let wakeSleep: (() => void) | null = null;
  // The most recent (possibly still in-flight) ack call, so stop() can
  // wait for it -- ack itself is deliberately fire-and-forget relative to
  // frame dispatch (see runAck below), so nothing else awaits this chain.
  let ackTail: Promise<void> = Promise.resolve();

  // See this file's header comment ("A ROW THAT FAILS VERIFICATION
  // TRANSIENTLY..."): the lowest update id that has failed verification
  // for a reason that might be transient and hasn't since been resolved.
  // Every cursor persistence point clamps to stop just short of this, so
  // the next reconnect's replay re-delivers it (and everything after --
  // dedupe makes that overlap harmless) instead of losing it for good.
  let pendingFailureId: number | null = null;
  function noteTransientFailure(id: number): void {
    if (pendingFailureId === null || id < pendingFailureId) pendingFailureId = id;
  }
  function noteResolved(id: number): void {
    if (pendingFailureId !== null && id === pendingFailureId) pendingFailureId = null;
  }
  function clampForPersistence(candidate: number): number {
    return pendingFailureId === null ? candidate : Math.min(candidate, pendingFailureId - 1);
  }
  async function persistCursor(candidate: number): Promise<void> {
    const safe = clampForPersistence(candidate);
    if (safe < 0) return; // nothing safe to persist yet (failure sits at/before id 0 -- can't happen in practice, guard anyway)
    try {
      await cursorStore.put(agentId, safe);
    } catch (err) {
      logger.error(`[socket ${agentId}] persisting cursor ${safe} failed: ${(err as Error).message}`);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = null;
        resolve();
      }, ms);
      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = null;
        resolve();
      };
    });
  }

  // Verifies + dedupes + dispatches ONE envelope, regardless of whether it
  // arrived as a replay frame, a live frame, or a row fetched via backfill
  // or the ack call -- all four paths funnel through here. Returns
  // "transient" (and records pendingFailureId) for a verification failure
  // that might resolve on retry; every other outcome ("advance") is safe
  // to note as processed, whether that means dispatched, a deduped-skip,
  // or a DEFINITIVE rejection (a genuinely bad signature) -- retrying a
  // definitively bad envelope forever would just wedge this client on it.
  async function handleOne(update: RawAgentUpdate): Promise<RowOutcome> {
    const headers = update.headers || {};
    let result: Awaited<ReturnType<typeof dispatcher.verifyEnvelope>>;
    try {
      result = await dispatcher.verifyEnvelope(headers["X-Salt-Agent-Id"], headers["X-Salt-Signature"], update.body);
    } catch (err) {
      logger.error(`[socket ${agentId}] verifying update ${update.id} threw: ${(err as Error).message}; will retry on the next replay`);
      noteTransientFailure(update.id);
      return "transient";
    }
    if (!result.ok) {
      if (result.transient) {
        logger.error(`[socket ${agentId}] update ${update.id} failed verification transiently (${result.reason}); will retry on the next replay`);
        noteTransientFailure(update.id);
        return "transient";
      }
      logger.error(`[socket ${agentId}] rejected update ${update.id} (${update.event}): ${result.reason}`);
      noteResolved(update.id);
      return "advance";
    }

    noteResolved(update.id);

    const alreadySeen = await dedupeStore.has(agentId, update.delivery_id).catch((err) => {
      logger.error(`[socket ${agentId}] dedupe lookup for ${update.delivery_id} failed: ${(err as Error).message}`);
      return false; // fail open on the dedupe check itself -- a lookup failure must not block real delivery
    });
    if (alreadySeen) return "advance";

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(update.body);
    } catch (err) {
      logger.error(`[socket ${agentId}] update ${update.id} had unparseable body: ${(err as Error).message}`);
      return "advance";
    }
    try {
      await dispatcher.dispatch(body, headers["X-Salt-Agent-Id"]);
    } catch (err) {
      logger.error(`[socket ${agentId}] unhandled error dispatching update ${update.id}: ${(err as Error).message}`);
    }
    await dedupeStore.add(agentId, update.delivery_id).catch((err) => {
      logger.error(`[socket ${agentId}] recording dedupe for ${update.delivery_id} failed: ${(err as Error).message}`);
    });
    return "advance";
  }

  // --- Ack (coalesced, event-driven -- see this file's header comment) ---
  let highestProcessed = 0;
  let ackInFlight = false;
  let ackPending = false;
  function noteProcessed(id: number): void {
    if (id > highestProcessed) highestProcessed = id;
  }
  function runAck(): void {
    if (stopped) return;
    if (highestProcessed === 0) return; // nothing processed yet -- nothing to ack
    if (ackInFlight) {
      ackPending = true;
      return;
    }
    ackInFlight = true;
    const after = highestProcessed;
    ackTail = (async () => {
      try {
        currentAbort = new AbortController();
        const url = `${host}/api/v1/agent/updates?timeout=0&limit=1&after=${after}`;
        let res: Response;
        try {
          res = await fetchImpl(url, { headers: { "api-key": apiKey }, signal: currentAbort.signal });
        } finally {
          currentAbort = null;
        }
        if (!res.ok) {
          logger.error(`[socket ${agentId}] ack request -> ${res.status}`);
          return;
        }
        const parsed = (await res.json()) as RawAgentUpdatesResponse;
        for (const row of parsed.updates || []) {
          const outcome = await handleOne(row);
          if (outcome === "advance") noteProcessed(row.id);
        }
        const finalCursor = typeof parsed.cursor === "number" ? parsed.cursor : after;
        await persistCursor(finalCursor);
      } catch (err) {
        if (!stopped) logger.error(`[socket ${agentId}] ack request failed: ${(err as Error).message}`);
      } finally {
        ackInFlight = false;
        if (ackPending) {
          ackPending = false;
          runAck();
        }
      }
    })();
  }

  // --- Backfill (replay_done.more only -- see this file's header comment) ---
  // Pages forward from `cursor` until a page comes back empty. Persists
  // (clamped) after every page -- each page is a real poll-shaped response,
  // safe to treat exactly like the old poll client's cursor advance.
  // `isClosed` lets the CALLER's connection stop this loop promptly on an
  // ordinary reconnect (not just the global `stopped` flag, which only
  // stop() sets) -- see handleReplayDone's caller for why this runs
  // detached from messageQueue in the first place.
  async function backfillFrom(cursor: number, isClosed: () => boolean): Promise<void> {
    let after = cursor;
    let backoff = minBackoffMs;
    while (!stopped && !isClosed()) {
      let res: Response;
      try {
        currentAbort = new AbortController();
        const url = `${host}/api/v1/agent/updates?timeout=0&limit=${limit}&after=${after}`;
        try {
          res = await fetchImpl(url, { headers: { "api-key": apiKey }, signal: currentAbort.signal });
        } finally {
          currentAbort = null;
        }
      } catch (err) {
        if (stopped || isClosed()) return;
        logger.error(`[socket ${agentId}] backfill request failed: ${(err as Error).message}; retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoffMs);
        continue;
      }
      if (!res.ok) {
        if (stopped || isClosed()) return;
        logger.error(`[socket ${agentId}] backfill -> ${res.status}; retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoffMs);
        continue;
      }
      backoff = minBackoffMs;
      const parsed = (await res.json()) as RawAgentUpdatesResponse;
      const rows = parsed.updates || [];
      for (const row of rows) {
        const outcome = await handleOne(row);
        if (outcome === "advance") {
          noteProcessed(row.id);
          after = row.id;
        }
      }
      const finalCursor = typeof parsed.cursor === "number" ? parsed.cursor : after;
      after = finalCursor;
      await persistCursor(after);
      if (rows.length === 0) return; // caught up
    }
  }

  // --- One websocket connection's lifecycle -----------------------------
  // Resolves once this connection has closed (however it closed), with an
  // optional retryAfterMs to override the next reconnect wait, and whether
  // it ever reached confirm_subscription (a clean connection resets the
  // exponential backoff).
  function runConnection(): Promise<{ retryAfterMs?: number; subscribed: boolean }> {
    return (async () => {
      let localCursor = 0;
      try {
        localCursor = await cursorStore.get(agentId);
      } catch (err) {
        logger.error(`[socket ${agentId}] loading cursor failed, starting from 0: ${(err as Error).message}`);
      }

      return new Promise<{ retryAfterMs?: number; subscribed: boolean }>((resolveConn) => {
        let settled = false;
        let subscribed = false;
        let retryAfterMsOverride: number | undefined;
        let state: "replaying" | "backfilling" | "live" = "replaying";
        let liveBuffer: RawAgentUpdate[] = [];
        let pingTimer: ReturnType<typeof setTimeout> | null = null;
        let closed = false; // this CONNECTION closed (distinct from `stopped`, the whole client) -- stops backfillTail promptly on an ordinary reconnect
        let backfillTail: Promise<void> = Promise.resolve();
        // Frames must be handled strictly in arrival order, but handleOne
        // is async -- Node's ws library can emit several buffered
        // 'message' events synchronously before the first handler's await
        // resolves, so without this chain two frames could be verified/
        // dispatched out of order or concurrently. Each 'message' handler
        // only ever appends to this chain, never awaits work directly.
        let messageQueue: Promise<void> = Promise.resolve();

        function clearPingTimer(): void {
          if (pingTimer) {
            clearTimeout(pingTimer);
            pingTimer = null;
          }
        }
        function armPingWatchdog(): void {
          clearPingTimer();
          pingTimer = setTimeout(() => {
            logger.error(`[socket ${agentId}] no ping for ${pingTimeoutMs}ms; treating the connection as dead`);
            try {
              socket.terminate();
            } catch {
              // already gone
            }
          }, pingTimeoutMs);
        }

        function finish(): void {
          if (settled) return;
          settled = true;
          closed = true;
          clearPingTimer();
          currentSocket = null;
          // Wait for this connection's own backfillTail (if any) to notice
          // `closed` and unwind before resolving -- otherwise loop() could
          // start a NEW connection while this one's backfill is still
          // mid-flight, and stop()'s "resolves once everything has settled"
          // guarantee would be a lie.
          backfillTail.finally(() => {
            resolveConn({ retryAfterMs: retryAfterMsOverride, subscribed });
          });
        }

        const socket = new WS(`${wsHost}/cable`, { headers: { "api-key": apiKey } });
        currentSocket = socket;

        async function handleReplayDone(frame: ReplayDoneFrame): Promise<void> {
          const serverCursor = typeof frame.cursor === "number" ? frame.cursor : localCursor;
          await persistCursor(serverCursor);
          if (frame.more) {
            state = "backfilling";
            // Deliberately NOT awaited here. This handler is one link in
            // messageQueue -- awaiting the whole backfill (which can take
            // several HTTP round trips) inside it would block every
            // SUBSEQUENT frame's handler from running at all until backfill
            // finished, since messageQueue only runs one link at a time.
            // That would make the `state === "backfilling"` buffering
            // branch below unreachable: a live frame could never actually
            // get buffered if its own handler never got to run in the
            // first place. Running it detached lets messageQueue keep
            // draining (buffering live frames as they arrive) while this
            // resolves independently; backfillTail is what finish() waits
            // on so stop()/reconnect still settle cleanly.
            backfillTail = backfillFrom(serverCursor, () => closed)
              .catch((err) => {
                logger.error(`[socket ${agentId}] backfill failed: ${(err as Error).message}`);
              })
              .then(() => {
                // The drain itself is routed through messageQueue too --
                // not just backfillFrom above -- so it can never race a
                // live frame that arrives (and gets appended to the
                // queue) in the exact window backfill just finished. Without
                // this, a frame queued between "snapshot the buffer" and
                // "flip state to live" would land in a liveBuffer nobody
                // ever drains again -- serializing it here means a frame
                // still sees state === "backfilling" (and buffers itself,
                // picked up by the NEXT drain -- though there is only ever
                // one) or runs after state flips to "live" (and takes the
                // ordinary live-dispatch path) -- never the gap in between.
                const drained = messageQueue.then(async () => {
                  const buffered = liveBuffer.slice().sort((a, b) => a.id - b.id);
                  liveBuffer = [];
                  for (const row of buffered) {
                    const outcome = await handleOne(row);
                    if (outcome === "advance") noteProcessed(row.id);
                  }
                  state = "live";
                  runAck();
                });
                messageQueue = drained.catch((err) => {
                  logger.error(`[socket ${agentId}] error draining the backfill live-frame buffer: ${(err as Error).message}`);
                });
                return messageQueue;
              });
            return;
          }
          state = "live";
          runAck();
        }

        async function handleFrame(raw: WebSocket.RawData): Promise<void> {
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(raw.toString());
          } catch (err) {
            logger.error(`[socket ${agentId}] unparseable frame: ${(err as Error).message}`);
            return;
          }

          const type = frame.type as string | undefined;
          if (type === "ping") {
            armPingWatchdog();
            return;
          }
          if (type === "welcome") {
            armPingWatchdog();
            return;
          }
          if (type === "confirm_subscription") {
            subscribed = true;
            logger.info(`[socket ${agentId}] subscribed (cursor ${localCursor})`);
            return;
          }
          if (type === "reject_subscription") {
            logger.error(`[socket ${agentId}] subscription rejected; reconnecting`);
            try {
              socket.close();
            } catch {
              // already gone
            }
            return;
          }
          if (type === "disconnect") {
            // Server-initiated close (e.g. a deploy) -- the 'close' event
            // follows and drives reconnect the same as any other close.
            logger.info(`[socket ${agentId}] server requested disconnect${frame.reason ? ` (${frame.reason})` : ""}`);
            return;
          }

          const payload = frame.message as Record<string, unknown> | undefined;
          if (!payload || typeof payload !== "object") return;

          if (payload.type === "replay_done") {
            await handleReplayDone(payload as unknown as ReplayDoneFrame);
            return;
          }

          if (typeof payload.id !== "number") return;
          const update = payload as unknown as RawAgentUpdate;
          if (state === "backfilling") {
            liveBuffer.push(update);
            return;
          }
          const outcome = await handleOne(update);
          if (outcome === "advance") {
            noteProcessed(update.id);
            if (state === "live") runAck();
          }
        }

        socket.on("open", () => {
          const identifier =
            localCursor > 0
              ? JSON.stringify({ channel: "AgentUpdatesChannel", after: localCursor })
              : JSON.stringify({ channel: "AgentUpdatesChannel" });
          socket.send(JSON.stringify({ command: "subscribe", identifier }));
        });

        socket.on("message", (raw) => {
          messageQueue = messageQueue.then(() => handleFrame(raw)).catch((err) => {
            logger.error(`[socket ${agentId}] error handling frame: ${(err as Error).message}`);
          });
        });

        socket.on("unexpected-response", (_req, res) => {
          const status = res.statusCode;
          if (status === 429) {
            retryAfterMsOverride = parseRetryAfterMs(res.headers["retry-after"]);
          }
          logger.error(`[socket ${agentId}] handshake failed: HTTP ${status}`);
          res.resume(); // drain so the underlying socket can close cleanly
          messageQueue.finally(finish);
        });

        socket.on("close", () => {
          messageQueue.finally(finish);
        });

        socket.on("error", (err) => {
          logger.error(`[socket ${agentId}] websocket error: ${(err as Error).message}`);
          // 'close' normally follows an 'error' in the ws library; finish()
          // runs there. If it somehow doesn't, stop()'s terminate() (or a
          // future reconnect attempt) still recovers the process.
        });
      });
    })();
  }

  async function loop(): Promise<void> {
    let backoff = minBackoffMs;
    logger.info(`[socket ${agentId}] connecting to ${wsHost}/cable`);
    while (!stopped) {
      let outcome: { retryAfterMs?: number; subscribed: boolean };
      try {
        outcome = await runConnection();
      } catch (err) {
        logger.error(`[socket ${agentId}] connection failed: ${(err as Error).message}`);
        outcome = { subscribed: false };
      }
      if (stopped) break;
      if (outcome.subscribed) backoff = minBackoffMs; // a clean connection resets the failure backoff
      const waitMs = outcome.retryAfterMs ?? jitter(backoff);
      logger.error(
        `[socket ${agentId}] reconnecting in ${waitMs}ms` + (outcome.retryAfterMs !== undefined ? " (Retry-After)" : "")
      );
      await sleep(waitMs);
      backoff = Math.min(backoff * 2, maxBackoffMs);
    }
  }

  return {
    start() {
      if (loopPromise) return; // already running
      stopped = false;
      loopPromise = loop().catch((err) => logger.error(`[socket ${agentId}] loop exited unexpectedly: ${(err as Error).message}`));
    },
    async stop() {
      stopped = true;
      wakeSleep?.();
      currentAbort?.abort();
      if (currentSocket) {
        try {
          currentSocket.terminate();
        } catch {
          // already gone
        }
      }
      await loopPromise;
      loopPromise = null;
      await ackTail.catch(() => {});
    },
  };
}
