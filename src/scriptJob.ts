// Deterministic-first scheduled work ("script jobs").
//
// A recurring job -- a news digest, a price watch, a "tell me when the build
// is green" -- is mostly plumbing: fetch some pages, drop what was already
// sent, write it up, post it. Only the "write it up" step ever needs a model,
// and often not even that. The owner's rule (2026-10-13): "use the right
// tools for the right jobs; don't use AI as the hammer for everything when
// deterministic scripts and tools can accommodate just as well."
//
// runScriptJob is that rule as a function. The host's scheduler (cron, a
// Grains wake_me, setInterval) calls it; this file never schedules anything.
//
//   sources   plain async functions that fetch and normalise items in code
//             (no model). Each runs ONCE per call, with a timeout; one that
//             throws or times out is listed in `failedSources` and the rest
//             carry on.
//   key       a stable id for an item (its URL, a post id) -- what `seen`
//             remembers.
//   seen      a SeenStore (required): drops items already sent. MemorySeenStore() lives
//             until the process restarts; FileSeenStore(file) survives it.
//   compose   OPTIONAL, and the ONLY place a model may be called. It runs
//             only when there is something new, so a quiet day costs no
//             tokens. Use the cheapest model that can write the text.
//             Leave it out and a plain list is posted (see defaultCompose).
//             Return empty only for a transient failure: empty posts nothing
//             and marks nothing, so the same items reach the model next run.
//   post      sends the text to the chat.
//
// Nothing new means no compose and no post. Items are marked seen only AFTER
// post succeeds: a failed post leaves them unseen so the next run retries,
// and a compose or post error is thrown to the scheduler (re-arm the schedule
// in a `finally` so a failed run never silently ends it).

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// --- SeenStore ---------------------------------------------------------------

export interface SeenMarkOptions {
  /** How long these keys stay "seen", in ms. Overrides the store's default; `Infinity` never expires. */
  ttlMs?: number;
}

/**
 * What a script job has already sent. Keys are opaque strings (a URL, a post
 * id); each is remembered until its own expiry, so a feed that republishes an
 * old story a month later can be told again on purpose.
 */
export interface SeenStore {
  /** True when `key` was marked and has not expired. */
  has(key: string): Promise<boolean>;
  /** Marks every key in `keys` seen, each expiring `ttlMs` from now (the store's default when omitted). */
  mark(keys: string[], opts?: SeenMarkOptions): Promise<void>;
  /** Forgets `key`, so the next run treats it as new. A no-op when it was never marked. */
  forget(key: string): Promise<void>;
}

export interface SeenStoreOptions {
  /** Default lifetime of a mark. Defaults to DEFAULT_SEEN_TTL_MS. */
  ttlMs?: number;
  /** Clock, for tests. Defaults to Date.now. */
  now?: () => number;
}

// Owner-only, like socket.ts's cursor files: the keys are usually URLs.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** A mark lasts 30 days unless the store or the call says otherwise. */
export const DEFAULT_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function expiryFor(now: number, ttlMs: number | undefined, fallback: number): number | null {
  const ttl = ttlMs ?? fallback;
  return Number.isFinite(ttl) ? now + ttl : null;
}

/** In-memory SeenStore. Marks are lost on process restart, and it dedupes only while the SAME instance outlives the runs -- construct it once, not inside the job. */
export function MemorySeenStore(options: SeenStoreOptions = {}): SeenStore {
  const now = options.now ?? Date.now;
  const defaultTtl = options.ttlMs ?? DEFAULT_SEEN_TTL_MS;
  const store = new Map<string, number | null>();
  return {
    async has(key) {
      if (!store.has(key)) return false;
      const expiresAt = store.get(key);
      if (expiresAt != null && expiresAt <= now()) {
        store.delete(key);
        return false;
      }
      return true;
    },
    async mark(keys, opts) {
      const at = now();
      for (const key of keys) store.set(key, expiryFor(at, opts?.ttlMs, defaultTtl));
    },
    async forget(key) {
      store.delete(key);
    },
  };
}

/**
 * One plain JSON file, `{ "<key>": <expires-at epoch ms, or null for never> }`,
 * written atomically (temp file + rename, the same convention as
 * FileSessionStore) so a crash mid-write never leaves half a file. Expired
 * keys are dropped whenever the file is rewritten. A missing file is an empty
 * store; an unreadable one throws rather than silently re-sending everything.
 *
 * The keys are whatever you pass to `key(item)` -- usually URLs -- stored in
 * PLAINTEXT (the file is created 0600, its new directories 0700). Run ONE job
 * per file at a time: writes are queued per instance, in this process only,
 * so two processes (or two instances) on one file can lose each other's keys.
 */
export function FileSeenStore(file: string, options: SeenStoreOptions = {}): SeenStore {
  const now = options.now ?? Date.now;
  const defaultTtl = options.ttlMs ?? DEFAULT_SEEN_TTL_MS;

  async function load(): Promise<Record<string, number | null>> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }

  async function save(entries: Record<string, number | null>): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2), { mode: FILE_MODE });
    await fs.rename(tmp, file);
  }

  // Writes are read-modify-write; run them one at a time so two overlapping
  // marks in this process never lose each other's keys.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  return {
    async has(key) {
      const entries = await load();
      if (!Object.prototype.hasOwnProperty.call(entries, key)) return false;
      const expiresAt = entries[key];
      return expiresAt == null || expiresAt > now();
    },
    mark(keys, opts) {
      return serial(async () => {
        const at = now();
        const entries = await load();
        for (const [k, expiresAt] of Object.entries(entries)) {
          if (expiresAt != null && expiresAt <= at) delete entries[k];
        }
        for (const key of keys) entries[key] = expiryFor(at, opts?.ttlMs, defaultTtl);
        await save(entries);
      });
    },
    forget(key) {
      return serial(async () => {
        const entries = await load();
        if (!Object.prototype.hasOwnProperty.call(entries, key)) return;
        delete entries[key];
        await save(entries);
      });
    },
  };
}

