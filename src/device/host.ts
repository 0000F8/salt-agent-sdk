// The DEVICE side of device control: createDeviceHost.
//
// It runs ON the controlled machine, inside the signed desktop app. It takes a
// decrypted command off the lane, decides whether it is allowed, and -- only
// if it is -- calls the matching HANDLER. It then encrypts the result for the
// lane readers and posts it, beats while the session is live, and reports
// per-class counts (never content) to the server.
//
// ============================================================================
// THE SEAM BOUNDARY (deliberately NOT implemented here).
// ============================================================================
// This module performs NO observation and NO input of any kind. It calls the
// `DeviceHostHandlers` the desktop app injects:
//   - observe()                      -> a UI observation
//   - click/type/key/scroll()        -> acting on the UI
//   - focusApp/listApps/readFile/writeFile() -> app + filesystem access
// The host decides IF a handler may run (capability, scope, approval mode,
// never-allowed floor, budget, rate limit, ordering) and what the device tells
// the server afterwards (per-class counts only, never content). The handler
// decides HOW.
//
// On the device side (salt-device) each handler is an ORCHESTRATOR over two OS
// primitives, a preferred one and a sensitive fallback, kept in separate files
// so either can be replaced on its own:
//   - observe -> a structured UI snapshot (accessibility tree)   [preferred]
//                falling back to a raw framebuffer grab           [sensitive]
//   - act     -> semantic accessibility actions (press/setValue) [preferred]
//                falling back to raw input-event synthesis        [sensitive]
// The two sensitive primitives (framebuffer grab, event synthesis) are the only
// pieces a safety review scrutinises, and the split keeps them small, isolated
// and swappable while the authority model here stays reviewable on its own.
// ============================================================================

import {
  CAPABILITY_FOR_OP,
  countClassForOp,
  decodeDeviceMessage,
  DeviceProtocolError,
  DEVICE_PROTOCOL_VERSION,
  deviceMessageId,
  encodeDeviceMessage,
  MAX_COMMANDS_PER_SECOND,
  MAX_DEVICE_PLAINTEXT_BYTES,
  MAX_OBSERVE_PER_SECOND,
  MUTATING_OPS,
  RESULT_CACHE_SIZE,
  type AppsResult,
  type ClickArgs,
  type DeviceCountClass,
  type DeviceErrorCode,
  type DeviceHeader,
  type DeviceOp,
  type DevicePauseReason,
  type FileResult,
  type KeyArgs,
  type ObservationResult,
  type ObserveArgs,
  type ScrollArgs,
} from "./protocol.js";
import type { LaneReaders } from "./client.js";
import { sameId, type SaltId } from "../ids.js";

/** The seams. The desktop app implements every method; the host calls one only
 *  after it has passed every gate below. A handler may throw -- the host turns
 *  a throw into an `error { code: "failed" }` and counts it as an error. */
export interface DeviceHostHandlers {
  observe(args: ObserveArgs): Promise<ObservationResult>;
  click(args: ClickArgs): Promise<void>;
  type(args: { text: string }): Promise<void>;
  key(args: KeyArgs): Promise<void>;
  scroll(args: ScrollArgs): Promise<void>;
  focusApp(args: { app: string }): Promise<void>;
  listApps(): Promise<AppsResult>;
  readFile(args: { path: string }): Promise<FileResult>;
  writeFile(args: { path: string; content_b64: string }): Promise<void>;
}

/** What the server told the device about this session in the
 *  `device_session_request` delivery. The device trusts this snapshot and
 *  re-checks it on EVERY command; it never widens it (only the person, locally,
 *  can widen a mandate, and that produces a new snapshot). */
export interface DeviceCapsSnapshot {
  sessionId: SaltId;
  agentId: SaltId;
  /** Armored public keys of every lane reader; results are encrypted for all. */
  readers: LaneReaders;
  /** The capabilities granted, keyed by `device.*`. A command whose op maps to
   *  a capability not present here is `out_of_scope`. */
  caps: Partial<Record<string, DeviceCapRule>>;
  budget?: { maxActions?: number; maxDurationS?: number };
  /** ISO8601; past it, the session ends `mandate_expired`. */
  expiresAt?: string;
}

