// Who is in this chat? Ask Salt's own record of it.
//
// Privacy-sensitive actions -- running a tool on a person's computer, reading
// out what they told you in private -- must be decided from Salt's chat
// record: fetch `GET /api/v1/chats/:id` with client.getChatRecord when you
// need it. NEVER from a cache, a memory service or a roster you built
// earlier. Those are fast when they are right
// and wrong when they are slow or stale, and a wrong answer here is a privacy
// error in one direction and a dead feature in the other: a slow memory
// service once switched a person's computer tools off inside their own 1:1.
//
// isPrivateChat mirrors salt-personal-agent's brain.chat_is_private, with one
// addition (no observer at all), and fails closed: anything the record cannot
// show is NOT private.

import { sameId, type SaltId } from "./ids.js";

/** The slice of a chat record isPrivateChat reads: the `session` block of `GET /api/v1/chats/:id`. */
export interface ChatRecord {
  session?: {
    public?: boolean;
    encrypted?: boolean;
    users?: Array<{ id?: SaltId; observer?: boolean; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * True only when this chat is private to `speakerId` and `myId`: encrypted,
 * not public, and its members are exactly those two -- a 1:1 or a private
 * lane (sidechain, advisor) -- with no observer among them, silent or not.
 *
 * - `encrypted` must not be `false`. An absent flag means an ordinary
 *   encrypted chat (a server that predates open rooms), as everywhere else in
 *   this SDK.
 * - `public` must not be true.
 * - `session.users` must be a list, every entry with an id. A record with no
 *   `session`, no member list, or a member without an id is not private.
 * - Any member flagged `observer` makes it not private (brain.chat_is_private
 *   ignores observers; this does not -- someone who can read the chat is in it).
 * - `speakerId` and `myId` must both be given.
 *
 * Ids compare case-insensitively (see sameId in ids.ts). The speaker and `myId` must be two different accounts.
 */
export function isPrivateChat(chat: ChatRecord | null | undefined, speakerId: SaltId | null | undefined, myId: SaltId | null | undefined): boolean {
  if (!chat || typeof chat !== "object" || !speakerId || !myId || sameId(speakerId, myId)) return false;
  const session = chat.session;
  if (!session || typeof session !== "object") return false;
  if (session.public) return false;
  if (session.encrypted === false) return false;
  const users = session.users;
  if (!Array.isArray(users)) return false;

  const ids: string[] = [];
  for (const u of users) {
    if (!u || typeof u !== "object" || u.id == null || u.id === "") return false;
    if (u.observer) return false;
    ids.push(String(u.id).toLowerCase());
  }
  const members = new Set(ids);
  return members.size === 2 && members.has(String(speakerId).toLowerCase()) && members.has(String(myId).toLowerCase());
}
