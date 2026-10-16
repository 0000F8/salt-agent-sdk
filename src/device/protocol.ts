// The `[[SALT-DEVICE]]` wire grammar (salt-api docs/DEVICE_PROTOCOL.md).
//
// A device command or result is the PLAINTEXT of an ordinary end-to-end
// encrypted lane message. Salt relays the ciphertext and never parses it;
// everything in this file runs INSIDE the agent and INSIDE the device, on
// plaintext that has already been decrypted (device client) or is about to be
// encrypted (device host). Nothing here touches a screen, a keyboard, or a
// network -- it only turns a command into a line of text and back.
//
// This module is pure: no I/O, no crypto, no transport. encode/decode/verify
// only. client.ts (agent side) and host.ts (device side) wrap it with the
// injected transports that do the encrypting, posting and dispatching.
//
// It is the single source of truth for the grammar on the TypeScript side; a
// change to the grammar is made in DEVICE_PROTOCOL.md first, then mirrored
// here, then announced -- never the other way round.

/** Grammar version. An incoming message with any other `v` is answered
 *  `error { code: "unsupported" }`, never guessed at. */
export const DEVICE_PROTOCOL_VERSION = 1 as const;

/** A single lane message carries at most this much PLAINTEXT. Larger files or
 *  images are refused with `too_large` (a later phase may chunk). Mirrors
 *  salt-api's own per-message plaintext cap. */
export const MAX_DEVICE_PLAINTEXT_BYTES = 4 * 1024 * 1024;

/** Per-session rate ceilings the device enforces. Over either, the device
 *  answers `busy` and does not run the command. */
export const MAX_COMMANDS_PER_SECOND = 5;
export const MAX_OBSERVE_PER_SECOND = 1;

// ---- one command in flight (device-locking contract §5) ---------------------
// Every constant the client and host must agree on lives here.

/** A command is valid for this long after the client built it. The client sets
 *  `exp = now + COMMAND_TTL_MS` (epoch MILLISECONDS); the host refuses a
 *  command whose `exp` has passed with `expired`, without executing it. */
export const COMMAND_TTL_MS = 30_000;

/** The host remembers this many results per session, by command `id`; a
 *  repeated `id` returns the stored result without executing. */
export const RESULT_CACHE_SIZE = 64;

/** Ops that change what is on the machine's screen/input state. The host
 *  serialises these device-wide (across every session on the machine) behind
 *  one mutex. `observe`, `list_apps` and the file ops do not take it. */
export const MUTATING_OPS: readonly string[] = ["click", "type", "key", "scroll", "submit", "focus_app", "task"];

/** Why a session is paused (device -> Salt -> agent). `person_active` and
 *  `secure_field` are the contract's two; `person_paused` is an explicit tray
 *  pause or hotkey. Free-form strings are tolerated on the wire. */
export type DevicePauseReason = "person_active" | "secure_field" | "person" | "phone" | "other" | (string & {});

/** Show Me (0.22.0): two device-to-agent ops that are not answers to a command.
 *  `still` is unsolicited (no `re`): the device posts a downscaled picture of its
 *  screen into the lane while a help request is open. `pointed` answers a person's
 *  `[[SALT-POINT]]` (its `re` is the point id): what is under the spot they tapped.
 *  They are kept out of `DEVICE_RESULT_OPS` on purpose: that list is pinned by the
 *  envelope-vector fixture shared byte for byte with saltapp-python. */
export type DeviceUnsolicitedOp = "still" | "pointed";
export const DEVICE_UNSOLICITED_OPS: readonly DeviceUnsolicitedOp[] = ["still", "pointed"];

/** Commands an agent sends to a device. */
export type DeviceOp =
  | "observe"
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "submit" // accessibility confirm of a named element; never a keystroke
  | "focus_app"
  | "list_apps"
  | "read_file"
  | "write_file"
  | "task" // hand the computer ONE whole task; it answers `progress` (non-final) then `task_result`
  | "stop"
  | "cancel" // drop the not-yet-started command named by body `{id}` (or header `re`), or abort a running task; consumes no seq
  | "shell"; // reserved; the server refuses device.shell in P0 and a host answers `forbidden`.

/** Results a device sends back to an agent. */
export type DeviceResultOp =
  | "ack"
  | "observation"
  | "apps"
  | "file"
  | "ask"
  | "error"
  | "ended"
  | "progress" // NON-final: one line of a running task, same `re` as the task
  | "task_result"; // the final answer to a `task`

