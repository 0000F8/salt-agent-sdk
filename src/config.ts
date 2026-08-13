// The Salt-platform-generic slice of salt-claude-agent/src/config.js.
// Model/provider config (ANTHROPIC_API_KEY, model name, system prompt,
// max tokens) deliberately isn't here -- that's the consumer's own config,
// since it's specific to whichever model they've wired up.

/**
 * Env values may store the armored PGP blocks on one line with literal
 * "\n" (the salt-app-example convention, since most .env / secrets-manager
 * tooling doesn't handle real newlines well). Normalise those back to real
 * newlines so openpgp can parse them; a genuine multi-line value is left untouched.
 */
export function unescapeArmor(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

export interface SaltAgentConfig {
  /** Salt API base URL, e.g. "https://saltfor.com" (no trailing slash). */
  host: string;
  saltApiKey: string;
  saltAppId: number;
  /** Cosmetic only (log lines) -- not looked up automatically. */
  saltUsername?: string;
  saltDisplayName?: string;

  appPublicKey: string;
  appPrivateKey: string;
  pgpPassphrase: string;

  /** Enables create_wallet / agent-provisioned wallets. */
  walletMasterKey?: string;

  /** This identity's own id, if it's the configured Mediator. */
  mediatorAgentId?: number;
  /** The "front door" agent id for hand_back_to_concierge. */
  globalAgentId?: number;

  /** Set SALT_VERIFY_SIGNATURES=false to skip webhook signature verification
   *  (local dev only). Production verifies by default; each identity's signing
   *  key is fetched from salt-api with its own api key, so nothing needs to be
   *  configured here. Replaced WEBHOOK_SHARED_SECRET, a single fleet-wide value
   *  that leaked to anyone who registered an agent. */
  verifySignatures?: boolean;

  port: number;
  /** This webhook server's own public URL, given to agents created via create_salt_agent. */
  publicWebhookUrl: string;
}

/**
 * Reads the generic Salt fields out of an env-like object (defaults to
 * process.env). Does not validate or exit the process -- see
 * validateSaltAgentConfig for that, which a consumer's own app code should
 * act on however fits it (throw, log + exit, etc.).
 */
export function loadSaltAgentConfig(env: NodeJS.ProcessEnv = process.env): SaltAgentConfig {
  const port = parseInt(env.PORT || "5100", 10);
  return {
    host: (env.HOST || "").replace(/\/$/, ""),
    saltApiKey: env.SALT_API_KEY || "",
    saltAppId: env.SALT_APP_ID != null ? parseInt(env.SALT_APP_ID, 10) : NaN,
    saltUsername: env.SALT_USERNAME || undefined,
    saltDisplayName: env.SALT_DISPLAY_NAME || undefined,

    appPublicKey: unescapeArmor(env.APP_PUBLIC_KEY) || "",
    appPrivateKey: unescapeArmor(env.APP_PRIVATE_KEY) || "",
    pgpPassphrase: env.PGP_PASSPHRASE || "salt",

    walletMasterKey: env.WALLET_MASTER_KEY || undefined,

    mediatorAgentId: env.MEDIATOR_AGENT_ID != null ? parseInt(env.MEDIATOR_AGENT_ID, 10) : undefined,
    globalAgentId: env.GLOBAL_AGENT_ID != null ? parseInt(env.GLOBAL_AGENT_ID, 10) : undefined,

    verifySignatures: env.SALT_VERIFY_SIGNATURES !== "false",

    port,
    publicWebhookUrl: env.PUBLIC_WEBHOOK_URL || `http://localhost:${port}/`,
  };
}

/** Returns the names of any required fields that are missing/invalid, or an empty array if the config is usable. */
export function validateSaltAgentConfig(config: SaltAgentConfig): string[] {
  const missing: string[] = [];
  if (!config.host) missing.push("HOST");
  if (!config.saltApiKey) missing.push("SALT_API_KEY");
  if (Number.isNaN(config.saltAppId)) missing.push("SALT_APP_ID");
  if (!config.appPublicKey) missing.push("APP_PUBLIC_KEY");
  if (!config.appPrivateKey) missing.push("APP_PRIVATE_KEY");
  return missing;
}
