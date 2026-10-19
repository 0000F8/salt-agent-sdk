// Work reports: how an agent keeps ONE person up to date on work it is doing
// for them -- asking another agent, a long lookup, a step that needs them --
// without saying any of it in the conversation.
//
// A report is an ordinary Salt message, end-to-end encrypted, posted into the
// private lane (a sidechain, Chat.coaching_for_chat_id) the agent shares with
// that person under the chat the work came from. Salt's web app reads the
// marker, keeps the report out of the thread, and gathers every report for a
// chat into that chat's Tasks panel, newest status per id. Nobody else in the
// chat is a member of the lane, so nobody else can read it, and Salt's server
// only ever sees ciphertext. Reports are sent `quiet` (no push) except a
// `waiting` one, which is the agent needing the person.
//
// Wire format, one message per status change:
//
//   [[SALT-WORK id=w_3f9a2c status=running kind=delegation with=weather]]
//   Asking @weather
//   What's the forecast for Lisbon tomorrow?
//
// Line 1 is the marker: `id` names one piece of work across its reports,
// `status` is running | waiting | done | failed | scheduled | cancelled,
// `kind` (delegation | task) and `with` (a handle, for a delegation) are
// optional; `scheduled` work (set to happen later, e.g. a reminder) carries
// `due=<ISO 8601 UTC>` so the panel says when it is due, and optionally
// `repeat=<hourly|daily|weekdays|weekly|monthly>` when it recurs (unknown
// values are ignored -- tolerant parse). Line 2 is a short title. Anything
// after is detail. The web app's parser lives in salt-fe
// `src/utilities/work.js`; keep the two in step.
//
// An optional `advantage: {json}` line may follow the title (DYNAMIC_ADVANTAGE
// phase 1): what has been shown to work, `{"edges":[{"label","edge","n"}],
// "open":[],"settled":[],"testing":[],"kept":[],"dropped":[],"explore":0.2}`,
// at most 8 edges sorted by edge, 4000 characters (formatAdvantage drops the
// lowest-n edges until it fits). Phase 1 fills `edges` and `explore` only.
// salt-fe reads it in `parseAdvantage`; Grains writes the same line into the
// reports it makes.
//
// Cancel (person -> agent), a WHOLE message on its own, sent into the same
// lane a `scheduled` report came from:
//
//   [[SALT-WORK-CANCEL id=w_3f9a2c]]
//
// parseWorkCancel below reads it; webhook.ts intercepts it before it would
// otherwise reach onMessage (see WebhookServerOptions.onWorkCancel) and the
// usual answer is a fresh report under the same id with status=cancelled.

import { randomBytes } from "node:crypto";
import type { SaltClient } from "./client";
import * as pgp from "./crypto";
import type { AgentIdentity } from "./identities";
import { sameId, type SaltId } from "./ids.js";

export type WorkStatus = "running" | "waiting" | "done" | "failed" | "scheduled" | "cancelled";
export type WorkKind = "delegation" | "task";
export type WorkRepeat = "hourly" | "daily" | "weekdays" | "weekly" | "monthly";

export const WORK_STATUSES: readonly WorkStatus[] = ["running", "waiting", "done", "failed", "scheduled", "cancelled"];
export const WORK_KINDS: readonly WorkKind[] = ["delegation", "task"];
export const WORK_REPEATS: readonly WorkRepeat[] = ["hourly", "daily", "weekdays", "weekly", "monthly"];

export const MAX_WORK_TITLE = 140;
export const MAX_WORK_DETAIL = 500;

export const MAX_ADVANTAGE_CHARS = 4000;
export const MAX_ADVANTAGE_EDGES = 8;

export interface AdvantageEdge {
  /** The kind of move, in words or snake_case labels ("post_to_profile · hacker_news · founders"). */
  label: string;
  /** How many times the agent's average result it earns (1.8 = 1.8x). */
  edge: number;
  /** Moves behind it. */
  n: number;
}

export interface Advantage {
  edges: AdvantageEdge[];
  /** Phase 2 keys: written empty today, kept as sent when read. */
  open?: unknown[];
  settled?: unknown[];
  testing?: unknown[];
  kept?: unknown[];
  dropped?: unknown[];
  /** Share of effort spent trying new things, 0 to 1. */
  explore?: number;
}

export interface WorkReport {
  id: string;
  status: WorkStatus;
  kind?: WorkKind;
  /** A handle, without the @, for a delegation. */
  with?: string;
  title: string;
  detail?: string;
  /** When scheduled work comes due, ISO 8601 UTC. */
  due?: string;
  /** Only meaningful alongside status "scheduled" -- how often it recurs. */
  repeat?: WorkRepeat;
  /** The confirmed transfer behind money work (`transfer=<id>`); salt-fe reads the receipt row from it. */
  transfer?: string;
  /** What has been shown to work, as the `advantage:` line after the title. */
  advantage?: Advantage;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const MARKER_RE = /^\[\[SALT-WORK ([^\]\n]*)\]\]\n?/;
