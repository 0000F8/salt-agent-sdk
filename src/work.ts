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
// lowest-n edges, then the oldest rows, until it fits). Phase 2 fills the
// lists: open [{q, by}], settled [{q, verdict, lift}], testing and kept
// [{id, text, lift}], dropped [{text, lift, why}]; an edge may carry its
// `arm_key` and a lens its `id` so the owner's taps can name them (see
// formatAdvantageTap below).
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
  /** The kind of move's key; lets "Never this" (SALT-ADV-NEVER kind=arm) name it. */
  arm_key?: string;
}

export type AdvantageVerdict = "supported" | "refuted" | "inconclusive";

/** An open question: what is being asked and by when it will be answered. */
export interface AdvantageQuestion { q: string; by?: string }
/** A settled question and what the test said. */
export interface AdvantageSettled { q: string; verdict: AdvantageVerdict; lift?: number }
/** A way of thinking being tried or kept; `id` lets the taps name it. */
export interface AdvantageLens { id?: string; text: string; lift?: number }
/** A dropped way of thinking and why. */
export interface AdvantageDropped { text: string; lift?: number; why?: string }

export interface Advantage {
  edges: AdvantageEdge[];
  open?: AdvantageQuestion[];
  settled?: AdvantageSettled[];
  testing?: AdvantageLens[];
  kept?: AdvantageLens[];
  dropped?: AdvantageDropped[];
  /** Share of effort spent trying new things, 0 to 1. */
  explore?: number;
}

const ADVANTAGE_LISTS = ["open", "settled", "testing", "kept", "dropped"] as const;
const ADVANTAGE_LIST_MAX = 10;
const ADV_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ADV_VERDICTS: readonly string[] = ["supported", "refuted", "inconclusive"];

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

const posNum = (v: unknown): number | undefined => {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n > 0 ? n : undefined;
};
const advId = (v: unknown): string | undefined => (typeof v === "string" && ADV_ID_RE.test(v) ? v : undefined);

// One normaliser for both directions: bad rows dropped, text one line and capped, lists capped.
function normaliseAdvantage(raw: any): Advantage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.edges)) return null;
  const list = (v: unknown): any[] => (Array.isArray(v) ? v.slice(0, ADVANTAGE_LIST_MAX) : []);
  const edges: AdvantageEdge[] = raw.edges
    .map((e: any) => {
      const edge: AdvantageEdge = { label: oneLine(e && e.label, 120), edge: Number(e && e.edge), n: Number(e && e.n) };
      const key = advId(e && e.arm_key);
      if (key) edge.arm_key = key;
      return edge;
    })
    .filter((e: AdvantageEdge) => e.label && Number.isFinite(e.edge) && e.edge > 0 && Number.isFinite(e.n) && e.n >= 0);
  const lens = (x: any): AdvantageLens => {
    const out: AdvantageLens = { text: oneLine(x && (x.text || x.label), 160) };
    const id = advId(x && x.id);
    if (id) out.id = id;
    const lift = posNum(x && x.lift);
    if (lift !== undefined) out.lift = lift;
    return out;
  };
  const advantage: Advantage = {
    edges,
    open: list(raw.open).map((x) => ({ q: oneLine(x && x.q, 200), by: oneLine(x && x.by, 40) || undefined })).filter((x) => x.q),
    settled: list(raw.settled)
      .map((x) => ({ q: oneLine(x && x.q, 200), verdict: x && x.verdict, lift: posNum(x && x.lift) }))
      .filter((x) => x.q && ADV_VERDICTS.includes(x.verdict)),
    testing: list(raw.testing).map(lens).filter((x) => x.text),
    kept: list(raw.kept).map(lens).filter((x) => x.text),
    dropped: list(raw.dropped)
      .map((x) => ({ text: oneLine(x && (x.text || x.label), 160), lift: posNum(x && x.lift), why: oneLine(x && x.why, 200) || undefined }))
      .filter((x) => x.text),
  };
  const explore = Number(raw.explore);
  if (raw.explore != null && Number.isFinite(explore)) advantage.explore = explore;
  return advantage;
}

/** The `advantage:` JSON for a report: edges sorted by edge (highest first),
 *  at most 8, every list present (empty when unused), and 4000 characters at
 *  most -- when it runs over, the lowest-n edge goes first, then the oldest
 *  row of the longest other list. Null when the input has no usable shape. */
