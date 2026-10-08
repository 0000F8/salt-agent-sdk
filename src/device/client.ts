// The AGENT side of device control: createDeviceClient.
//
// It opens a control session on a device the agent holds a `device.*` mandate
// for, then sends commands (observe / click / type / ...) and awaits the
// device's results. It NEVER contacts the device directly and never learns
// more than the lane carries: every command is the plaintext of a lane message
// the transport encrypts for the lane readers and posts; every result is a
// lane message the dispatcher decrypts and feeds back in here.
//
// This module is transport-agnostic on purpose (DEVICE_PROTOCOL.md / the P1
// contract: "Pure, injected transports, fakes in tests"). The REST calls and
// the encrypt-and-post are injected as `DeviceClientTransport`; httpDevice
// Transport (below) wires them to a real SaltClient, and tests pass a fake.
//
// What it does NOT do: capture a screen or synthesise input. Those live only
// on the device, behind the host's injected handlers. This side just asks.

import {
  CAPABILITY_FOR_OP,
  COMMAND_TTL_MS,
  DeviceProtocolError,
  DEVICE_PROTOCOL_VERSION,
  deviceMessageId,
  decodeDeviceMessage,
  encodeDeviceMessage,
  type ClickArgs,
  type DeviceErrorCode,
  type DeviceOp,
  type DevicePauseReason,
  type DeviceResultOp,
  type ErrorResult,
  type FileResult,
  type KeyArgs,
  type ObservationResult,
  type ObserveArgs,
  type ScrollArgs,
  type AppsResult,
} from "./protocol.js";
import { sameId, type SaltId } from "../ids.js";

/** Who the lane messages must be encrypted for: every reader's armored public
 *  key. Carried by the `device_session_active` delivery. */
export interface LaneReaders {
  chatId: SaltId;
  publicKeys: string[];
}

export type DeviceSessionStatus = "queued" | "requested" | "active" | "paused" | "ended";

export interface DeviceSessionMeta {
  id: SaltId;
  device_id: SaltId;
  agent_id: SaltId;
  mandate_id: SaltId;
  status: DeviceSessionStatus;
  /** `queued` only: 1-based place in the device's queue. */
  position?: number;
  /** `paused` only. */
  pause_reason?: DevicePauseReason;
  chat?: { id: SaltId; readers: string[] };
}

/** Thrown by a transport's openSession on `409 {code:"session_live", session_id}`:
 *  this agent already has a live session on the device. open() reattaches. */
export class DeviceSessionLiveError extends Error {
  readonly sessionId: SaltId;
  constructor(sessionId: SaltId) {
    super("session_live");
    this.name = "DeviceSessionLiveError";
    this.sessionId = sessionId;
  }
}

/** A command was refused (or not sent) because the session is paused: the
 *  person is using the machine, or a secure field needs them. Wait for the
 *  `resumed` state (onState) and try again. */
export class DevicePausedError extends DeviceProtocolError {
  readonly reason: DevicePauseReason;
  constructor(reason: DevicePauseReason) {
    super("paused", `device session paused: ${reason}`);
    this.name = "DevicePausedError";
    this.reason = reason;
  }
}

/** What onState emits. */
export type DeviceState =
  | { state: "queued"; position: number }
  | { state: "requested" }
  | { state: "active" }
  | { state: "paused"; reason: DevicePauseReason }
  | { state: "resumed" }
  | { state: "ended"; reason: string };

/** The injected transport. httpDeviceTransport provides a real one. */
export interface DeviceClientTransport {
  /** POST /api/v1/devices/:id/sessions -> the created session: status
   *  `requested` (device must approve locally), `active`, or `queued` (202,
   *  another agent controls the device). Throws DeviceSessionLiveError on a 409
   *  `session_live`. */
  openSession(deviceId: SaltId): Promise<DeviceSessionMeta>;
  /** POST /api/v1/device_sessions/:sid/reattach -> {session, last_seq}. */
  reattachSession?(sessionId: SaltId): Promise<{ session: DeviceSessionMeta; last_seq: number }>;
  /** GET /api/v1/device_sessions/:sid; used only to learn the lane readers when
   *  a promotion delivery did not carry them. */
  fetchSession?(sessionId: SaltId): Promise<DeviceSessionMeta>;
  /** POST /api/v1/device_sessions/:sid/stop (subtract-only, idempotent). */
  stopSession(sessionId: SaltId): Promise<void>;
  /** Encrypt `plaintext` for the current lane readers and POST it as one lane
   *  message. The transport owns the crypto and the readers; this module only
   *  decides the plaintext. */
  postCommand(plaintext: string, readers: LaneReaders): Promise<void>;
}

