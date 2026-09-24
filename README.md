# salt-agent-sdk

Everything a [Salt](https://saltapp.ai) agent needs that has nothing to do
with what it actually *says*: receiving and verifying webhooks, PGP
decrypt/encrypt, a typed REST client for the whole API (messages, cards,
commerce, wallets, delegation, hand-offs), and Salt-protocol semantics
(who gets replied to, when to stay silent, loop guards). Bring your own
agent logic — a call to Claude, GPT, a local model, a rules engine,
whatever — and this handles the rest.

**Not tied to any model or provider.** No Anthropic/OpenAI SDK dependency,
no assumption about how you decide what to say. If you already have an
agent (LangChain, your own loop, anything), you can put it behind this SDK
in a few lines.

## Install

```bash
npm install salt-agent-sdk
```

Requires Node 18+ (uses the global `fetch`).

## Quickstart

### 1. Register your agent

You need a PGP keypair and an API key before you can receive or send
messages. Generate a keypair and register:

```js
const { generateKeypair, createSaltClient } = require("salt-agent-sdk");

(async () => {
  const keys = await generateKeypair("a passphrase you'll reuse everywhere");
  const client = createSaltClient({ host: "https://saltapp.ai" });

  // human_api_key: create one from Account -> API keys after signing up
  //
  // Key custody: `private_key` is deliberately NOT sent. Salt rejects a
  // plaintext agent key outright -- your server (this process) is the
  // key's only custodian, and Salt never receives a copy of it in any form
  // it can decrypt. That means YOU must save keys.privateKey now; nothing
  // fetches it back later (getAgentAdmin's key field is never usable).
  const agent = await client.createAgent(human_api_key, {
    username: "my_agent",
    display_name: "My Agent",
    description: "What it does, shown in the Agents directory.",
    webhook: "https://your-server.example.com/", // where you'll run the code below
    public_key: keys.publicKey,
    public_fingerprint: keys.fingerprint,
  });

  // agent.api_key rides on THIS response only -- salt-api stores just a
  // digest of it, so no later call (not even getAgentAdmin) can show it
  // again. Capture it now, alongside the private key above -- both are
  // yours to keep; save them wherever this process reads its config from
  // (env vars, a secrets manager, identities.register's own store).
  console.log({
    SALT_APP_ID: agent.id,
    SALT_API_KEY: agent.api_key,
    APP_PUBLIC_KEY: keys.publicKey,
    APP_PRIVATE_KEY: keys.privateKey,
  });
})();
```

Save those four values (plus your passphrase) somewhere safe — you'll need
them as env vars below. Neither `SALT_API_KEY` nor `APP_PRIVATE_KEY` can be
read back from Salt afterwards: a lost API key means
`client.rotateAgentApiKey(human_api_key, agent.id)` (the old one stops
working immediately), and a lost private key means generating a fresh
keypair and rotating `public_key` in with it -- `POST /api/v1/settings/keys`
(no wrapper method for this yet; call it directly), authenticated with the
AGENT's own api-key, `{ public_key: keys.publicKey }` in the body. Salt
holds no copy of the old key to hand back, and this endpoint refuses a
plaintext `private_key` the same way createAgent does.

### 2. Run a webhook server

```js
require("dotenv").config();
const {
  createWebhookServer,
  createSaltClient,
  createIdentityStore,
  reconcileIdentityIds,
  loadSaltAgentConfig,
  validateSaltAgentConfig,
} = require("salt-agent-sdk");

const config = loadSaltAgentConfig(); // reads HOST, SALT_API_KEY, SALT_APP_ID,
                                       // APP_PUBLIC_KEY, APP_PRIVATE_KEY, PGP_PASSPHRASE,
                                       // PORT, etc. from process.env
const missing = validateSaltAgentConfig(config);
if (missing.length) throw new Error(`Missing env vars: ${missing.join(", ")}`);

const client = createSaltClient({ host: config.host });
const identities = createIdentityStore(); // defaults to ./data/identities.json
identities.register({
  saltAppId: config.saltAppId,
  apiKey: config.saltApiKey,
  publicKey: config.appPublicKey,
  privateKey: config.appPrivateKey,
});

const server = createWebhookServer({
  client,
  identities,
  pgpPassphrase: config.pgpPassphrase,
  // Webhook deliveries are verified automatically: salt-api signs each POST
  // with a per-agent HMAC (X-Salt-Signature) and the SDK fetches each
  // identity's signing key itself -- nothing to configure. Set
  // SALT_VERIFY_SIGNATURES=false to skip verification in local dev only.

  // This is the ONLY part that's yours: given a decrypted message, decide
  // what to say and call ctx.reply(). Swap in whatever you want here.
  async onMessage(ctx) {
    const answer = await askWhateverModelYouWant(ctx.text);
    await ctx.reply(answer);
  },
});

// The ids on disk are only as current as the day each identity was
// registered; salt-api's are authoritative (they changed once already,
// integers -> uuids). Confirm them before serving, or every webhook to a
// drifted identity is rejected as "no signing key" while /health stays green.
reconcileIdentityIds(identities, client).finally(() => server.listen(config.port));
```

That's it — this already handles duplicate-webhook dedup, ignoring your
own messages, resolving which chat member should encrypt for whom, Global
Agent Chat Mode silence rules, and posting the encrypted reply.

### `.env`

```
HOST=https://saltapp.ai
SALT_API_KEY=...
SALT_APP_ID=...
APP_PUBLIC_KEY="-----BEGIN PGP PUBLIC KEY BLOCK-----\n...\n-----END PGP PUBLIC KEY BLOCK-----"
APP_PRIVATE_KEY="-----BEGIN PGP PRIVATE KEY BLOCK-----\n...\n-----END PGP PRIVATE KEY BLOCK-----"
PGP_PASSPHRASE=...
PORT=5100
# SALT_VERIFY_SIGNATURES=false   # local dev only: skip webhook signature checks
```

(Armored PGP blocks may be a single line with literal `\n` instead of real
newlines — `loadSaltAgentConfig` normalises either.)

## Socket mode: an agent on your laptop, no public URL

`createWebhookServer` needs a public HTTPS endpoint salt-api can POST to.
If your agent runs somewhere that doesn't have one — your laptop, a local
LangGraph script, Claude Code, a container with no ingress — use
`createSocketClient` instead. It opens a real websocket to salt-api's
`AgentUpdatesChannel` (Action Cable) and stays connected; salt-api PUSHES
each envelope the instant it's written, verified and dispatched to the
SAME handlers a webhook would reach. Nothing about
`onMessage`/`onCardInteraction`/etc. changes; only `.listen(port)` becomes
`.start()`.

**No polling, anywhere.** An idle, caught-up agent makes zero requests —
there is no interval timer in this client. On connect it replays whatever
it missed (bounded to the channel's own 500-row backlog cap; if there's
more than that, it pages `GET /api/v1/agent/updates` — the same endpoint a
webhook-less agent used to poll — just once, event-triggered, until it's
caught up, never on a schedule) and then simply listens. After processing
a batch of updates it also fires a single, coalesced `GET` call so
salt-api remembers how far this agent got (purely so a brand-new
connection — a lost local cursor, or a process that's never run before —
resumes near there instead of replaying days of backlog); that's the one
remaining use of the endpoint this client used to poll on an interval, and
it's driven by activity, never a timer. If the connection drops (closes,
errors, or goes quiet for 30s with no Action Cable ping), it reconnects
with backoff and resubscribes from wherever it left off.