export const AGENT_OPS: readonly DeviceOp[] = [
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
];

export const DEVICE_RESULT_OPS: readonly DeviceResultOp[] = [
  "ack",
  "observation",
  "apps",
  "file",
  "ask",
  "error",
  "ended",
  "progress",
  "task_result",
];

/** Error codes a device may answer with (DEVICE_PROTOCOL.md). */
export type DeviceErrorCode =
  | "forbidden" // the op is never allowed (e.g. shell) or hits the never-allowed floor
  | "out_of_scope" // the mandate's selector/caps do not cover this
  | "needs_approval" // mode is `ask` and the person has not approved at the machine
  | "unsupported" // unknown `v` or `op`
  | "out_of_order" // `seq` gap or not strictly increasing
  | "bad_args" // malformed args
  | "too_large" // payload over MAX_DEVICE_PLAINTEXT_BYTES
  | "busy" // rate limit hit
  | "clock_skew" // `exp` is further ahead than a command may live: the sender's clock is behind. Body carries the device's `now`
  | "expired" // the command's `exp` passed before it started; not executed
  | "paused" // the person (or a secure field) has the device; not executed. Body carries `reason`
  | "failed"; // the handler ran and failed

export const DEVICE_ERROR_CODES: readonly DeviceErrorCode[] = [
  "forbidden",
  "out_of_scope",
  "needs_approval",
  "unsupported",
  "out_of_order",
  "bad_args",
  "too_large",
  "busy",
  "expired",
  "clock_skew",
  "paused",
  "failed",
];

/** The `device.*` mandate capability each agent op requires. `stop` needs
 *  none. `shell` maps to the reserved `device.shell`, which the server refuses
 *  in P0, so a host answers it `forbidden` without consulting scope. */
export const CAPABILITY_FOR_OP: Record<DeviceOp, string | null> = {
  observe: "device.observe",
  click: "device.act",
  type: "device.act",
  key: "device.act",
  scroll: "device.act",
  submit: "device.act",
  focus_app: "device.apps",
  list_apps: "device.apps",
  read_file: "device.files.read",
  write_file: "device.files.write",
  task: "device.task",
  stop: null,
  cancel: null,
  shell: "device.shell",
};

/** The per-class count a device reports to the server (never content). A
 *  `stop` or an op that errors before running maps to `error` or nothing; the
 *  host decides. */
export type DeviceCountClass =
  | "observe"
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "file_read"
  | "file_write"
  | "app_focus"
  | "task" // one whole task handed to the computer
  | "command" // one command a task ran
  | "look" // one screenshot a task took
  | "error";

export const DEVICE_COUNT_CLASSES: readonly DeviceCountClass[] = [
  "observe",
  "click",
  "type",
  "key",
  "scroll",
  "file_read",
  "file_write",
  "app_focus",
  "task",
  "command",
  "look",
  "error",
];

/** Map a successfully-run op to the metadata class it increments. `list_apps`
 *  and `focus_app` both count as `app_focus`; file ops split read/write;
 *  `stop`/`shell` have no count. Returns null when nothing should be counted. */
export function countClassForOp(op: DeviceOp): DeviceCountClass | null {
  switch (op) {
    case "observe":
      return "observe";
    case "click":
      return "click";
    case "type":
      return "type";
    case "key":
      return "key";
    case "scroll":
      return "scroll";
    case "submit": // a confirm is a press of a control: counted with clicks
      return "click";
    case "read_file":
      return "file_read";
    case "write_file":
      return "file_write";
    case "focus_app":
    case "list_apps":
      return "app_focus";
    case "task":
      return "task";
    case "stop":
    case "cancel":
    case "shell":
      return null;
  }
}

// ---- argument / result body shapes -----------------------------------------

