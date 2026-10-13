# AGENTS.md

salt-agent-sdk is the TypeScript reference SDK for building agents on
[Salt](https://saltapp.ai), an end-to-end encrypted chat where humans and AI
agents are equal contacts — 1:1/group chats, in-chat crypto payments,
interactive "cards", inline `ask`/`approve` questions, socket mode (no
public URL needed), and open (unencrypted, large-capacity) rooms. This is
the reference action layer other Salt integrations build on (salt-mcp,
saltapp-elizaos, saltapp-chat-adapter, saltapp-openclaw, n8n-nodes-saltapp,
others). Bring your own model/agent logic; this SDK handles webhook
signature verification, PGP crypto, the REST client, and wire formats.

## Commands

Run from the repo root. All verified directly in this repo, 2026-09-27.

- `npm install` — installs deps, runs `prepare` → `npm run build`. Verified:
  succeeds (98 packages; 3 moderate `npm audit` advisories, not addressed).
- `npm run build` — `tsc -p tsconfig.json`, emits `dist/`. Verified: clean.
- `npm test` — `npm run build && node --test tests/*.test.js`. Verified
  2026-10-13: **305/305 passing, 0 failing.**
- No `lint` script exists — `tsc` is the only static check. (README.md's
  closing "No test suite yet" is stale — `tests/` has ~20 files, 187 cases.)

## Layout

- `src/client.ts` — `createSaltClient({host})`: typed REST client for
  every salt-api endpoint, plus `client.actFor()`/`client.mandates`.
- `src/webhook.ts` — `createDispatcher`/`createWebhookServer`: the actual
  Salt protocol (signatures, routing, dedup, GACM/mediator silence, loop
  capping, session persist). `socket.ts` wraps the SAME dispatcher over a
  websocket instead of an HTTP route.
- `src/socket.ts` — `createSocketClient`: socket mode for an agent with no
  public URL, no polling loop, over `AgentUpdatesChannel`.
- `src/actions.ts` — `createActions()`: 22 Salt-platform actions as
  provider-agnostic JSON Schema tools (`toAnthropicTools`/`toOpenAITools`).
- `src/sessions.ts` — per-(identity, chat) memory (`MemorySessionStore`/
  `FileSessionStore`, transcript tail, hand-off session-note format).
- `src/scriptJob.ts` — `runScriptJob` and `SeenStore` (`MemorySeenStore`/
  `FileSeenStore`): scheduled work done by code, with a model only where
  one is needed ("Right tool for the job", below).
- `src/chatPrivacy.ts` — `isPrivateChat(chat, speakerId, myId)`: who is in
  a chat, decided from Salt's own chat record.
- `src/identities.ts` + `src/reconcile.ts` — on-disk identity registry,
  plus re-keying when salt-api's ids drift.

## Rules that bite

- **A tool waiting on a human's card answer polls that card, never the
  agent outbox.** `client.getCard(apiKey, cardId, {after?})`
  (`GET /api/v1/cards/:id`) is owner-only, safe for concurrent callers.
  `GET /api/v1/agent/updates` (socket-mode backfill) has exactly ONE
  forward-only cursor per agent — `after=` there permanently advances the
  ack, cutting off a live socket listener or another poller.
  `createSocketClient`'s own cursor (`~/.salt/agents/<agentId>/` by
  default) is the same one-per-agent shape.
- **`postCard`'s response carries `resource_id`/`message_id`, never a
  top-level `id`** (`actions.ts`'s `post_card` reads `result.resource_id`
  as `card_id`) — test fakes must model salt-api's real response shape,
  not what the calling code assumes; a mock that invents `{id: ...}`
  passes locally while lying about the real shape, and this exact bug has
  shipped identically across multiple downstream Salt adapters.
