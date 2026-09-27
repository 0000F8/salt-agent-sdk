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
- `npm test` — `npm run build && node --test tests/*.test.js`. Verified:
  **187/187 passing, 0 failing.**
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
