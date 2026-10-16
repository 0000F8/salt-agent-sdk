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
  COMMAND_TTL_MS,
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
  decodePoint,
  isPointMessage,
  normalizePointed,
  normalizeProgress,
  normalizeStill,
  normalizeTaskResult,
  STILL_MAX_PER_MINUTE,
  STILL_MIN_INTERVAL_MS,
  newTaskId,
  parseTaskArgs,
  PROGRESS_MIN_INTERVAL_MS,
  RESULT_CACHE_SIZE,
  TASK_DEVICE_GRACE_MS,
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
  type PointedBody,
  type PointedRefusal,
  type Progress,
  type ScrollArgs,
  type StillBody,
  type SubmitArgs,
  type TaskArgs,
  type TaskResult,
} from "./protocol.js";
import pathMod from "node:path";
import type { LaneReaders } from "./client.js";
import { HELP_DELIVERY_TYPES, type HelpRequest, type HelpViewer } from "../help.js";
import { sameId, type SaltId } from "../ids.js";

/** The seams. The desktop app implements every method; the host calls one only
 *  after it has passed every gate below. A handler may throw -- the host turns
 *  a throw into an `error { code: "failed" }` and counts it as an error. */
export interface DeviceHostHandlers {
  observe(args: ObserveArgs): Promise<ObservationResult>;
  click(args: ClickArgs): Promise<HandlerResult>;
  type(args: { text: string }): Promise<HandlerResult>;
  key(args: KeyArgs): Promise<HandlerResult>;
  scroll(args: ScrollArgs): Promise<HandlerResult>;
  submit(args: SubmitArgs): Promise<HandlerResult>;
  focusApp(args: { app: string }): Promise<HandlerResult>;
  listApps(): Promise<AppsResult>;
  readFile(args: { path: string }): Promise<FileResult>;
  writeFile(args: { path: string; content_b64: string }): Promise<HandlerResult>;
  /** Do ONE whole task (op `task`, capability `device.task`). Optional: a host without it
   *  answers `unsupported`. The host holds the device lock for the whole run. What comes back
   *  is allow-listed field by field into a `TaskResult` (see `normalizeTaskResult`), so an
   *  extra field never reaches the agent. Let a `DeviceBudgetSpentError` from `ctx.spend`
   *  bubble: it ends the task and the session. */
  task?(args: TaskArgs, ctx: DeviceTaskContext): Promise<TaskResult>;
  /** Show Me: what is under the spot a person pointed at? Optional: a host without it answers a
   *  point `refused: "not_allowed"`. Called only after the host accepted the point (a person over
   *  the device, a help request or watch still open, a fresh point id). `x` and `y` are fractions
   *  of the picture the person tapped (`obs` names the still; absent = the live frame). Return the
   *  `screen` spot, the frontmost `app`, the `element` under it and, when the answer must be withheld,
   *  `refused`. The host drops the element of a refused answer and of any never-allowed app, so a
   *  handler that forgets cannot leak a name. A throw is answered `not_allowed`. */
  resolvePoint?(args: ResolvePointArgs): Promise<ResolvedPoint>;
}

export interface ResolvePointArgs {
  help_id: string;
  obs?: string;
  x: number;
  y: number;
  words: string;
}

/** What `resolvePoint` hands back; the host adds `help_id`, `x`, `y` and `words` itself. */
export type ResolvedPoint = Pick<PointedBody, "screen" | "app" | "element" | "refused">;

/** What `ctx.spend` counts a task step as. `act` is counted as a `click` (the closest of the
 *  existing classes: a press of a control) and `apps` as `app_focus`. */
export type TaskSpendClass = "command" | "look" | "act" | "observe" | "apps";

const SPEND_COUNT: Record<TaskSpendClass, DeviceCountClass> = {
  command: "command",
  look: "look",
  act: "click",
  observe: "observe",
  apps: "app_focus",
};

/** What a `task` handler is given besides its arguments. */
export interface DeviceTaskContext {
  /** Aborts when the agent cancels the task (`reason` "cancelled"), when `timeout_s` runs out
   *  ("timeout") and when the session ends ("session_ended"). A handler that ignores it is cut
   *  off 15 s after `timeout_s` with a `timeout` result and the device lock is released. */
  signal: AbortSignal;
  /** Tell the agent (and keep the session alive) with one plain line. The host allow-lists the
   *  fields, cuts `line` to 140 and sends at most one every 2 s (the newest waiting one goes
   *  out when the gap is over). Never throws. Call it at least once a minute on a long task:
   *  Salt ends a session that has run nothing for 2 minutes (5 when a person supervises). */
  progress(p: Progress): void;
  /** Count one step toward the grant's budget and the metadata counts, and keep the session
   *  alive. Throws `DeviceBudgetSpentError` when `max_actions` is already spent: let it bubble. */
  spend(cls: TaskSpendClass): void;
  /** Why the session is paused (the person has the computer), or null. A task must not act
   *  while this is non-null. */
  paused(): DevicePauseReason | null;
  /** Resolves `running` at once when not paused, or when the pause ends; `paused_out` when the
   *  task's own time runs out first (finish with status `paused_out`); `stopped` when the task
   *  is cancelled or the session ends. */
  waitWhilePaused(): Promise<"running" | "paused_out" | "stopped">;
  /** The `device.task` rule's mode: `ask` means every command asks the person first (Limited
   *  grant), `auto` runs it, `notify` runs it and tells them. The host does not ask for the
   *  task as a whole; the handler asks per command. */
  mode: DeviceCapRule["mode"];
  /** The grant's other rules (`device.observe`, `device.act`, `device.apps`, ...), read-only. */
  caps: Readonly<Partial<Record<string, DeviceCapRule>>>;
}