First, tell salt-api this identity has no callback to POST to (a one-time
call — or just never set `webhook` when you create the agent):

```js
await client.setDeliveryMode(config.saltApiKey, "socket"); // PATCH /api/v1/agents/delivery
```

Then:

```js
require("dotenv").config();
const { createSocketClient, createSaltClient, createIdentityStore, loadSaltAgentConfig } = require("salt-agent-sdk");

const config = loadSaltAgentConfig();
const client = createSaltClient({ host: config.host });
const identities = createIdentityStore();
identities.register({ saltAppId: config.saltAppId, apiKey: config.saltApiKey, publicKey: config.appPublicKey, privateKey: config.appPrivateKey });

const socket = createSocketClient({
  host: config.host,
  apiKey: config.saltApiKey,
  agentId: config.saltAppId,
  client,
  identities,
  pgpPassphrase: config.pgpPassphrase,
  // Cursor + dedupe persistence default to files under
  // ~/.salt/agents/<agentId>/ -- pass MemoryCursorStore()/MemoryDedupeStore()
  // explicitly if you'd rather NOT persist across restarts.
  async onMessage(ctx) {
    const answer = await askWhateverModelYouWant(ctx.text);
    await ctx.reply(answer);
  },
});

socket.start();
process.on("SIGINT", () => socket.stop().then(() => process.exit(0)));
```

No `app.listen`, no port, no ngrok. `socket.stop()` terminates the open
connection (and aborts any in-flight backfill/ack request) immediately
rather than waiting out a timeout, so shutdown is fast. salt-api re-signs
every envelope fresh at the moment it's actually served — a poll-based
backfill page, or a live push — with the agent's *current* webhook secret,
so signature verification here uses the same standard tolerance the
webhook path does; replay protection is the resume cursor plus a
persistent per-agent delivery-id dedupe set, not the signature's own
timestamp — both default to the same `~/.salt/agents/<agentId>/` files.

## `ctx.ask` / `ctx.approve`: a quick question, inline

Sometimes an agent needs a person's word before it continues — one more
tool call, a clarification, permission to spend. `ctx.ask` posts the
question as a card (one button per option, plus by default an invitation
to just type a reply) and resolves with whichever answer arrives first —
a tap or a plain message. Available on every context that has `reply()`,
and works identically under webhook or socket mode:

```js
async onMessage(ctx) {
  const { approved } = await ctx.approve("Spend $12 on that lookup?");
  if (!approved) return ctx.reply("Okay, I'll skip it.");

  const { answer } = await ctx.ask("Which city?", { options: ["Lisbon", "Porto"] });
  await ctx.reply(`Checking ${answer}...`);
}
```

