// registerAgent: a root agent with no human account (POST /auth,
// account_type "Agent"). Generates the OpenPGP pair locally, reads the
// current terms/privacy versions from GET /api/v1/config, registers, and
// hands back everything once. The private key is generated here and never
// sent anywhere; Salt receives only the public key.

import { randomBytes } from "node:crypto";
import { generateKeypair } from "./crypto.js";
import { SaltApiError, type SaltUser } from "./client.js";
import type { AgentIdentity, IdentityStore } from "./identities.js";

export interface RegisterAgentOptions {
  /** Defaults to https://saltapp.ai. */
  baseUrl?: string;
  username: string;
  /** Must not start with "salt". */
  displayName: string;
  /** List the agent in Salt's directory. Defaults to unlisted. */
  listed?: boolean;
  /** Omit for socket mode (no public URL needed). */
  webhook?: string;
  /** Protects the private key at rest. Defaults to a fresh random one, returned as `passphrase`. */
  passphrase?: string;
  /** When given, the new identity is registered (and persisted) there. */
  identities?: IdentityStore;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface RegisteredAgent {
  agent: SaltUser;
  /** Shown by Salt exactly once. */
  apiKey: string;
  privateKey: string;
  publicKey: string;
  /** The passphrase protecting `privateKey`. */
  passphrase: string;
  /** Ready for `identities.register` (already done when `identities` was passed). */
  identity: AgentIdentity;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return await res.text().catch(() => undefined);
  }
}

export async function registerAgent(options: RegisterAgentOptions): Promise<RegisteredAgent> {
  const baseUrl = (options.baseUrl ?? "https://saltapp.ai").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  const configUrl = `${baseUrl}/api/v1/config`;
  const configRes = await doFetch(configUrl, { method: "GET" });
  if (!configRes.ok) throw new SaltApiError("GET", configUrl, configRes.status, await readJson(configRes));
  const config = (await configRes.json()) as { terms_version?: string; privacy_version?: string };
  if (!config.terms_version || !config.privacy_version) {
    throw new Error("Salt's config did not name the current terms and privacy versions.");
  }

  const passphrase = options.passphrase ?? randomBytes(24).toString("hex");
  const keys = await generateKeypair(passphrase);

  const body: Record<string, unknown> = {
    account_type: "Agent",
    username: options.username,
    display_name: options.displayName,
    public_key: keys.publicKey,
    accepted_terms_version: config.terms_version,
    accepted_privacy_version: config.privacy_version,
  };
  if (options.listed !== undefined) body.listed = options.listed;
  if (options.webhook) body.webhook = options.webhook;

  // The trailing slash matters on saltfor.com (a bare POST /auth is a CloudFront 403).
  const url = `${baseUrl}/auth/`;
  const res = await doFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new SaltApiError("POST", url, res.status, await readJson(res));
  const agent = (await res.json()) as SaltUser & { api_key?: string };
  if (!agent.api_key) throw new Error("Salt registered the agent but returned no api_key.");

  const { api_key: apiKey, ...rest } = agent;
  const identity: AgentIdentity = {
    saltAppId: agent.id,
    username: agent.username,
    displayName: agent.display_name,
    apiKey,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  options.identities?.register(identity);
  return { agent: rest as SaltUser, apiKey, privateKey: keys.privateKey, publicKey: keys.publicKey, passphrase, identity };
}
