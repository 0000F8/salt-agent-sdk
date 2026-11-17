# sdk lane: browser actions (salt-agent-sdk 0.37.0, branch feat/browse-parity)

## Exported action names (salt-mcp must annotate both)

- `browser_grants`: input `{}` (additionalProperties false). Returns `{grants:[{browser_client_id, mode, all_tabs, client, ...}]}` (active only). Read-only.
- `browser_step`: input `{action, args?, browser_client_id?, timeout_ms?}`; returns `{status, reason?, summary, result?, step_id?}`. Mutating (drives a person's browser); open-world.

`browser_step` schema (`BROWSER_STEP_SCHEMA`, exported from `src/browser.ts`):

- `action`: enum `BROWSER_ACTIONS` = open, read, click, type, scroll, screenshot, handoff, tabs, control, press, select, hover, drag, upload, wait_for, screenshot_diff, console, eval, dialog, network, emulate, recording, demonstrate, webmcp
- `args`: object (checked per action by the SDK before posting)
- `browser_client_id`: string, optional
- `timeout_ms`: integer 1000..120000, default 60000
- required: `["action"]`, additionalProperties false

Per-action `args` schemas (plain JSON Schema, with `required` and one-of groups) are in `BROWSER_ACTION_SPECS` (also exported): the mcp lane can build `salt_browser_open|read|click|type|press|screenshot|eval|handoff|tabs` from `BROWSER_ACTION_SPECS[action].args` and `.use`. Also exported: `createBrowserTools({client, pgpPassphrase})` -> `{grants, step, definitions}`, `browserGrants(client, caller)`, `browserStep(client, caller, pgpPassphrase, input)`, `checkBrowserArgs`, `recordBrowserStepEvent`, types `BrowserStepInput`, `BrowserStepResult`, `BrowserGrant`, `BrowserImage`.

Result shapes: images are `result.image {mime, base64}` (screenshot) and `result.diff_image {mime, base64}` (screenshot_diff); recording stop keeps `webm_base64`. Statuses: done, failed, refused, stopped, expired, needs_human, running (+ reason `timed_out` when the wait ended; do not repeat). SDK-made reasons: `no_grant` (404), `rate_limited` (429), `unreachable`, `not_sealed`, `unreadable`, or Salt's own `code` on a 4xx.

## Changes

- `src/browser.ts` new; `src/client.ts` 3 methods; `src/actions.ts` registers both in `createActions`; `src/webhook.ts` routes `type: "browser_step"` in `dispatch` and `resolveAnswer` (socket early path); `src/index.ts` export; README section; CHANGELOG; version 0.37.0.
- Event shape assumed: `{type:"browser_step", step:{id, step_id, status, summary, reason, result_armor}}` (or the step at top level); `result_armor` and REST `result` are both accepted.

## Tests

`node --test tests/browser-step.test.js`: 13 pass, 0 fail (step post, event wait, event-before-POST race, unseal, GET fallback, timeout, needs_human, 5xx retry with same step_id, 4xx structured, unsealed/unreadable results, bad args, dispatcher routing). Also run for regression: work-cancel, ask, socket-ask, socket tests: pass. `npm run build`: clean.

## Not done

- A look-only grant's `read_only` refusal comes from the server/extension; the SDK does not pre-check mode.
- The contract says `eval`/`upload` size caps (64 KB, 5 MB) are enforced by the extension; the SDK checks key names and required parts only.
- The worktree's `node_modules` is a symlink to the main salt-agent-sdk checkout (not committed).