const DUE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const CANCEL_MARKER_RE = /^\[\[SALT-WORK-CANCEL id=([A-Za-z0-9_-]{1,64})\]\]$/;

/** A fresh id for one piece of work. */
export function newWorkId(): string {
  return `w_${randomBytes(6).toString("hex")}`;
}

const oneLine = (text: string | undefined, max: number): string =>
  (text || "").replace(/\s+/g, " ").trim().slice(0, max);

/** The `advantage:` JSON for a report: edges sorted by edge (highest first),
 *  at most 8, the lowest-n edge dropped until it fits 4000 characters, the
 *  phase 2 keys present and empty. Null when the input has no usable shape. */
export function formatAdvantage(advantage: Advantage | null | undefined): string | null {
  if (!advantage || !Array.isArray(advantage.edges)) return null;
  const edges = advantage.edges
    .map((e) => ({ label: oneLine(e && e.label, 120), edge: Number(e && e.edge), n: Number(e && e.n) }))
    .filter((e) => e.label && Number.isFinite(e.edge) && e.edge > 0 && Number.isFinite(e.n) && e.n >= 0)
    .sort((a, b) => b.edge - a.edge)
    .slice(0, MAX_ADVANTAGE_EDGES);
  const explore = Number(advantage.explore);
  const build = () =>
    JSON.stringify({
      edges,
      open: [],
      settled: [],
      testing: [],
      kept: [],
      dropped: [],
      explore: Number.isFinite(explore) ? explore : 0,
    });
  let json = build();
  while (json.length > MAX_ADVANTAGE_CHARS && edges.length) {
    let lowest = 0;
    edges.forEach((e, i) => { if (e.n < edges[lowest].n) lowest = i; });
    edges.splice(lowest, 1);
    json = build();
  }
  return json.length > MAX_ADVANTAGE_CHARS ? null : json;
}

/** The value of an `advantage:` line, as an Advantage, or null (bad JSON, wrong shape, over the cap). */
export function parseAdvantage(value: string): Advantage | null {
  if (!value || value.length > MAX_ADVANTAGE_CHARS) return null;
  let raw: any;
  try { raw = JSON.parse(value); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.edges)) return null;
  const edges: AdvantageEdge[] = raw.edges
    .map((e: any) => ({ label: oneLine(e && e.label, 120), edge: Number(e && e.edge), n: Number(e && e.n) }))
    .filter((e: AdvantageEdge) => e.label && Number.isFinite(e.edge) && e.edge > 0 && Number.isFinite(e.n) && e.n >= 0)
    .slice(0, MAX_ADVANTAGE_EDGES);
  const advantage: Advantage = { edges };
  for (const key of ["open", "settled", "testing", "kept", "dropped"] as const) {
    if (Array.isArray(raw[key])) advantage[key] = raw[key];
  }
  const explore = Number(raw.explore);
  if (raw.explore != null && Number.isFinite(explore)) advantage.explore = explore;
  return advantage;
}

const ADVANTAGE_LINE_RE = /^advantage:[ \t]*(.*)$/;

/** The plaintext of one report. Throws on a malformed id or status. */
export function formatWorkReport(report: WorkReport): string {
  if (!ID_RE.test(report.id || "")) throw new Error("A work report needs an id of letters, digits, _ or -.");
  if (!WORK_STATUSES.includes(report.status)) throw new Error(`status must be one of ${WORK_STATUSES.join(", ")}.`);
  const attrs = [`id=${report.id}`, `status=${report.status}`];
  if (report.kind && WORK_KINDS.includes(report.kind)) attrs.push(`kind=${report.kind}`);
  const handle = (report.with || "").replace(/^@/, "");
  if (handle && HANDLE_RE.test(handle)) attrs.push(`with=${handle}`);
  if (report.due && DUE_RE.test(report.due)) attrs.push(`due=${report.due}`);
  if (report.repeat && WORK_REPEATS.includes(report.repeat)) attrs.push(`repeat=${report.repeat}`);
  if (report.transfer && ID_RE.test(report.transfer)) attrs.push(`transfer=${report.transfer}`);
  const title = oneLine(report.title, MAX_WORK_TITLE);
  if (!title) throw new Error("A work report needs a title.");
  const detail = (report.detail || "").trim().slice(0, MAX_WORK_DETAIL);
  const advantage = formatAdvantage(report.advantage);
  return `[[SALT-WORK ${attrs.join(" ")}]]\n${title}${advantage ? `\nadvantage: ${advantage}` : ""}${detail ? `\n${detail}` : ""}`;
}

