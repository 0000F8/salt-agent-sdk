// K2 socket mode (design-fleet/runs/2026-09-17-distribution/LANES.md
// "Socket mode contract"): an agent with no public URL -- OpenClaw, a local
// LangGraph script, Claude Code on a laptop -- can't receive a webhook
// POST. This is the Slack Socket Mode / Telegram getUpdates precedent: long-
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
// One long-poll drain per (host) identity, since salt-api's outbox and its
// auth are both per-agent -- a process hosting several socket-mode
// identities runs one createSocketClient per identity, each feeding the
// same or a shared dispatcher.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createDispatcher, type Logger, type WebhookServerOptions } from "./webhook.js";
import type { SaltId } from "./ids.js";

const consoleLogger: Logger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

// --- Cursor persistence ----------------------------------------------------

export interface CursorStore {
  /** The last-acked update id for this identity, or 0 for "never polled". */
  get(agentId: SaltId): Promise<number>;
  put(agentId: SaltId, cursor: number): Promise<void>;
}

/** In-memory cursor store -- the default. Lost on restart, so a fresh
 *  process re-reads from cursor 0 (everything AgentUpdatePruneJob hasn't
 *  pruned yet, up to 7 days -- see salt-api's AgentUpdate model). */
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

function cursorFileFor(dir: string, agentId: SaltId): string {
  const safe = String(agentId).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return path.join(dir, `${safe}.cursor`);
}

/**
 * One plain text file per identity under `dir`, holding just the cursor
 * number -- written atomically (temp file + rename), the same convention
 * sessions.ts's FileSessionStore uses. Pass a directory BESIDE (not the
 * same as) the one given to FileSessionStore, e.g.
 * `FileCursorStore(path.join(dataDir, "cursors"))` next to
 * `FileSessionStore(path.join(dataDir, "sessions"))`.
 */
export function FileCursorStore(dir: string): CursorStore {
  return {
    async get(agentId) {
      try {
        const raw = await fs.readFile(cursorFileFor(dir, agentId), "utf8");
        const n = parseInt(raw.trim(), 10);
        return Number.isFinite(n) ? n : 0;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw err;
      }
    },
    async put(agentId, cursor) {
      await fs.mkdir(dir, { recursive: true });
      const target = cursorFileFor(dir, agentId);
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmp, String(cursor));
      await fs.rename(tmp, target);
    },
  };
}

// --- The long-poll client ---------------------------------------------------

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

export interface SocketClientOptions extends WebhookServerOptions {
  /** The salt-api deployment's origin, e.g. "https://saltapp.ai" -- the
   *  long-poll request is plain fetch (there is no long-poll-aware method
   *  on SaltClient), so it needs the host directly rather than through
   *  `client`. No trailing slash required either way. */
  host: string;
  /** This identity's OWN api-key. GET /api/v1/agent/updates authenticates
   *  per-agent and drains only that agent's own outbox -- this is NOT the
   *  same thing as `identities`, which can hold several hosted identities
   *  for DECRYPT/ROUTE purposes; a process socket-draining more than one of
   *  them runs one createSocketClient per identity. */
  apiKey: string;
  /** That identity's Salt id -- used as the cursor store's key and in log lines. */
  agentId: SaltId;
  /** Where the long-poll cursor is persisted across restarts. Defaults to
   *  an in-memory store (a fresh process starts from cursor 0). */
  cursorStore?: CursorStore;
  /** Seconds the server should hold the request open waiting for new rows.
   *  Server-clamped to [0, 25] regardless of what's sent here. */
  timeoutSeconds?: number;
  /** Max rows per response. Defaults to 100 (the server's own default). */
  limit?: number;
  /** Base retry delay after a failed poll (network error or non-2xx),
   *  doubling each consecutive failure up to `maxBackoffMs`. Reset to this
   *  after any successful round trip. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Override fetch (e.g. for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SocketClient {
  /** Starts the long-poll loop in the background. A no-op if already running. */
  start(): void;
  /** Stops the loop: aborts an in-flight request/backoff wait immediately
   *  and resolves once the loop has actually exited (never mid-iteration). */
  stop(): Promise<void>;
}

/**
 * Drains one identity's K2 socket-mode outbox by long-polling
 * GET /api/v1/agent/updates, verifying each envelope with the exact same
 * check createWebhookServer applies to a webhook POST (createDispatcher's
 * verifyEnvelope, both headers + body), and dispatching it to the SAME
 * onMessage/onCardInteraction/etc. handlers. See this file's header
 * comment for the one-line switch from createWebhookServer.
 */
export function createSocketClient(options: SocketClientOptions): SocketClient {
  const logger = options.logger ?? consoleLogger;
  const dispatcher = createDispatcher(options);
  const host = options.host.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const cursorStore = options.cursorStore ?? MemoryCursorStore();
  const timeoutSeconds = options.timeoutSeconds ?? 25;
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

  async function pollOnce(cursor: number): Promise<number> {
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
    for (const update of parsed.updates || []) {
      await handleOne(update);
    }
    return typeof parsed.cursor === "number" ? parsed.cursor : cursor;
  }

  async function handleOne(update: RawAgentUpdate): Promise<void> {
    const headers = update.headers || {};
    let reason: string | null;
    try {
      reason = await dispatcher.verifyEnvelope(headers["X-Salt-Agent-Id"], headers["X-Salt-Signature"], update.body);
    } catch (err) {
      logger.error(`[socket ${agentId}] verifying update ${update.id} failed: ${(err as Error).message}`);
      return;
    }
    if (reason) {
      // Never dispatch an update whose signature doesn't check out -- a
      // relay (or a bug) between salt-api and this process must not be
      // able to forge an event just by getting bytes into the outbox row.
      logger.error(`[socket ${agentId}] rejected update ${update.id} (${update.event}): ${reason}`);
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(update.body);
    } catch (err) {
      logger.error(`[socket ${agentId}] update ${update.id} had unparseable body: ${(err as Error).message}`);
      return;
    }
    try {
      await dispatcher.dispatch(body, headers["X-Salt-Agent-Id"]);
    } catch (err) {
      logger.error(`[socket ${agentId}] unhandled error dispatching update ${update.id}: ${(err as Error).message}`);
    }
  }

  async function loop(): Promise<void> {
    let cursor = 0;
    try {
      cursor = await cursorStore.get(agentId);
    } catch (err) {
      logger.error(`[socket ${agentId}] loading cursor failed, starting from 0: ${(err as Error).message}`);
    }
    let backoff = minBackoffMs;
    logger.info(`[socket ${agentId}] long-polling ${host}/api/v1/agent/updates from cursor ${cursor}`);

    while (!stopped) {
      try {
        const nextCursor = await pollOnce(cursor);
        if (nextCursor !== cursor) {
          cursor = nextCursor;
          try {
            await cursorStore.put(agentId, cursor);
          } catch (err) {
            logger.error(`[socket ${agentId}] persisting cursor ${cursor} failed: ${(err as Error).message}`);
          }
        }
        backoff = minBackoffMs; // a clean round trip resets the backoff, empty or not
      } catch (err) {
        if (stopped) break; // an abort from stop() surfaces here as a fetch error -- not a real failure
        logger.error(`[socket ${agentId}] long-poll failed: ${(err as Error).message}; retrying in ${backoff}ms`);
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