- **A chat's `encrypted` flag nests differently by endpoint** —
  `GET /api/v1/chats/:id` nests it under `session` (`client.getChat()`
  reads `chat?.session?.encrypted`, normalized to a flat boolean), while
  webhook/socket payloads (`MessageContext.encrypted`,
  `ChatOpenedContext.encrypted`) carry it top-level. Check which shape
  you actually hold. Separately: an encrypted chat refuses a non-PGP body
  and an open room refuses ciphertext — `postMessage`/`reply()` always
  encrypt, `postPlainMessage` is open-rooms-only, salt-api 422s either way.

## Right tool for the job

Owner's rule (2026-10-13): "use the right tools for the right jobs; don't use
AI as the hammer for everything when deterministic scripts and tools can
accommodate just as well." A model is for judgement and language. Fetching a
page, comparing it with last time, remembering what was already sent and
deciding whether anything changed are code. Every agent built on this SDK
follows it.

### Scheduled work is a script job

A recurring job (a news digest, a price watch) is a script the host's
scheduler runs (cron, a Grains `wake_me`, `setInterval`), not a model turn
that browses. `runScriptJob` is the shape:

```ts
const result = await runScriptJob({
  sources: { hackerNews, blogFeed },   // plain async functions: fetch + normalise, no model
  key: (item) => item.url,             // a stable id
  seen: FileSeenStore("data/digest-seen.json", { ttlMs: 14 * 24 * 3600_000 }),
  compose: (fresh) => cheapModel(fresh), // OPTIONAL: the only place a model may run
  post: (text) => ctx.reply(text),       // or client.postMessage
});
// { fetched, fresh, posted, failedSources }
```

- **Sources** are ordinary functions. Each runs once per call with a timeout
  (`sourceTimeoutMs`, default 20 s, and an `AbortSignal` to pass to `fetch`).
  A source that throws or hangs lands in `failedSources`; the others carry on.
- **`seen`** drops what was already sent. `MemorySeenStore()` forgets on
  restart; `FileSeenStore(file)` does not. `seen` is required: construct the
  store ONCE, outside the job function (a `MemorySeenStore` made inside it
  dedupes nothing). Marks expire per key (`ttlMs`), so an old story can come
  back on purpose. The file holds your item keys in plaintext. Run one job
  per seen-file at a time: the write queue is per instance/process, not
  across processes.
- **`compose` is optional, and runs only when something is new.** A quiet
  day costs nothing. Use the CHEAPEST model that can write the text (a small
  model for a digest; the big one is for conversations), give it only the new
  items, and keep ranking, filtering and deduping in code before it. Without
  `compose`, a plain "- title / url" list is posted. Return empty only for a
  transient failure: empty means nothing is marked, so the same items go to
  the model again next run.
- **Nothing new: no compose, no post.** Items are marked seen only AFTER
  `post` succeeds; if `post` or `compose` throws, `runScriptJob` throws and
  nothing is marked, so the next run retries.
- **Re-arm in a `finally`.** `runScriptJob` never schedules. If your
  scheduler needs the next run set each time, set it whether this run
  succeeded, failed or was skipped (see the spent-budget rule below).

### A computer going quiet (`onDeviceSessionEnded` / `onDeviceBack`)

If the person's computer stops answering for 15 s in the middle of a device
session, Salt ends it with `end_reason: "lost_contact"` and tells you with
`device_session_ended` (`ctx.lostContact`). If the computer is seen alive
again within 24 h while the grant is still active, Salt sends ONE `device_back`
for that session (`ctx.previousSessionId`; `ctx.chatId` is the person's 1:1,
or null). `device_back` grants nothing: open a new session to continue.
(Source of truth: salt-api `docs/DEVICE_PROTOCOL.md`.)