/** The report in a plaintext, or null when it is not one. */
export function parseWorkReport(plaintext: string): WorkReport | null {
  const match = MARKER_RE.exec(plaintext || "");
  if (!match) return null;
  const attrs: Record<string, string> = {};
  match[1].split(/\s+/).forEach((pair) => {
    const eq = pair.indexOf("=");
    if (eq > 0) attrs[pair.slice(0, eq)] = pair.slice(eq + 1);
  });
  const status = attrs.status as WorkStatus;
  if (!ID_RE.test(attrs.id || "") || !WORK_STATUSES.includes(status)) return null;
  const [title, ...rest] = plaintext.slice(match[0].length).split("\n");
  const report: WorkReport = { id: attrs.id, status, title: (title || "").trim() };
  if (WORK_KINDS.includes(attrs.kind as WorkKind)) report.kind = attrs.kind as WorkKind;
  if (attrs.with && HANDLE_RE.test(attrs.with)) report.with = attrs.with;
  if (attrs.due && DUE_RE.test(attrs.due) && !Number.isNaN(Date.parse(attrs.due))) report.due = attrs.due;
  if (WORK_REPEATS.includes(attrs.repeat as WorkRepeat)) report.repeat = attrs.repeat as WorkRepeat;
  if (attrs.transfer && ID_RE.test(attrs.transfer)) report.transfer = attrs.transfer;
  const kept: string[] = [];
  rest.forEach((line) => {
    const m = ADVANTAGE_LINE_RE.exec(line.trim());
    if (!m) { kept.push(line); return; }
    const advantage = parseAdvantage(m[1].trim());
    if (advantage) report.advantage = advantage;
  });
  const detail = kept.join("\n").trim();
  if (detail) report.detail = detail;
  return report;
}

/** The work id from a `[[SALT-WORK-CANCEL id=...]]` marker -- the person
 *  cancelling a `scheduled` report of theirs, sent as a whole message into
 *  the same lane the report came from -- or null when `plaintext` is not
 *  one. See webhook.ts's `onWorkCancel`, which intercepts this marker
 *  before it would otherwise reach `onMessage`. */
export function parseWorkCancel(plaintext: string): string | null {
  const match = CANCEL_MARKER_RE.exec((plaintext || "").trim());
  return match ? match[1] : null;
}

export interface WorkTarget {
  /** The chat the work came from. */
  chatId: SaltId;
  /** The person the work is for. */
  requesterId: SaltId;
}

interface Lane {
  id: SaltId;
  keys: string[];
}

/**
 * Posts reports into the private lane with the person the work is for. The
 * lane is get-or-created once per (agent, chat, person) and remembered. When
 * the work came from inside a lane already (the person answered a `waiting`
 * report there), the report goes into that lane.
 *
 * `report` never throws: a report that cannot be delivered must not fail the
 * work it describes. It resolves true when the report was posted.
 */
export function createWorkReporter(client: SaltClient) {
  const lanes = new Map<string, Lane>();
  const key = (caller: AgentIdentity, target: WorkTarget) =>
    `${caller.saltAppId}:${target.chatId}:${target.requesterId}`.toLowerCase();

  const recipientKeys = (users: Array<Record<string, any>> | undefined, caller: AgentIdentity) =>
    (users || []).filter((u) => !sameId(u.id, caller.saltAppId) && u.public_key).map((u) => u.public_key as string);

  async function laneFor(caller: AgentIdentity, target: WorkTarget): Promise<Lane> {
    const cached = lanes.get(key(caller, target));
    if (cached) return cached;
    let lane: Lane;
    try {
      const res = (await client.openSidechain(caller.apiKey, target.chatId, target.requesterId)) as { session?: { id: SaltId; users?: Array<Record<string, any>> } };
      if (!res || !res.session) throw new Error("No lane came back.");
      lane = { id: res.session.id, keys: recipientKeys(res.session.users, caller) };
    } catch (err) {
      // 422 "This is already a private lane.": the work came from inside one.
      const status = (err as { status?: number }).status;
      if (status !== 422) throw err;
      const members = await client.getChatMembers(caller.apiKey, target.chatId);
      if (members.length !== 2) throw err;
      lane = { id: target.chatId, keys: recipientKeys(members as Array<Record<string, any>>, caller) };
    }
    if (!lane.keys.length) throw new Error("The person has no usable public key.");
    lanes.set(key(caller, target), lane);
    return lane;
  }

  async function report(caller: AgentIdentity, target: WorkTarget, workReport: WorkReport): Promise<boolean> {
    try {
      const plaintext = formatWorkReport(workReport);
      const lane = await laneFor(caller, target);
      const message = await pgp.encryptFor(plaintext, lane.keys);
      const senderMessage = await pgp.encryptFor(plaintext, [caller.publicKey]);
      await client.postMessage(caller.apiKey, lane.id, message, senderMessage, undefined, undefined, {
        quiet: workReport.status !== "waiting",
      });
      return true;
    } catch {
      return false;
    }
  }

  return { report, forget: () => lanes.clear() };
}

export type WorkReporter = ReturnType<typeof createWorkReporter>;
