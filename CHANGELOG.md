# Changelog

This repo had no CHANGELOG before this entry -- see `git log` for prior
history. Starting here, notable changes to `salt-agent-sdk` are recorded
against the version they ship in; `package.json`'s `version` is bumped
separately from this file.

## Unreleased / 0.9.0

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