/** `ctx.spend` when the grant's `max_actions` is already spent. A `DeviceProtocolError` with
 *  code `out_of_scope`, so a handler that lets it bubble answers the agent "action budget
 *  spent" and the host ends the session `budget_exhausted`. */
export class DeviceBudgetSpentError extends DeviceProtocolError {
  constructor() {
    super("out_of_scope", "action budget spent");
    this.name = "DeviceBudgetSpentError";
  }
}

/** What a mutating handler may hand back: nothing, or a record about how the action went
 *  (a typed text reports `typed`, `method`, `verified`, `note`). Only those four fields ride
 *  into the ack, each with its own type, so the agent learns what the computer really did and
 *  nothing else (never a field's text, a screen, or any other handler-supplied field). */
export type HandlerResult = void | Record<string, unknown>;

const ACK_NOTE_MAX = 300;

/** The ack body: the allow-listed handler fields (typed: finite number, method: string,
 *  verified: boolean, note: string capped at 300), then `ok: true` (which a handler cannot
 *  override, so an old agent that only reads `ok` sees the same wire it always did). */
export function ackBody(result: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (typeof r.typed === "number" && Number.isFinite(r.typed)) out.typed = r.typed;
    if (typeof r.method === "string") out.method = r.method.length > ACK_NOTE_MAX ? r.method.slice(0, ACK_NOTE_MAX) : r.method;
    if (typeof r.verified === "boolean") out.verified = r.verified;
    if (typeof r.note === "string") out.note = r.note.length > ACK_NOTE_MAX ? r.note.slice(0, ACK_NOTE_MAX) : r.note;
  }
  out.ok = true;
  return out;
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
  beat(sessionId: SaltId, report?: DeviceBeatReport): Promise<void>;
  /** PATCH /device_sessions/:sid/counts with whole-number per-class counts and
   *  the newest executed seq. Salt extends an agent's lease ONLY from these
   *  device reports (it never sees commands). */
  reportCounts(
    sessionId: SaltId,
    counts: Partial<Record<DeviceCountClass, number>>,
    report?: { last_seq?: number }
  ): Promise<void>;
  /** POST /device_sessions/:sid/stop with an end reason (subtract-only). */
  stop(sessionId: SaltId, reason: string): Promise<void>;
  /** POST /device_sessions/:sid/pause `{reason}` (device key). Optional: a
   *  transport without it still pauses locally. The only place the pause
   *  endpoint's shape lives is httpDeviceHostTransport (http.ts). */
  pause?(sessionId: SaltId, reason: DevicePauseReason): Promise<void>;
  /** POST /device_sessions/:sid/resume (device key). */
  resume?(sessionId: SaltId): Promise<void>;
}

/** The optional body of a beat: when the device last executed a command
 *  (ISO8601) and that command's seq. Sent on every beat once one has run. */