export function formatAdvantage(advantage: Advantage | null | undefined): string | null {
  const a = normaliseAdvantage(advantage);
  if (!a) return null;
  a.edges = a.edges.sort((x, y) => y.edge - x.edge).slice(0, MAX_ADVANTAGE_EDGES);
  const build = () => JSON.stringify({ ...a, explore: a.explore ?? 0 });
  let json = build();
  while (json.length > MAX_ADVANTAGE_CHARS) {
    if (a.edges.length) {
      let lowest = 0;
      a.edges.forEach((e, i) => { if (e.n < a.edges[lowest].n) lowest = i; });
      a.edges.splice(lowest, 1);
    } else {
      const longest = ADVANTAGE_LISTS.reduce((best, k) => ((a[k] as unknown[]).length > (a[best] as unknown[]).length ? k : best), ADVANTAGE_LISTS[0]);
      if (!(a[longest] as unknown[]).length) break;
      (a[longest] as unknown[]).shift();
    }
    json = build();
  }
  return json.length > MAX_ADVANTAGE_CHARS ? null : json;
}

/** The value of an `advantage:` line, as an Advantage, or null (bad JSON, wrong shape, over the cap). */
export function parseAdvantage(value: string): Advantage | null {
  if (!value || value.length > MAX_ADVANTAGE_CHARS) return null;
  let raw: any;
  try { raw = JSON.parse(value); } catch { return null; }
  const advantage = normaliseAdvantage(raw);
  if (advantage) advantage.edges = advantage.edges.slice(0, MAX_ADVANTAGE_EDGES);
  return advantage;
}

// The person's two taps on What's working (ADVANTAGE_P2_CONTRACT flow C): a
// whole message from the person, one exact token, sent into the lane the
// plan's reports come from. The runtime acts only when the speaker is the
// owner (or the person the plan serves).
//   [[SALT-ADV-NEVER kind=arm key=<arm_key>]]    never this kind of move
//   [[SALT-ADV-NEVER kind=lens id=<lens_id>]]    never this way of thinking
//   [[SALT-ADV-KEEP kind=lens id=<lens_id>]]     keep going with it
export type AdvantageTapAction = "never" | "keep";
export type AdvantageTapKind = "arm" | "lens";
export interface AdvantageTap { action: AdvantageTapAction; kind: AdvantageTapKind; ref: string }

const ADV_TAP_RE = /^\[\[SALT-ADV-(NEVER|KEEP) kind=(arm key|lens id)=([A-Za-z0-9_-]{1,64})\]\]$/;

/** The wire message for a tap. Throws on a combination the protocol does not have (keep goes with a lens only) or a bad ref. */
export function formatAdvantageTap(tap: AdvantageTap): string {
  if (!ADV_ID_RE.test(tap.ref || "")) throw new Error("A tap needs a key or id of letters, digits, _ or -.");
  if (tap.action !== "never" && tap.action !== "keep") throw new Error("action must be never or keep.");
  if (tap.kind !== "arm" && tap.kind !== "lens") throw new Error("kind must be arm or lens.");
  if (tap.action === "keep" && tap.kind !== "lens") throw new Error("Keep going names a lens.");
  return `[[SALT-ADV-${tap.action.toUpperCase()} kind=${tap.kind} ${tap.kind === "arm" ? "key" : "id"}=${tap.ref}]]`;
}