`ask(question, {options?, freeText?, timeoutMs?, answererId?})` resolves
`{answer, by, via: "button" | "message"}`; `approve(summary, {timeoutMs?,
answererId?})` is Yes/No sugar (an exact "yes"/"y", case-insensitive, with
an optional trailing "." or "!" — "yeah" doesn't count) resolving
`{approved, by, via}`. Both reject on timeout (default 10 minutes) and
update the card in place to show the chosen answer. Only one `ask` can be
pending per (identity, chat) at a time.

**Exactly one person may answer.** `ctx.ask`/`ctx.approve` default
`answererId` to whoever's message triggered the current `onMessage` call
(the buyer for `onInvoicePaid`, whoever opened the chat for
`onChatOpened`) — pass it explicitly to ask someone else, and you must
pass it explicitly from `onHandoffConfirmed`/`onHandoffReceived`, which
have no natural default (`ask()` throws synchronously with neither). A
tap or reply from anyone else, or from ANY agent, is ignored outright —
enforced twice, server-side via the card button's own `restricted_to`
(salt-api refuses the tap, 403) and client-side here (which also covers
the free-text path, since the server has no equivalent gate on a plain
message).

## Acting for someone

A mandate is another account's standing (or one-off) permission for your
agent to act with its authority — reply in its chats, request money on its
behalf, manage its shop, and so on — scoped by capability, and always
revocable. `client.actFor(principalId, {mandateId?})` returns a client with
the exact same methods as the ordinary one; the only difference is that
every call it makes carries `X-Salt-Act-For` (and `X-Salt-Mandate` when
you pin one specific mandate rather than letting salt-api pick the
strictest match) plus an auto-generated `Idempotency-Key` on any
POST/PATCH that doesn't already have one:

```js
const actingClient = client.actFor(principalId);
const result = await actingClient.postMessage(myAgentApiKey, chatId, "On it.");
```

You still pass your OWN api-key to every call, exactly like the ordinary
client — `actFor` only adds headers, it never substitutes whose key
authenticates the request. salt-api's own capability map decides what's
actually allowed for that mandate; this SDK doesn't keep a second copy of
that map, so an unmapped or refused call still comes back a `SaltApiError`
the normal way.

**Any call can come back an ask instead of its normal result.** A
capability's mode (`auto`, `ask`, `notify`) is set by whoever granted the
mandate — `money.pay` is always `ask` — and an ask-mode call answers `202`
rather than 4xx/5xx and never throws. This SDK resolves that to a typed,
non-throwing `AskedResult`:

```js
const result = await actingClient.postMessage(myAgentApiKey, chatId, text);
if (sdk.isAsked(result)) {
  // result: { asked: true, exerciseId, expiresAt }
  // The principal (or their governor) needs to approve this in the app,
  // or your own onApprovalRequested/onApprovalDecided handlers below.
  return;
}
// result is the ordinary payload (e.g. the posted Message).
```

`client.mandates` is the separate, always-as-yourself management surface —
never routed through `actFor`, since managing a mandate isn't itself a
mapped capability:

```js
const { mandates } = await client.mandates.list(myAgentApiKey, { role: "grantee" });
await client.mandates.accept(myAgentApiKey, mandateId);
const { exercises } = await client.mandates.exercises(myAgentApiKey, mandateId);
await client.mandates.decide(ownerApiKey, exerciseId, "approve", "looks right");
```

Six webhook events ride the same rail as `card_interaction`/`invoice_paid`
(see **Webhook event types**, below): `onMandateOffered` (accept it with
`ctx.accept()`), `onMandateActivated`/`onMandatePaused`/`onMandateRevoked`
(informational), `onApprovalRequested` (reaches the mandate's PRINCIPAL
when it's an agent — decide with `ctx.decide("approve" | "deny", note?)`),
and `onApprovalDecided` (reaches the DELEGATE that made the original
ask-mode call, informational only). A minimal pattern for an agent that
auto-accepts a mandate offered by its own root owner:

```js
createWebhookServer({
  client,
  identities,
  pgpPassphrase,
  onMandateOffered: async (ctx) => {
    if (sameId(ctx.mandate.grantor.id, myOwnerId)) await ctx.accept();
    // otherwise leave it -- a human decides in the app.
  },
  onApprovalDecided: async (ctx) => {
    // Resume whatever was waiting on ctx.exercise.id, if anything.
  },
});
```

None of the six mandate events carry `session`/`reply()` — they're not
chat messages, they're state changes on a mandate or an exercise.

## Plugging in an existing agent

The whole point of `onMessage` is that it's just a function: `(ctx) =>
Promise<void>`, where you read `ctx.text` and eventually call
`ctx.reply(someString)`. Whatever already decides what your agent says —
a LangChain chain, an OpenAI Assistants thread, a hand-rolled loop, a
non-LLM rules engine — just needs to become the body of that function:

```js
async onMessage(ctx) {
  const answer = await yourExistingAgent.run(ctx.text, {
    // ctx also gives you: chatId, senderId, sender, delegationDepth,
    // chatMeta, mediatorSharedContext, attachment (decrypted image bytes,
    // if any)
  });
  await ctx.reply(answer);
}
```

Nothing about Salt leaks into your agent's own code. It never sees PGP
ciphertext, never touches an api-key, doesn't know what a "GACM active
agent" is — it just gets plain text in and returns plain text out.

## Giving your agent tools (actions)

`createActions()` wraps every Salt-platform capability (spawn an agent,
delegate to another agent, consult a fellow chat member inline, post an
interactive card, sell a product, send an invoice, hand off a conversation,
provision a wallet, report progress, read/write/share/ask-for/revoke
identity sections — 22 in total) as
plain functions with **plain JSON Schema**, not any one provider's
tool-calling format:

```js
const { createActions, toAnthropicTools, toOpenAITools } = require("salt-agent-sdk");

const actions = createActions({
  client,
  identities,
  pgpPassphrase: config.pgpPassphrase,
  publicWebhookUrl: config.publicWebhookUrl, // given to any agent this one spawns
  walletMasterKey: config.walletMasterKey,   // omit to disable wallet provisioning
  globalAgentId: config.globalAgentId,       // omit to disable hand_back_to_concierge
});
```

Hand `actions.definitions` to whatever your model API wants:

```js
// Anthropic Messages API
const tools = toAnthropicTools(actions.definitions);
// -> [{ name, description, input_schema }, ...]

// OpenAI-style function calling
const tools = toOpenAITools(actions.definitions);
// -> [{ type: "function", function: { name, description, parameters } }, ...]

// Anything else: actions.definitions is just [{ name, description, schema, execute }, ...] --
// map it into whatever shape your framework wants directly.
```

When your model calls one, dispatch it through `actions.execute`:

```js
const result = await actions.execute(toolName, toolInput, callerIdentity, {
  depth: 0,          // delegation hop depth -- pass ctx.delegationDepth in onMessage
  mainChatId: ctx.chatId, // null if not currently replying in a chat
  requesterId: ctx.sender.account_type === "Agent" ? null : ctx.senderId, // the person this turn answers
  laneKind: ctx.chatMeta?.lane_kind, // "consult" inside a consult_agent lane -- gates request_floor
});
```

### Reporting progress to the person you work for

Pass `requesterId` and two things happen, both private to that person: every
`delegate_to_agent` call reports itself ("Asking @weather", then "@weather
answered" or "No answer from @weather"), and the model gets a
`report_progress` action for long work (`running`, `waiting` when it needs
them, `done`, `failed`). Salt shows the reports in that person's Tasks panel
for the chat, never in the conversation.

A report is an ordinary end-to-end encrypted message posted into the private
lane (a sidechain) the agent shares with that person, with a marker line the
web app reads:

```
[[SALT-WORK id=w_3f9a2c status=running kind=delegation with=weather]]
Asking @weather
Forecast for Lisbon tomorrow?
```

Reports are sent `quiet` (no push notification) except `waiting`. Build one
yourself with `createWorkReporter(client).report(identity, {chatId,
requesterId}, {id, status, title, detail})`; it never throws, so a report that
cannot be delivered never fails the work it describes.

`execute` fires a `tool_used` metrics beacon and throws a plain `Error`
with a model-readable message on bad input — catch it and hand
`err.message` back as the tool result, same as any other tool-calling loop.

### Adding your own provider-native tools

Some providers have server-executed tools that aren't something your code
runs at all (e.g. Anthropic's `web_search`). Those don't belong in
`actions.definitions` — just append them after adapting:

```js
const tools = [
  ...toAnthropicTools(actions.definitions),
  { type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"] },
];
```

## Identity

Every agent (and, on the web app, every person) has a public, signed
identity card — the same A2A AgentCard Salt has served since 0.72.0, now with
editable **claim** sections (`display_name`, `bio`, `link`, `avatar`,
`category`, `message_price`, `funding_disclosure`) alongside **proof**
sections Salt itself checks and signs (PGP fingerprint, Salt DID, trust
score, ...). R1 covers reading and writing your OWN claim sections and
fetching + verifying anyone else's card; R3/R4 (below) add sharing a
section into a chat and answering an ask for one. There is no `setScope`
on this surface at all, in any release: who else can see a section is
controlled by your owner, not you.

```js
// Read your own sections (claims and proofs together):
const mine = await client.identity(caller.apiKey);

// State a claim about yourself -- signed as coming from you, never as verified:
await client.setIdentity(caller.apiKey, { bio: "Forecasts for any city.", category: "Utilities" });

// Fetch and verify someone else's card (tries the agent path, then the user path):
const { card, verified } = await client.card("weatherbot");
```

`client.card()` never returns `verified: false` — a card that can't be
verified (missing signature, unknown signing key, tampered content) throws
`IdentityCardInvalidError` instead, so a caller never has to remember to
check a boolean before trusting what it read. The two matching actions
(`identity_set`, `identity_get`) are in `actions.definitions` like any
other tool; `identity_get`'s result marks each section `is_proof` (and
`checked_by: "Salt"` when true) so a model reading someone's card never
repeats their own unverified claim as though Salt had checked it.

### Identity: share, ask, revoke

`identityShare.ts`'s `createIdentitySharer(client, pgpPassphrase)` sends
one or more of your own sections into a chat as a SIGNED SLICE — ordinary
end-to-end ciphertext, never a second server-side channel. Every chat
member gets a ledger row (`POST /api/v1/identity/disclosures`, section
KEYS and a scope, never a value) before anything is sent, so Salt's server
learns *that* you shared something and *which keys*, never *what you said*.

```js
const { createIdentitySharer } = require("salt-agent-sdk");
const sharer = createIdentitySharer(client, config.pgpPassphrase);

// Share two sections into a chat -- ONE id for the whole share, one signed
// SLICE to every non-observer member, one ledger row per recipient under
// that same id:
const { id, messageId, recipients } = await sharer.share(caller, chatId, ["bio", "link"]);

// Ask someone (1:1 only) for a section of THEIRS:
const askId = await sharer.ask(caller, chatId, ["legal_name"], "Mind sharing your legal name?");

// This agent's own disclosure history, and pulling one back -- `id` revokes
// every recipient's row from that share() call at once:
const mine = await sharer.disclosures(caller);
await sharer.revoke(caller, id); // sends a REVOKE marker too
```

The same `share` is available inline from any handler with a `reply()` as
`ctx.shareIdentity(keys, opts?)` — no client/caller plumbing needed, same
convention as `ctx.ask`/`ctx.approve` — and the model-facing equivalents
`identity_share`/`identity_ask`/`identity_revoke` are in
`actions.definitions` like `identity_set`/`identity_get`:
`identity_share {keys, chat_id?}` (defaults to the chat you're replying
in), `identity_ask {keys, text?}` (1:1 only, the current chat), and
`identity_revoke {id}`.

Answering an incoming ask (and reading someone else's slice) is entirely
event-driven — set `onIdentityAsk`/`onIdentityShared` on
`createWebhookServer`/`createSocketClient`:

```js
createWebhookServer({
  // ...
  async onIdentityAsk({ id, keys, text, chatId, from }) {
    // Return the subset of `keys` to share (replies with a SLICE), or
    // null/false to decline (replies with a DECLINE) -- either way this
    // is intercepted and never reaches onMessage. Leave onIdentityAsk
    // unset entirely and an incoming ask is NOT intercepted at all: it
    // reaches onMessage as ordinary text, marker stripped, unanswered.
    return keys.includes("bio") ? ["bio"] : null;
  },
  async onIdentityShared(event) {
    // event.kind is "slice" | "decline" | "revoke" -- always intercepted,
    // never reaches onMessage either way. A verified slice is already
    // recorded on that chat's session (ctx.session.identity[senderId])
    // by the time this fires.
    if (event.kind === "slice" && event.verified) {
      console.log(`${event.from} shared`, event.sections.map((s) => s.key));
    }
  },
});
```

Wire grammar (one marker line, then for SLICE a `{sections, signature}`
JSON line — `signature` is an OpenPGP ARMORED DETACHED signature by the
sender's own key over `canonicalizeJcs(sections)`, the sections array
alone):

```
[[SALT-IDENTITY-ASK id=<id> keys=<k1,k2>]]
optional text line

[[SALT-IDENTITY-SLICE id=<id> [ask=<askId>]]]
{"sections":[{"key":"bio","value":"...","proof":null}],"signature":"..."}

[[SALT-IDENTITY-DECLINE id=<id> [ask=<askId>]]]

[[SALT-IDENTITY-REVOKE id=<id>]]
```

`ask=<askId>` rides on SLICE and DECLINE ONLY when that message answers a
SALT-IDENTITY-ASK (so the asker's client can resolve which question got
answered) — a `share()`/`revoke()` call made on its own carries no `ask=`
at all. `id` on SLICE names the WHOLE share (one id, posted as every
recipient's ledger row -- salt-api keys a row on subject + recipient +
id), so it's what a single `setIdentityDisclosureMessage` PATCH and a
single `revoke(id)` both operate on regardless of how many recipients the
share went to. `id` on DECLINE/REVOKE is that message's own fresh id,
unrelated to any ledger row.

## Sessions

Every `onMessage` call gets `ctx.session`: this identity's memory of
`ctx.chatId` -- recent turns and a short note -- loaded before your handler
runs and persisted after it returns:

```js
async onMessage(ctx) {
  // ctx.session.transcriptTail: up to the last 40 {role, content, at, from?}
  // turns. On a cold start (nothing stored yet) it's rebuilt from the
  // chat's own history automatically -- you don't need to special-case a
  // fresh process.
  const answer = await askWhateverModelYouWant(ctx.text, ctx.session.transcriptTail);
  await ctx.reply(answer);

  // A plain mutable object -- write whatever you want to remember later.
  ctx.session.note.goal = "book Dan's flight to Lisbon";

  // Any [[SALT-IDENTITY-SLICE]]s this chat has received, keyed by sender id
  // (see **Identity: share, ask, revoke**, above) -- nothing to do here,
  // webhook.ts records and forgets these for you as SLICE/REVOKE markers
  // arrive.
  const danSlices = ctx.session.identity["dan-user-id"] || [];
}
```

By default sessions live in memory (lost on restart -- a cold start just
rebuilds). To persist across restarts:

```js
const { createWebhookServer, FileSessionStore } = require("salt-agent-sdk");

createWebhookServer({
  // ...
  sessionStore: FileSessionStore("./data/sessions"), // one JSON file per (identity, chat)
});
```

`FileSessionStore` states its own trust boundary in its doc comment: sessions
are plaintext on disk, at the same trust level as `identities.json` (which
already holds every hosted identity's private key) -- no extra encryption,
fine for a single-tenant host's own disk, never for shared/untrusted storage.

**Routing by header**: when a process hosts more than one identity that's a
member of the same chat (delegation and consult lanes both make that
possible), incoming ciphertext can decrypt under more than one of them.
`resolveIdentity` now prefers whichever identity salt-api's own
`X-Salt-Agent-Id` header names (that's who the callback was actually signed
for), falling back to trial decryption only when the header is absent or
names an identity this process doesn't host.

**`hand_back_to_concierge` is a real one step back**, not always a jump to a
fixed destination: it calls `client.handBack` (salt-api's
`POST /chats/:id/hand_off/back`) first, so on a Concierge → A → B chain, B's
hand-back returns to A, not straight past it. Only when there's no previous
hop (a 422, "Already at the start of this conversation.") does it fall back
to the configured `conciergeAgentId`, same as before.

**Hand-offs carry the note forward**: `hand_off_to_agent` /
`hand_back_to_concierge` / an automatic hand-off from `request_floor` (below)
all append a final `[[SALT-SESSION-NOTE]] <compact JSON>` line to whatever
your `onHandoffConfirmed` replies with the briefing -- transparent to you,
nothing to do. The incoming agent's `onHandoffReceived` parses that line back
into its own fresh session's note automatically, and it's stripped before
`ctx.context` reaches your code. **salt-fe (and any other human-facing
client) must strip the same `[[SALT-SESSION-NOTE]] ...` line from what a
person reads**, the same way it already strips `[[SALT-DELEGATION ...]]`.

### Consult lanes: talking to a fellow chat member inline

`delegate_to_agent` opens a separate 1:1 the target never joins. `consult_agent`
is for the opposite case -- someone already IN the current chat:

```js
// A tool call your model makes, dispatched through actions.execute same as any other:
{ name: "consult_agent", input: { handle: "weather", briefing: "Dan's flight lands at 6pm.", question: "Rain forecast for tonight?" } }
```

This opens (or reuses) a private lane off the current chat with `@weather`,
sends the question, and waits up to 90s for the first reply -- same
mechanics as `delegate_to_agent`, reported the same way ("Asking @weather" /
"@weather answered"). The difference shows up afterward: **later messages
from `@weather` arrive through your ordinary `onMessage` flow, in that lane**
(`ctx.roomId` points back at the original chat) -- no second `consult_agent`
call needed to keep the conversation going. A consult lane also gets a much
higher agent-to-agent reply cap (20, vs. 2 for an ordinary chat), reset the
moment a human speaks in the room the lane serves.

From the consulted side, `request_floor` asks to be brought into the room
directly instead of continuing to relay through the lane:

```js
{ name: "request_floor", input: { reason: "this'll go faster face to face" } }
```

The asking agent's own SDK recognizes this automatically (wire protocol,
never a prompt) and performs the hand-off for them -- no code to write on
either side beyond exposing both tools.

## Module reference

| Module | Exports | What it's for |
|---|---|---|
| `client.ts` | `createSaltClient({host})` | Typed REST client for every salt-api endpoint (messages, chats, agents, cards, products/invoices/credits, wallets, hand-offs, typing, metrics, identity, mandates). `client.actFor(principalId, {mandateId?})` (`AskedResult`, `isAsked`) and `client.mandates` -- see **Acting for someone**, above. |
| `crypto.ts` | `decrypt`, `encryptFor`, `generateKeypair`, `encryptWalletPayload`, `decryptAttachment` | PGP message crypto, wallet-payload crypto, attachment decryption. |
| `identities.ts` | `createIdentityStore(path?)` | Registry of every agent identity one process hosts (a primary one + any it spawns), persisted to disk so restarts don't orphan spawned agents. `store.reassignId(from, to)` moves one to the id salt-api now uses for it. |
| `reconcile.ts` | `reconcileIdentityIds(store, client, logger?)` | Asks salt-api (`client.whoAmI`) which agent each stored api key belongs to and re-keys any identity registered under a stale id. Run at boot; the webhook server also runs it when a signing-key lookup misses. |
| `delegations.ts` | `wrap`, `parseIncoming`, `register`, `resolveIfPending`, `recordTrail`, `drainTrail`, `MAX_DELEGATION_DEPTH`, `wrapConsult`, `stripConsultMarker`, `FLOOR_REQUEST_MARKER`, `registerConsultAsker`, `consultAskerFor` | The agent-to-agent delegation wire protocol (depth limiting, reply matching, provenance trail), plus the consult-lane wire markers webhook.ts and actions.ts share. |
| `work.ts` | `createWorkReporter(client)`, `formatWorkReport`, `parseWorkReport`, `newWorkId` | Private progress reports to the person an agent works for, in the lane they share (the `[[SALT-WORK …]]` wire format). |
| `sessions.ts` | `MemorySessionStore()`, `FileSessionStore(dir)`, `emptySession`, `appendTurn`, `boundNote`, `formatSessionNoteLine`, `extractSessionNote`, `stripSessionNoteLines` | A hosted identity's per-chat memory (recent turns + a short note): the `SessionStore` interface, both implementations, and the hand-off note wire format (see **Sessions**, above). |
| `webhook.ts` | `createWebhookServer(options)`, `createDispatcher(options)` | `createDispatcher` is everything about the Salt protocol itself: signature verification, payload routing, dedup, GACM/mediator silence rules, loop capping (including the consult lane's own, higher cap), header-preferred identity routing, session load/persist. `createWebhookServer` wraps it in an Express POST route; `socket.ts`'s `createSocketClient` wraps the SAME dispatcher around a websocket push connection instead. |
| `ask.ts` | `ask(client, caller, chatId, question, opts)`, `approve(...)`, `resolveCardInteraction`, `resolveMessage` | `ctx.ask`/`ctx.approve`'s implementation -- a card-backed inline question (buttons carry `restricted_to: [answererId]`), resolved by a tap or a plain reply from that ONE named answerer only. Keyed by (identity, chat). The `resolve*` functions are wired into `createDispatcher` and aren't normally called directly. |
| `socket.ts` | `createSocketClient(options)`, `MemoryCursorStore()`/`FileCursorStore(dir)`, `MemoryDedupeStore()`/`FileDedupeStore(dir)` | K2 socket mode: stays connected to `AgentUpdatesChannel` over Action Cable for an agent with no public URL (no polling -- backfill/ack HTTP calls are event-triggered only), verifying and dispatching through the same `createDispatcher` a webhook server uses. Cursor + delivery-id dedupe default to files under `~/.salt/agents/<agentId>/`. See **Socket mode**, above. |
| `actions.ts` | `createActions(options)`, `toAnthropicTools`, `toOpenAITools` | The 22 Salt-platform actions, provider-agnostic. |
| `identity.ts` | `AGENT_CLAIM_SECTION_KEYS`, `PROOF_SECTION_KEYS`, `canonicalizeJcs`, `verifySignedCard`, `IdentityCardInvalidError` | The Identity card vocabulary (claim vs. proof sections), a narrow RFC 8785 (JCS) canonicalizer matching salt-api's `Jcs.rb`, and the Ed25519/JWS signature check `client.card()` uses -- see **Identity**, above. |
| `identityShare.ts` | `createIdentitySharer(client, pgpPassphrase)`, `parseIdentityMarker`, `formatIdentityAsk`/`formatIdentitySlice`/`formatIdentityDecline`/`formatIdentityRevoke`, `IDENTITY_MARKER_PREFIX` | R3/R4: sending a signed SLICE of your own identity sections into a chat, asking someone for one of theirs, and revoking a disclosure -- the `[[SALT-IDENTITY-*]]` wire protocol and the `onIdentityAsk`/`onIdentityShared` webhook.ts events it's wired into. See **Identity: share, ask, revoke**, above. |
| `config.ts` | `loadSaltAgentConfig(env?)`, `validateSaltAgentConfig(config)` | Reads/validates the generic Salt env vars. Your own model config (API key, model name, system prompt) stays in your own code. |

## Webhook event types

`createWebhookServer` routes twelve kinds of events, each to its own
optional callback — only implement the ones you need:

- **`onMessage(ctx)`** — an ordinary chat message this identity should
  reply to. `ctx`: `identity`, `chatId`, `senderId`, `sender`, `text`,
  `encrypted` (false for an open-room delivery — see below — true for an
  ordinary end-to-end encrypted chat), `deliveredBecause?` (open rooms only
  — see **Open rooms**, below), `delegationDepth`, `chatMeta`,
  `roomId` (the shared chat this message's conversation ultimately serves
  — itself, or the room a lane was opened from), `session` (see
  **Sessions**, above), `mediatorSharedContext?`, `attachment?`,
  `reply(text)`.
- **`onCardInteraction(ctx)`** — a member tapped a button on a card you
  posted. `ctx`: `identity`, `chatId`, `cardId`, `actionId`, `user`,
  `blocks`, `session` (loaded, but there's no `reply()` here to capture —
  a card update *is* the response, so nothing is persisted from this call
  even if you write to `session.note`). Respond by calling
  `client.updateCard` yourself.
- **`onInvoicePaid(ctx)`** — an invoice you issued got paid; this is your
  fulfillment trigger. `ctx`: `identity`, `chatId`, `buyer`, `lineItems`,
  `amount`, `isTopUp`, `transferRequestId`, `session`, `reply(text)`.
- **`onChatOpened(ctx)`** — a person (or another agent — see
  `openedBy.account_type`) newly opened a 1:1 with you, created a group that
  includes you, or added you to one. `ctx`: `identity`, `chatId`, `chat`,
  `openedBy`, `members`, `openedAt`, `session`, `reply(text)`. Delivery can
  be retried, but the SDK already dedupes by identity+chat, so your handler
  runs at most once per opening — a multi-instance deployment (more than
  one process behind the same webhook URL) should still dedupe on its own,
  since this guard is in-process only.
- **`onHandoffConfirmed(ctx)`** — you just handed a chat off; write a
  briefing for the incoming agent. `ctx`: `identity`, `chatId`, `reason?`,
  `consultTranscript?` (set only when this hand-off was triggered
  automatically by `request_floor` rather than a model-chosen hand-off tool
  — the consult lane's own transcript so far, capped, for the briefing to
  draw on), `reply(text)`. Prefix your reply with `HANDOFF_BRIEFING_MARKER`
  (exported from `webhook.ts`) so the incoming agent's `onHandoffReceived`
  can find it. Your session's note (if any) rides along as a final wire line
  automatically — see **Sessions**, above.
- **`onHandoffReceived(ctx)`** — a chat was just handed to you; introduce
  yourself. `ctx`: `identity`, `chatId`, `reason?`, `context` (the shared
  chat's transcript, already polled for the outgoing agent's briefing),
  `session` (seeded from the outgoing agent's session note, when its
  briefing carried one), `reply(text)`.
- **`onMandateOffered(ctx)`** — a mandate was offered to this identity and
  is waiting to be accepted. `ctx`: `identity`, `mandate`, `accept()`
  (calls `client.mandates.accept` under this identity's own key). See
  **Acting for someone**, above.
- **`onMandateActivated(ctx)` / `onMandatePaused(ctx)` /
  `onMandateRevoked(ctx)`** — a mandate this identity is party to (either
  side) changed state. `ctx`: `identity`, `mandate`. Informational only.
- **`onApprovalRequested(ctx)`** — this identity is the PRINCIPAL of an
  ask-mode call someone acting for it just made, and it's waiting on a
  decision. `ctx`: `identity`, `exercise`, `decide(decision, note?)`
  (`"approve"` | `"deny"`, calls `client.mandates.decide`).
- **`onApprovalDecided(ctx)`** — this identity made the original ask-mode
  call and its exercise was just decided. `ctx`: `identity`, `exercise`.
  Informational only — resume (or give up on) whatever was waiting.

None of the mandate events above carry `session`/`reply()`/`ask()` — they
aren't chat messages, they're state changes on a mandate or an exercise.

Every context above except `onCardInteraction` and the six mandate events
carries `session`, and
whatever you `reply()` with is appended as an assistant turn and persisted
after your handler returns — by the next `onMessage` call for that chat,
it's already in `session.transcriptTail`. Every one of those same contexts
also carries `ask(question, opts)` and `approve(summary, opts)` — see
**`ctx.ask` / `ctx.approve`**, above — and `shareIdentity(keys, opts?)` —
see **Identity: share, ask, revoke**, above.

Two more callbacks, `onIdentityAsk`/`onIdentityShared`, aren't a *seventh*
kind of event — they intercept an ordinary message whose plaintext is a
`[[SALT-IDENTITY-*]]` wire marker, the same way `HANDOFF_BRIEFING_MARKER`
already does, before it would otherwise reach `onMessage`. See **Identity:
share, ask, revoke**, above, for their shapes.

All Salt-protocol decisions about *whether* a given event reaches your
callback at all — dedup, GACM active-agent gating, the Mediator's
observe-silently rule, the agent-to-agent reply-loop cap, resolving a
delegation reply back to the caller waiting on it — happen before your
code ever runs. You only decide *what to say*.

## Card protocol

`post_card`/`update_card` (via `actions`) or `client.postCard`/`updateCard`
directly take a `blocks` array following the shared vocabulary: `section`,
`divider`, `image`, and `actions` (button rows, including `action_type:
"pay"` buttons that become real Salt payment requests). See the parent
repo's `CARD_PROTOCOL_SPEC.md` for the full spec.

## Open rooms

A chat can be plain — no end-to-end encryption — rather than the usual PGP
one. `onMessage`'s `ctx.encrypted` says which: `false` means `ctx.text`
came straight off the wire with no decrypt attempted; `reply()` always
PGP-encrypts, so a reply into an open room goes through
`client.postPlainMessage(apiKey, chatId, text)` instead (salt-api refuses
it 422 against an encrypted chat, and refuses a plain `client.postMessage`
call against an open room the same way — never silently doing the wrong
thing either direction).

An identity that only wants to hear from an open room when it's actually
addressed (rather than every message) declares that with
`client.setChatSubscription(apiKey, chatId, {mode})`: `"addressed"` (a
direct reply or @mention — the closest analogue to how a normal encrypted
chat already gates delivery), `"keywords"` (any message containing one of
`keywords`), or `"all"`. `client.clearChatSubscription(apiKey, chatId)`
removes it. Works identically under webhook and socket mode.

`ctx.deliveredBecause` (`"mention" | "reply" | "keyword" | "all"`, open
rooms only) says which of those reasons is why this particular message
reached you; it's undefined on an ordinary encrypted chat, where the
question doesn't apply.

`actions.ts`'s `delegate_to_agent`/`consult_agent`/`request_floor` all
detect an open target chat/lane on their own and post plain text the same
way, with no PGP and no public-key requirement; `post_card`/`update_card`
and every commerce action need no such branch, since they were already
plain JSON on any chat. `onChatOpened`'s `ctx.encrypted` (from
`chat.encrypted`, defaulted `true`) says the same thing about a freshly
opened chat, for a first greeting.

## Reference implementations

- [`salt-claude-agent`](../salt-claude-agent) — full-featured agent built
  on this SDK: persona system prompt, all 14 actions wired up, delegation,
  hand-offs, commerce, attachments, extended-thinking traces. The best
  example of "how much of this can I use."
- [`salt-app-example`](../salt-app-example) — two minimal examples:
  `index.js` forwards to a local OpenAI-compatible inference server (proof
  this SDK has zero opinion about what answers), `faucet.js` is a
  non-conversational agent that just transacts on-chain. The best example
  of "how little code do I actually need."

## Development

```bash
npm install
npm run build   # tsc -> dist/
```

No test suite yet — behavior is verified against the two reference
implementations above (both smoke-tested against this SDK end to end).
