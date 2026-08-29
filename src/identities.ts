// Registry of every Salt agent identity a process can act as: a primary
// one from the consumer's own config, plus any it spawns at runtime (e.g.
// via an actions.createSaltAgent call). Spawned agents share the same
// webhook server as their parent, so incoming requests get routed to the
// right identity by trying each one's private key against the ciphertext
// (see webhook.ts's resolveIdentity).
//
// Ported from salt-claude-agent/src/identities.js, restructured from a
// module-level singleton into a factory: the original hardcoded its store
// path relative to its own __dirname, which only works when the file lives
// in the top-level app -- once this is a node_modules dependency,
// __dirname points inside node_modules/salt-agent-sdk/dist instead of the
// consumer's own project, silently breaking persistence. Callers now pass
// an explicit path (or accept the process.cwd()-relative default).

import * as fs from "node:fs";
import * as path from "node:path";

import type { SaltId } from "./ids.js";

export interface AgentIdentity {
  saltAppId: SaltId;
  username: string;
  displayName?: string;
  apiKey: string;
  publicKey: string;
  privateKey: string;
  /** Free-form per-identity state a consumer's own agent loop may want to stash (e.g. a system prompt). */
  [key: string]: unknown;
}

export interface IdentityStore {
  register(identity: AgentIdentity): void;
  get(saltAppId: SaltId): AgentIdentity | undefined;
  all(): AgentIdentity[];
}

const DEFAULT_STORE_PATH = path.join(process.cwd(), "data", "identities.json");

/**
 * Creates a JSON-file-backed identity store. Loads synchronously at
 * creation time so a spawned agent's keys survive a process restart --
 * without this, restarting to pick up a code change would silently orphan
 * every agent the process had ever spawned (their identity would only have
 * lived in memory, so they'd stop being able to decrypt anything sent to
 * them).
 */
export function createIdentityStore(storePath: string = DEFAULT_STORE_PATH): IdentityStore {
  // Keyed by the lowercased id. Ids arrive from webhook bodies, REST
  // responses and env vars, and a uuid that differs only in case would
  // otherwise register as a second, separate identity -- the process would
  // hold two copies of one agent and route to whichever it looked up first.
  const identities = new Map<string, AgentIdentity>();
  const mapKey = (id: SaltId): string => String(id).toLowerCase();

  function load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(storePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[identities] failed to read store:", (err as Error).message);
      }
      return;
    }
    try {
      for (const identity of JSON.parse(raw) as AgentIdentity[]) {
        identities.set(mapKey(identity.saltAppId), identity);
      }
    } catch (err) {
      console.error("[identities] failed to parse store:", (err as Error).message);
    }
  }

  function persist(): void {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(Array.from(identities.values()), null, 2));
    } catch (err) {
      console.error("[identities] failed to persist store:", (err as Error).message);
    }
  }

  load();

  return {
    register(identity: AgentIdentity): void {
      identities.set(mapKey(identity.saltAppId), identity);
      persist();
    },
    get(saltAppId: SaltId): AgentIdentity | undefined {
      return identities.get(mapKey(saltAppId));
    },
    all(): AgentIdentity[] {
      return Array.from(identities.values());
    },
  };
}
