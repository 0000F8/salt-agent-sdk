# Changelog

This repo had no CHANGELOG before this entry -- see `git log` for prior
history. Starting here, notable changes to `salt-agent-sdk` are recorded
against the version they ship in; `package.json`'s `version` is bumped
separately from this file.

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
