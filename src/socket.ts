// K2 socket mode (design-fleet/runs/2026-09-17-distribution/LANES.md
// "Socket mode contract"): an agent with no public URL -- OpenClaw, a local
// LangGraph script, Claude Code on a laptop -- can't receive a webhook
// POST. This is the Slack Socket Mode / Telegram getUpdates precedent: SHORT-
// poll `GET /api/v1/agent/updates` for exactly what a webhook would have
// delivered, verify each envelope the same way, and hand it to the SAME
// handlers.
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
// One drain per (host) identity, since salt-api's outbox and its auth are
// both per-agent -- a process hosting several socket-mode identities runs
// one createSocketClient per identity, each feeding the same or a shared
// dispatcher.
//
// SECURITY REVIEW (2026-09-18), what changed here and why:
//   H1: salt-api's long-poll became a SHORT poll (server-clamped to 0..2s).
//       AgentUpdatesChannel over Action Cable is the real push path; this
//       is the fallback/catch-up, polled ADAPTIVELY (see ACTIVE_POLL_DELAY_MS/
//       IDLE_POLL_DELAY_MS below) rather than in a tight loop.
//   M5/F3: a socket envelope can sit in the outbox for days before this
//       client ever sees it, so its embedded signing timestamp is routinely
//       "stale" by the webhook path's ~300s tolerance. Verification here
//       uses a MUCH wider tolerance (SOCKET_SIGNATURE_TOLERANCE_SECONDS,
//       matching salt-api's AgentUpdate::RETENTION + 1h of slack). Replay
//       protection comes from the cursor plus a persistent per-agent
//       delivery_id dedupe (DedupeStore) instead of the timestamp. A
//       verification failure that LOOKS transient (a network error
//       fetching the signing key, never a bad/forged signature) halts this
//       batch and does NOT advance the cursor past it -- retried with
//       backoff instead, or a real update sitting behind a network blip
//       would be skipped forever.
//   The default cursor/dedupe stores are now FILE-based
//   (~/.salt/agents/<agentId>/{cursor,seen}.json) -- memory is opt-in, not
//   the default, since silently losing the cursor/dedupe set on every
//   restart is exactly the kind of thing that should be a deliberate
//   choice, not an accident of not passing an option.

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { createDispatcher, type Logger, type WebhookServerOptions } from "./webhook.js";
import type { SaltId } from "./ids.js";

const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

/** `~/.salt/agents/<agentId>` -- the default home for BOTH the cursor and
 *  dedupe files for one identity, unless the caller passes its own stores. */
function defaultStateDir(agentId: SaltId): string {
  const safe = String(agentId).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return path.join(homedir(), ".salt", "agents", safe);
}

async function writeJsonAtomic(target: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, target);
}

// --- Cursor persistence ----------------------------------------------------

export interface CursorStore {
  /** The last-acked update id for this identity, or 0 for "never polled". */
  get(agentId: SaltId): Promise<number>;
  put(agentId: SaltId, cursor: number): Promise<void>;
}

/** In-memory cursor store. Lost on restart (a fresh process re-reads from
 *  cursor 0 -- everything AgentUpdatePruneJob hasn't pruned yet, up to
 *  AgentUpdate::RETENTION). Opt in explicitly; the default is
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
 * One JSON file, `cursor.json`, inside `dir` -- written atomically (temp
 * file + rename), the same convention sessions.ts's FileSessionStore uses.
 * `dir` is meant to be ONE IDENTITY'S OWN directory (see defaultStateDir) --
 * unlike sessions.ts's shared-directory-with-one-file-per-key convention,
 * this holds exactly one value, so there's nothing to key by inside it; a
 * process draining several identities passes a different `dir` per
 * identity (createSocketClient's default already does this for you).
 */