/** The tap in a whole message, or null when the text is not exactly one. */
export function parseAdvantageTap(plaintext: string): AdvantageTap | null {
  const m = ADV_TAP_RE.exec((plaintext || "").trim());
  if (!m) return null;
  const tap = { action: m[1].toLowerCase() as AdvantageTapAction, kind: m[2].split(" ")[0] as AdvantageTapKind, ref: m[3] };
  return tap.action === "keep" && tap.kind !== "lens" ? null : tap;
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

// --- Reading the plan's report back (Salt 0.243.0) --------------------------
// A plan's report is a work report with `kind=strategy` and a `strategy: {json}`
// line, posted into the private lane (see top of file). The person's web app
// reads it; `readPlanReport` lets the agent that wrote it, or any agent in the
// lane, read the latest one back with its own key. Salt only ever holds the
// ciphertext, so this fetches the lane's messages and decrypts them here. The
// JSON is returned as the writer sent it (salt-fe `parseStrategy` is the
// reference reader for its fields); only the marker is checked.

export const STRATEGY_REPORT_STATUSES = ["attempting", "blocked", "succeeded", "abandoned", "superseded"] as const;
export type StrategyReportStatus = (typeof STRATEGY_REPORT_STATUSES)[number];
const STRATEGY_JSON_MAX = 20000;

/** One `strategy` work report, as decrypted. `strategy` is the `strategy: {json}` line's object, untouched. */
export interface PlanReport {
  /** The work id from the marker (the strategy id when the writer used one). */
  id: string;
  status: StrategyReportStatus;
  title: string;
  /** Free text after the title, if any. */
  detail?: string;
  strategy: Record<string, unknown> & {
    strategy_id?: string;
    mandate_id?: string;
    goal?: string;
    next_check_in?: string;
    progress?: Array<{ metric: string; actual: number | null; target: number | null; unit?: string; source_label?: string }>;
    steps?: Array<{ text: string; state: string; at?: string }>;
    targets?: Array<Record<string, unknown>>;
  };
  /** The lane message it came from, and when it was posted, as Salt sent them. */
  messageId?: SaltId;
  createdAt?: string;
}

/** The plan report in a plaintext, or null when it is not a `kind=strategy` report with a readable `strategy:` line. */
export function parsePlanReport(plaintext: string): PlanReport | null {
  const match = MARKER_RE.exec(plaintext || "");
  if (!match) return null;
  const attrs: Record<string, string> = {};
  match[1].split(/\s+/).forEach((pair) => {
    const eq = pair.indexOf("=");
    if (eq > 0) attrs[pair.slice(0, eq)] = pair.slice(eq + 1);
  });
  if (attrs.kind !== "strategy" || !ID_RE.test(attrs.id || "")) return null;
  const [title, ...rest] = plaintext.slice(match[0].length).split("\n");
  let strategy: PlanReport["strategy"] | null = null;
  const kept: string[] = [];
  rest.forEach((line) => {
    const m = /^strategy:[ \t]*(.*)$/.exec(line.trim());
    if (!m) { kept.push(line); return; }
    const raw = m[1].trim();
    if (!raw || raw.length > STRATEGY_JSON_MAX) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) strategy = parsed;
    } catch { /* a malformed line is no strategy */ }
  });
  if (!strategy) return null;
  const inner = strategy as PlanReport["strategy"] & { status?: string };
  const status = (STRATEGY_REPORT_STATUSES as readonly string[]).includes(inner.status as string) ? inner.status : attrs.status;
  if (!(STRATEGY_REPORT_STATUSES as readonly string[]).includes(status as string)) return null;
  const report: PlanReport = { id: attrs.id, status: status as StrategyReportStatus, title: (title || "").trim(), strategy: inner };
  const detail = kept.join("\n").trim();
  if (detail) report.detail = detail;
  return report;
}

/**
 * The latest `strategy` work report in the private lane with `requesterId` under `chatId`, decrypted with the identity's own key
 * (`passphrase` is the one its key was made with). Without `requesterId`, `chatId` is read as the lane itself. Opens the lane if it
 * does not exist yet (get-or-create, like posting a report does), so it needs a chat you are a member of. `strategyId` keeps only
 * reports of that plan. Resolves to null when the lane holds none; a message that cannot be opened with this key (it predates it) is
 * skipped, never fatal. HTTP errors (no such chat, not a member) are thrown as `SaltApiError`.
 */
export async function readPlanReport(
  client: SaltClient,
  identity: Pick<AgentIdentity, "apiKey" | "privateKey">,
  chatId: SaltId,
  opts: { passphrase: string; requesterId?: SaltId; strategyId?: string }
): Promise<PlanReport | null> {
  let laneId = chatId;
  if (opts.requesterId !== undefined) {
    try {
      const res = (await client.openSidechain(identity.apiKey, chatId, opts.requesterId)) as { session?: { id: SaltId } };
      if (res?.session?.id !== undefined) laneId = res.session.id;
    } catch (err) {
      // 422 "This is already a private lane.": chatId is the lane.
      if ((err as { status?: number }).status !== 422) throw err;
    }
  }
  const messages = (await client.getChatMessages(identity.apiKey, laneId)) as Array<{ id?: SaltId; message?: unknown; encrypted?: boolean; event_type?: string; created_at?: string }>;
  let latest: PlanReport | null = null;
  for (const m of messages) {
    if (!m || m.event_type || typeof m.message !== "string") continue;
    let plaintext: string;
    if (m.encrypted === false) plaintext = m.message;
    else {
      if (!/^-----BEGIN PGP MESSAGE-----/.test(m.message.trim())) continue;
      try {
        plaintext = await pgp.decrypt(m.message, identity.privateKey, opts.passphrase);
      } catch {
        continue;
      }
    }
    const report = parsePlanReport(plaintext);
    if (!report) continue;
    if (opts.strategyId && (report.strategy.strategy_id ?? report.id) !== opts.strategyId) continue;
    const at = m.created_at && !Number.isNaN(Date.parse(m.created_at)) ? Date.parse(m.created_at) : null;
    const latestAt = latest?.createdAt ? Date.parse(latest.createdAt) : null;
    // Chat order is oldest first; a later message wins unless both carry times and it is older.
    if (latest && at !== null && latestAt !== null && at < latestAt) continue;
    latest = { ...report, ...(m.id !== undefined ? { messageId: m.id } : {}), ...(m.created_at ? { createdAt: m.created_at } : {}) };
  }
  return latest;
}