export interface ObserveArgs {
  target: "screen" | "window";
  display?: number;
  window?: string;
  max_width?: number;
  format?: "png" | "jpeg";
  /** Which representation the agent wants back. The device PREFERS and defaults
   *  to `ui` (a structured snapshot): it is smaller, machine-readable, auditable
   *  and does not read pixels. `pixels` asks for a rendered image (the raw
   *  framebuffer path) and `both` asks for a tree with an image beside it; a
   *  device may still answer `ui` only if its pixel primitive is absent. */
  want?: "ui" | "pixels" | "both";
}
export interface ElementRef {
  /** The observation id these coordinates / this node were read from. */
  obs: string;
  /** A `UiNode.id` within that observation. Present for a SEMANTIC action
   *  (invoke / set value / focus the named element); absent for a raw
   *  coordinate action. */
  node: string;
}
export interface ClickArgs {
  x: number;
  y: number;
  button?: "left" | "right";
  count?: 1 | 2;
  obs?: string; // the observation these coordinates were read from
  /** When present, the device performs the SEMANTIC action on this element
   *  (its accessibility `press`), not a coordinate click. Preferred: it is
   *  robust to layout and logs the element, not an (x,y). x/y remain the
   *  fallback for elements the tree cannot name (a canvas, a custom view). */
  element?: ElementRef;
}
export interface TypeArgs {
  text: string;
  /** When present, set the value of / type into this named field via the
   *  accessibility layer, rather than typing at whatever currently has focus. */
  into?: ElementRef;
}
export interface SubmitArgs {
  /** The named field (or form control) to confirm through the accessibility layer. */
  element: ElementRef;
}
export interface KeyArgs {
  keys: string[];
}
export interface ScrollArgs {
  x: number;
  y: number;
  dx: number;
  dy: number;
}
export interface FocusAppArgs {
  app: string;
}
export interface ReadFileArgs {
  path: string;
}
export interface WriteFileArgs {
  path: string;
  content_b64: string;
}

/** One node of a structured UI snapshot: a window, a control, a menu item.
 *  This is what the PREFERRED observe path returns instead of pixels — the UI
 *  as the operating system's own accessibility layer already describes it. */
export interface UiNode {
  /** Stable within THIS observation, so a later semantic action can name it
   *  (ElementRef.node). Not stable across observations. */
  id: string;
  /** The accessibility role: "window", "button", "textfield", "menuitem", ... */
  role: string;
  /** The accessible label / title, when the element has one. */
  name?: string;
  /** The current value (a text field's contents, a slider's position, ...). A
   *  redaction pass blanks this for anything the floor must never reveal. */
  value?: string;
  /** Screen bounds, so the agent can still reason spatially and so a raw
   *  fallback action has coordinates if the semantic one is unavailable. */
  bounds?: { x: number; y: number; w: number; h: number };
  /** The owning app's bundle id / exe name. */
  app?: string;
  /** The semantic actions this element supports, e.g. ["press","setValue"]. */
  actions?: string[];
  children?: UiNode[];
}
export interface UiSnapshot {
  /** The frontmost app at capture time (bundle id / exe). */
  app?: string;
  /** The frontmost window's title. */
  window?: string;
  root: UiNode;
}
/** The result of an `observe`. It carries a structured `ui` snapshot and/or a
 *  rendered image. The device prefers `ui`; `image_b64` and its size fields are
 *  present only when pixels were asked for (`want:"pixels"|"both"`) or the tree
 *  alone could not answer. At least one of `ui` / `image_b64` is always set. */
export interface ObservationResult {
  obs: string;
  ui?: UiSnapshot;
  width?: number;
  height?: number;
  scale?: number;
  format?: "png" | "jpeg";
  image_b64?: string;
}
export interface AppsResult {
  apps: Array<{ id: string; name: string; frontmost: boolean }>;
}
export interface FileResult {
  path: string;
  size: number;
  content_b64: string;
}
export interface DeviceAskResult {
  reason: string;
}
export interface ErrorResult {
  code: DeviceErrorCode;
  message?: string;
  /** `out_of_order`, `expired`, `paused`: the seq the host will accept next. */
  expected_seq?: number;
  /** `paused`: why. */
  reason?: DevicePauseReason;
  /** `clock_skew`, `expired`: the device's clock (ms since epoch). */
  now?: number;
}
export interface EndedResult {
  reason: string;
}

// ---- a whole task (op `task`, capability `device.task`) ---------------------
// The agent hands the computer ONE job in plain words; a local agent on the
// device does it (commands, screenshots, the screen reader, input), checks it,
// and answers with a checked receipt. Command output and screenshots never
// leave the computer: a TaskResult carries words and numbers only.

/** Caps on what a task may say. The agent's side checks the same ones on what it
 *  receives, so neither end trusts the other's limits. */