export function FileCursorStore(dir: string): CursorStore {
  const file = path.join(dir, "cursor.json");
  return {
    async get() {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as { cursor?: unknown };
        return typeof parsed.cursor === "number" && Number.isFinite(parsed.cursor) ? parsed.cursor : 0;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw err;
      }
    },
    async put(_agentId, cursor) {
      await writeJsonAtomic(file, { cursor });
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
 * One JSON file, `seen.json`, inside `dir` (an ordered array of the last
 * `max` delivery ids, oldest first) -- same atomic-write convention as
 * FileCursorStore. `dir` is one identity's own directory; agentId is
 * accepted only to satisfy DedupeStore's shape.
 */
export function FileDedupeStore(dir: string, max: number = DEFAULT_DEDUPE_MAX): DedupeStore {
  const file = path.join(dir, "seen.json");
  let cache: string[] | null = null; // mirrors the file within one process so `has` doesn't re-read on every check

  async function load(): Promise<string[]> {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = JSON.parse(raw);
      cache = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") cache = [];
      else throw err;
    }
    return cache;
  }

  return {
    async has(_agentId, deliveryId) {
      const list = await load();
      return list.includes(deliveryId);
    },
    async add(_agentId, deliveryId) {
      const list = await load();
      if (list.includes(deliveryId)) return;
      list.push(deliveryId);
      while (list.length > max) list.shift();
      cache = list;
      await writeJsonAtomic(file, list);
    },
  };
}

// --- The short-poll client --------------------------------------------------

/** The wire shape of one row from GET /api/v1/agent/updates -- see LANES.md's socket mode contract. */
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

// M5/F3: matches salt-api's AgentUpdate::RETENTION (7 days) plus an hour of
// slack -- an envelope can legitimately sit in the outbox that long before
// this client ever sees it. The webhook path's ~300s default stays as-is
// for createWebhookServer; only the socket path needs this much room.
export const SOCKET_SIGNATURE_TOLERANCE_SECONDS = 7 * 24 * 60 * 60 + 60 * 60;

// Adaptive polling (H1's short-poll decision, LANES.md): the server itself
// only ever HOLDS a request for up to ~2s when there's nothing to return,
// so without an extra pause between polls an idle agent would still hit
// the endpoint every ~2s indefinitely. Right after real activity, poll
// again soon (ACTIVE_POLL_DELAY_MS); back off toward IDLE_POLL_DELAY_MS one
// step at a time the longer nothing shows up, and snap back to
// ACTIVE_POLL_DELAY_MS the moment something does.
export const ACTIVE_POLL_DELAY_MS = 1000;
export const IDLE_POLL_DELAY_MS = 5000;

export interface SocketClientOptions extends WebhookServerOptions {
  /** The salt-api deployment's origin, e.g. "https://saltapp.ai" -- the
   *  poll request is plain fetch (there is no long-poll-aware method on
   *  SaltClient), so it needs the host directly rather than through
   *  `client`. No trailing slash required either way. */
  host: string;
  /** This identity's OWN api-key. GET /api/v1/agent/updates authenticates
   *  per-agent and drains only that agent's own outbox -- this is NOT the
   *  same thing as `identities`, which can hold several hosted identities
   *  for DECRYPT/ROUTE purposes; a process socket-draining more than one of
   *  them runs one createSocketClient per identity. */
  apiKey: string;
  /** That identity's Salt id -- the cursor/dedupe stores' default directory
   *  key, and used in log lines. */
  agentId: SaltId;
  /** Where the poll cursor is persisted across restarts. Defaults to
   *  `FileCursorStore(~/.salt/agents/<agentId>)` -- pass `MemoryCursorStore()`
   *  explicitly to opt OUT of persistence instead. */
  cursorStore?: CursorStore;
  /** Persistent per-agent delivery_id dedupe (M5/F3) -- replay protection
   *  that doesn't rely on the envelope's own timestamp. Defaults to
   *  `FileDedupeStore(~/.salt/agents/<agentId>)`; pass `MemoryDedupeStore()`
   *  explicitly to opt out of persistence. */
  dedupeStore?: DedupeStore;
  /** Seconds the server should hold the request open waiting for new rows.
   *  Server-clamped to [0, 2] regardless of what's sent here (H1) --
   *  defaults to 2, the most useful value now that anything higher is
   *  wasted on the wire. */
  timeoutSeconds?: number;
  /** Max rows per response. Defaults to 100 (the server's own default). */
  limit?: number;
  /** Base retry delay after a failed poll (a network error, a non-2xx
   *  response, or a transient verification failure -- M5/F3), doubling
   *  each consecutive failure up to `maxBackoffMs`. Reset after any clean
   *  round trip. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Override fetch (e.g. for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SocketClient {
  /** Starts the poll loop in the background. A no-op if already running. */
  start(): void;
  /** Stops the loop: aborts an in-flight request/backoff wait immediately
   *  and resolves once the loop has actually exited (never mid-iteration). */
  stop(): Promise<void>;
}

type RowOutcome = "advance" | "halt";

/**
 * Drains one identity's K2 socket-mode outbox by polling
 * GET /api/v1/agent/updates (adaptively -- see ACTIVE_POLL_DELAY_MS/
 * IDLE_POLL_DELAY_MS), verifying each envelope with the exact same check
 * createWebhookServer applies to a webhook POST (createDispatcher's
 * verifyEnvelope, both headers + body, at SOCKET_SIGNATURE_TOLERANCE_SECONDS),
 * and dispatching it to the SAME onMessage/onCardInteraction/etc. handlers.
 * See this file's header comment for the one-line switch from
 * createWebhookServer, and for what the 2026-09-18 security review changed.
 */
export function createSocketClient(options: SocketClientOptions): SocketClient {
  const logger = options.logger ?? consoleLogger;
  const dispatcher = createDispatcher(options);
  const host = options.host.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const stateDir = defaultStateDir(options.agentId);
  const cursorStore = options.cursorStore ?? FileCursorStore(stateDir);
  const dedupeStore = options.dedupeStore ?? FileDedupeStore(stateDir);
  const timeoutSeconds = options.timeoutSeconds ?? 2;
  const limit = options.limit ?? 100;
  const minBackoffMs = options.minBackoffMs ?? 1000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const agentId = options.agentId;

  let stopped = true;
  let loopPromise: Promise<void> | null = null;
  let abortController: AbortController | null = null;
  let wakeSleep: (() => void) | null = null;

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

  // Returns "halt" the moment a row fails verification for a reason that
  // might be transient -- the caller must not advance the cursor past it.
  // Every other outcome (dispatched, deduped-skip, or a DEFINITIVE
  // rejection like a bad signature) is "advance": retrying a genuinely bad
  // envelope forever would just wedge the client on it.
  async function handleOne(update: RawAgentUpdate): Promise<RowOutcome> {
    const headers = update.headers || {};
    let result: Awaited<ReturnType<typeof dispatcher.verifyEnvelope>>;
    try {
      result = await dispatcher.verifyEnvelope(headers["X-Salt-Agent-Id"], headers["X-Salt-Signature"], update.body, {
        toleranceSeconds: SOCKET_SIGNATURE_TOLERANCE_SECONDS,
      });
    } catch (err) {
      logger.error(`[socket ${agentId}] verifying update ${update.id} threw: ${(err as Error).message}; will retry`);
      return "halt";
    }
    if (!result.ok) {
      if (result.transient) {
        logger.error(`[socket ${agentId}] update ${update.id} failed verification transiently (${result.reason}); will retry`);
        return "halt";
      }
      logger.error(`[socket ${agentId}] rejected update ${update.id} (${update.event}): ${result.reason}`);
      return "advance";
    }

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

  async function pollOnce(cursor: number): Promise<{ cursor: number; hadActivity: boolean; halted: boolean }> {
    const url = `${host}/api/v1/agent/updates?after=${cursor}&timeout=${timeoutSeconds}&limit=${limit}`;
    abortController = new AbortController();
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { "api-key": options.apiKey }, signal: abortController.signal });
    } finally {
      abortController = null;
    }
    if (!res.ok) {
      throw new Error(`GET /api/v1/agent/updates -> ${res.status}`);
    }
    const parsed = (await res.json()) as RawAgentUpdatesResponse;
    const updates = parsed.updates || [];

    let advanced = cursor;
    for (const update of updates) {
      const outcome = await handleOne(update);
      if (outcome === "halt") {
        // Stop here -- never process (or advance past) anything after a
        // row we couldn't yet verify, or ordering guarantees are moot.
        return { cursor: advanced, hadActivity: advanced !== cursor, halted: true };
      }
      advanced = update.id;
    }
    // No halts: trust the server's own cursor (it equals the last row's id,
    // or `after` unchanged when there was nothing to return).
    const finalCursor = typeof parsed.cursor === "number" ? parsed.cursor : advanced;
    return { cursor: finalCursor, hadActivity: updates.length > 0, halted: false };
  }

  async function loop(): Promise<void> {
    let cursor = 0;
    try {
      cursor = await cursorStore.get(agentId);
    } catch (err) {
      logger.error(`[socket ${agentId}] loading cursor failed, starting from 0: ${(err as Error).message}`);
    }
    let backoff = minBackoffMs;
    let idleDelayMs = ACTIVE_POLL_DELAY_MS;
    logger.info(`[socket ${agentId}] polling ${host}/api/v1/agent/updates from cursor ${cursor}`);

    while (!stopped) {
      try {
        const result = await pollOnce(cursor);
        if (result.cursor !== cursor) {
          cursor = result.cursor;
          try {
            await cursorStore.put(agentId, cursor);
          } catch (err) {
            logger.error(`[socket ${agentId}] persisting cursor ${cursor} failed: ${(err as Error).message}`);
          }
        }

        if (result.halted) {
          // A transient verification failure -- treat exactly like a
          // failed round trip: back off and retry from the SAME (or
          // partially advanced) cursor.
          if (stopped) break;
          logger.error(`[socket ${agentId}] retrying after a transient verification failure in ${backoff}ms`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, maxBackoffMs);
          continue;
        }

        backoff = minBackoffMs; // a clean round trip always resets the failure backoff
        idleDelayMs = result.hadActivity ? ACTIVE_POLL_DELAY_MS : Math.min(idleDelayMs + ACTIVE_POLL_DELAY_MS, IDLE_POLL_DELAY_MS);
        if (stopped) break;
        await sleep(idleDelayMs);
      } catch (err) {
        if (stopped) break; // an abort from stop() surfaces here as a fetch error -- not a real failure
        logger.error(`[socket ${agentId}] poll failed: ${(err as Error).message}; retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoffMs);
      }
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
      abortController?.abort();
      wakeSleep?.();
      await loopPromise;
      loopPromise = null;
    },
  };
}
