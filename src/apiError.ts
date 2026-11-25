// SaltApiError lives in its own module so the typed refusals (mailgrant.ts, folderArchives.ts) can extend it without
// importing client.ts, which imports them. client.ts re-exports it, so `import { SaltApiError } from "./client"` is unchanged.
import type { GrantAsk, GrantNeeded } from "./client.js";

export class SaltApiError extends Error {
  status: number;
  body: unknown;
  /** Salt's machine-readable refusal code (`{error, code}`), when the body carries one. */
  code?: string;
  /** Seconds to wait, from `Retry-After`, on a 429 (e.g. `too_many_attempts` from the password-gated reset). */
  retryAfterSeconds?: number;
  /** The grant that would unlock a refused call, when the refusal names one (missing authority for an agent caller). */
  grant?: GrantNeeded;
  /** A ready request that files the ask for `grant`. Pass `err.ask.body` to `client.requestGrant`, adding `reason`. Absent when the call is the owner's to decide alone (e.g. a spending freeze). */
  ask?: GrantAsk;

  constructor(method: string, url: string, status: number, body: unknown) {
    // Salt's refusals carry one plain sentence ({error: "..."}). Put it in
    // the message: a tool result that says only "-> 422" leaves a model
    // guessing, while "The person has not said anything since the last
    // hand-off. Answer them yourself..." tells it what to do instead.
    // POST /auth (self-registration) answers {status: {message}} instead.
    const b = body && typeof body === "object" ? (body as { error?: unknown; status?: { message?: unknown } }) : undefined;
    const sentence = typeof b?.error === "string" ? b.error : typeof b?.status?.message === "string" ? b.status.message : undefined;
    const reason = sentence ? `: ${sentence}` : "";
    super(`Salt API ${method} ${url} -> ${status}${reason}`);
    this.name = "SaltApiError";
    this.status = status;
    this.body = body;
    if (typeof (b as { code?: unknown } | undefined)?.code === "string") this.code = (b as { code: string }).code;
    const env = body && typeof body === "object" ? (body as { grant?: unknown; ask?: unknown }) : undefined;
    if (env?.grant && typeof env.grant === "object" && typeof (env.grant as { capability?: unknown }).capability === "string") this.grant = env.grant as GrantNeeded;
    if (env?.ask && typeof env.ask === "object" && typeof (env.ask as { path?: unknown }).path === "string") this.ask = env.ask as GrantAsk;
  }
}