export const TASK_GOAL_MAX = 2000;
export const TASK_DONE_WHEN_MAX = 500;
export const TASK_MAX_STEPS_MIN = 1;
export const TASK_MAX_STEPS_MAX = 60;
export const TASK_MAX_STEPS_DEFAULT = 30;
export const TASK_TIMEOUT_S_MIN = 10;
export const TASK_TIMEOUT_S_MAX = 600;
export const TASK_TIMEOUT_S_DEFAULT = 180;
export const PROGRESS_LINE_MAX = 140;
export const TASK_SUMMARY_MAX = 500;
export const TASK_STEP_LINE_MAX = 140;
export const TASK_RESULT_STEPS_MAX = 60;
export const TASK_CHECKED_WHAT_MAX = 200;
export const TASK_ID_MAX = 64;
/** The device sends `progress` at most this often (the host throttles). */
export const PROGRESS_MIN_INTERVAL_MS = 2_000;
/** A task's command deadline on the device is `timeout_s` + this, not COMMAND_TTL_MS. */
export const TASK_DEVICE_GRACE_MS = 15_000;
/** The agent waits `timeout_s` + this for the result before it cancels. */
export const TASK_CLIENT_GRACE_MS = 30_000;

export interface TaskArgs {
  /** What the person asked for, in plain words. 1..2000 characters. */
  goal: string;
  /** How the device should check it worked. At most 500 characters. */
  done_when?: string;
  /** 1..60, default 30. */
  max_steps?: number;
  /** Seconds, 10..600, default 180. */
  timeout_s?: number;
}

/** One non-final line of a running task. `waiting` is true while a person is being asked. */
export interface Progress {
  step: number;
  of?: number;
  line: string;
  waiting?: boolean;
}

export type TaskStatus = "done" | "failed" | "stopped" | "denied" | "timeout" | "paused_out";
export const TASK_STATUSES: readonly TaskStatus[] = ["done", "failed", "stopped", "denied", "timeout", "paused_out"];

export type TaskStepKind = "command" | "look" | "observe" | "act" | "apps" | "ask" | "check";
export const TASK_STEP_KINDS: readonly TaskStepKind[] = ["command", "look", "observe", "act", "apps", "ask", "check"];

export interface TaskStep {
  n: number;
  kind: TaskStepKind;
  /** A command's text may appear here, truncated; its output never does. */
  line: string;
  ok: boolean;
}

export interface TaskResult {
  /** The device's local record id (`t_<hex>`). */
  task_id: string;
  status: TaskStatus;
  /** One or two plain sentences, at most 500 characters. */
  summary: string;
  checked: { ok: boolean; what: string } | null;
  steps: TaskStep[];
  commands: number;
  duration_ms: number;
}

// A cap counts characters as people do (Unicode code points), not UTF-16 units, so an emoji
// is never cut in half and the Python SDK (which counts code points) reads the same limits.
function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s; // code points <= UTF-16 units: certainly within the cap
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function wholeNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isInteger(x) ? x : null;
}

/** The task arguments, checked and with defaults filled in; unknown keys are dropped.
 *  A goal that is missing, empty or over 2000 characters, or a `done_when` over 500, is
 *  `bad_args` (the sender fixes the words; nothing is cut off silently). `max_steps` and
 *  `timeout_s` must be whole numbers and are clamped into their range. Throws
 *  DeviceProtocolError("bad_args"). Used by the agent before it sends and by the device
 *  before it runs. */
export function parseTaskArgs(body: unknown): TaskArgs & { max_steps: number; timeout_s: number } {
  if (!isRecord(body)) throw new DeviceProtocolError("bad_args", "task needs a goal");
  const { goal, done_when, max_steps, timeout_s } = body;
  if (typeof goal !== "string" || goal.trim().length === 0) throw new DeviceProtocolError("bad_args", "goal must be a non-empty string");
  if (charCount(goal) > TASK_GOAL_MAX) throw new DeviceProtocolError("bad_args", `goal is over ${TASK_GOAL_MAX} characters`);
  let doneWhen: string | undefined;
  if (done_when !== undefined && done_when !== null) {
    if (typeof done_when !== "string") throw new DeviceProtocolError("bad_args", "done_when must be a string");
    if (charCount(done_when) > TASK_DONE_WHEN_MAX) throw new DeviceProtocolError("bad_args", `done_when is over ${TASK_DONE_WHEN_MAX} characters`);
    doneWhen = done_when;
  }
  let steps = TASK_MAX_STEPS_DEFAULT;
  if (max_steps !== undefined && max_steps !== null) {
    const n = wholeNumber(max_steps);
    if (n === null) throw new DeviceProtocolError("bad_args", "max_steps must be a whole number");
    steps = Math.min(TASK_MAX_STEPS_MAX, Math.max(TASK_MAX_STEPS_MIN, n));
  }
  let timeout = TASK_TIMEOUT_S_DEFAULT;
  if (timeout_s !== undefined && timeout_s !== null) {
    const n = wholeNumber(timeout_s);
    if (n === null) throw new DeviceProtocolError("bad_args", "timeout_s must be a whole number");
    timeout = Math.min(TASK_TIMEOUT_S_MAX, Math.max(TASK_TIMEOUT_S_MIN, n));
  }
  const out: TaskArgs & { max_steps: number; timeout_s: number } = { goal, max_steps: steps, timeout_s: timeout };
  if (doneWhen !== undefined && doneWhen !== "") out.done_when = doneWhen;
  return out;
}

