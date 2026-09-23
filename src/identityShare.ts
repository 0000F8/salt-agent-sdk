// Identity on Salt, R3 + R4 (design-fleet/runs/2026-09-22-identity/plan.md
// sections 5, 7, 8): sending a SIGNED SLICE of an agent's own identity
// sections into a chat as ordinary E2E ciphertext, answering an incoming
// ask for one, and revoking a disclosure already sent. Builds directly on
// identity.ts's R1 (the card vocabulary, canonicalizeJcs) and client.ts's
// R1 identity()/setIdentity() -- this module is what turns those into
// something an agent can actually SEND.
//
// Wire, inside the E2E plaintext, one marker line then (for SLICE) a JSON
// line:
//
//   [[SALT-IDENTITY-SLICE id=01J9…]]
//   {"sections":[{"key":"bio","value":"Forecasts for any city.","proof":null}],
//    "signature":"-----BEGIN PGP SIGNATURE-----…"}
//
//   [[SALT-IDENTITY-ASK id=01J9… keys=bio,link]]
//   Mind sharing your bio and link?
//
//   [[SALT-IDENTITY-DECLINE id=01J9… ask=01J8…]]
//
//   [[SALT-IDENTITY-REVOKE id=01J9…]]
//
// `id` on SLICE/DECLINE/REVOKE is that message's OWN id (a fresh
// crypto.randomUUID() -- for SLICE this is also one of the ledger rows
// disclose() just wrote, see the design note on `share` below). `ask`
// (SLICE and DECLINE only) is the id of the SALT-IDENTITY-ASK this message
// answers -- present only when answering one, so an asker's client can
// resolve which question got answered. The signature on a SLICE is an
// OpenPGP ARMORED DETACHED signature (crypto.ts's signDetached), by the
// sender's own key, over `canonicalizeJcs(sections)` -- the sections array
// alone, not the whole payload object (identity.ts's canonicalizeJcs is
// the exact same RFC 8785 canonicalizer salt-api's card signing uses,
// reused here with an OpenPGP signature standing in for Salt's Ed25519 Web
// Bot Auth key -- a slice is signed as coming from the agent, never
// checked by Salt).
//
// Design note on `share`'s ledger vs. wire id (flagged for the web/API
// lanes -- see the SDK's own report): the plan's ledger is per-RECIPIENT
// (one row per member of a named share), but ONE ciphertext message goes
// to the whole chat, so it can carry only ONE `id=`. This module uses the
// FIRST recipient's disclosure id as the wire id; every row (including any
// beyond the first) still gets the same `message_id` PATCHed onto it, and
// `share`'s return value lists every {id, recipientId} pair regardless.
// The dominant real path -- answering a SALT-IDENTITY-ASK -- is always a
// 1:1 (client.identity.ask refuses anywhere else), so there is exactly one
// recipient and no ambiguity there.

import { randomUUID } from "node:crypto";
import type { IdentityDisclosure, SaltClient } from "./client";
import * as pgp from "./crypto";
import { canonicalizeJcs, type CardSection } from "./identity.js";
import type { AgentIdentity } from "./identities";
import { sameId, type SaltId } from "./ids.js";

// --- Wire markers ----------------------------------------------------------

/** Every SALT-IDENTITY-* marker starts with this -- webhook.ts checks it before attempting the more specific parse, the same way it gates on delegations.FLOOR_REQUEST_MARKER. */
export const IDENTITY_MARKER_PREFIX = "[[SALT-IDENTITY-";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[a-z0-9_]{1,64}$/;
const MARKER_RE = /^\[\[SALT-IDENTITY-(ASK|SLICE|DECLINE|REVOKE)([^\]\n]*)\]\]\n?/;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const pair of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq > 0) attrs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return attrs;
}

export interface IdentitySlicePayload {
  sections: CardSection[];
  signature: string;
}

export type ParsedIdentityMarker =
  | { kind: "ask"; id: string; keys: string[]; text?: string }
  | { kind: "slice"; id: string; askId?: string; payload: IdentitySlicePayload }
  | { kind: "decline"; id: string; askId?: string }
  | { kind: "revoke"; id: string };

/**
 * Parses one SALT-IDENTITY-* marker (plus, for SLICE, its JSON line) out of
 * a decrypted plaintext. Returns null for anything that isn't one of these
 * four markers, or that starts as one but is malformed (a bad id, an ASK
 * with no keys, a SLICE whose JSON doesn't parse into {sections,
 * signature}) -- webhook.ts treats either case as "starts with the prefix
 * but nothing usable came out of it" and drops the message rather than
 * guessing.
 */