// --- runScriptJob ------------------------------------------------------------

/** Handed to every source: abort the fetch when it fires (the job's timeout). Sources that ignore it still get raced against the timeout. */
export interface ScriptSourceContext {
  signal: AbortSignal;
}

/** A source is a plain async function: fetch something, normalise it into items, return them. No model. */
export type ScriptSource<T> = (ctx: ScriptSourceContext) => Promise<T[]> | T[];

/** What an item looks like when you don't write `compose`: `title` and `url` make the default list. */
export interface ScriptJobItem {
  title?: string;
  url?: string;
  [key: string]: unknown;
}

export interface ScriptJobLogger {
  error(msg: string): void;
}

export interface ScriptJobOptions<T> {
  /** Named sources (`{ hackerNews, rss }`) or a plain array. The name is what `failedSources` reports; an array entry is named by its function name, else `source-<index>`. */
  sources: Record<string, ScriptSource<T>> | Array<ScriptSource<T>>;
  /** A stable id for an item -- its URL, a post id. Two items with the same key are the same story. */
  key: (item: T) => string;
  /** What was already sent. */
  seen: SeenStore;
  /** OPTIONAL, and the only place a model may be called. Gets only the NEW items, and only when there are some. Return the text to post; an empty string or null posts nothing and marks nothing. Omit it for a plain list. */
  compose?: (fresh: T[]) => Promise<string | null | undefined> | string | null | undefined;
  /** Sends the text to the chat. Throwing leaves every item unseen. */
  post: (text: string, fresh: T[]) => Promise<unknown> | unknown;
  /** Per-source timeout in ms. Default DEFAULT_SOURCE_TIMEOUT_MS. */
  sourceTimeoutMs?: number;
  /** How long posted items stay seen, in ms. Default: the store's own. */
  seenTtlMs?: number;
  logger?: ScriptJobLogger;
}

export interface ScriptJobResult {
  /** Items the sources returned, before dropping any (items from a failed source are not counted). */
  fetched: number;
  /** Items not seen before and not duplicated within this run: what compose got. */
  fresh: number;
  /** True when `post` ran and succeeded. */
  posted: boolean;
  /** Names of the sources that threw or timed out. */
  failedSources: string[];
}

export const DEFAULT_SOURCE_TIMEOUT_MS = 20_000;

/** The deterministic text posted when there is no `compose`: one line per item, "- title" and its url beneath. */
export function defaultCompose<T>(fresh: T[], key: (item: T) => string): string {
  return fresh
    .map((item) => {
      const it = item as unknown as ScriptJobItem;
      const k = key(item);
      const title = typeof it?.title === "string" && it.title ? it.title : k;
      const url = typeof it?.url === "string" && it.url && it.url !== title ? it.url : null;
      return url ? `- ${title}\n  ${url}` : `- ${title}`;
    })
    .join("\n");
}

function withTimeout<T>(run: (signal: AbortSignal) => Promise<T> | T, ms: number, name: string): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${name} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([Promise.resolve().then(() => run(controller.signal)), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs one pass of a script job and says what happened. See the header
 * comment for the contract; the short version: fetch in code, drop what was
 * sent, compose only if something is new, post, and only then mark seen.
 */
export async function runScriptJob<T>(options: ScriptJobOptions<T>): Promise<ScriptJobResult> {
  const { key, seen, compose, post } = options;
  const logger = options.logger ?? { error: (msg: string) => console.error(msg) };
  const timeoutMs = options.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;

  const named: Array<[string, ScriptSource<T>]> = Array.isArray(options.sources)
    ? options.sources.map((fn, i) => [fn.name || `source-${i}`, fn])
    : Object.entries(options.sources);

  const settled = await Promise.all(
    named.map(async ([name, fn]) => {
      try {
        const items = await withTimeout((signal) => fn({ signal }), timeoutMs, name);
        return { name, items: Array.isArray(items) ? items : [], ok: true as const };
      } catch (err) {
        logger.error(`[script job] source ${name} failed: ${(err as Error).message}`);
        return { name, items: [] as T[], ok: false as const };
      }
    })
  );

  const failedSources = settled.filter((s) => !s.ok).map((s) => s.name);
  const all = settled.flatMap((s) => s.items);

  // Source order decides which copy of a duplicate wins.
  const fresh: T[] = [];
  const freshKeys: string[] = [];
  const inRun = new Set<string>();
  for (const item of all) {
    let k: string;
    try {
      k = String(key(item));
    } catch (err) {
      logger.error(`[script job] key() threw, item skipped: ${(err as Error).message}`);
      continue;
    }
    if (inRun.has(k)) continue;
    inRun.add(k);
    if (await seen.has(k)) continue;
    fresh.push(item);
    freshKeys.push(k);
  }

  const result: ScriptJobResult = { fetched: all.length, fresh: fresh.length, posted: false, failedSources };
  if (fresh.length === 0) return result;

  const text = compose ? await compose(fresh) : defaultCompose(fresh, key);
  if (typeof text !== "string" || text.trim() === "") return result;

  await post(text, fresh);
  result.posted = true;

  try {
    await seen.mark(freshKeys, options.seenTtlMs === undefined ? undefined : { ttlMs: options.seenTtlMs });
  } catch (err) {
    // The post already went out; throwing now would tell the scheduler it
    // did not. The cost is a possible repeat next run, so say so loudly.
    logger.error(`[script job] posted, but marking ${freshKeys.length} item(s) seen failed (they may repeat): ${(err as Error).message}`);
  }
  return result;
}