/** The wire body of a `task` command: only the fields that were given. */
export function taskCommandBody(goal: string, opts: { doneWhen?: string; maxSteps?: number; timeoutS?: number } = {}): TaskArgs {
  const raw: Record<string, unknown> = { goal };
  if (opts.doneWhen !== undefined) raw.done_when = opts.doneWhen;
  if (opts.maxSteps !== undefined) raw.max_steps = opts.maxSteps;
  if (opts.timeoutS !== undefined) raw.timeout_s = opts.timeoutS;
  const p = parseTaskArgs(raw); // refuses what the device would refuse
  const out: TaskArgs = { goal: p.goal };
  if (p.done_when !== undefined) out.done_when = p.done_when;
  if (opts.maxSteps !== undefined) out.max_steps = p.max_steps;
  if (opts.timeoutS !== undefined) out.timeout_s = p.timeout_s;
  return out;
}

/** A `progress` body, allow-listed with the caps applied; null when it is not one (no
 *  usable `step` or `line`). Nothing but `step`, `of`, `line` and `waiting` gets through. */
export function normalizeProgress(raw: unknown): Progress | null {
  if (!isRecord(raw)) return null;
  const step = wholeNumber(raw.step);
  if (step === null || step < 0 || typeof raw.line !== "string") return null;
  const out: Progress = { step, line: clip(raw.line, PROGRESS_LINE_MAX) };
  const of = wholeNumber(raw.of);
  if (of !== null && of >= 1) out.of = of;
  if (typeof raw.waiting === "boolean") out.waiting = raw.waiting;
  return out;
}

/** A fresh local task id, `t_<hex>`. */
export function newTaskId(rand: () => number = Math.random): string {
  let hex = "";
  for (let i = 0; i < 12; i++) hex += Math.floor(rand() * 16).toString(16);
  return `t_${hex}`;
}

/** A `task_result` body, allow-listed field by field with type checks and caps. Used by the
 *  device on what its handler returned and by the agent on what the device sent, so extra
 *  fields never travel and a malformed one becomes a safe default rather than a throw:
 *  an unknown `status` reads `failed`, `steps` keeps the first 60 valid rows, strings are cut
 *  to their caps, numbers must be whole and non-negative. `fallback` fills what is missing. */
export function normalizeTaskResult(raw: unknown, fallback: { task_id?: string; duration_ms?: number } = {}): TaskResult {
  const r = isRecord(raw) ? raw : {};
  const task_id = typeof r.task_id === "string" && r.task_id.length > 0 ? clip(r.task_id, TASK_ID_MAX) : (fallback.task_id ?? newTaskId());
  const status = TASK_STATUSES.includes(r.status as TaskStatus) ? (r.status as TaskStatus) : "failed";
  const summary = typeof r.summary === "string" ? clip(r.summary, TASK_SUMMARY_MAX) : "";
  let checked: TaskResult["checked"] = null;
  if (isRecord(r.checked) && typeof r.checked.ok === "boolean") {
    checked = { ok: r.checked.ok, what: typeof r.checked.what === "string" ? clip(r.checked.what, TASK_CHECKED_WHAT_MAX) : "" };
  }
  const steps: TaskStep[] = [];
  if (Array.isArray(r.steps)) {
    for (const s of r.steps) {
      if (steps.length >= TASK_RESULT_STEPS_MAX) break;
      if (!isRecord(s) || !TASK_STEP_KINDS.includes(s.kind as TaskStepKind) || typeof s.line !== "string") continue;
      const n = wholeNumber(s.n);
      steps.push({
        n: n !== null && n >= 0 ? n : steps.length + 1,
        kind: s.kind as TaskStepKind,
        line: clip(s.line, TASK_STEP_LINE_MAX),
        ok: s.ok === true,
      });
    }
  }
  const commands = wholeNumber(r.commands);
  const duration = wholeNumber(r.duration_ms);
  return {
    task_id,
    status,
    summary,
    checked,
    steps,
    commands: commands !== null && commands >= 0 ? commands : 0,
    duration_ms: duration !== null && duration >= 0 ? duration : (fallback.duration_ms ?? 0),
  };
}

