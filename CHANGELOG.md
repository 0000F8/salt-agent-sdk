# Changelog

This repo had no CHANGELOG before this entry -- see `git log` for prior
history. Starting here, notable changes to `salt-agent-sdk` are recorded
against the version they ship in; `package.json`'s `version` is bumped
separately from this file.

## Unreleased (wants 0.17.0, minor: new exports, no breaking change)

### Added

- **An agent can be a recovery guardian.** salt-api now accepts any account as a social-recovery guardian and delivers `recovery_share_requested` (the fields a person's Security page shows; no share material) on the standard rail. `client.incomingRecoveryRequests`, `client.heldRecoveryShares` and `client.releaseRecoveryShare(apiKey, {request, privateKey, passphrase})` open the share held for the requester with the agent's OWN key, re-seal it to the request's ephemeral public key exactly as salt-fe does, and contribute it; `sealShareForRequester` and `resealHeldShare` are exported for hosts that gate the release behind their own approval. Judging that a request is genuine stays the guardian's. `tests/recovery-guardian.test.js`. Not published.

## 0.16.0 — 2026-10-02

### Added

- **Agents can react to messages, sparingly.** `client.react(apiKey, messageId, emoji)` (`POST /api/v1/messages/:id/reactions`, a toggle: the same emoji again removes yours) and `client.myReactions(apiKey)` (`GET /api/v1/reactions/mine`); `ctx.react(emoji)` and `ctx.messageId` on the `onMessage` context; a `react_to_message` action for model-driven hosts. The server's 422 sentences ("Pick a single emoji.", "You can react with up to 12 emoji.") arrive as `SaltApiError.message`. The owner's rule, carried in the README, the JSDoc and the action description: react "not all the time, just when they choose", and only "if it relevantly complements the chat in a friendly way"; never instead of answering, never every message, never your own, at most one per message. `tests/react.test.js` runs a mock server shaped like the real controller. Not published.

## 0.15.0 — 2026-09-30

### Added

- **`registerAgent({username, displayName, listed?, webhook?, passphrase?, identities?, baseUrl?})`**: registers a root agent with no human account (`POST /auth`, versions read from `GET /api/v1/config`), generating the OpenPGP key pair locally; returns `{agent, apiKey, privateKey, publicKey, passphrase, identity}` and saves the identity when given a store. The private key never leaves the caller.
- `client.searchContacts` (find a human by handle); `SaltApiError` carries the `status.message` sentence `/auth` refusals use.
- README: install from GitHub until the registry package is current; quickstart is register → socket mode (no public URL) → find the human → open the 1:1 → `ask` with buttons. From the second stranger journey gate.

## 0.14.1 — 2026-09-30

### Fixed

- **`ctx.ask()` with buttons never resolved a tap.** It read the card id as `posted.id`, but `POST /api/v1/cards` answers the card's chat message envelope: the card id is `resource_id` (mirrored at `resource.id`). Taps never matched and the card never updated to "Answered". Every `postCard` fixture now uses the real envelope. Found by a stranger's journey gate (salt-api 0.117.0 changelog).
- **`await ctx.ask()` inside a handler deadlocked socket mode.** Every frame, pings and the answer included, went through one serial queue, so the handler waited on a frame queued behind itself; the socket died at ~30 s, reconnected and replayed `chat_opened` (duplicate cards). Control frames (ping, welcome, confirm, reject, disconnect) are now handled on arrival; `Dispatcher.resolveAnswer` settles a pending ask or delegation reply before the frame reaches the handler queue; everything else stays ordered; the ack never passes a row whose handler is still running; a replayed row whose handler is still running is skipped. `tests/socket-ask.test.js` hangs on the old code. Known: a handler blocked in `delegate_to_agent` (not `ctx.ask`) is not covered by the early pass.
- README: typed replies are on by default only when `options` is empty; pass `freeText: true` to allow both.

## 0.14.0 — 2026-09-30

### Added

- **Files plan, step 1 — agents can send attachments, and read more than images.** `client.sendAttachment(apiKey, chatId, {bytes, filename, contentType, caption?})` encrypts a file exactly the way salt-fe's `chatbox.jsx` `sendOneAttachment` does: a fresh one-time AES-256-GCM key over the bytes (`crypto.encryptAttachment`, byte-identical wire format to the browser's Web Crypto output -- proven in `tests/attachment-web-parity.test.js` by porting the web's own `encryptFileBytes`/`decryptFileBytes` onto Node's WebCrypto implementation), with that key/iv/filename/content_type/size PGP-encrypted as one JSON blob for every current chat member's public key (fetched fresh per call), posted as `attachment`/`attachment_encrypted_key` alongside an encrypted caption (defaults to "📎 &lt;filename&gt;"). Refuses before doing any crypto work on a file over `crypto.MAX_ATTACHMENT_BYTES` (15 MB, mirrors salt-api's own cap) or a `contentType` outside `crypto.ALLOWED_SEND_CONTENT_TYPES`; `sanitizeAttachmentFilename` strips path components and control characters so a filename can never be used as a path once decrypted on the receiving end.
- **Inbound attachments are no longer images-only.** `webhook.ts`'s `decryptAttachmentIfPresent` now decrypts bytes for ANY content type (still bounded by `MAX_ATTACHMENT_BYTES`, checked against the declared size BEFORE downloading, so a metadata blob that lies about its own size can't force an unbounded download) and hands the handler `ctx.attachment.data`. Text-shaped files (`text/*`, JSON, CSV, Markdown) additionally get `ctx.attachment.text`, the UTF-8 decoded content. PDFs get bytes only -- the SDK has no pure-JS PDF parser in its dependency tree, so text extraction from a PDF is left to a consumer (e.g. a Python host using `pypdf`).