- **Say it once, plainly.** Once per `sessionId`, in the chat the work came
  from (the delivery's own chat is the device lane, which nobody reads), else
  the person's 1:1: the computer stopped answering, and nothing else was
  sent. Fixed words, no model: "Ada's MacBook stopped answering while I was
  using it. I stopped there and nothing else was sent." Dedupe on the session
  id; deliveries are retried.
- **Never claim an action landed** unless a device tool returned it. The last
  command in the old session may or may not have happened.
- **When it is back, offer; do not resume.** "Ada's MacBook is back. Want me
  to finish it?" On a yes, open a new session and look at the screen first
  before assuming the last step landed.
- Any other `end_reason` is not for this etiquette.
- The `device_offline` activity kind is the person's own notice (their bell
  and push, "<computer> went offline while <agent> was using it"); this SDK
  has no activity or device REST types, so there is nothing to add for it
  here. `GET /api/v1/devices` rows also carry `offline_since` and
  `lost_contact: {agent_id, agent_name, ended_at}` for the owner.

### Pick the model by rules, not by habit

Most turns don't need your strongest model. Decide with plain rules, no model call:

- **Start cheap.** A short message, a reaction, a lookup or "remember this" runs on your
  cheaper model with a small toolset.
- **Middle by default.** Longer messages, links, attachments, scheduled wakes and events run
  on the cheaper model with the full toolset.
- **Escalate only for what is costly or can't be undone:** moving money, acting for a person
  under a mandate, sending email, building or publishing code, changing an agent's settings
  or spending, controlling a computer. When the cheap model asks for one of those tools,
  discard that step and redo it on the strong model, so the strong model writes the
  arguments (the amount, the code, the text that goes out). Also escalate on a retry after a
  refusal or repeated tool failures.
- **Never de-escalate inside a turn**, and log the tier and the reason on every call so you
  can measure the mix.

A model-based router is optional and only worth it for the borderline cases rules can't
decide: it costs about a tenth of a cent per message on the cheapest model.

### Who is in the chat comes from Salt's chat record

`isPrivateChat(chat, speakerId, myId)` is true only for an encrypted,
non-public chat whose members are exactly the speaker and this agent, with no
observer. Fetch the chat with `client.getChatRecord(apiKey, chatId)`
(`GET /api/v1/chats/:id`) when you need it, and decide
privacy-sensitive things (device tools, anything from the person's private
data) from THAT, every time they matter. Never from a cache, a memory service
or a roster you built earlier: they can be slow or stale, and a slow memory
service once switched a person's computer tools off inside their own 1:1.
Missing fields fail closed (not private), an absent `encrypted` flag means
encrypted, and an observer, even a silent one, makes it not private.

### When your own model budget is spent

If the model you pay for runs out (a spend cap, a quota), the agent does not
fall silent and does not talk about money:

- Reply with ONE plain pause line: "I'm paused right now and can't answer
  this yet. I'll pick it up as soon as I can." No budget, cost, tokens or
  credits to people, ever.
- At most once per chat per day. Remember the day you said it; later messages
  that day get nothing, not a loop of apologies.
- **A skipped run still re-arms.** A scheduled job skipped for budget must
  set its next run exactly as a successful one does. A skip that forgets to
  re-arm silently kills the schedule (it happened to AI News). This is also
  why a script job costs nothing when nothing is new: it can keep running.
- The SDK has no model wrapper, so none of this is code here; it is the host's
  responsibility.

## Where the truth is

- https://saltapp.ai/api/openapi.json (OpenAPI spec), https://saltapp.ai/agents.md (agent manifest).
- https://mcp.saltapp.ai/mcp — the hosted MCP server; every action this SDK
  exposes needs a matching annotation in salt-mcp.
- `../salt-mcp/docs/CLIENTS.md` (sibling repo) — client-side MCP notes.

## Publishing

`salt-agent-sdk` **does** have a package on npm, but it's `0.1.0` —
ancient, far behind this repo's current version (`0.12.2`). Socket mode,
sessions, delegation, mandates/`actFor`, identity, and the card protocol
all postdate what's published; don't write install instructions implying
`npm install salt-agent-sdk` gets anything close to this repo today.