// ---- the marker -------------------------------------------------------------

export interface DeviceHeader {
  v: number;
  id: string;
  seq: number;
  op: string;
  session: string;
  re?: string;
  /** Expiry, epoch milliseconds. Commands only; absent = never expires. */
  exp?: number;
}

export interface DeviceMessage {
  header: DeviceHeader;
  /** The JSON body, or `undefined` when the marker stood alone. */
  body?: unknown;
}

const MARKER_RE =
  /^\[\[SALT-DEVICE ((?:[a-z_]+=[^\s\]]+ ?)+)\]\]\s*([\s\S]*)$/;

/** Turn a header + optional body into the plaintext of one lane message. The
 *  caller encrypts the returned string for the lane readers and posts it. */
export function encodeDeviceMessage(header: DeviceHeader, body?: unknown): string {
  const parts = [
    `v=${header.v}`,
    `id=${header.id}`,
    `seq=${header.seq}`,
    `op=${header.op}`,
    `session=${header.session}`,
  ];
  if (header.re !== undefined) parts.push(`re=${header.re}`);
  if (header.exp !== undefined) parts.push(`exp=${header.exp}`);
  const marker = `[[SALT-DEVICE ${parts.join(" ")}]]`;
  if (body === undefined) return marker;
  return `${marker}\n${JSON.stringify(body)}`;
}

/** Parse the decrypted plaintext of a lane message. Returns the header + body,
 *  or `null` when the text is not a device message at all (it may be a plain
 *  chat line, which the caller ignores). Throws only on a message that LOOKS
 *  like one but is structurally broken, so the caller can answer `bad_args`. */
export function decodeDeviceMessage(plaintext: string): DeviceMessage | null {
  const trimmed = plaintext.trimStart();
  if (!trimmed.startsWith("[[SALT-DEVICE")) return null;
  const m = MARKER_RE.exec(trimmed);
  if (!m) throw new DeviceProtocolError("bad_args", "malformed SALT-DEVICE marker");

  const fields: Record<string, string> = {};
  for (const pair of m[1].trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq === -1) throw new DeviceProtocolError("bad_args", `bad marker field: ${pair}`);
    fields[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  for (const required of ["v", "id", "seq", "op", "session"]) {
    if (fields[required] === undefined) {
      throw new DeviceProtocolError("bad_args", `marker missing ${required}`);
    }
  }

  const v = Number(fields.v);
  const seq = Number(fields.seq);
  if (!Number.isInteger(v) || !Number.isInteger(seq) || seq < 1) {
    throw new DeviceProtocolError("bad_args", "v and seq must be positive integers");
  }

  const header: DeviceHeader = {
    v,
    id: fields.id,
    seq,
    op: fields.op,
    session: fields.session,
  };
  if (fields.re !== undefined) header.re = fields.re;
  if (fields.exp !== undefined) {
    const exp = Number(fields.exp);
    if (!Number.isFinite(exp)) throw new DeviceProtocolError("bad_args", "exp must be a number");
    header.exp = exp;
  }

  const rest = m[2];
  let body: unknown;
  if (rest.trim().length > 0) {
    try {
      body = JSON.parse(rest);
    } catch {
      throw new DeviceProtocolError("bad_args", "SALT-DEVICE body is not JSON");
    }
  }

  return { header, body };
}

export class DeviceProtocolError extends Error {
  readonly code: DeviceErrorCode;
  constructor(code: DeviceErrorCode, message?: string) {
    super(message ?? code);
    this.name = "DeviceProtocolError";
    this.code = code;
  }
}

// ---- a tiny ULID (time-sortable, opaque to the server) ----------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID-shaped id for a command. The server treats it as an opaque token;
 *  the only property code here relies on is uniqueness. Sortable by time is a
 *  convenience for logs and nothing more (ordering is enforced by `seq`). */
export function deviceMessageId(now: number = Date.now(), rand: () => number = Math.random): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let randPart = "";
  for (let i = 0; i < 16; i++) {
    randPart += CROCKFORD[Math.floor(rand() * 32)];
  }
  return time + randPart;
}

// ---- Show Me: stills and points (CONTRACT.md section 3) ---------------------