## 0.13.0 — 2026-09-29

### Added

- **Capabilities ("What I can do")**: `identity_set` and `client.setIdentity` take `capabilities`, a list of at most 5 `{title (≤60), detail? (≤120)}` that replaces the agent's whole list. It is what a visitor sees on the agent's page and what the agent's A2A card `skills` are generated from (salt-api 0.107.0). `Capability` type and `MAX_CAPABILITIES` exported.

## 0.12.2 — 2026-09-27

### Added

- **`client.setCallback(apiKey, webhook)`** (`PATCH /api/v1/agents/callback`,
  `AgentsController#set_callback`): an agent sets its OWN webhook callback
  by api-key, no id parameter -- same shape as `setDeliveryMode`/
  `setChatSubscription`. The OpenAPI pass (design-fleet/runs/
  2026-09-17-distribution/OPENAPI.md) flagged that `saltapp-python` already
  had `set_callback`/`set_delivery_mode` while this client only had
  `setDeliveryMode` -- an integration built strictly from this SDK's public
  methods would never discover the callback endpoint exists at all, even
  though a comment on `setChatSubscription` already referred to
  `setCallback` as if it were there. Returns `{agent_id, callback}`; a 422
  means a blank or unsafe webhook (`User#callback_must_be_safe`), a 403
  means the caller isn't an agent. Deliberately NOT added to `actions.ts`
  -- this is host-side configuration (which URL an agent's platform points
  its own callback at), never something the agent's own model should call
  as a tool.

## 0.12.1 — 2026-09-26

### Added

- **`client.getCard(apiKey, cardId, {after?})`** (`GET /api/v1/cards/:id`,
  salt-api 0.96.0): a card's OWNER polling its own tap history instead of
  the agent's socket-mode outbox, which has exactly one forward-only
  cursor per agent -- two concurrent pollers (or one running beside a
  socket listener) can otherwise silently consume each other's answers.
  Returns `CardWithInteractions` (`{id, state, owner_id, interactions}`);
  a "pay" tap's interaction carries a live `transfer_request_status`, not
  a snapshot from tap time. `after` (another interaction's id or an ISO
  8601 timestamp) pages forward; an unrecognised value fails open (the
  full list, still 200) rather than rejecting. Rejects with
  `SaltApiError` status 404 -- never 403, byte-identical to an unknown
  `cardId` -- for anyone but the owner. A client method, not an agent
  action: unlike `post_card`/`update_card` it isn't meant to be called by
  the agent's own model, so it carries no `actions.ts` entry (and needs
  no salt-mcp annotation).

## 0.12.0 — 2026-09-23

### Added

- **Mandates R2: `client.actFor(principalId, {mandateId?})`.** Returns a
  client with the SAME method surface as the ordinary one (built from the
  same `buildMethods` implementations, just a different `request` closure),
  except every call it makes carries `X-Salt-Act-For: <principalId>` (and
  `X-Salt-Mandate: <mandateId>` when one is pinned), plus an
  auto-generated `Idempotency-Key` on any POST/PATCH that didn't already
  supply one -- an ask-mode call needs to be safely retried, and any
  mapped action can come back an ask depending on how the grantor
  configured that capability. The delegate's own api-key is still passed
  per call, exactly like the base client -- `actFor` only adds headers, it
  never substitutes whose key authenticates the request. A call's return
  type is `Promise<R | AskedResult>` for every method (`Acted<F>`); check
  `isAsked(result)` before reading the normal fields. An ask-mode 202
  `{status: "asked", exercise_id, expires_at}` resolves to
  `{asked: true, exerciseId, expiresAt}` and never throws. The base
  (non-acting) client is untouched -- it never sends either header and
  never sees a 202 (salt-api's resolver only runs the ask/mandate
  machinery when `X-Salt-Act-For` is present at all).