export function parseIdentityMarker(plaintext: string): ParsedIdentityMarker | null {
  const match = MARKER_RE.exec(plaintext || "");
  if (!match) return null;
  const attrs = parseAttrs(match[2]);
  const id = attrs.id || "";
  if (!ID_RE.test(id)) return null;
  const rest = plaintext.slice(match[0].length);

  switch (match[1]) {
    case "ASK": {
      const keys = (attrs.keys || "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      if (keys.length === 0) return null;
      const text = rest.trim();
      return { kind: "ask", id, keys, text: text || undefined };
    }
    case "SLICE": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rest);
      } catch {
        return null;
      }
      const payload = parsed as Partial<IdentitySlicePayload> | null;
      if (!payload || !Array.isArray(payload.sections) || typeof payload.signature !== "string") return null;
      return { kind: "slice", id, askId: attrs.ask, payload: payload as IdentitySlicePayload };
    }
    case "DECLINE":
      return { kind: "decline", id, askId: attrs.ask };
    case "REVOKE":
      return { kind: "revoke", id };
    default:
      return null;
  }
}

/** `[[SALT-IDENTITY-ASK id=… keys=k1,k2]]`, optionally followed by a text line. */
export function formatIdentityAsk(id: string, keys: string[], text?: string): string {
  if (!ID_RE.test(id)) throw new Error("identity ask needs an id of letters, digits, _ or -.");
  const clean = keys.map((k) => k.trim()).filter(Boolean);
  if (clean.length === 0) throw new Error("identity ask needs at least one section key.");
  const line = `[[SALT-IDENTITY-ASK id=${id} keys=${clean.join(",")}]]`;
  const body = (text || "").trim();
  return body ? `${line}\n${body}` : line;
}

/** `[[SALT-IDENTITY-SLICE id=… [ask=…]]]` followed by the {sections, signature} JSON line. */
export function formatIdentitySlice(id: string, sections: CardSection[], signature: string, askId?: string): string {
  if (!ID_RE.test(id)) throw new Error("identity slice needs an id of letters, digits, _ or -.");
  const attrs = askId ? `id=${id} ask=${askId}` : `id=${id}`;
  return `[[SALT-IDENTITY-SLICE ${attrs}]]\n${JSON.stringify({ sections, signature })}`;
}

/** `[[SALT-IDENTITY-DECLINE id=… [ask=…]]]`. */
export function formatIdentityDecline(id: string, askId?: string): string {
  if (!ID_RE.test(id)) throw new Error("identity decline needs an id of letters, digits, _ or -.");
  return askId ? `[[SALT-IDENTITY-DECLINE id=${id} ask=${askId}]]` : `[[SALT-IDENTITY-DECLINE id=${id}]]`;
}

/** `[[SALT-IDENTITY-REVOKE id=…]]`. */
export function formatIdentityRevoke(id: string): string {
  if (!ID_RE.test(id)) throw new Error("identity revoke needs an id of letters, digits, _ or -.");
  return `[[SALT-IDENTITY-REVOKE id=${id}]]`;
}

// --- Incoming events (webhook.ts's onIdentityAsk / onIdentityShared) ------

export interface IdentityAskInfo {
  id: string;
  keys: string[];
  text?: string;
  chatId: SaltId;
  from: SaltId;
}

/**
 * Handed to `onIdentityAsk`. Return the subset of `info.keys` to share
 * (shares those, replying with a SLICE carrying `ask=info.id`) or
 * `null`/`false` (sends a DECLINE carrying `ask=info.id`). Returning an
 * empty array behaves like declining -- there is nothing to build a slice
 * from. Leaving `onIdentityAsk` unset entirely means an incoming ask is
 * never intercepted at all: it reaches `onMessage` as ordinary text with
 * just the marker line stripped (see webhook.ts), unanswered.
 */
export type IdentityAskHandler = (info: IdentityAskInfo) => Promise<string[] | null | false | undefined> | string[] | null | false | undefined;

export interface IdentitySliceEvent {
  kind: "slice";
  id: string;
  askId?: string;
  from: SaltId;
  chatId: SaltId;
  sections: CardSection[];
  /** True only when the signature verified against the sender's own public key (fetched fresh from the chat's member list). False for a bad/missing signature, an unknown sender key, or a verification that itself failed -- never thrown. */
  verified: boolean;
}

export interface IdentityDeclineEvent {
  kind: "decline";
  id: string;
  askId?: string;
  from: SaltId;
  chatId: SaltId;
}