export interface DeviceBeatReport {
  last_command_at?: string;
  last_seq?: number;
  /** True on every beat while a `task` handler is running: one model call can take two minutes, and a
   *  plain beat does not keep the session alive past the idle lease. */
  task_running?: true;
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
  requestLocalApproval?(op: DeviceOp, args: unknown, opts?: { timeoutMs: number }): Promise<boolean>;
  /** Told after a `notify`-mode command runs, so the app can surface it. */
  onNotify?(op: DeviceOp, args: unknown): void;
  /** Told when the host ends the session itself (budget, duration, lost beat,
   *  a stop command). The app updates its indicator and writes its audit line. */
  onEnded?(reason: string): void;
  /** Every gate decision, for the app's append-only on-disk audit log. Content
   *  is the caller's to redact; the host passes op + decision + reason only. */
  onAudit?(entry: DeviceAuditEntry): void;
  /** Show Me: a help request opened on this session. The app posts a still now and then stills on
   *  change (via `host.postStill`) for ten minutes. */
  onHelpOpened?(req: HelpRequest): void;
  /** Show Me: the person is looking from their phone. The app posts a still now, restarts its
   *  ten-minute window and shows "<name> is looking from their phone". */
  onHelpViewing?(req: HelpRequest, viewer: HelpViewer | null): void;
  /** Show Me: the help request closed (answered, withdrawn or ended). The app stops and clears its lines. */
  onHelpClosed?(req: HelpRequest): void;
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
  "com.apple.passwords",
  "com.bitwarden.desktop",
  "com.dashlane.dashlane",
  "org.keepassxc.keepassxc",
  "1password",
  "bitwarden",
  "keepassxc",
  "keychain access",
  "passwords",
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
  /** Show Me: feed a lane message in together with WHO sent it (the decrypted text and the sender's
   *  account id). Returns true when it was a `[[SALT-POINT]]` line, consumed here whether or not it
   *  was acted on; false for anything else (pass that to `handleCommand`). A point is accepted only
   *  from a person `options.isPersonOverDevice` names, only while its help request is open (or
   *  `options.isWatchLive()`), and once per point id; the answer is a `pointed` op with `re` = the
   *  point id. Every refusal is one audit line (op `point`) and no reply. */
  handleLaneMessage(plaintext: string, senderId: SaltId): Promise<boolean>;
  /** Show Me: feed a `help_request_opened|viewing|closed` delivery in (the `onDeviceDelivery` type
   *  and body). Returns true when it was one of those for THIS session and the matching callback
   *  ran. */
  handleDelivery(type: string, body: unknown): boolean;
  /** Show Me: post a still into the lane (op `still`, no `re`). Resolves `{posted: true}`, or
   *  `{posted: false, reason}` when held back: `too_soon` (under 2 s since the last one),
   *  `too_many` (30 in the last minute), `no_help` (no help request open for that id and no live
   *  watch), `secure_field` (the session is paused for a secure field), `ended`. Throws
   *  `bad_args` for a malformed body and `too_large` over the per-message cap. */
  postStill(body: StillBody): Promise<{ posted: true } | { posted: false; reason: "too_soon" | "too_many" | "no_help" | "secure_field" | "ended" }>;
  /** The help request ids currently open on this session. */
  openHelpIds(): string[];
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
    /** Least gap between two `progress` lines of a task (default PROGRESS_MIN_INTERVAL_MS). */
    progressMinIntervalMs?: number;
    /** How long past `timeout_s` a task handler may run before it is cut off (default 15 s). */
    taskGraceMs?: number;
    /** Show Me: is this account one of the device's people (owner, chain root or the session's
     *  grantor), per the host's cached `GET /devices/:id/grants`? A point from anyone else is ignored.
     *  Absent, every point is ignored. */
    isPersonOverDevice?: (accountId: SaltId) => boolean;
    /** Show Me: is a live watch call on this device right now? While it is, a point is accepted
     *  without an open help request. Default: never. */
    isWatchLive?: () => boolean;
    /** Least gap between two stills (default STILL_MIN_INTERVAL_MS, 2 s). For tests: the 30-a-minute
     *  cap can only be reached below the default gap. */
    stillMinIntervalMs?: number;
  } = {}
): DeviceHost {
  const deviceLock = options.deviceLock ?? sharedDeviceLock;
  const clock = options.now ?? Date.now;
  const beatIntervalMs = options.beatIntervalMs ?? 5_000;
  const progressMinIntervalMs = options.progressMinIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
  const taskGraceMs = options.taskGraceMs ?? TASK_DEVICE_GRACE_MS;
  const neverAllowed = (options.neverAllowedApps ?? NEVER_ALLOWED_APPS).map((s) => s.toLowerCase());

  let lastSeq = 0;
  // Newest command this host actually executed (for lease reports).
  let lastRanAt: string | null = null;
  let lastRanSeq: number | null = null;
  let pausedReason: DevicePauseReason | null = null;
  // One command at a time per session: every command runs behind this tail.
  let tail: Promise<unknown> = Promise.resolve();
  // Ids received and not yet started / ids a `cancel` asked us to drop.
  const queuedIds = new Map<string, number>();
  // Ids a `cancel` named (even before the command arrived). Bounded: oldest dropped.
  const cancelledIds = new Set<string>();
  const CANCELLED_CAP = 256;
  // What Salt has been told about our pause state (null = running).
  let reportedPause: DevicePauseReason | null = null;
  let pauseSync: Promise<void> = Promise.resolve();
  // A device whose clock runs ahead of the sender's may see an `exp` this far in the future.
  const EXP_SKEW_MS = 5_000;
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
  // Tasks being run right now, by command id: `cancel` and the end of the session abort them.
  const runningTasks = new Map<string, AbortController>();
  // Callers of ctx.waitWhilePaused(), released by resume().
  const resumeWaiters = new Set<() => void>();

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
        // last_seq only rides with real work: a batch of nothing but handler
        // failures must not look like progress (Salt extends the lease on it).
        const work = (Object.keys(batch) as DeviceCountClass[]).some((k) => k !== "error");
        await transport.reportCounts(snapshot.sessionId, batch, work && lastRanSeq !== null ? { last_seq: lastRanSeq } : undefined);
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
    extra: { expected_seq?: number; reason?: DevicePauseReason; now?: number } = {}
  ): Promise<{ op: string; body?: unknown }> {
    audit({ commandId: header.id, op: header.op, decision: code === "needs_approval" ? "needs_approval" : "refused", code, reason: message });
    // Refusals are not actions and are not reported as counts (they would
    // otherwise extend the lease and spend the budget server-side).
    return reply(header, "error", { code, message, ...extra });
  }

  /** Why a path is refused, or null when it is inside a root. Only absolute,
   *  already-normalised paths are accepted (`..`, `.`, doubled or trailing
   *  slashes are refused, never resolved), compared to the resolved roots on
   *  segment boundaries. The device re-checks against the real filesystem
   *  (symlinks) at I/O time. */
  function fileScopeProblem(rule: DeviceCapRule | undefined, p: string): string | null {
    if (!rule) return "no files capability";
    if (!rule.fileRoots || rule.fileRoots.length === 0) return "files need an explicit root";
    if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return "path must be a non-empty string";
    if (!pathMod.isAbsolute(p) || pathMod.resolve(p) !== p) return "path must be absolute and normalised";
    const inside = rule.fileRoots.some((root) => {
      const r = pathMod.resolve(root);
      return p === r || p.startsWith(r.endsWith(pathMod.sep) ? r : r + pathMod.sep);
    });
    return inside ? null : "path is outside the allowed roots";
  }

  /** The floor: an app named by id OR by a longer name that contains a never-allowed one
   *  ("1Password 7 - Password Manager") is refused whatever the mandate says. */
  function isNeverAllowed(app: string): boolean {
    const a = app.toLowerCase();
    return neverAllowed.some((n) => a === n || a.includes(n));
  }

  function appInScope(rule: DeviceCapRule | undefined, app: string): boolean {
    if (isNeverAllowed(app)) return false;
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
      // Remembered even when the command has not arrived yet (messages can
      // reorder); processed on arrival, so a long action never delays it.
      // The target is body `{id}` (a command) or the header's `re` (a task); a running task is
      // aborted, which ends it `stopped`.
      const bodyId = (body as { id?: unknown } | undefined)?.id;
      const id = typeof bodyId === "string" ? bodyId : header.re;
      const running = typeof id === "string" ? runningTasks.get(id) : undefined;
      if (running) running.abort("cancelled");
      else if (typeof id === "string" && id.length <= 64) {
        cancelledIds.delete(id);
        cancelledIds.add(id);
        while (cancelledIds.size > CANCELLED_CAP) cancelledIds.delete(cancelledIds.values().next().value as string);
      }
      audit({ commandId: typeof id === "string" ? id : "-", op: "cancel", decision: "ran" });
      return true;
    }

    // `stop` waits its turn like any command, but a running task must not make it wait up to
    // `timeout_s`: tell the task now, so the stop is reached as soon as it unwinds.
    if (header.op === "stop" && header.v === DEVICE_PROTOCOL_VERSION) {
      for (const ac of runningTasks.values()) ac.abort("session_ended");
    }

    queuedIds.set(header.id, (queuedIds.get(header.id) ?? 0) + 1);
    // The deadline runs on THIS device's clock from arrival: the sender's `exp`
    // can only shorten it, never extend it.
    const receivedAt = clock();
    const run = tail.then(() => processCommand(header, body, receivedAt));
    tail = run.catch(() => undefined);
    return run;
  }

  async function processCommand(header: DeviceHeader, body: unknown, receivedAt: number): Promise<boolean> {
    const left = (queuedIds.get(header.id) ?? 1) - 1;
    if (left > 0) queuedIds.set(header.id, left);
    else queuedIds.delete(header.id);
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

    if (cancelledIds.delete(header.id)) {
      audit({ commandId: header.id, op: header.op, decision: "refused", reason: "cancelled before start" });
      return true;
    }

    // Expiry: `exp` is required, and the deadline is the device's own: the
    // sooner of the sender's `exp` and arrival + the TTL. Not executed,
    // consumes no seq.
    if (header.exp === undefined) {
      await refuse(header, "bad_args", "exp is required", { expected_seq: lastSeq + 1 });
      return true;
    }
    if (header.exp > receivedAt + COMMAND_TTL_MS + EXP_SKEW_MS) {
      // Distinct from bad_args: the sender's clock is behind ours. Carries our
      // `now` so the client can correct its offset and resend the same id.
      await refuse(header, "clock_skew", "exp is further ahead than a command may live", { expected_seq: lastSeq + 1, now: clock() });
      return true;
    }
    const deadline = Math.min(header.exp, receivedAt + COMMAND_TTL_MS);
    if (clock() >= deadline) {
      await refuse(header, "expired", "command expired before it started", { expected_seq: lastSeq + 1, now: clock() });
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

    // A task needs a handler, and arguments the device would run: checked here so a task that
    // cannot run never takes the approval, the budget or the lock.
    let taskArgs: ReturnType<typeof parseTaskArgs> | undefined;
    if (op === "task") {
      if (!handlers.task) {
        await refuse(header, "unsupported", "this computer cannot run whole tasks");
        return true;
      }
      try {
        taskArgs = parseTaskArgs(body);
      } catch (e) {
        await refuse(header, "bad_args", e instanceof Error ? e.message : "bad task arguments");
        return true;
      }
    }

    // Selector scope: apps and file roots.
    if ((op === "focus_app") && !appInScope(rule, (body as { app?: string })?.app ?? "")) {
      const app = (body as { app?: string })?.app ?? "";
      await refuse(header, isNeverAllowed(app) ? "forbidden" : "out_of_scope", `app not in scope: ${app}`);
      return true;
    }
    // Observing a named app is looking at it: the same floor applies.
    if (op === "observe") {
      const app = (body as { app?: string } | undefined)?.app;
      if (typeof app === "string" && isNeverAllowed(app)) {
        await refuse(header, "forbidden", `app not in scope: ${app}`);
        return true;
      }
    }
    if (op === "read_file" || op === "write_file") {
      const path = (body as { path?: string })?.path ?? "";
      const problem = fileScopeProblem(rule, path);
      if (problem) {
        const malformed = problem.startsWith("path must be");
        await refuse(header, malformed ? "forbidden" : "out_of_scope", `path not in scope: ${problem}`);
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
    // A task is not asked about as a whole: the handler asks before each command (ctx.mode).
    const mode = rule?.mode ?? "auto";
    if (mode === "ask" && op !== "task") {
      // Never wait past the command's own deadline.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - clock()));
      });
      const asked: Promise<boolean> = callbacks.requestLocalApproval
        ? callbacks.requestLocalApproval(op, body, { timeoutMs: Math.max(0, deadline - clock()) }).catch(() => false)
        : Promise.resolve(false);
      const outcome = await Promise.race([asked, timedOut]);
      if (timer) clearTimeout(timer);
      if (outcome === "timeout") {
        await refuse(header, "expired", "command expired while waiting for approval", { expected_seq: lastSeq + 1 });
        return true;
      }
      const approved = outcome;
      if (!approved) {
        await refuse(header, "needs_approval", "waiting for the person at the machine");
        return true;
      }
    }

    // Budget: a budgeted action is any counted op. Check BEFORE running so a
    // spent budget never runs one more.
    const cls = countClassForOp(op);
    // A task is not itself an action: its steps are (ctx.spend), so it is counted but not charged.
    const budgeted = cls !== null && cls !== "error" && op !== "task";
    const checksBudget = budgeted || op === "task";
    if (checksBudget && snapshot.budget?.maxActions !== undefined && spent >= snapshot.budget.maxActions) {
      await refuse(header, "out_of_scope", "action budget spent");
      await stop("budget_exhausted");
      return true;
    }

    // Run the handler (the seam). Mutating ops hold the device-wide mutex so
    // two sessions on one machine never interleave input.
    try {
      // Everything that waited (approval, the device lock, other sessions'
      // actions) can have changed the world: re-check the session, the pause,
      // the mandate and the deadline at the last moment, INSIDE the lock.
      const checked = async (): Promise<{ op: string; body?: unknown } | Gate> => {
        const gate = lastChance(header, deadline);
        if (gate) return gate;
        return dispatch(op, body, header, taskArgs, rule);
      };
      const out = MUTATING_OPS.includes(op) ? await deviceLock.run(checked) : await checked();
      if (isGate(out)) {
        // Not executed: give the seq back so the sender can resend this command.
        lastSeq = header.seq - 1;
        if (out.silent) return true;
        await refuse(header, out.code, out.message, { expected_seq: header.seq, reason: out.reason });
        return true;
      }
      const result = out;
      if (budgeted) spent += 1;
      lastRanAt = new Date(clock()).toISOString();
      lastRanSeq = header.seq;
      if (cls) bump(cls);
      audit({ commandId: header.id, op: header.op, decision: "ran" });
      if (mode === "notify") callbacks.onNotify?.(op, body);
      remember(header.id, { op: result.op, body: result.body });
      await reply(header, result.op, result.body);
    } catch (e) {
      if (e instanceof DeviceBudgetSpentError) {
        // A task spent the last of the budget and did not finish: nothing to count as an error.
        remember(header.id, { op: "error", body: { code: e.code, message: e.message } });
        await refuse(header, e.code, e.message);
        await stop("budget_exhausted");
        return true;
      }
      const code: DeviceErrorCode = e instanceof DeviceProtocolError ? e.code : "failed";
      const message = e instanceof Error ? e.message : String(e);
      // The person guard (paused / busy) refused INSIDE the handler: nothing
      // ran, so report it as what it is, do not cache it and give the seq back.
      const duck = e as { code?: unknown; reason?: unknown };
      if (!(e instanceof DeviceProtocolError) && (duck?.code === "paused" || duck?.code === "busy")) {
        lastSeq = header.seq - 1;
        await refuse(header, duck.code, message, {
          expected_seq: header.seq,
          reason: typeof duck.reason === "string" ? (duck.reason as DevicePauseReason) : undefined,
        });
        return true;
      }
      // The handler ran (or tried to): a retry by id must not run it again.
      remember(header.id, { op: "error", body: { code, message } });
      bump("error");
      await refuse(header, code, message);
      return true;
    }

    // End the session the moment the last budgeted action is spent.
    if (checksBudget && snapshot.budget?.maxActions !== undefined && spent >= snapshot.budget.maxActions) {
      await stop("budget_exhausted");
    }
    return true;
  }

  type Gate = { gate: true; code: DeviceErrorCode; message: string; reason?: DevicePauseReason; silent?: boolean };
  function isGate(x: unknown): x is Gate {
    return typeof x === "object" && x !== null && (x as Gate).gate === true;
  }

  /** The last look before a handler runs. */
  function lastChance(header: DeviceHeader, deadline: number): Gate | null {
    if (ended) return { gate: true, code: "forbidden", message: "session ended", silent: true };
    if (cancelledIds.delete(header.id)) {
      audit({ commandId: header.id, op: header.op, decision: "refused", reason: "cancelled before start" });
      return { gate: true, code: "forbidden", message: "cancelled", silent: true };
    }
    if (pausedReason !== null) {
      return { gate: true, code: "paused", message: `paused: ${pausedReason}`, reason: pausedReason };
    }
    if (snapshot.expiresAt && clock() >= Date.parse(snapshot.expiresAt)) {
      return { gate: true, code: "out_of_scope", message: "mandate expired" };
    }
    if (clock() >= deadline) {
      return { gate: true, code: "expired", message: "command expired before it could run" };
    }
    return null;
  }

  async function dispatch(
    op: DeviceOp,
    body: unknown,
    header: DeviceHeader,
    taskArgs: ReturnType<typeof parseTaskArgs> | undefined,
    rule: DeviceCapRule | undefined
  ): Promise<{ op: string; body?: unknown }> {
    switch (op) {
      case "observe":
        return { op: "observation", body: await handlers.observe((body as ObserveArgs) ?? { target: "screen" }) };
      case "click":
        return { op: "ack", body: ackBody(await handlers.click(body as ClickArgs)) };
      case "type":
        return { op: "ack", body: ackBody(await handlers.type(body as { text: string })) };
      case "key":
        return { op: "ack", body: ackBody(await handlers.key(body as KeyArgs)) };
      case "scroll":
        return { op: "ack", body: ackBody(await handlers.scroll(body as ScrollArgs)) };
      case "submit":
        return { op: "ack", body: ackBody(await handlers.submit(body as SubmitArgs)) };
      case "focus_app":
        return { op: "ack", body: ackBody(await handlers.focusApp(body as { app: string })) };
      case "list_apps":
        return { op: "apps", body: await handlers.listApps() };
      case "read_file":
        return { op: "file", body: await handlers.readFile(body as { path: string }) };
      case "write_file":
        return { op: "ack", body: ackBody(await handlers.writeFile(body as { path: string; content_b64: string })) };
      case "task":
        return { op: "task_result", body: await runTask(header, taskArgs as ReturnType<typeof parseTaskArgs>, rule) };
      default:
        throw new DeviceProtocolError("unsupported", op);
    }
  }

  /** Note that something ran just now, so the next beat carries it and Salt moves the lease. */
  function touchLease(header: DeviceHeader): void {
    lastRanAt = new Date(clock()).toISOString();
    lastRanSeq = header.seq;
  }

  /** Run a task handler under the device lock the caller already holds. Progress goes out as
   *  non-final results with the task's `re`, always before the final one. */
  async function runTask(header: DeviceHeader, args: ReturnType<typeof parseTaskArgs>, rule: DeviceCapRule | undefined): Promise<TaskResult> {
    const handler = handlers.task as NonNullable<DeviceHostHandlers["task"]>;
    const ac = new AbortController();
    runningTasks.set(header.id, ac);
    const startedAt = clock();
    const timeoutMs = args.timeout_s * 1000;
    let over = false;
    let lastProgressAt = Number.NEGATIVE_INFINITY;
    let pendingProgress: Progress | null = null;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    let postChain: Promise<void> = Promise.resolve();

    const sendProgress = (p: Progress): void => {
      lastProgressAt = clock();
      touchLease(header);
      postChain = postChain
        .then(() => reply(header, "progress", p))
        .then(() => undefined)
        .catch(() => undefined); // a failed progress line never stops the task
    };

    const ctx: DeviceTaskContext = {
      signal: ac.signal,
      progress(p) {
        if (over || ended) return;
        const n = normalizeProgress(p);
        if (!n) return;
        const wait = progressMinIntervalMs - (clock() - lastProgressAt);
        if (wait <= 0) {
          if (progressTimer) clearTimeout(progressTimer);
          progressTimer = undefined;
          pendingProgress = null;
          sendProgress(n);
          return;
        }
        // Too soon: keep only the newest and send it when the gap is over.
        pendingProgress = n;
        if (!progressTimer) {
          progressTimer = setTimeout(() => {
            progressTimer = undefined;
            const q = pendingProgress;
            pendingProgress = null;
            if (q && !over && !ended) sendProgress(q);
          }, wait);
        }
      },
      spend(cls) {
        if (over) throw new Error("the task is over");
        if (ended) throw new DeviceProtocolError("failed", "session ended");
        const counted = SPEND_COUNT[cls];
        if (!counted) throw new DeviceProtocolError("bad_args", `unknown step class ${String(cls)}`);
        const max = snapshot.budget?.maxActions;
        if (max !== undefined && spent >= max) throw new DeviceBudgetSpentError();
        spent += 1;
        touchLease(header);
        bump(counted);
      },
      paused: () => pausedReason,
      waitWhilePaused() {
        if (pausedReason === null) return Promise.resolve("running");
        const outcome = (): "paused_out" | "stopped" => (ac.signal.reason === "timeout" ? "paused_out" : "stopped");
        if (ac.signal.aborted) return Promise.resolve(outcome());
        return new Promise((resolve) => {
          const done = (v: "running" | "paused_out" | "stopped"): void => {
            resumeWaiters.delete(onResume);
            ac.signal.removeEventListener("abort", onAbort);
            resolve(v);
          };
          const onResume = (): void => done("running");
          const onAbort = (): void => done(outcome());
          resumeWaiters.add(onResume);
          ac.signal.addEventListener("abort", onAbort, { once: true });
        });
      },
      mode: rule?.mode ?? "auto",
      caps: Object.freeze({ ...snapshot.caps }),
    };

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    timers.push(setTimeout(() => ac.abort("timeout"), timeoutMs));
    if (snapshot.expiresAt) {
      const until = Date.parse(snapshot.expiresAt) - clock();
      if (until < timeoutMs) timers.push(setTimeout(() => ac.abort("session_ended"), Math.max(0, until)));
    }
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    type Outcome = { kind: "ok"; value: unknown } | { kind: "err"; error: unknown } | { kind: "hard" };
    let outcome: Outcome;
    try {
      const ran: Promise<Outcome> = (async () => handler(args, ctx))().then(
        (value): Outcome => ({ kind: "ok", value }),
        (error): Outcome => ({ kind: "err", error })
      );
      const hard = new Promise<Outcome>((resolve) => {
        hardTimer = setTimeout(() => resolve({ kind: "hard" }), timeoutMs + taskGraceMs);
      });
      outcome = await Promise.race([ran, hard]);
    } finally {
      for (const t of timers) clearTimeout(t);
      if (hardTimer) clearTimeout(hardTimer);
    }
    over = true;
    if (progressTimer) clearTimeout(progressTimer);
    pendingProgress = null;
    runningTasks.delete(header.id);
    if (outcome.kind === "hard") ac.abort("timeout"); // a handler that ignored the signal is let go
    await postChain; // every progress line goes out before the final result

    const elapsed = Math.max(0, clock() - startedAt);
    const cut = (status: TaskResult["status"], summary: string): TaskResult => ({
      task_id: newTaskId(),
      status,
      summary,
      checked: null,
      steps: [],
      commands: 0,
      duration_ms: elapsed,
    });
    if (outcome.kind === "ok") return normalizeTaskResult(outcome.value, { duration_ms: elapsed });
    if (outcome.kind === "hard") return cut("timeout", "The task ran out of time.");
    if (outcome.error instanceof DeviceBudgetSpentError) throw outcome.error;
    if (ac.signal.aborted) {
      // The handler gave up because it was told to: that is a stop or a timeout, not a failure.
      return ac.signal.reason === "timeout" ? cut("timeout", "The task ran out of time.") : cut("stopped", "The task was stopped.");
    }
    throw outcome.error;
  }

  function start(): void {
    if (ended || beatTimer) return;
    beatTimer = setInterval(async () => {
      void syncPause(); // retry a pause/resume report that failed
      try {
        // Beats keep running while paused: Salt ends a paused session that stops
        // beating after 15 s. After a command has run, every beat says so.
        const report: DeviceBeatReport = {
          ...(lastRanAt !== null ? { last_command_at: lastRanAt, last_seq: lastRanSeq ?? undefined } : {}),
          ...(runningTasks.size > 0 ? { task_running: true as const } : {}),
        };
        await transport.beat(snapshot.sessionId, Object.keys(report).length ? report : undefined);
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
    for (const ac of runningTasks.values()) ac.abort("session_ended");
    openHelp.clear();
    audit({ commandId: "-", op: "stop", decision: "ended", reason });
    callbacks.onEnded?.(reason);
    try {
      await transport.stop(snapshot.sessionId, reason);
    } catch {
      /* subtract-only + idempotent; a failed stop still ends us locally */
    }
  }

  /** Make Salt's picture of our pause state match ours. Salt only accepts a
   *  pause from `active`, so a reason CHANGE is resume-then-pause. A failed
   *  report is retried on the next beat (the local pause stands meanwhile). */
  function syncPause(): Promise<void> {
    pauseSync = pauseSync.then(async () => {
      if (ended) return;
      const want = pausedReason;
      if (reportedPause === want) return;
      try {
        if (reportedPause !== null) {
          await transport.resume?.(snapshot.sessionId);
          reportedPause = null;
        }
        if (want !== null) {
          await transport.pause?.(snapshot.sessionId, want);
          reportedPause = want;
        }
      } catch {
        /* retried on the next beat */
      }
    });
    return pauseSync;
  }

  async function pause(reason: DevicePauseReason): Promise<void> {
    if (ended) return;
    const changed = pausedReason !== reason;
    pausedReason = reason;
    audit({ commandId: "-", op: "pause", decision: "refused", reason });
    if (!changed) return;
    await syncPause();
  }

  async function resume(): Promise<void> {
    if (ended || pausedReason === null) return;
    pausedReason = null;
    audit({ commandId: "-", op: "resume", decision: "ran" });
    for (const release of [...resumeWaiters]) release();
    await syncPause();
  }

  // ---- Show Me: help requests, stills and points (CONTRACT.md sections 3 and 4) ----------------
  // Help requests open on THIS session, by id. A point is acted on only while its help id is here
  // (or a watch is live).
  const openHelp = new Map<string, HelpRequest>();
  // Point ids already answered, oldest dropped: a replayed or re-delivered point is answered once.
  const seenPoints = new Set<string>();
  const SEEN_POINTS_CAP = 256;
  // Times of recently posted stills (the 2 s gap and the 30-a-minute window).
  const stillTimes: number[] = [];

  function helpFromBody(body: unknown): HelpRequest | null {
    const hr = (body as { help_request?: unknown } | null | undefined)?.help_request;
    if (!hr || typeof hr !== "object") return null;
    const r = hr as HelpRequest;
    if (typeof r.id !== "string" || r.id === "") return null;
    // A delivery about another session is not ours.
    if (r.device_session_id == null || !sameId(r.device_session_id, snapshot.sessionId)) return null;
    return r;
  }

  function handleDelivery(type: string, body: unknown): boolean {
    if (!(HELP_DELIVERY_TYPES as readonly string[]).includes(type)) return false;
    if (ended) return false;
    const req = helpFromBody(body);
    if (!req) return false;
    if (type === "help_request_opened") {
      openHelp.set(req.id, req);
      callbacks.onHelpOpened?.(req);
    } else if (type === "help_request_viewing") {
      openHelp.set(req.id, req);
      const v = (body as { viewer?: HelpViewer | null }).viewer;
      callbacks.onHelpViewing?.(req, v && typeof v === "object" && typeof v.id === "string" ? v : null);
    } else {
      openHelp.delete(req.id);
      callbacks.onHelpClosed?.(req);
    }
    return true;
  }

  function helpAllowsStills(helpId: string): boolean {
    return openHelp.has(helpId) || (options.isWatchLive?.() ?? false);
  }

  async function postStill(
    raw: StillBody
  ): Promise<{ posted: true } | { posted: false; reason: "too_soon" | "too_many" | "no_help" | "secure_field" | "ended" }> {
    if (ended) return { posted: false, reason: "ended" };
    const body = normalizeStill(raw);
    if (!body) throw new DeviceProtocolError("bad_args", "malformed still");
    if (!helpAllowsStills(body.help_id)) return { posted: false, reason: "no_help" };
    // No new still while secure input is on.
    if (pausedReason === "secure_field") return { posted: false, reason: "secure_field" };
    const now = clock();
    while (stillTimes.length && now - stillTimes[0] >= 60_000) stillTimes.shift();
    if (stillTimes.length && now - stillTimes[stillTimes.length - 1] < (options.stillMinIntervalMs ?? STILL_MIN_INTERVAL_MS)) return { posted: false, reason: "too_soon" };
    if (stillTimes.length >= STILL_MAX_PER_MINUTE) return { posted: false, reason: "too_many" };
    const plaintext = encodeDeviceMessage(
      { v: DEVICE_PROTOCOL_VERSION, id: deviceMessageId(), seq: nextOutSeq(), op: "still", session: snapshot.sessionId },
      body
    );
    if (Buffer.byteLength(plaintext, "utf8") > MAX_DEVICE_PLAINTEXT_BYTES) throw new DeviceProtocolError("too_large", "still exceeds the per-message limit");
    stillTimes.push(now);
    await transport.postResult(plaintext, snapshot.readers);
    return { posted: true };
  }

  function pointRefused(pointId: string, why: string): void {
    audit({ commandId: pointId, op: "point", decision: "refused", code: "forbidden", reason: why });
  }

  async function handleLaneMessage(plaintext: string, senderId: SaltId): Promise<boolean> {
    if (!isPointMessage(plaintext)) return false;
    if (ended) return true;
    let point;
    try {
      point = decodePoint(plaintext);
    } catch (e) {
      pointRefused("-", `malformed point: ${(e as Error).message}`);
      return true;
    }
    if (!point) return true;
    if (!options.isPersonOverDevice?.(senderId)) {
      pointRefused(point.id, "sender is not a person over this device");
      return true;
    }
    if (!helpAllowsStills(point.help)) {
      pointRefused(point.id, "no open help request for that id");
      return true;
    }
    if (seenPoints.has(point.id)) {
      pointRefused(point.id, "point id already answered");
      return true;
    }
    seenPoints.add(point.id);
    while (seenPoints.size > SEEN_POINTS_CAP) seenPoints.delete(seenPoints.values().next().value as string);

    let resolved: ResolvedPoint | null = null;
    let refused: PointedRefusal | null = null;
    if (!handlers.resolvePoint) {
      refused = "not_allowed";
    } else {
      try {
        resolved = await handlers.resolvePoint({ help_id: point.help, obs: point.obs, x: point.x, y: point.y, words: point.words });
      } catch {
        refused = "not_allowed";
      }
    }
    // The floor, again: never name anything in a never-allowed app, whatever the handler said.
    if (resolved && refused === null) {
      refused = resolved.refused ?? null;
      if (refused === null && resolved.app && isNeverAllowed(resolved.app)) refused = "forbidden_app";
    }
    const answer: PointedBody =
      normalizePointed({
        help_id: point.help,
        x: point.x,
        y: point.y,
        screen: resolved?.screen ?? { x: 0, y: 0 },
        app: refused === "forbidden_app" ? null : (resolved?.app ?? null),
        element: refused === null ? (resolved?.element ?? null) : null,
        refused,
        words: point.words,
      }) ?? ({ help_id: point.help, x: point.x, y: point.y, screen: { x: 0, y: 0 }, app: null, element: null, refused: "not_allowed", words: "" } as PointedBody);
    audit({ commandId: point.id, op: "point", decision: "ran", reason: answer.refused ?? undefined });
    await reply({ id: point.id } as DeviceHeader, "pointed", answer);
    return true;
  }

  return { handleCommand, start, stop, actionsSpent: () => spent, pause, resume, pausedReason: () => pausedReason, handleLaneMessage, handleDelivery, postStill, openHelpIds: () => [...openHelp.keys()] };
}

const AGENT_OP_SET = new Set<DeviceOp>([
  "observe",
  "click",
  "type",
  "key",
  "scroll",
  "submit",
  "focus_app",
  "list_apps",
  "read_file",
  "write_file",
  "task",
  "stop",
  "cancel",
  "shell",
]);