/** The device posts at most one still every 2 s, and at most 30 a minute per lane. */
export const STILL_MIN_INTERVAL_MS = 2_000;
export const STILL_MAX_PER_MINUTE = 30;
/** A person's optional words on a point. */
export const POINT_WORDS_MAX = 200;
/** Longest id a SALT-POINT header field may carry (help id, obs id, point id). */
export const POINT_ID_MAX = 64;
/** `pointed.words` is the point's words, same cap. */
export const POINTED_NAME_MAX = 200;

export interface StillBody {
  help_id: string;
  /** The observation id of this picture; a person's point names it back. */
  obs: string;
  width: number;
  height: number;
  scale: number;
  format: "jpeg" | "png";
  image_b64: string;
  /** ISO8601. */
  taken_at: string;
}

export type PointedRefusal = "forbidden_app" | "secure_field" | "stale" | "not_allowed";
export const POINTED_REFUSALS: readonly PointedRefusal[] = ["forbidden_app", "secure_field", "stale", "not_allowed"];

export interface PointedElement {
  role: string;
  subrole: string | null;
  name: string | null;
  value: string | null;
  bounds: { x: number; y: number; w: number; h: number };
}

export interface PointedBody {
  help_id: string;
  x: number;
  y: number;
  /** The spot in screen coordinates. */
  screen: { x: number; y: number };
  app: string | null;
  /** Null when nothing is named under the point, or when the answer was refused. */
  element: PointedElement | null;
  refused: PointedRefusal | null;
  words: string;
}

/** A still body, allow-listed with types checked; null when it is not one. Used by the agent
 *  on what a device sent. Extra fields are dropped. */
export function normalizeStill(raw: unknown): StillBody | null {
  if (!isRecord(raw)) return null;
  const { help_id, obs, width, height, scale, format, image_b64, taken_at } = raw;
  if (typeof help_id !== "string" || help_id === "" || typeof obs !== "string" || obs === "") return null;
  if (format !== "jpeg" && format !== "png") return null;
  if (typeof image_b64 !== "string" || image_b64 === "") return null;
  const w = wholeNumber(width);
  const h = wholeNumber(height);
  if (w === null || h === null || w < 1 || h < 1) return null;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) return null;
  return { help_id, obs, width: w, height: h, scale, format, image_b64, taken_at: typeof taken_at === "string" ? taken_at : "" };
}

function finite(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** A `pointed` body, allow-listed field by field; null when it is not one. A refused answer
 *  never carries an element, whatever the sender put there. */
export function normalizePointed(raw: unknown): PointedBody | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.help_id !== "string" || raw.help_id === "") return null;
  const x = finite(raw.x);
  const y = finite(raw.y);
  if (x === null || y === null || x < 0 || x > 1 || y < 0 || y > 1) return null;
  const sx = isRecord(raw.screen) ? finite(raw.screen.x) : null;
  const sy = isRecord(raw.screen) ? finite(raw.screen.y) : null;
  if (sx === null || sy === null) return null;
  const refused = POINTED_REFUSALS.includes(raw.refused as PointedRefusal) ? (raw.refused as PointedRefusal) : null;
  let element: PointedElement | null = null;
  if (refused === null && isRecord(raw.element) && typeof raw.element.role === "string") {
    const e = raw.element;
    const b = isRecord(e.bounds) ? e.bounds : {};
    element = {
      role: clip(e.role as string, 80),
      subrole: typeof e.subrole === "string" ? clip(e.subrole, 80) : null,
      name: typeof e.name === "string" ? clip(e.name, POINTED_NAME_MAX) : null,
      value: typeof e.value === "string" ? clip(e.value, POINTED_NAME_MAX) : null,
      bounds: { x: finite(b.x) ?? 0, y: finite(b.y) ?? 0, w: finite(b.w) ?? 0, h: finite(b.h) ?? 0 },
    };
  }
  return {
    help_id: raw.help_id,
    x,
    y,
    screen: { x: sx, y: sy },
    app: typeof raw.app === "string" ? clip(raw.app, 200) : null,
    element,
    refused,
    words: typeof raw.words === "string" ? clip(raw.words, POINT_WORDS_MAX) : "",
  };
}

/** One point a person made on a still (or, live, on the call's frame). */
export interface PointMessage {
  v: number;
  /** The help request this point answers. */
  help: string;
  /** The still it was made on; absent means the live frame. */
  obs?: string;
  /** Fractions of the picture, 0..1. */
  x: number;
  y: number;
  /** A fresh id per point; the device answers each id once. */
  id: string;
  words: string;
}