export interface IdentityRevokeEvent {
  kind: "revoke";
  id: string;
  from: SaltId;
  chatId: SaltId;
}

export type IdentitySharedEvent = IdentitySliceEvent | IdentityDeclineEvent | IdentityRevokeEvent;

/** Handed every incoming SLICE, DECLINE and REVOKE from someone else -- never called for this identity's own outgoing messages. None of the three ever reach `onMessage`. */
export type IdentitySharedHandler = (event: IdentitySharedEvent) => Promise<void> | void;

// --- Outgoing: share / ask / disclosures / revoke --------------------------

export interface ShareOptions {
  /** Set when this share answers an incoming SALT-IDENTITY-ASK -- rides on the SLICE marker as `ask=`. */
  ask?: string;
}

export interface ShareResult {
  messageId: SaltId;
  /** One entry per non-observer chat member other than the caller -- the ledger row identityShare wrote for them, in the same order client.getChatMembers returned. */
  disclosures: Array<{ id: string; recipientId: SaltId }>;
}

export interface IdentitySharer {
  /**
   * Shares `keys` from this agent's own identity into `chatId`: one ledger
   * row per non-observer member other than the caller (aborting on the
   * first refusal with nothing sent), then ONE signed, encrypted SLICE
   * message to the whole chat, then a message_id PATCH onto every row.
   */
  share(caller: AgentIdentity, chatId: SaltId, keys: string[], opts?: ShareOptions): Promise<ShareResult>;
  /** Sends an ASK for `keys` into a 1:1 chat and returns its id. Refuses (before sending anything) outside a 1:1. */
  ask(caller: AgentIdentity, chatId: SaltId, keys: string[], text?: string): Promise<string>;
  /** Sends a bare DECLINE (optionally answering `askId`) with no ledger row -- there is nothing to disclose. Returns the decline message's own id. */
  decline(caller: AgentIdentity, chatId: SaltId, askId?: string): Promise<{ id: string }>;
  /** This agent's own disclosure ledger, newest first. */
  disclosures(caller: AgentIdentity, opts?: { before?: string; limit?: number }): Promise<IdentityDisclosure[]>;
  /** Revokes one disclosure row server-side, then sends a REVOKE marker into the chat it was disclosed in. */
  revoke(caller: AgentIdentity, disclosureId: string): Promise<IdentityDisclosure>;
}

async function recipientMembers(client: SaltClient, caller: AgentIdentity, chatId: SaltId) {
  const members = await client.getChatMembers(caller.apiKey, chatId);
  return members.filter((m) => !sameId(m.id, caller.saltAppId) && !(m as { observer?: boolean }).observer);
}

async function encryptToMembers(caller: AgentIdentity, members: Array<{ public_key?: string }>, plaintext: string) {
  const recipientKeys = members.filter((m) => !!m.public_key).map((m) => m.public_key as string);
  if (recipientKeys.length === 0) throw new Error("No one in this chat has a usable public key -- nothing was sent.");
  const message = await pgp.encryptFor(plaintext, recipientKeys);
  const senderMessage = await pgp.encryptFor(plaintext, [caller.publicKey]);
  return { message, senderMessage };
}

