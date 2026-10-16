// The `[[SALT-HELP reason=...]]` marker (Show Me, CONTRACT.md section 1).
//
// An agent that is stuck asks a person for help with an ordinary end-to-end
// encrypted message in its 1:1 with them. The first line is the marker; the
// rest is the question in plain words. Salt never parses it: the server only
// learns that a help request exists (ids and a reason) from POST /help_requests.
// salt-fe strips the marker line from every human-facing view and shows the
// question.
//
// Pure: encode and decode only.

export const HELP_REASONS = ["stuck", "which", "unclear", "look"] as const;
export type HelpReason = (typeof HELP_REASONS)[number];

/** The question is at most this many characters (Unicode code points). */
export const HELP_QUESTION_MAX = 500;

export interface HelpMessage {
  reason: HelpReason;
  question: string;
}

const HELP_RE = /^\[\[SALT-HELP reason=([a-z]+)\]\][ \t]*(?:\r?\n([\s\S]*))?$/;

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** True when the text opens with the SALT-HELP marker (well formed or not). */
export function isHelpMessage(plaintext: string): boolean {
  return plaintext.trimStart().startsWith("[[SALT-HELP");
}

/** The plaintext of a help question. Throws on an unknown reason, an empty question or one
 *  over 500 characters (nothing is cut off silently). */
export function encodeHelp(h: { reason: HelpReason; question: string }): string {
  if (!HELP_REASONS.includes(h.reason)) throw new Error(`help reason must be one of ${HELP_REASONS.join(", ")}`);
  const question = typeof h.question === "string" ? h.question.trim() : "";
  if (question === "") throw new Error("a help question cannot be empty");
  if (codePoints(question) > HELP_QUESTION_MAX) throw new Error(`a help question is at most ${HELP_QUESTION_MAX} characters`);
  return `[[SALT-HELP reason=${h.reason}]]\n${question}`;
}

/** Parse a decrypted message. Null when it is not a help message, or when it opens with the
 *  marker but is malformed (unknown reason, empty or over-long question): a reader treats
 *  that as ordinary text. */
export function decodeHelp(plaintext: string): HelpMessage | null {
  const trimmed = plaintext.trimStart();
  if (!trimmed.startsWith("[[SALT-HELP")) return null;
  const m = HELP_RE.exec(trimmed);
  if (!m) return null;
  if (!HELP_REASONS.includes(m[1] as HelpReason)) return null;
  const question = (m[2] ?? "").trim();
  if (question === "" || codePoints(question) > HELP_QUESTION_MAX) return null;
  return { reason: m[1] as HelpReason, question };
}