const POINT_MARKER_RE = /^\[\[SALT-POINT ((?:[a-z_]+=[^\s\]]+ ?)+)\]\]([\s\S]*)$/;
const POINT_TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 0..1 with at most four decimals: "0", "1", "0.5", "0.6012", "1.0".
const POINT_FRACTION_RE = /^(?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?)$/;

/** True when the text opens with the SALT-POINT marker (well formed or not). */
export function isPointMessage(plaintext: string): boolean {
  return plaintext.trimStart().startsWith("[[SALT-POINT");
}

function fraction(n: number, what: string): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1) {
    throw new DeviceProtocolError("bad_args", `${what} must be between 0 and 1`);
  }
  return n.toFixed(4);
}

/** The plaintext of a point. `x` and `y` are written with four decimals. Throws
 *  DeviceProtocolError("bad_args") on an out-of-range fraction, a bad id, or words over 200
 *  characters (nothing is cut off silently). */
export function encodePoint(p: { help: string; obs?: string; x: number; y: number; id: string; words?: string }): string {
  for (const [what, val] of [["help", p.help], ["id", p.id], ...(p.obs !== undefined ? [["obs", p.obs]] : [])] as Array<[string, string]>) {
    if (typeof val !== "string" || !POINT_TOKEN_RE.test(val)) throw new DeviceProtocolError("bad_args", `${what} is not a valid id`);
  }
  const words = p.words ?? "";
  if (typeof words !== "string" || charCount(words) > POINT_WORDS_MAX) {
    throw new DeviceProtocolError("bad_args", `words are over ${POINT_WORDS_MAX} characters`);
  }
  const parts = [`v=${DEVICE_PROTOCOL_VERSION}`, `help=${p.help}`];
  if (p.obs !== undefined) parts.push(`obs=${p.obs}`);
  parts.push(`x=${fraction(p.x, "x")}`, `y=${fraction(p.y, "y")}`, `id=${p.id}`);
  const marker = `[[SALT-POINT ${parts.join(" ")}]]`;
  return words === "" ? marker : `${marker}\n${words}`;
}

/** Parse the decrypted plaintext of a lane message. Returns null when it is not a point at
 *  all. Throws DeviceProtocolError("bad_args") on a message that opens with the marker but
 *  is broken: a wrong version, a missing field, an x or y outside 0..1 (or with more than
 *  four decimals), a bad id, or words over 200 characters. */
export function decodePoint(plaintext: string): PointMessage | null {
  const trimmed = plaintext.trimStart();
  if (!trimmed.startsWith("[[SALT-POINT")) return null;
  const m = POINT_MARKER_RE.exec(trimmed);
  if (!m) throw new DeviceProtocolError("bad_args", "malformed SALT-POINT marker");
  const fields: Record<string, string> = {};
  for (const pair of m[1].trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq === -1) throw new DeviceProtocolError("bad_args", `bad marker field: ${pair}`);
    const k = pair.slice(0, eq);
    if (k in fields) throw new DeviceProtocolError("bad_args", `repeated marker field: ${k}`);
    fields[k] = pair.slice(eq + 1);
  }
  for (const required of ["v", "help", "x", "y", "id"]) {
    if (fields[required] === undefined) throw new DeviceProtocolError("bad_args", `marker missing ${required}`);
  }
  if (fields.v !== String(DEVICE_PROTOCOL_VERSION)) throw new DeviceProtocolError("unsupported", `unsupported SALT-POINT version ${fields.v}`);
  for (const k of ["help", "id", ...(fields.obs !== undefined ? ["obs"] : [])]) {
    if (!POINT_TOKEN_RE.test(fields[k])) throw new DeviceProtocolError("bad_args", `${k} is not a valid id`);
  }
  if (!POINT_FRACTION_RE.test(fields.x) || !POINT_FRACTION_RE.test(fields.y)) {
    throw new DeviceProtocolError("bad_args", "x and y must be between 0 and 1 with at most four decimals");
  }
  const words = m[2].replace(/^\r?\n/, "").trim();
  if (charCount(words) > POINT_WORDS_MAX) throw new DeviceProtocolError("bad_args", `words are over ${POINT_WORDS_MAX} characters`);
  const out: PointMessage = { v: DEVICE_PROTOCOL_VERSION, help: fields.help, x: Number(fields.x), y: Number(fields.y), id: fields.id, words };
  if (fields.obs !== undefined) out.obs = fields.obs;
  return out;
}