export interface DeviceCapRule {
  /** auto = run; ask = ask the person at the machine first; notify = run and
   *  tell them. The device holds this decision, never the server. */
  mode: "auto" | "ask" | "notify";
  /** For device.apps: the only bundle ids / exe names in scope (empty/omitted
   *  = any app the floor allows). */
  apps?: string[];
  /** For device.files.*: the only path prefixes in scope. A file op outside
   *  every root is `out_of_scope`. */
  fileRoots?: string[];
}

export interface DeviceHostTransport {
  /** Encrypt `plaintext` for the lane readers and POST it as one lane message. */
  postResult(plaintext: string, readers: LaneReaders): Promise<void>;
  /** POST /device_sessions/:sid/beat. A 409 means the session is over: the
   *  transport should throw a DeviceBeatOverError so the host stops at once. */
  beat(sessionId: SaltId): Promise<void>;
  /** PATCH /device_sessions/:sid/counts with whole-number per-class counts. */
  reportCounts(sessionId: SaltId, counts: Partial<Record<DeviceCountClass, number>>): Promise<void>;
  /** POST /device_sessions/:sid/stop with an end reason (subtract-only). */
  stop(sessionId: SaltId, reason: string): Promise<void>;
  /** POST /device_sessions/:sid/pause `{reason}` (device key). Optional: a
   *  transport without it still pauses locally. The only place the pause
   *  endpoint's shape lives is httpDeviceHostTransport (http.ts). */
  pause?(sessionId: SaltId, reason: DevicePauseReason): Promise<void>;
  /** POST /device_sessions/:sid/resume (device key). */
  resume?(sessionId: SaltId): Promise<void>;
}

export class DeviceBeatOverError extends Error {}

/** A FIFO async mutex. One of these guards every mutating command (click /
 *  type / key / scroll / focus_app) on the machine, whichever session sent it.
 *  `sharedDeviceLock` is the process-wide instance every host uses by default,
 *  so two sessions on one machine can never interleave input. salt-device may
 *  pass its own via `options.deviceLock` (e.g. to also hold it around local
 *  tray actions that inject input). */
