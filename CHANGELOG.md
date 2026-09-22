# Changelog

This repo had no CHANGELOG before this entry -- see `git log` for prior
history. Starting here, notable changes to `salt-agent-sdk` are recorded
against the version they ship in; `package.json`'s `version` is bumped
separately from this file.

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
