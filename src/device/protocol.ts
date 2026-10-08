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

/** Commands an agent sends to a device. */
export type DeviceOp =
  | "observe"
  | "click"
  | "type"
  | "key"
  | "scroll"
  | "focus_app"
  | "list_apps"
  | "read_file"
  | "write_file"
  | "stop"
  | "shell"; // reserved; the server refuses device.shell in P0 and a host answers `forbidden`.

/** Results a device sends back to an agent. */
export type DeviceResultOp =
  | "ack"
  | "observation"
  | "apps"
  | "file"
  | "ask"
  | "error"
  | "ended";

export const AGENT_OPS: readonly DeviceOp[] = [
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
  focus_app: "device.apps",
  list_apps: "device.apps",
  read_file: "device.files.read",
  write_file: "device.files.write",
  stop: null,
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
    case "read_file":
      return "file_read";
    case "write_file":
      return "file_write";
    case "focus_app":
    case "list_apps":
      return "app_focus";
    case "stop":
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
}
export interface ClickArgs {
  x: number;
  y: number;
  button?: "left" | "right";
  count?: 1 | 2;
  obs?: string; // the observation these coordinates were read from
}
export interface TypeArgs {
  text: string;
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

export interface ObservationResult {
  obs: string;
  width: number;
  height: number;
  scale: number;
  format: "png" | "jpeg";
  image_b64: string;
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
}
export interface EndedResult {
  reason: string;
}

// ---- the marker -------------------------------------------------------------

export interface DeviceHeader {
  v: number;
  id: string;
  seq: number;
  op: string;
  session: string;
  re?: string;
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