export interface DeviceClientOptions {
  /** How long a session may sit in `requested` (waiting for the device's local
   *  approval) before open() gives up. Does not run while `queued`. The server
   *  ends an unanswered request after 2 minutes with `request_expired`;
   *  default here is a touch longer so the server's own end reaches us first. */
  approvalTimeoutMs?: number;
  /** Per-command timeout waiting for a result. Default 30s. On timeout the
   *  client sends `cancel {id}`. */
  commandTimeoutMs?: number;
  /** How long a command stays valid (header `exp`). Default COMMAND_TTL_MS. */
  commandTtlMs?: number;
}

export interface DeviceResult {
  op: DeviceResultOp;
  body: unknown;
}

type Pending = {
  resolve: (r: DeviceResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Listener = (...args: unknown[]) => void;

class CommandTimeout extends Error {}

export interface DeviceClient {
  /** Open a session. By default resolves when it is `active`, waiting through
   *  `queued` (another agent controls the device) and `requested` (the device's
   *  local approval) on `device_session` deliveries, never polling. Rejects if
   *  the device declines, the request expires, or the mandate is gone. With
   *  `{wait: false}` it returns at once with the state the server answered
   *  (e.g. `queued` with `position`); watch onState for the rest. If this
   *  agent already has a live session on the device (409 session_live) it
   *  reattaches and continues at last_seq + 1. */
  open(opts?: { wait?: boolean }): Promise<DeviceSessionMeta>;
  observe(args?: ObserveArgs): Promise<ObservationResult>;
  click(args: ClickArgs): Promise<void>;
  type(text: string): Promise<void>;
  key(keys: string[]): Promise<void>;
  scroll(args: ScrollArgs): Promise<void>;
  focusApp(app: string): Promise<void>;
  listApps(): Promise<AppsResult>;
  readFile(path: string): Promise<FileResult>;
  writeFile(path: string, contentB64: string): Promise<void>;
  /** End the session (subtract-only). Safe to call more than once. */
  stop(): Promise<void>;
  /** The live session metadata, or null before open() / after it ended. */
  session(): DeviceSessionMeta | null;
  /** The pause reason while paused, else null. */
  pausedReason(): DevicePauseReason | null;
  /** Feed a `device_session` socket delivery in (promoted / queue_moved /
   *  paused / resumed / ended, and the legacy active / ended types). The
   *  consumer calls this from its dispatcher. */
  handleDelivery(event: string, body: unknown): void;
  /** Feed a decrypted lane message in (a result the device posted). Returns
   *  true if it was a device result this client consumed. */
  handleLaneMessage(plaintext: string): boolean;
  on(event: "active" | "ended" | "ask", cb: Listener): void;
  /** Session state changes: queued(position) / requested / active /
   *  paused(reason) / resumed / ended(reason). Returns an unsubscribe. */
  onState(cb: (s: DeviceState) => void): () => void;
}

export function createDeviceClient(
  transport: DeviceClientTransport,
  params: { deviceId: SaltId },
  options: DeviceClientOptions = {}
): DeviceClient {
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 150_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  const commandTtlMs = options.commandTtlMs ?? COMMAND_TTL_MS;

  let meta: DeviceSessionMeta | null = null;
  let readers: LaneReaders | null = null;
  let seq = 0;
  let pausedReason: DevicePauseReason | null = null;
  const pending = new Map<string, Pending>();
  const listeners: Record<string, Listener[]> = { active: [], ended: [], ask: [] };
  const stateListeners: Array<(s: DeviceState) => void> = [];
  let openResolve: ((m: DeviceSessionMeta) => void) | null = null;
  let openReject: ((e: Error) => void) | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;
  // Single flight: commands run one at a time, in call order.
  let tail: Promise<unknown> = Promise.resolve();
  let inFlight = 0;

  function emit(event: string, ...args: unknown[]): void {
    for (const cb of listeners[event] ?? []) {
      try {
        cb(...args);
      } catch {
        /* a listener throwing never breaks the stream */
      }
    }
  }

  function emitState(s: DeviceState): void {
    for (const cb of stateListeners) {
      try {
        cb(s);
      } catch {
        /* a listener throwing never breaks the stream */
      }
    }
  }

  function readersFrom(m: DeviceSessionMeta): LaneReaders | null {
    if (!m.chat || !m.chat.readers?.length) return null;
    return { chatId: m.chat.id, publicKeys: m.chat.readers };
  }

  function failAll(err: Error): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function clearOpenTimer(): void {
    if (openTimer) clearTimeout(openTimer);
    openTimer = null;
  }

  /** The approval clock runs only while `requested`, never while `queued`. */
  function startApprovalTimer(): void {
    if (!openReject || openTimer) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      const rej = openReject;
      openResolve = openReject = null;
      rej?.(new DeviceProtocolError("failed", "device did not approve in time"));
    }, approvalTimeoutMs);
    if (typeof (openTimer as { unref?: () => void }).unref === "function") {
      (openTimer as { unref: () => void }).unref();
    }
  }

  function settleOpen(m: DeviceSessionMeta): void {
    clearOpenTimer();
    const res = openResolve;
    openResolve = openReject = null;
    res?.(m);
  }

  /** The session just became (or was found) active. Readers come from the
   *  payload; if absent they are fetched once. */
  function becomeActive(m: DeviceSessionMeta, announce: boolean): void {
    meta = { ...m, status: "active" };
    pausedReason = null;
    readers = readersFrom(meta);
    const finish = () => {
      settleOpen(meta as DeviceSessionMeta);
      if (announce) {
        emit("active", meta);
        emitState({ state: "active" });
      }
    };
    if (readers || !transport.fetchSession) return finish();
    const sid = meta.id;
    void transport
      .fetchSession(sid)
      .then((f) => {
        if (meta && sameId(meta.id, sid) && f) {
          meta = { ...meta, ...f, status: meta.status };
          readers = readersFrom(meta);
        }
      })
      .catch(() => undefined)
      .then(finish);
  }

  async function open(o: { wait?: boolean } = {}): Promise<DeviceSessionMeta> {
    const wait = o.wait !== false;
    if (meta && (meta.status === "active" || meta.status === "paused")) return meta;
    // Register the waiter SYNCHRONOUSLY, before the POST's await yields: the
    // device's `device_session_active` delivery can race ahead of the POST
    // response, and it must find a resolver already in place.
    let waiter: Promise<DeviceSessionMeta> | null = null;
    if (wait) {
      waiter = new Promise<DeviceSessionMeta>((resolve, reject) => {
        openResolve = resolve;
        openReject = reject;
      });
      waiter.catch(() => undefined); // a rejection is delivered to the caller below
    }
    let created: DeviceSessionMeta;
    try {
      created = await transport.openSession(params.deviceId);
    } catch (e) {
      if (e instanceof DeviceSessionLiveError) return reattach(e.sessionId, waiter);
      clearOpenTimer();
      openResolve = openReject = null;
      throw e;
    }
    seq = 0;
    // If a delivery already moved us on while the POST was in flight, its
    // fields (status, chat) win; otherwise take the POST's view.
    meta = meta ? { ...created, ...meta } : created;
    switch (meta.status) {
      case "active":
        becomeActive(meta, true);
        return waiter ? waiter : meta;
      case "queued":
        emitState({ state: "queued", position: meta.position ?? 1 });
        break;
      case "requested":
        emitState({ state: "requested" });
        startApprovalTimer();
        break;
      default:
        break;
    }
    if (!waiter) return meta;
    return waiter;
  }

  async function reattach(sessionId: SaltId, waiter: Promise<DeviceSessionMeta> | null): Promise<DeviceSessionMeta> {
    try {
      if (!transport.reattachSession) throw new DeviceProtocolError("failed", "transport cannot reattach");
      const r = await transport.reattachSession(sessionId);
      seq = r.last_seq; // continue at last_seq + 1
      if (r.session.status === "paused") {
        meta = { ...r.session };
        readers = readersFrom(meta);
        pausedReason = meta.pause_reason ?? "paused";
        settleOpen(meta);
        emitState({ state: "paused", reason: pausedReason });
      } else {
        becomeActive(r.session, true);
      }
      return waiter ? await waiter : (meta as DeviceSessionMeta);
    } catch (e) {
      clearOpenTimer();
      openResolve = openReject = null;
      throw e;
    }
  }

  function requireActive(): { m: DeviceSessionMeta; r: LaneReaders } {
    if (pausedReason !== null) throw new DevicePausedError(pausedReason);
    if (!meta || meta.status !== "active") {
      throw new DeviceProtocolError("failed", "no active device session");
    }
    if (!readers) {
      throw new DeviceProtocolError("failed", "session active but lane readers unknown");
    }
    return { m: meta, r: readers };
  }

  /** Post one plaintext and wait for the result keyed to `id`. On the client
   *  timeout, tell the device to drop it (`cancel {id}`) and fail. */
  async function sendAndWait(id: string, plaintext: string, r: LaneReaders, m: DeviceSessionMeta, op: string): Promise<DeviceResult> {
    const result = new Promise<DeviceResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CommandTimeout(`${op} timed out`));
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    result.catch(() => undefined);
    try {
      await transport.postCommand(plaintext, r);
    } catch (e) {
      const p = pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(id);
      }
      throw e;
    }
    try {
      return await result;
    } catch (e) {
      if (e instanceof CommandTimeout) {
        // Out-of-band and best effort: consumes no seq. A command that already
        // started keeps its stored result on the device for a retry by id.
        const cancel = encodeDeviceMessage(
          { v: DEVICE_PROTOCOL_VERSION, id: deviceMessageId(), seq: Math.max(seq, 1), op: "cancel", session: m.id },
          { id }
        );
        await transport.postCommand(cancel, r).catch(() => undefined);
        throw new DeviceProtocolError("failed", e.message);
      }
      throw e;
    }
  }

  async function execute(op: DeviceOp, args?: unknown): Promise<DeviceResult> {
    const { m, r } = requireActive();
    const id = deviceMessageId(); // reused by every resend of this command
    seq += 1;
    let resynced = false;
    let refreshed = false;
    for (;;) {
      const plaintext = encodeDeviceMessage(
        { v: DEVICE_PROTOCOL_VERSION, id, seq, op, session: m.id, exp: Date.now() + commandTtlMs },
        args
      );
      const res = await sendAndWait(id, plaintext, r, m, op);
      if (res.op !== "error") return res;
      const b = (res.body ?? {}) as ErrorResult;
      const expected = typeof b.expected_seq === "number" ? b.expected_seq : undefined;
      if (b.code === "out_of_order" && expected !== undefined && !resynced) {
        resynced = true;
        seq = expected; // resend with the SAME id so it cannot run twice
        continue;
      }
      if (b.code === "expired" && !refreshed) {
        refreshed = true;
        if (expected !== undefined) seq = expected;
        continue; // same id and seq, fresh exp
      }
      if (b.code === "paused") {
        if (expected !== undefined) seq = expected - 1;
        // Not a state change (deliveries own that): just fail this call.
        throw new DevicePausedError(b.reason ?? "paused");
      }
      if (expected !== undefined) seq = expected - 1;
      return res;
    }
  }

  function request(op: DeviceOp, args?: unknown): Promise<DeviceResult> {
    if (pausedReason !== null) return Promise.reject(new DevicePausedError(pausedReason));
    const run = inFlight === 0 ? execute(op, args) : tail.then(() => execute(op, args));
    inFlight += 1;
    tail = run.then(
      () => undefined,
      () => undefined
    ).then(() => {
      inFlight -= 1;
    });
    return run;
  }

  // Typed wrappers. Each throws a DeviceProtocolError on an `error` result and
  // on an `ask` result (the person has to act at the machine first).
  function expect(op: DeviceOp, wantOp: DeviceResultOp): (args?: unknown) => Promise<unknown> {
    return async (args?: unknown) => {
      const res = await request(op, args);
      if (res.op === "error") {
        const b = (res.body ?? {}) as { code?: DeviceErrorCode; message?: string };
        throw new DeviceProtocolError(b.code ?? "failed", b.message);
      }
      if (res.op === "ask") {
        const reason = ((res.body ?? {}) as { reason?: string }).reason ?? "the device is waiting for the person";
        emit("ask", reason);
        throw new DeviceProtocolError("needs_approval", reason);
      }
      if (res.op !== wantOp) {
        throw new DeviceProtocolError("failed", `expected ${wantOp}, got ${res.op}`);
      }
      return res.body;
    };
  }

  const doObserve = expect("observe", "observation");
  const doClick = expect("click", "ack");
  const doType = expect("type", "ack");
  const doKey = expect("key", "ack");
  const doScroll = expect("scroll", "ack");
  const doFocus = expect("focus_app", "ack");
  const doListApps = expect("list_apps", "apps");
  const doReadFile = expect("read_file", "file");
  const doWriteFile = expect("write_file", "ack");

  function handleDelivery(kind: string, body: unknown): void {
    if (!kind.startsWith("device_session")) return;
    const b = (body ?? {}) as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type : kind;
    // New deliveries carry `event`; the legacy ones only a `device_session_<x>` type.
    const ev = typeof b.event === "string" ? b.event : type.replace(/^device_session_?/, "");
    const sess = b.session && typeof b.session === "object" ? (b.session as DeviceSessionMeta) : undefined;
    const sid = (sess?.id ?? b.session_id) as SaltId | undefined;
    if (meta && sid !== undefined && !sameId(sid, meta.id)) return;
    const status = (b.status ?? sess?.status) as DeviceSessionStatus | undefined;

    switch (ev) {
      case "active":
      case "promoted": {
        if (!meta && !sess) return;
        const merged = { ...(meta ?? ({} as DeviceSessionMeta)), ...(sess ?? {}) } as DeviceSessionMeta;
        if (sid !== undefined) merged.id = sid;
        if (ev === "active" || status === "active") {
          becomeActive(merged, true);
        } else {
          meta = { ...merged, status: "requested" };
          emitState({ state: "requested" });
          startApprovalTimer();
        }
        break;
      }
      case "queue_moved": {
        if (!meta) return;
        const position = Number(b.position);
        if (!Number.isFinite(position)) return;
        meta = { ...meta, status: "queued", position };
        emitState({ state: "queued", position });
        break;
      }
      case "paused": {
        if (!meta) return;
        const reason = (b.pause_reason ?? b.reason ?? "paused") as DevicePauseReason;
        pausedReason = reason;
        meta = { ...meta, status: "paused", pause_reason: reason };
        emitState({ state: "paused", reason });
        break;
      }
      case "resumed": {
        if (!meta) return;
        pausedReason = null;
        meta = { ...meta, status: "active", pause_reason: undefined };
        emitState({ state: "resumed" });
        break;
      }
      case "ended": {
        const reason = (b.end_reason as string) ?? "ended";
        if (meta) meta.status = "ended";
        pausedReason = null;
        clearOpenTimer();
        const err = new DeviceProtocolError("failed", `session ended: ${reason}`);
        const rej = openReject;
        openResolve = openReject = null;
        rej?.(err);
        failAll(err);
        emit("ended", reason);
        emitState({ state: "ended", reason });
        break;
      }
      default:
        break;
    }
  }

  function handleLaneMessage(plaintext: string): boolean {
    let decoded;
    try {
      decoded = decodeDeviceMessage(plaintext);
    } catch {
      return false; // a malformed device line from the device: not ours to answer
    }
    if (!decoded) return false;
    const { header, body } = decoded;
    if (!meta || !sameId(header.session, meta.id)) return false;
    if (header.re === undefined) return false; // a result always answers a command id
    const p = pending.get(header.re);
    if (!p) return false;
    clearTimeout(p.timer);
    pending.delete(header.re);
    p.resolve({ op: header.op as DeviceResultOp, body });
    return true;
  }

  return {
    open,
    observe: (args?: ObserveArgs) => doObserve(args ?? { target: "screen" }) as Promise<ObservationResult>,
    click: (args: ClickArgs) => doClick(args).then(() => undefined),
    type: (text: string) => doType({ text }).then(() => undefined),
    key: (keys: string[]) => doKey({ keys } satisfies KeyArgs).then(() => undefined),
    scroll: (args: ScrollArgs) => doScroll(args).then(() => undefined),
    focusApp: (app: string) => doFocus({ app }).then(() => undefined),
    listApps: () => doListApps() as Promise<AppsResult>,
    readFile: (path: string) => doReadFile({ path }) as Promise<FileResult>,
    writeFile: (path: string, contentB64: string) => doWriteFile({ path, content_b64: contentB64 }).then(() => undefined),
    async stop() {
      const id = meta?.id;
      if (!id) return;
      try {
        await transport.stopSession(id);
      } finally {
        if (meta) meta.status = "ended";
        failAll(new DeviceProtocolError("failed", "session stopped"));
      }
    },
    session: () => meta,
    pausedReason: () => pausedReason,
    handleDelivery,
    handleLaneMessage,
    on: (event, cb) => {
      (listeners[event] ??= []).push(cb);
    },
    onState: (cb) => {
      stateListeners.push(cb);
      return () => {
        const i = stateListeners.indexOf(cb);
        if (i >= 0) stateListeners.splice(i, 1);
      };
    },
    _capabilityForOp: CAPABILITY_FOR_OP, // re-exported for consumers that gate before sending
  } as DeviceClient & { _capabilityForOp: typeof CAPABILITY_FOR_OP };
}