/** Builds the {share, ask, decline, disclosures, revoke} surface bound to one client. */
export function createIdentitySharer(client: SaltClient, pgpPassphrase: string): IdentitySharer {
  async function share(caller: AgentIdentity, chatId: SaltId, keys: string[], opts: ShareOptions = {}): Promise<ShareResult> {
    const wanted = (keys || []).map((k) => k.trim()).filter(Boolean);
    if (wanted.length === 0) throw new Error("identity.share needs at least one section key.");
    for (const key of wanted) {
      if (!KEY_RE.test(key)) throw new Error(`identity.share: "${key}" is not a valid section key -- nothing was sent.`);
    }

    const recipients = await recipientMembers(client, caller, chatId);
    if (recipients.length === 0) throw new Error("No one to share with in this chat -- nothing was sent.");

    // This agent's own sections -- refuse locally, before any ledger row is
    // written, for a key this agent hasn't stated at all or has scoped to
    // nobody. (Per-recipient enforcement for a NAMED or verified-contacts
    // scope still happens server-side, at the postIdentityDisclosure call
    // below -- this is only the "does this section exist and are you
    // willing to share it under any circumstance" check.)
    const mine = await client.identity(caller.apiKey);
    const byKey = new Map(mine.sections.map((s) => [s.key, s]));
    const sections: CardSection[] = wanted.map((key) => {
      const section = byKey.get(key);
      if (!section || section.value == null || section.scope === "nobody") {
        throw new Error(`identity.share: "${key}" is not a section this agent shares -- nothing was sent.`);
      }
      const proof = section.kind === "proof" ? (section.checked_by ? { by: section.checked_by } : true) : null;
      return { key, value: section.value, proof };
    });

    // One ledger row per recipient, BEFORE any ciphertext -- abort on the
    // first refusal (plan section 8's "0 bytes of section value reach the
    // server" holds either way: this call sends section KEYS and a scope,
    // never a value).
    const disclosures: Array<{ id: string; recipientId: SaltId }> = [];
    for (const member of recipients) {
      const id = randomUUID();
      await client.postIdentityDisclosure(caller.apiKey, {
        id,
        section_keys: wanted,
        scope: "named",
        chat_id: chatId,
        recipient_id: member.id,
      });
      disclosures.push({ id, recipientId: member.id });
    }

    const signature = await pgp.signDetached(canonicalizeJcs(sections), caller.privateKey, pgpPassphrase);
    // See the module doc comment: the wire message can carry only one id --
    // the first recipient's ledger row stands in for the message as a
    // whole. The 1:1 answer-to-an-ask path (the dominant real caller of
    // this function) always has exactly one recipient.
    const plaintext = formatIdentitySlice(disclosures[0].id, sections, signature, opts.ask);
    const { message, senderMessage } = await encryptToMembers(caller, recipients, plaintext);
    const posted = (await client.postMessage(caller.apiKey, chatId, message, senderMessage)) as { message_id?: SaltId; id?: SaltId } | null;
    const messageId = (posted?.message_id ?? posted?.id) as SaltId;

    for (const d of disclosures) {
      try {
        await client.setIdentityDisclosureMessage(caller.apiKey, d.id, messageId);
      } catch {
        // Best-effort: the slice is already sent and readable either way;
        // a failed PATCH only means this row's audit trail is missing the
        // message_id it would otherwise carry.
      }
    }

    return { messageId, disclosures };
  }

  async function ask(caller: AgentIdentity, chatId: SaltId, keys: string[], text?: string): Promise<string> {
    const wanted = (keys || []).map((k) => k.trim()).filter(Boolean);
    if (wanted.length === 0) throw new Error("identity.ask needs at least one section key.");

    const chat = await client.getChat(caller.apiKey, chatId);
    if (!chat.users || chat.users.length !== 2) {
      throw new Error("identity.ask can only be sent in a 1:1 chat -- nothing was sent.");
    }

    const id = randomUUID();
    const plaintext = formatIdentityAsk(id, wanted, text);
    const others = chat.users.filter((u) => !sameId(u.id, caller.saltAppId));
    const { message, senderMessage } = await encryptToMembers(caller, others, plaintext);
    await client.postMessage(caller.apiKey, chatId, message, senderMessage);
    return id;
  }

  async function decline(caller: AgentIdentity, chatId: SaltId, askId?: string): Promise<{ id: string }> {
    const recipients = await recipientMembers(client, caller, chatId);
    if (recipients.length === 0) throw new Error("No one to decline to in this chat -- nothing was sent.");
    const id = randomUUID();
    const plaintext = formatIdentityDecline(id, askId);
    const { message, senderMessage } = await encryptToMembers(caller, recipients, plaintext);
    await client.postMessage(caller.apiKey, chatId, message, senderMessage);
    return { id };
  }

  async function disclosures(caller: AgentIdentity, opts?: { before?: string; limit?: number }): Promise<IdentityDisclosure[]> {
    const result = await client.listIdentityDisclosures(caller.apiKey, opts);
    return result.disclosures ?? [];
  }

  async function revoke(caller: AgentIdentity, disclosureId: string): Promise<IdentityDisclosure> {
    const row = await client.revokeIdentityDisclosure(caller.apiKey, disclosureId);
    const plaintext = formatIdentityRevoke(disclosureId);
    try {
      const recipients = await recipientMembers(client, caller, row.chat_id);
      if (recipients.length > 0) {
        const { message, senderMessage } = await encryptToMembers(caller, recipients, plaintext);
        await client.postMessage(caller.apiKey, row.chat_id, message, senderMessage);
      }
    } catch {
      // Best-effort: the row is revoked server-side (nothing new will be
      // served for it) even if telling this chat about it right now failed.
    }
    return row;
  }

  return { share, ask, decline, disclosures, revoke };
}
