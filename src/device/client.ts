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
  DeviceProtocolError,
  DEVICE_PROTOCOL_VERSION,
  deviceMessageId,
  decodeDeviceMessage,
  encodeDeviceMessage,
  type ClickArgs,
  type DeviceErrorCode,
  type DeviceOp,
  type DeviceResultOp,
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

export interface DeviceSessionMeta {
  id: SaltId;
  device_id: SaltId;
  agent_id: SaltId;
  mandate_id: SaltId;
  status: "requested" | "active" | "ended";
  chat?: { id: SaltId; readers: string[] };
}

/** The injected transport. httpDeviceTransport provides a real one. */
export interface DeviceClientTransport {
  /** POST /api/v1/devices/:id/sessions -> the created session (status
   *  `requested`). The device still has to approve locally. */
  openSession(deviceId: SaltId): Promise<DeviceSessionMeta>;
  /** POST /api/v1/device_sessions/:sid/stop (subtract-only, idempotent). */
  stopSession(sessionId: SaltId): Promise<void>;
  /** Encrypt `plaintext` for the current lane readers and POST it as one lane
   *  message. The transport owns the crypto and the readers; this module only
   *  decides the plaintext. */
  postCommand(plaintext: string, readers: LaneReaders): Promise<void>;
}

export interface DeviceClientOptions {
  /** How long open() waits for the device's local approval before giving up.
   *  The server ends an unanswered request after 2 minutes with
   *  `request_expired`; default here is a touch longer so the server's own
   *  end reaches us first. */
  approvalTimeoutMs?: number;
  /** Per-command timeout waiting for a result. Default 30s. */
  commandTimeoutMs?: number;
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

export interface DeviceClient {
  /** Open a session and wait for the device to approve locally. Rejects if the
   *  device declines, the request expires, or the mandate is gone. */
  open(): Promise<DeviceSessionMeta>;
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
  /** Feed a `device_session` socket delivery in (active / ended). The consumer
   *  calls this from its dispatcher. */
  handleDelivery(event: string, body: unknown): void;
  /** Feed a decrypted lane message in (a result the device posted). Returns
   *  true if it was a device result this client consumed. */
  handleLaneMessage(plaintext: string): boolean;
  on(event: "active" | "ended" | "ask", cb: Listener): void;
}

export function createDeviceClient(
  transport: DeviceClientTransport,
  params: { deviceId: SaltId },
  options: DeviceClientOptions = {}
): DeviceClient {
  const approvalTimeoutMs = options.approvalTimeoutMs ?? 150_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;

  let meta: DeviceSessionMeta | null = null;
  let readers: LaneReaders | null = null;
  let seq = 0;
  const pending = new Map<string, Pending>();
  const listeners: Record<string, Listener[]> = { active: [], ended: [], ask: [] };
  let openResolve: ((m: DeviceSessionMeta) => void) | null = null;
  let openReject: ((e: Error) => void) | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;

  function emit(event: string, ...args: unknown[]): void {
    for (const cb of listeners[event] ?? []) {
      try {
        cb(...args);
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

  async function open(): Promise<DeviceSessionMeta> {
    if (meta && meta.status === "active") return meta;
    // Register the waiter SYNCHRONOUSLY, before the POST's await yields: the
    // device's `device_session_active` delivery can race ahead of the POST
    // response, and it must find a resolver already in place.
    const waiter = new Promise<DeviceSessionMeta>((resolve, reject) => {
      openResolve = resolve;
      openReject = reject;
      openTimer = setTimeout(() => {
        openResolve = openReject = null;
        reject(new DeviceProtocolError("failed", "device did not approve in time"));
      }, approvalTimeoutMs);
      if (typeof (openTimer as { unref?: () => void }).unref === "function") {
        (openTimer as { unref: () => void }).unref();
      }
    });
    const created = await transport.openSession(params.deviceId);
    // If a delivery already flipped us active while the POST was in flight, its
    // fields (status, chat) win; otherwise take the POST's view.
    meta = meta ? { ...created, ...meta } : created;
    if (meta.status === "active") {
      readers = readersFrom(meta);
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
      openResolve?.(meta);
      openResolve = openReject = null;
      return meta;
    }
    return waiter;
  }

  function requireActive(): { m: DeviceSessionMeta; r: LaneReaders } {
    if (!meta || meta.status !== "active") {
      throw new DeviceProtocolError("failed", "no active device session");
    }
    if (!readers) {
      throw new DeviceProtocolError("failed", "session active but lane readers unknown");
    }
    return { m: meta, r: readers };
  }

  async function request(op: DeviceOp, args?: unknown): Promise<DeviceResult> {
    const { m, r } = requireActive();
    const id = deviceMessageId();
    seq += 1;
    const plaintext = encodeDeviceMessage({ v: DEVICE_PROTOCOL_VERSION, id, seq, op, session: m.id }, args);
    const result = new Promise<DeviceResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new DeviceProtocolError("failed", `${op} timed out`));
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
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
    return result;
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

  function handleDelivery(event: string, body: unknown): void {
    if (event !== "device_session") return;
    const b = (body ?? {}) as { type?: string; session?: DeviceSessionMeta; end_reason?: string } & Record<string, unknown>;
    const incoming = (b.session ?? b) as DeviceSessionMeta;
    if (!incoming || !sameId(incoming.id, meta?.id ?? incoming.id)) {
      // Not about our session; ignore. (Before open() resolves, meta.id is
      // already set from openSession, so this matches on approval.)
    }
    switch (b.type) {
      case "device_session_active": {
        if (meta && !sameId(incoming.id, meta.id)) return;
        meta = { ...(meta ?? incoming), ...incoming, status: "active" };
        readers = readersFrom(meta);
        if (openTimer) clearTimeout(openTimer);
        openTimer = null;
        openResolve?.(meta);
        openResolve = openReject = null;
        emit("active", meta);
        break;
      }
      case "device_session_ended": {
        if (meta && !sameId(incoming.id, meta.id)) return;
        const reason = (b.end_reason as string) ?? "ended";
        if (meta) meta.status = "ended";
        if (openTimer) clearTimeout(openTimer);
        openTimer = null;
        const err = new DeviceProtocolError("failed", `session ended: ${reason}`);
        openReject?.(err);
        openResolve = openReject = null;
        failAll(err);
        emit("ended", reason);
        break;
      }
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
    handleDelivery,
    handleLaneMessage,
    on: (event, cb) => {
      (listeners[event] ??= []).push(cb);
    },
    _capabilityForOp: CAPABILITY_FOR_OP, // re-exported for consumers that gate before sending
  } as DeviceClient & { _capabilityForOp: typeof CAPABILITY_FOR_OP };
}
