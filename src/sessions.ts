// A hosted identity's memory of ONE chat: enough of the recent back-and-forth
// and a short structured note to pick a conversation back up -- across a
// process restart (FileSessionStore), and across a hand-off (the note rides
// the outgoing agent's briefing message as a final wire-protocol line and is
// parsed back into the new session on the other end -- see webhook.ts).
//
// This is bookkeeping, not intelligence: nothing here decides what an agent
// says. webhook.ts loads/rebuilds a session before onMessage runs, hands it
// to the consumer as ctx.session (a plain mutable object -- write to
// ctx.session.note directly, e.g. to record who you consulted), and persists
// it after the handler returns. A consumer that ignores ctx.session entirely
// sees no behavior change.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SaltId } from "./ids.js";

export interface SessionTurn {
  role: "user" | "assistant";
  content: string;
  /** epoch ms */
  at: number;
  /** Who said it, for a "user" turn -- a username when known, else an id. Omitted for "assistant" (that's always this identity). */
  from?: string;
  /** Why this delivery reached the identity, on an open room only -- mirrors
   *  webhook.ts's MessageContext.deliveredBecause for a "user" turn rebuilt
   *  from the chat's own history (see rebuildTranscriptTail). Never set on
   *  an "assistant" turn (this identity's own message); omitted for an
   *  ordinary encrypted chat, where the question doesn't apply. */
  deliveredBecause?: "mention" | "reply" | "keyword" | "all";
}

export interface SessionNote {
  /** What this session is trying to accomplish, in the agent's own words. */
  goal?: string;
  /** Set while blocked on something from the person/other party; cleared once they answer. */
  waitingOn?: string;
  /** Every delegate_to_agent / consult_agent call made in service of this session -- oldest first. */
  consulted: Array<{ handle: string; laneId: string }>;
  /** The most recent work.ts report id this session posted, if any -- lets a resumed session keep updating the same report instead of starting a new one. */
  lastReportId?: string;
}

export interface Session {
  /** The room this session ultimately serves -- itself for an ordinary chat, or the shared chat a lane (sidechain/coaching/consult) was opened from. */
  roomId: SaltId;
  /** The actual chat this session's messages arrive/post in -- may be a lane. */
  chatId: SaltId;
  /** This identity's relationship to `chatId`: the active participant ("active"), a lane off some room ("lane" -- Mediator coaching, a translator, a work.ts report lane), a consult lane specifically ("consult"), or present without being the one who speaks ("observer"). Descriptive only -- nothing in this SDK gates behavior on it. */
  role: "active" | "observer" | "consult" | "lane";
  /** Recent turns, oldest first, capped at MAX_TRANSCRIPT_TURNS. */
  transcriptTail: SessionTurn[];
  note: SessionNote;
  /** epoch ms of the last write. */
  updatedAt: number;
}

export interface SessionStore {
  get(identityId: SaltId, chatId: SaltId): Promise<Session | null>;
  put(identityId: SaltId, chatId: SaltId, session: Session): Promise<void>;
  forget(identityId: SaltId, chatId: SaltId): Promise<void>;
}

/** Turns kept per session -- old ones drop off the front, oldest first. */
export const MAX_TRANSCRIPT_TURNS = 40;
/** A note's serialized size budget, in characters. */
export const MAX_NOTE_CHARS = 1200;

const mapKey = (id: SaltId): string => String(id).toLowerCase();

/** A fresh, empty session for `chatId` (in room `roomId`). */
export function emptySession(chatId: SaltId, roomId: SaltId, role: Session["role"] = "active"): Session {
  return { roomId, chatId, role, transcriptTail: [], note: { consulted: [] }, updatedAt: Date.now() };
}

/** Appends one turn in place, dropping the oldest turns past MAX_TRANSCRIPT_TURNS. */
export function appendTurn(session: Session, turn: SessionTurn): void {
  session.transcriptTail.push(turn);
  if (session.transcriptTail.length > MAX_TRANSCRIPT_TURNS) {
    session.transcriptTail.splice(0, session.transcriptTail.length - MAX_TRANSCRIPT_TURNS);
  }
}

/**
 * Returns a copy of `note` whose serialized JSON fits MAX_NOTE_CHARS,
 * dropping the OLDEST `consulted` entries first -- `goal`/`waitingOn`/
 * `lastReportId` are the actual point of the note and are never what gets
 * cut to make room. If it's still over budget with nothing left to drop,
 * returns it as-is: that's a caller writing an oversized goal/waitingOn
 * string, which no amount of trimming `consulted` will fix.
 */
