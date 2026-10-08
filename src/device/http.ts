// Real transports for the device client and host, wired to a Salt deployment
// over HTTPS. The pure logic in client.ts / host.ts takes these as injected
// dependencies; tests pass fakes instead.
//
// These do the two things the pure modules deliberately leave out: the device
// REST calls (open/stop/beat/counts) and the encrypt-and-post of a lane
// message. They still touch NO screen and NO input -- a result's bytes
// (a screenshot, a file) are produced by the host's injected handler and only
// encrypted here.

import { encryptFor } from "../crypto.js";
import type { SaltId } from "../ids.js";
import type { DeviceClientTransport, DeviceSessionMeta, LaneReaders } from "./client.js";
import { DeviceBeatOverError, type DeviceHostTransport } from "./host.js";
import type { DeviceCountClass } from "./protocol.js";

export interface DeviceHttpOptions {
  host: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function call<T>(
  opts: DeviceHttpOptions,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: T }> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.host.replace(/\/$/, "")}${path}`, {
    method,
    headers: { "api-key": opts.apiKey, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = undefined;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data: data as T };
}

/** Agent-side transport. `apiKey` is the ACTING AGENT's key. */
export function httpDeviceAgentTransport(opts: DeviceHttpOptions): DeviceClientTransport {
  return {
    async openSession(deviceId: SaltId): Promise<DeviceSessionMeta> {
      const { status, data } = await call<DeviceSessionMeta>(opts, "POST", `/api/v1/devices/${deviceId}/sessions`);
      if (status >= 400) throw new Error(`openSession failed: ${status}`);
      return data;
    },
    async stopSession(sessionId: SaltId): Promise<void> {
      await call(opts, "POST", `/api/v1/device_sessions/${sessionId}/stop`);
    },
    async postCommand(plaintext: string, readers: LaneReaders): Promise<void> {
      const ciphertext = await encryptFor(plaintext, readers.publicKeys);
      const { status } = await call(opts, "POST", `/api/v1/messages`, {
        chat_id: readers.chatId,
        message: ciphertext,
        quiet: true,
      });
      if (status >= 400) throw new Error(`postCommand failed: ${status}`);
    },
  };
}

/** Device-side transport. `apiKey` is the DEVICE's own key. */
export function httpDeviceHostTransport(opts: DeviceHttpOptions): DeviceHostTransport {
  return {
    async postResult(plaintext: string, readers: LaneReaders): Promise<void> {
      const ciphertext = await encryptFor(plaintext, readers.publicKeys);
      const { status } = await call(opts, "POST", `/api/v1/messages`, {
        chat_id: readers.chatId,
        message: ciphertext,
        quiet: true,
      });
      if (status >= 400) throw new Error(`postResult failed: ${status}`);
    },
    async beat(sessionId: SaltId): Promise<void> {
      const { status } = await call(opts, "POST", `/api/v1/device_sessions/${sessionId}/beat`);
      if (status === 409) throw new DeviceBeatOverError("session over");
      if (status >= 400) throw new Error(`beat failed: ${status}`);
    },
    async reportCounts(sessionId: SaltId, counts: Partial<Record<DeviceCountClass, number>>): Promise<void> {
      await call(opts, "PATCH", `/api/v1/device_sessions/${sessionId}/counts`, { counts });
    },
    async stop(sessionId: SaltId, reason: string): Promise<void> {
      await call(opts, "POST", `/api/v1/device_sessions/${sessionId}/stop`, { reason });
    },
  };
}
