// The `[[SALT-SCREEN session=<id> device=<id>]]` marker (the screen card).
//
// An agent that holds a live device session shows the person that computer's screen with an
// ordinary end-to-end encrypted message: the first line is the marker, the rest is a one-line
// caption. Salt never parses it. salt-fe strips the marker from every human-facing view and
// renders a card that plays the session live.
//
// Pure: build and parse only.

/** The caption is at most this many characters (Unicode code points). */
export const SCREEN_CAPTION_MAX = 200;

export interface ScreenMessage {
  sessionId: string;
  deviceId: string;
  caption: string;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_RE = new RegExp(`^${UUID}$`);
const SCREEN_RE = /^\[\[SALT-SCREEN((?:[ \t]+[A-Za-z_]+=[^\s\]]*)*)[ \t]*\]\][ \t]*(?:\r?\n([\s\S]*))?$/;

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** True when the text opens with the SALT-SCREEN marker (well formed or not). */
export function isScreenMessage(plaintext: string): boolean {
  return plaintext.trimStart().startsWith("[[SALT-SCREEN");
}

/** The plaintext of a screen card. Throws on a session or device id that is not a UUID or a
 *  caption over 200 characters (nothing is cut off silently). The caption may be empty. */
export function buildScreenMarker(s: { sessionId: string; deviceId: string; caption?: string }): string {
  if (typeof s.sessionId !== "string" || !UUID_RE.test(s.sessionId)) throw new Error("sessionId must be a UUID");
  if (typeof s.deviceId !== "string" || !UUID_RE.test(s.deviceId)) throw new Error("deviceId must be a UUID");
  const caption = typeof s.caption === "string" ? s.caption.trim() : "";
  if (/[\r\n]/.test(caption)) throw new Error("a screen caption is one line");
  if (codePoints(caption) > SCREEN_CAPTION_MAX) throw new Error(`a screen caption is at most ${SCREEN_CAPTION_MAX} characters`);
  return `[[SALT-SCREEN session=${s.sessionId} device=${s.deviceId}]]\n${caption}`;
}

/** Parse a decrypted message. Null when it is not a screen card, or opens with the marker but is
 *  malformed (missing or non-UUID session/device, over-long caption): a reader treats that as
 *  ordinary text. Unknown attributes are ignored. */
export function parseScreenMarker(plaintext: string): ScreenMessage | null {
  const trimmed = plaintext.trimStart();
  if (!trimmed.startsWith("[[SALT-SCREEN")) return null;
  const m = SCREEN_RE.exec(trimmed);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const part of m[1].trim().split(/\s+/)) {
    if (!part) continue;
    const i = part.indexOf("=");
    attrs[part.slice(0, i)] = part.slice(i + 1);
  }
  if (!UUID_RE.test(attrs.session ?? "") || !UUID_RE.test(attrs.device ?? "")) return null;
  const caption = (m[2] ?? "").trim();
  if (codePoints(caption) > SCREEN_CAPTION_MAX) return null;
  return { sessionId: attrs.session, deviceId: attrs.device, caption };
}