export function boundNote(note: SessionNote): SessionNote {
  const bounded: SessionNote = { ...note, consulted: [...(note.consulted || [])] };
  while (JSON.stringify(bounded).length > MAX_NOTE_CHARS && bounded.consulted.length > 0) {
    bounded.consulted.shift();
  }
  return bounded;
}

/**
 * In-memory session store -- the default. Sessions are lost on process
 * restart (a cold-start rebuild from chat history fills the gap -- see
 * webhook.ts's loadOrRebuildSession).
 */
export function MemorySessionStore(): SessionStore {
  const store = new Map<string, Session>();
  const key = (identityId: SaltId, chatId: SaltId) => `${mapKey(identityId)}:${mapKey(chatId)}`;
  return {
    async get(identityId, chatId) {
      return store.get(key(identityId, chatId)) ?? null;
    },
    async put(identityId, chatId, session) {
      store.set(key(identityId, chatId), session);
    },
    async forget(identityId, chatId) {
      store.delete(key(identityId, chatId));
    },
  };
}

// --- FileSessionStore ----------------------------------------------------

function fileFor(dir: string, identityId: SaltId, chatId: SaltId): string {
  const safe = (id: SaltId) => mapKey(id).replace(/[^a-z0-9_-]/g, "_");
  return path.join(dir, `${safe(identityId)}__${safe(chatId)}.json`);
}

/**
 * One plain JSON file per (identity, chat) under `dir`, written atomically
 * (temp file + rename, so a crash mid-write never leaves a half-written
 * session on disk -- the same convention identities.ts uses for its own
 * store).
 *
 * TRUST BOUNDARY, stated plainly: sessions are stored in PLAINTEXT on this
 * filesystem, right beside the identities.json this same process already
 * keeps there (which holds every hosted identity's PRIVATE PGP KEY). This
 * store adds no encryption of its own -- it is exactly as trusted as the
 * disk it's on, which is the same trust level the rest of this process
 * already assumes. Fine for a single-tenant agent host's own local/attached
 * disk; do not point `dir` at shared or otherwise untrusted storage, and
 * do not treat a session file as safe to hand to anyone Salt itself
 * couldn't already show the conversation to.
 */
export function FileSessionStore(dir: string): SessionStore {
  return {
    async get(identityId, chatId) {
      try {
        const raw = await fs.readFile(fileFor(dir, identityId, chatId), "utf8");
        return JSON.parse(raw) as Session;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    async put(identityId, chatId, session) {
      await fs.mkdir(dir, { recursive: true });
      const target = fileFor(dir, identityId, chatId);
      const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(session, null, 2));
      await fs.rename(tmp, target);
    },
    async forget(identityId, chatId) {
      try {
        await fs.unlink(fileFor(dir, identityId, chatId));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}

// --- Hand-off session note wire format -------------------------------------
//
// A hand-off briefing's FINAL line, appended by webhook.ts's
// handleHandoffConfirmed to whatever text the consumer's onHandoffConfirmed
// sent -- transparent to that consumer. The incoming agent's
// handleHandoffReceived parses it back out of the polled transcript (see
// HANDOFF_BRIEFING_MARKER in webhook.ts) into the new session's note, then
// strips the line before handing the transcript to onHandoffReceived: it's
// wire protocol, never conversational content. salt-fe strips the same line
// from what a human reads.

export const SESSION_NOTE_MARKER = "[[SALT-SESSION-NOTE]]";

const SESSION_NOTE_LINE_RE = /^\[\[SALT-SESSION-NOTE\]\] (.+)$/gm;

/**
 * A session note's wire line, or undefined when there's nothing worth
 * carrying forward (an empty note would just be noise on every hand-off).
 */
export function formatSessionNoteLine(note: SessionNote | undefined | null): string | undefined {
  if (!note) return undefined;
  const hasContent = !!(note.goal || note.waitingOn || note.lastReportId || (note.consulted && note.consulted.length > 0));
  if (!hasContent) return undefined;
  return `${SESSION_NOTE_MARKER} ${JSON.stringify(boundNote(note))}`;
}

/** The LAST [[SALT-SESSION-NOTE]] line's parsed payload in `text`, or undefined if there isn't one or it doesn't parse. */
export function extractSessionNote(text: string): SessionNote | undefined {
  const matches = [...text.matchAll(SESSION_NOTE_LINE_RE)];
  if (matches.length === 0) return undefined;
  try {
    return JSON.parse(matches[matches.length - 1][1]) as SessionNote;
  } catch {
    return undefined;
  }
}

/** Removes every [[SALT-SESSION-NOTE]] line from `text` -- wire protocol, not conversational content. */
export function stripSessionNoteLines(text: string): string {
  return text
    .replace(/^\[\[SALT-SESSION-NOTE\]\].*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