- **`client.mandates`**: `list`/`get`/`propose`/`update`/`accept`/`renew`/
  `pause`/`resume`/`revoke`/`exercises`/`openExercises`/`decide` -- always
  as yourself, never through `actFor` (mandate management isn't itself a
  mapped capability). New types `Mandate`, `MandateCapabilityRow`,
  `MandateExercise`, `MandateParty`, `MandateTrail`, `MandateChild`,
  `ProposeMandateParams`, `UpdateMandateParams` mirror salt-api's wire
  shapes.
- **`client.prepareTransfer`** (`POST /transfers/prepare`): `money.pay`'s
  mode is forced to `ask`, so this always resolves an `AskedResult`, never
  a Transfer -- settle it with `transfers#create`'s own `exercise_id` once
  the exercise is approved.
- **Six new webhook event types**, same rail as
  `card_interaction`/`invoice_paid` (a per-recipient plaintext POST,
  `X-Salt-Agent-Id` names which hosted identity it's for):
  `onMandateOffered` (`ctx.mandate`, `ctx.accept()` --
  `client.mandates.accept` under this identity's own key),
  `onMandateActivated`/`onMandatePaused`/`onMandateRevoked` (`ctx.mandate`,
  informational), `onApprovalRequested` (delivered to the mandate's
  PRINCIPAL when it's an agent -- `ctx.exercise`, `ctx.decide("approve" |
  "deny", note?)`), `onApprovalDecided` (delivered to the DELEGATE that
  made the original ask-mode call -- `ctx.exercise`, informational only,
  no further action). None of these carry `session`/`reply()` -- they
  aren't chat messages, they're mandate/exercise state changes.



- `identity.share()` is the grant: a section the agent scoped to nobody is shareable, and the share is what admits that recipient (salt-api 0.87.0). The local refusal remains only for a key the agent has never stated.
- The ledger POST carries no claimed scope; salt-api records the narrowest real scope after the grant. `PostIdentityDisclosureParams.scope` is optional.

## 0.11.0 — 2026-09-22

### Added

- **Identity R3 + R4: `identityShare.ts`.** `createIdentitySharer(client,
  pgpPassphrase)` sends a SIGNED SLICE of an agent's own identity sections
  into a chat as ordinary E2E ciphertext (`share`), asks a fellow 1:1
  member for one of theirs (`ask`), lists/revokes this agent's own
  disclosure ledger (`disclosures`/`revoke`) -- the ledger rides
  `POST/PATCH /api/v1/identity/disclosures`, metadata only, never a
  section value. salt-api keys a disclosure row on subject + recipient +
  id, so `share()` generates ONE id per call and posts that SAME id as
  every non-observer recipient's ledger row: that one id is what the wire
  SLICE's `id=` carries, what a single `setIdentityDisclosureMessage` PATCH
  reaches every row of, and what a single `revoke(id)` call revokes every
  row of, regardless of how many recipients the share went to.
  `ShareResult` is `{id, messageId, recipients}`. `ctx.shareIdentity(keys,
  opts?)` is the same `share` on every context that already carries
  `reply()`/`ask()`/`approve()`.
- **`onIdentityAsk` / `onIdentityShared`** on `createWebhookServer` /
  `createSocketClient`: an incoming `[[SALT-IDENTITY-ASK]]` is answered
  (a SLICE or a DECLINE, both carrying `ask=<id>`) by `onIdentityAsk`'s
  return value when it's registered, or falls through to `onMessage` as
  ordinary text (marker stripped) when it isn't. An incoming SLICE,
  DECLINE or REVOKE from someone else always intercepts (never reaches
  `onMessage`); a SLICE is verified against the sender's own public key
  and, once verified, recorded on that chat's session before
  `onIdentityShared` fires.
- **`identity_share {keys, chat_id?}` / `identity_ask {keys, text?}` /
  `identity_revoke {id}`** in `actions.definitions`, alongside
  `identity_set`/`identity_get`. `identity_share` defaults to the chat the
  model is currently replying in; `identity_ask` is 1:1-only, same as the
  sharer's own `ask()`. 22 actions in total now.
- **`Session.identity`**: `session.identity[senderId]` holds the verified
  (and unverified) SALT-IDENTITY-SLICEs a chat's session has received,
  capped per sender and pruned on a matching REVOKE
  (`sessions.recordReceivedIdentitySlice`/`forgetReceivedIdentitySlice`).
- **`crypto.signDetached` / `crypto.verifyDetached`**: armored OpenPGP
  detached sign/verify over a plain string, the primitives a slice's
  signature is built and checked with.

## 0.10.2 — 2026-09-22

### Added

- **Open rooms reach `actions.ts`.** Every action that posts a wire-protocol
  message into a chat (`delegate_to_agent`, `consult_agent`, `request_floor`)
  now reads that chat's `encrypted` from the payload it already fetches for
  member keys (`request_floor` had none, so it gains one `client.getChat`
  call) and posts plain text via the same `postPlainMessage` path on an open
  room instead of PGP-encrypting -- never both, since salt-api refuses a
  ciphertext-shaped body on an open room and a plaintext one everywhere
  else. `post_card`/`update_card` and every commerce action need no change:
  they were already plain JSON with no client-side encryption on any chat.
- **`ChatOpenedContext.encrypted`.** Read from the `chat_opened` payload's
  `chat.encrypted` (defaulted `true` when absent), so a greeting into an
  open room can be posted plain via `client.postPlainMessage` -- same
  convention as `MessageContext.encrypted`; `reply()` itself still always
  PGP-encrypts regardless.

## 0.10.1 — 2026-09-22

### Added

- **`MessageContext.deliveredBecause`.** On an open room only, why THIS
  delivery reached the identity -- `"mention" | "reply" | "keyword" | "all"`,
  read from salt-api's `message.delivered_because` (undefined for an ordinary
  encrypted chat, where every member always gets every message). Present on
  both the webhook and socket paths (they share one dispatcher) and, when
  history carries it, on `SessionTurn.deliveredBecause` for the other
  party's turn in a cold-start session rebuild -- never on this identity's
  own turn.

## 0.10.0 — 2026-09-22

### Changed

- **`createSocketClient` no longer polls.** It holds a websocket to salt-api's
  `AgentUpdatesChannel` over Action Cable (`wss://<host>/cable`, api-key on the
  handshake), subscribes with the persisted cursor, replays the backlog, then
  listens. An idle, caught-up agent makes zero requests. `GET /api/v1/agent/updates`
  survives only as an event-triggered backfill when `replay_done.more` is set and
  as one coalesced ack per processed batch. Reconnects with jittered backoff
  (1 s → 60 s); 30 s without a cable ping is treated as dead. Owner rule: polling
  is never a mechanic. Removed `ACTIVE_POLL_DELAY_MS`/`IDLE_POLL_DELAY_MS` and the
  `timeoutSeconds` option; added `RECONNECT_MIN_DELAY_MS`, `RECONNECT_MAX_DELAY_MS`,
  `PING_TIMEOUT_MS`, `webSocketImpl`, `pingTimeoutMs`. New dependency: `ws`.

### Added

- **Open rooms.** A delivered message with `encrypted: false` is plain text: no PGP,
  identity resolved from `X-Salt-Agent-Id`; `MessageContext.encrypted`.
  `client.postPlainMessage(apiKey, chatId, text)`.
- **Interests.** `client.setChatSubscription(apiKey, chatId, {mode, keywords})` and
  `clearChatSubscription` (`PUT`/`DELETE /api/v1/chats/:id/subscription`).

## 0.9.0 — 2026-09-22

### Added

- **Identity, R1** (design-fleet/runs/2026-09-22-identity/plan.md):
  `client.identity(apiKey)` reads an agent's own identity sections (claims
  and proofs together); `client.setIdentity(apiKey, claims)` sets one or
  more of its own CLAIM sections (`display_name`, `bio`, `link`, `avatar`,
  `category`, `message_price`, `funding_disclosure`) and refuses client-side
  to send `scope` at all -- section visibility is owner-controlled, not
  agent-controlled, and isn't on this SDK surface yet. `client.card(handle,
  {kind?})` fetches a person's or an agent's publicly served, signed
  identity card (trying the agent path then the user path) and verifies its
  Ed25519/JWS signature (RFC 8785 canonicalization, matching salt-api's
  `AgentCardSigner`/`Jcs`/`SaltSigningKey` exactly) against Salt's published
  Web Bot Auth key, fetched once and cached. A card that can't be verified
  throws `IdentityCardInvalidError` rather than ever coming back
  `verified: false`. Two new actions, `identity_set` and `identity_get`, are
  in `actions.definitions` (19 actions total, up from 17); `identity_get`'s
  result marks each section `is_proof` (`checked_by: "Salt"` when true) so
  a claim is never presented as though it had been checked. New module:
  `src/identity.ts` (section vocabulary, the JCS canonicalizer, the
  signature verifier). See the README's **Identity** section for usage.
