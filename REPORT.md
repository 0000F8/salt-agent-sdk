# sdk lane: Firefox reach (salt-agent-sdk, branch feat/fr-sdk; version NOT bumped, not published)

## Exported names and shapes (the mcp lane reads this)

All from `src/browser.ts`, re-exported by `src/index.ts`.

- `BROWSER_ACTIONS` now ends with: `locate`, `route`, `download`, `cookies`, `clipboard` (after `webmcp`).
- `BROWSER_ACTION_SPECS[action] = {use, args (JSON Schema, additionalProperties false), required?, oneOf?}`:
  - `locate`: `{ref (required), tab}`. Read-only.
  - `route`: `{op: add|remove|list|clear (required), id, match, action: block|fulfill|redirect|modify, status:int, headers:object, body, body_base64, redirect_url, replace:[{find,with}], tab}`. SDK check: `add` needs `match` and `action`, `remove` needs `id`.
  - `download`: `{url (required, http/https), tab, save:boolean, filename}`.
  - `cookies`: `{op: get|set|remove (required), url (required, http/https), tab, name, value, path, secure, http_only, same_site: no_restriction|lax|strict, expires:number}`.
  - `clipboard`: `{op: read|write (required), text}`. SDK check: `write` needs `text`.
  - `eval` gains `world: "page"|"isolated"`; `dialog` gains `mode: "next"|"always"`; `control.use` now names `tabs.hide`/`tabs.show` (method stays a free string, the SDK never listed control methods); `emulate.use` updated for Firefox.
- Results (`BrowserStepResult.result` is now `BrowserResultFields`, all optional, index signature kept):
  `world`, `armed`, `mode`, `seen: BrowserDialogSeen[]`, `detectable: string[]`, `screen/viewport: BrowserRect`, `device_pixel_ratio`, `in_front`, `id`, `routes: BrowserRoute[] | number`, `not_supported_fields`, `file: BrowserFile`, `url`, `saved`, `filename`, `cookies: BrowserCookie[]`, `text`, `written`, `image`, `diff_image`.
- `download` bytes: wire `{url, mime, size, data_base64}` becomes `result.file = {mime, base64, size}`; `data_base64`/`mime`/`size` are removed from `result`. `save: true` keeps `{url, saved, filename}` and no `file`. (If `size` is missing it is computed from the base64.)
- New exported types: `BrowserFile`, `BrowserRect`, `BrowserLocateResult`, `BrowserDialogSeen`, `BrowserRoute`, `BrowserCookie`, `BrowserResultFields`.
- `BrowserGrant` gains `identity?: "person"|"own"` and `hidden?: boolean`.
- `needs_permission` is documented as a reason (BrowserStepResult comment and the `browser_step` description, with the fix sentence). Reasons are not enumerated in code, so it passes through as the step's `reason`.
- `browser_step`'s description and `args` description are generated from the specs, so the new actions appear there automatically (annotation of read-only vs not stays in salt-mcp: `locate` read-only; `download` without save and `cookies get` read-only; the rest not).

## Files changed

- `src/browser.ts` (actions, specs, types, `checkBrowserArgs`, `shapeImages` download branch, description)
- `tests/browser-step-reach.test.js` (new, 8 tests)
- `README.md` (Firefox reach section with one example each), `CHANGELOG.md` (Unreleased entry)

## Tests

`npm run build`: clean (tsc, no output).
`node --test tests/browser-step-reach.test.js tests/browser-step.test.js`: 21 tests, 21 pass, 0 fail (8 new + the 13 existing).

## Not done

- No version bump, no publish (as instructed). The new entry sits under "Unreleased".
- The SDK does not pre-check grant mode or permissions; the extension/API enforce them.
- `node_modules` in the worktree is a symlink to the main checkout's (not committed).