export class DeviceLock {
  private tail: Promise<void> = Promise.resolve();
  /** Resolves with a release function once every earlier holder released. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ready = this.tail.then(() => release_once(release));
    this.tail = this.tail.then(() => gate);
    return ready;
  }
  /** Run `fn` while holding the lock. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
function release_once(release: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}

/** The process-wide device mutex (default for every host). */
export const sharedDeviceLock = new DeviceLock();

export interface DeviceHostCallbacks {
  /** The LOCAL approval prompt for an `ask`-mode command. Resolves true if the
   *  person at the machine approved. The host shows `needs_approval` until it
   *  does. The DESKTOP APP owns this UI; absent, every ask-mode op is refused. */
  requestLocalApproval?(op: DeviceOp, args: unknown): Promise<boolean>;
  /** Told after a `notify`-mode command runs, so the app can surface it. */
  onNotify?(op: DeviceOp, args: unknown): void;
  /** Told when the host ends the session itself (budget, duration, lost beat,
   *  a stop command). The app updates its indicator and writes its audit line. */
  onEnded?(reason: string): void;
  /** Every gate decision, for the app's append-only on-disk audit log. Content
   *  is the caller's to redact; the host passes op + decision + reason only. */
  onAudit?(entry: DeviceAuditEntry): void;
}

export interface DeviceAuditEntry {
  at: number;
  commandId: string;
  op: string;
  decision: "ran" | "refused" | "needs_approval" | "ended";
  code?: DeviceErrorCode;
  reason?: string;
}

/** Apps the floor never allows a command to target, whatever a mandate says:
 *  password managers and keychains. The desktop app extends this with its own
 *  Salt windows (which it also blanks in the capture handler). Browsers are
 *  deliberately NOT here (owner: browsers full, no deny-list). */
export const NEVER_ALLOWED_APPS: readonly string[] = [
  "com.1password.1password",
  "com.agilebits.onepassword7",
  "com.apple.keychainaccess",
  "com.bitwarden.desktop",
  "com.dashlane.dashlane",
  "org.keepassxc.keepassxc",
  "1password",
  "bitwarden",
  "keepassxc",
  "keychain access",
  "dashlane",
];

export interface DeviceHost {
  /** Feed a decrypted lane message in. Non-device lines and results from
   *  elsewhere return false and are ignored. A command is answered (ack /
   *  observation / error / ...) via the transport. */
  handleCommand(plaintext: string): Promise<boolean>;
  /** Start the live heartbeat + budget/duration watch. The desktop app calls
   *  this once the session is active. */
  start(): void;
  /** End the session locally (subtract-only) and tell the server. */
  stop(reason?: string): Promise<void>;
  /** The spent count of budgeted actions, for the indicator. */
  actionsSpent(): number;
  /** Pause the session: every command (except `stop` and `cancel`) is refused
   *  `paused` with `reason` until resume(). Takes effect synchronously; the
   *  returned promise settles when Salt has been told (a failed report never
   *  un-pauses). Idempotent; a second reason replaces the first. Does not
   *  interrupt a command already executing. */
  pause(reason: DevicePauseReason): Promise<void>;
  /** Clear the pause and tell Salt. No-op when not paused. */
  resume(): Promise<void>;
  /** The current pause reason, or null. */
  pausedReason(): DevicePauseReason | null;
}

export function createDeviceHost(
  snapshot: DeviceCapsSnapshot,
  handlers: DeviceHostHandlers,
  transport: DeviceHostTransport,
  callbacks: DeviceHostCallbacks = {},
  options: {
    beatIntervalMs?: number;
    neverAllowedApps?: readonly string[];
    /** Device-wide mutex for mutating ops. Default: the process-wide
     *  `sharedDeviceLock`, so every host in this process shares one. */
    deviceLock?: DeviceLock;
    /** Clock, for tests. */
    now?: () => number;
  } = {}
): DeviceHost {
  const deviceLock = options.deviceLock ?? sharedDeviceLock;
  const clock = options.now ?? Date.now;
  const beatIntervalMs = options.beatIntervalMs ?? 5_000;
  const neverAllowed = (options.neverAllowedApps ?? NEVER_ALLOWED_APPS).map((s) => s.toLowerCase());

  let lastSeq = 0;
  let pausedReason: DevicePauseReason | null = null;
  // One command at a time per session: every command runs behind this tail.
  let tail: Promise<unknown> = Promise.resolve();
  // Ids received and not yet started / ids a `cancel` asked us to drop.
  const queuedIds = new Map<string, number>();
  const cancelledIds = new Set<string>();
  // The last RESULT_CACHE_SIZE results by command id (insertion order = age).
  const resultCache = new Map<string, { op: string; body?: unknown }>();
  let spent = 0; // budgeted actions used
  let ended = false;
  const startedAt = Date.now();
  let beatTimer: ReturnType<typeof setInterval> | null = null;
  let durationTimer: ReturnType<typeof setTimeout> | null = null;
  // Rate windows: timestamps of recent commands / observes.
  const cmdTimes: number[] = [];
  const obsTimes: number[] = [];
  // Pending counts to flush to the server, coalesced.
  const pendingCounts: Partial<Record<DeviceCountClass, number>> = {};
  let countsFlushQueued = false;

  function audit(entry: Omit<DeviceAuditEntry, "at">): void {
    callbacks.onAudit?.({ at: Date.now(), ...entry });
  }

  function bump(cls: DeviceCountClass): void {
    pendingCounts[cls] = (pendingCounts[cls] ?? 0) + 1;
    if (countsFlushQueued || ended) return;
    countsFlushQueued = true;
    // Flush on the next tick so a burst of commands coalesces into one PATCH.
    queueMicrotask(async () => {
      countsFlushQueued = false;
      const batch = { ...pendingCounts };
      for (const k of Object.keys(pendingCounts) as DeviceCountClass[]) delete pendingCounts[k];
      if (Object.keys(batch).length === 0) return;
      try {
        await transport.reportCounts(snapshot.sessionId, batch);
      } catch {
        /* counts are metadata; a failed PATCH never stops control */
      }
    });
  }

  function withinRate(op: DeviceOp, now: number): boolean {
    while (cmdTimes.length && now - cmdTimes[0] >= 1000) cmdTimes.shift();
    while (obsTimes.length && now - obsTimes[0] >= 1000) obsTimes.shift();
    if (cmdTimes.length >= MAX_COMMANDS_PER_SECOND) return false;
    if (op === "observe" && obsTimes.length >= MAX_OBSERVE_PER_SECOND) return false;
    cmdTimes.push(now);
    if (op === "observe") obsTimes.push(now);
    return true;
  }

  async function reply(header: DeviceHeader, op: string, body?: unknown): Promise<{ op: string; body?: unknown }> {
    const id = deviceMessageId();
    const plaintext = encodeDeviceMessage(
      { v: DEVICE_PROTOCOL_VERSION, id, seq: nextOutSeq(), op, session: snapshot.sessionId, re: header.id },
      body
    );
    if (Buffer.byteLength(plaintext, "utf8") > MAX_DEVICE_PLAINTEXT_BYTES) {
      // The result itself is too big (a huge screenshot or file). Answer the
      // small error instead; never post an over-cap message.
      const small = encodeDeviceMessage(
        { v: DEVICE_PROTOCOL_VERSION, id: deviceMessageId(), seq: nextOutSeq(), op: "error", session: snapshot.sessionId, re: header.id },
        { code: "too_large", message: "result exceeds the per-message limit" }
      );
      await transport.postResult(small, snapshot.readers);
      bump("error");
      return { op: "error", body: { code: "too_large", message: "result exceeds the per-message limit" } };
    }
    await transport.postResult(plaintext, snapshot.readers);
    return { op, body };
  }

  function remember(id: string, r: { op: string; body?: unknown }): void {
    resultCache.delete(id);
    resultCache.set(id, r);
    while (resultCache.size > RESULT_CACHE_SIZE) {
      resultCache.delete(resultCache.keys().next().value as string);
    }
  }

  let outSeq = 0;
  function nextOutSeq(): number {
    outSeq += 1;
    return outSeq;
  }

  async function refuse(
    header: DeviceHeader,
    code: DeviceErrorCode,
    message?: string,
    extra: { expected_seq?: number; reason?: DevicePauseReason } = {}
  ): Promise<{ op: string; body?: unknown }> {
    audit({ commandId: header.id, op: header.op, decision: code === "needs_approval" ? "needs_approval" : "refused", code, reason: message });
    if (code !== "needs_approval") bump("error");
    return reply(header, "error", { code, message, ...extra });
  }

  function fileInScope(rule: DeviceCapRule | undefined, path: string): boolean {
    if (!rule) return false;
    if (!rule.fileRoots || rule.fileRoots.length === 0) return false; // files need an explicit root
    return rule.fileRoots.some((root) => path === root || path.startsWith(root.endsWith("/") ? root : root + "/"));
  }

  function appInScope(rule: DeviceCapRule | undefined, app: string): boolean {
    if (neverAllowed.includes(app.toLowerCase())) return false;
    if (!rule) return false;
    if (!rule.apps || rule.apps.length === 0) return true; // any app the floor allows
    return rule.apps.some((a) => a.toLowerCase() === app.toLowerCase());
  }

  /** Entry point. Sync part: decode, drop what is not ours, handle `cancel`
   *  immediately. Everything else queues behind the session's tail so commands
   *  run strictly one at a time, in arrival order. */
  async function handleCommand(plaintext: string): Promise<boolean> {
    if (ended) return false;
    let decoded;
    try {
      decoded = decodeDeviceMessage(plaintext);
    } catch (e) {
      // A line that looked like a device message but is malformed: we cannot
      // trust its id to answer, so drop it. (A well-formed bad_args is answered
      // below, once we have a header to reply to.)
      void e;
      return false;
    }
    if (!decoded) return false;
    const { header, body } = decoded;

    // Only our active session; anything else is dropped silently.
    if (!sameId(header.session, snapshot.sessionId)) return false;

    if (header.op === "cancel" && header.v === DEVICE_PROTOCOL_VERSION) {
      // Out of band: never queued, consumes no seq. Drops a command that has
      // not started; a started or finished one keeps its stored result.
      const id = (body as { id?: unknown } | undefined)?.id;
      if (typeof id === "string" && (queuedIds.get(id) ?? 0) > 0) cancelledIds.add(id);
      return true;
    }

    queuedIds.set(header.id, (queuedIds.get(header.id) ?? 0) + 1);
    const run = tail.then(() => processCommand(header, body));
    tail = run.catch(() => undefined);
    return run;
  }

  async function processCommand(header: DeviceHeader, body: unknown): Promise<boolean> {
    const left = (queuedIds.get(header.id) ?? 1) - 1;
    if (left > 0) queuedIds.set(header.id, left);
    else queuedIds.delete(header.id);
    if (cancelledIds.delete(header.id)) {
      audit({ commandId: header.id, op: header.op, decision: "refused", reason: "cancelled before start" });
      return true;
    }
    if (ended) return true;

    if (header.v !== DEVICE_PROTOCOL_VERSION) {
      await refuse(header, "unsupported", `protocol v=${header.v}`);
      return true;
    }

    // Idempotency: a repeated id returns the stored result, never re-executes.
    const stored = resultCache.get(header.id);
    if (stored) {
      await reply(header, stored.op, stored.body);
      return true;
    }

    // Expiry: not executed, consumes no seq.
    if (header.exp !== undefined && clock() >= header.exp) {
      await refuse(header, "expired", "command expired before it started", { expected_seq: lastSeq + 1 });
      return true;
    }

    // Paused: the person (or a secure field) has the device. `stop` still works.
    if (pausedReason !== null && header.op !== "stop") {
      await refuse(header, "paused", `paused: ${pausedReason}`, { expected_seq: lastSeq + 1, reason: pausedReason });
      return true;
    }

    // Ordering: strictly increasing seq per sender. A repeat of a KNOWN id was
    // answered from the cache above; any other seq that is not exactly the next
    // one (a gap, or a stale seq from a client that lost its place) is
    // out_of_order, and the agent resyncs to expected_seq.
    if (header.seq !== lastSeq + 1) {
      await refuse(header, "out_of_order", `expected seq ${lastSeq + 1}, got ${header.seq}`, { expected_seq: lastSeq + 1 });
      return true;
    }
    lastSeq = header.seq;

    const op = header.op as DeviceOp;
    if (!AGENT_OP_SET.has(op)) {
      await refuse(header, "unsupported", `op ${header.op}`);
      return true;
    }

    if (op === "stop") {
      await reply(header, "ended", { reason: "stopped_by_agent" });
      await stop("stopped_by_agent");
      return true;
    }

    if (op === "shell") {
      await refuse(header, "forbidden", "shell is not available");
      return true;
    }

    // Expiry / duration.
    if (snapshot.expiresAt && Date.now() >= Date.parse(snapshot.expiresAt)) {
      await refuse(header, "out_of_scope", "mandate expired");
      await stop("mandate_expired");
      return true;
    }

    // Capability present?
    const capName = CAPABILITY_FOR_OP[op];
    const rule = capName ? snapshot.caps[capName] : undefined;
    if (capName && !rule) {
      await refuse(header, "out_of_scope", `no ${capName} in this mandate`);
      return true;
    }

    // Selector scope: apps and file roots.
    if ((op === "focus_app") && !appInScope(rule, (body as { app?: string })?.app ?? "")) {
      const app = (body as { app?: string })?.app ?? "";
      await refuse(header, neverAllowed.includes(app.toLowerCase()) ? "forbidden" : "out_of_scope", `app not in scope: ${app}`);
      return true;
    }
    if (op === "read_file" || op === "write_file") {
      const path = (body as { path?: string })?.path ?? "";
      if (!fileInScope(rule, path)) {
        await refuse(header, "out_of_scope", `path not in scope: ${path}`);
        return true;
      }
    }
    if (op === "write_file") {
      const content = (body as { content_b64?: string })?.content_b64 ?? "";
      if (content.length > MAX_DEVICE_PLAINTEXT_BYTES) {
        await refuse(header, "too_large", "file exceeds the per-message limit");
        return true;
      }
    }

    // Rate limit.
    const now = Date.now();
    if (!withinRate(op, now)) {
      await refuse(header, "busy", "rate limit");
      return true;
    }

    // Approval mode.
    const mode = rule?.mode ?? "auto";
    if (mode === "ask") {
      const approved = callbacks.requestLocalApproval
        ? await callbacks.requestLocalApproval(op, body).catch(() => false)
        : false;
      if (!approved) {
        await refuse(header, "needs_approval", "waiting for the person at the machine");
        return true;
      }
    }

    // Budget: a budgeted action is any counted op. Check BEFORE running so a
    // spent budget never runs one more.
    const cls = countClassForOp(op);
    const budgeted = cls !== null && cls !== "error";
    if (budgeted && snapshot.budget?.maxActions !== undefined && spent >= snapshot.budget.maxActions) {
      await refuse(header, "out_of_scope", "action budget spent");
      await stop("budget_exhausted");
      return true;
    }

    // Run the handler (the seam). Mutating ops hold the device-wide mutex so
    // two sessions on one machine never interleave input.
    try {
      const result = MUTATING_OPS.includes(op)
        ? await deviceLock.run(() => dispatch(op, body))
        : await dispatch(op, body);
      if (budgeted) spent += 1;
      if (cls) bump(cls);
      audit({ commandId: header.id, op: header.op, decision: "ran" });
      if (mode === "notify") callbacks.onNotify?.(op, body);
      remember(header.id, { op: result.op, body: result.body });
      await reply(header, result.op, result.body);
    } catch (e) {
      const code: DeviceErrorCode = e instanceof DeviceProtocolError ? e.code : "failed";
      const message = e instanceof Error ? e.message : String(e);
      // The handler ran (or tried to): a retry by id must not run it again.
      remember(header.id, { op: "error", body: { code, message } });
      await refuse(header, code, message);
      return true;
    }

    // End the session the moment the last budgeted action is spent.
    if (budgeted && snapshot.budget?.maxActions !== undefined && spent >= snapshot.budget.maxActions) {
      await stop("budget_exhausted");
    }
    return true;
  }

  async function dispatch(op: DeviceOp, body: unknown): Promise<{ op: string; body?: unknown }> {
    switch (op) {
      case "observe":
        return { op: "observation", body: await handlers.observe((body as ObserveArgs) ?? { target: "screen" }) };
      case "click":
        await handlers.click(body as ClickArgs);
        return { op: "ack", body: { ok: true } };
      case "type":
        await handlers.type(body as { text: string });
        return { op: "ack", body: { ok: true } };
      case "key":
        await handlers.key(body as KeyArgs);
        return { op: "ack", body: { ok: true } };
      case "scroll":
        await handlers.scroll(body as ScrollArgs);
        return { op: "ack", body: { ok: true } };
      case "focus_app":
        await handlers.focusApp(body as { app: string });
        return { op: "ack", body: { ok: true } };
      case "list_apps":
        return { op: "apps", body: await handlers.listApps() };
      case "read_file":
        return { op: "file", body: await handlers.readFile(body as { path: string }) };
      case "write_file":
        await handlers.writeFile(body as { path: string; content_b64: string });
        return { op: "ack", body: { ok: true } };
      default:
        throw new DeviceProtocolError("unsupported", op);
    }
  }

  function start(): void {
    if (ended || beatTimer) return;
    beatTimer = setInterval(async () => {
      try {
        await transport.beat(snapshot.sessionId);
      } catch (e) {
        if (e instanceof DeviceBeatOverError) {
          await stop("lost_contact");
        }
        // any other beat error: keep trying until the dead-man sweep ends us.
      }
    }, beatIntervalMs);
    if (typeof (beatTimer as { unref?: () => void }).unref === "function") (beatTimer as { unref: () => void }).unref();

    if (snapshot.budget?.maxDurationS !== undefined) {
      const ms = Math.max(0, snapshot.budget.maxDurationS * 1000 - (Date.now() - startedAt));
      durationTimer = setTimeout(() => void stop("duration_limit"), ms);
      if (typeof (durationTimer as { unref?: () => void }).unref === "function") (durationTimer as { unref: () => void }).unref();
    }
  }

  async function stop(reason = "stopped_by_device"): Promise<void> {
    if (ended) return;
    ended = true;
    if (beatTimer) clearInterval(beatTimer);
    if (durationTimer) clearTimeout(durationTimer);
    beatTimer = durationTimer = null;
    audit({ commandId: "-", op: "stop", decision: "ended", reason });
    callbacks.onEnded?.(reason);
    try {
      await transport.stop(snapshot.sessionId, reason);
    } catch {
      /* subtract-only + idempotent; a failed stop still ends us locally */
    }
  }

  async function pause(reason: DevicePauseReason): Promise<void> {
    if (ended) return;
    const changed = pausedReason !== reason;
    pausedReason = reason;
    audit({ commandId: "-", op: "pause", decision: "refused", reason });
    if (!changed) return;
    try {
      await transport.pause?.(snapshot.sessionId, reason);
    } catch {
      /* the local pause stands; Salt learns on the next report */
    }
  }

  async function resume(): Promise<void> {
    if (ended || pausedReason === null) return;
    pausedReason = null;
    audit({ commandId: "-", op: "resume", decision: "ran" });
    try {
      await transport.resume?.(snapshot.sessionId);
    } catch {
      /* see pause() */
    }
  }

  return { handleCommand, start, stop, actionsSpent: () => spent, pause, resume, pausedReason: () => pausedReason };
}

const AGENT_OP_SET = new Set<DeviceOp>([
  "observe",
  "click",
  "type",
  "key",
  "scroll",
  "focus_app",
  "list_apps",
  "read_file",
  "write_file",
  "stop",
  "cancel",
  "shell",
]);
