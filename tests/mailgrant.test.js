// Salt 0.264.0 mailbox grant, agent side: client.mailbox, MailGrantError, openMailRow, the two deliveries.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const sdk = require("../dist/index.js");
const ROWS = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "mail_in_rows.json"), "utf8"));

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return respond(url, opts, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}
function jsonResponse(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k] }, json: async () => body, text: async () => JSON.stringify(body) };
}
const make = (respond) => {
  const fetchImpl = recordingFetch(respond);
  return { fetchImpl, client: sdk.createSaltClient({ host: "https://salt.test", fetchImpl }) };
};
const silent = { info() {}, warn() {}, error() {}, debug() {} };

test("getGrant reads the agent's own grant with holder_id on agents/me", async () => {
  const grant = { mandate_id: "m1", agent_id: "a1", holder_id: "h1", rows: [{ capability: "mail.read", feature: "Read", mode: "alone", default_mode: "alone", offered: true, warn_line: null }], waiting: [], recent_use: [] };
  const { fetchImpl, client } = make(() => jsonResponse(200, grant));
  const g = await client.mailbox.getGrant("k", "h1");
  assert.equal(g.rows[0].mode, "alone");
  assert.equal(fetchImpl.calls[0].method, "GET");
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/agents\/me\/mailbox_grant\?holder_id=h1$/);
  assert.equal(fetchImpl.calls[0].headers["api-key"], "k");
});

test("listMessages and openMessage: paths, cursor, approval_id", async () => {
  const { fetchImpl, client } = make((u) => (/messages\/m9/.test(u) ? jsonResponse(200, { id: "m9", chat_id: "c", message: "ARMOR" }) : jsonResponse(200, { messages: [{ id: "m9", chat_id: "c", received_at: "t", seq: 1 }], next_before: "nb" })));
  const page = await client.mailbox.listMessages("k", "h1", { before: "x", approvalId: "ap1" });
  assert.equal(page.next_before, "nb");
  assert.match(fetchImpl.calls[0].url, /\/mailbox\/messages\?holder_id=h1&before=x&approval_id=ap1$/);
  const row = await client.mailbox.openMessage("k", "m9", "h1");
  assert.equal(row.message, "ARMOR");
  assert.match(fetchImpl.calls[1].url, /\/mailbox\/messages\/m9\?holder_id=h1$/);
});

test("a 202 is a typed MailAsked, not an AskedResult", async () => {
  const { client } = make(() => jsonResponse(202, { approval_id: "ap7", status: "waiting", message: "Asked.", poll: "/api/v1/approvals/ap7" }));
  const r = await client.mailbox.allowSender("k", "s1", "h1");
  assert.ok(sdk.isMailAsked(r));
  assert.equal(r.approvalId, "ap7");
  assert.equal(r.poll, "/api/v1/approvals/ap7");
  assert.equal(sdk.isMailAsked({ asked: true, exerciseId: "e" }), false);
});

test("allow, block, senders paging, alias revoke use the right verbs and paths", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(200, { senders: [], next_before: null }));
  await client.mailbox.listSenders("k", "h1", { limit: 100, before: "2026-11-24T10:00:00Z" });
  await client.mailbox.allowSender("k", "s1", "h1");
  await client.mailbox.blockSender("k", "s2", "h1");
  await client.mailbox.revokeAlias("k", "t1", "h1");
  await client.mailbox.listAliases("k", "h1");
  const c = fetchImpl.calls;
  assert.match(c[0].url, /\/mailbox\/senders\?holder_id=h1&limit=100&before=2026-11-24T10%3A00%3A00Z$/);
  assert.deepStrictEqual([c[1].method, c[2].method, c[3].method, c[4].method], ["POST", "POST", "DELETE", "GET"]);
  assert.match(c[1].url, /\/mailbox\/senders\/s1\/allow\?holder_id=h1$/);
  assert.match(c[2].url, /\/mailbox\/senders\/s2\/block\?holder_id=h1$/);
  assert.match(c[3].url, /\/mailbox\/tags\/t1\?holder_id=h1$/);
});

test("makeAlias sends purpose and plan_ref with an Idempotency-Key; too long throws before any request", async () => {
  const { fetchImpl, client } = make(() => jsonResponse(201, { id: "t1", tag: "bsky", address: "x@agents.test", purpose: "Bluesky sign-up", plan_ref: "acct-7" }));
  await client.mailbox.makeAlias("k", "h1", { tag: "bsky", purpose: "Bluesky sign-up", planRef: "acct-7" });
  const c = fetchImpl.calls[0];
  assert.deepStrictEqual(c.body, { tag: "bsky", purpose: "Bluesky sign-up", plan_ref: "acct-7" });
  assert.ok(c.headers["Idempotency-Key"]);
  await client.mailbox.makeAlias("k", "h1", { idempotencyKey: "mine" });
  assert.equal(fetchImpl.calls[1].headers["Idempotency-Key"], "mine");
  assert.deepStrictEqual(fetchImpl.calls[1].body, {});
  await assert.rejects(client.mailbox.makeAlias("k", "h1", { purpose: "x".repeat(61) }), (e) => e instanceof sdk.MailGrantError && e.kind === "invalid_purpose");
  await assert.rejects(client.mailbox.makeAlias("k", "h1", { planRef: "x".repeat(81) }), (e) => e instanceof sdk.MailGrantError && e.kind === "invalid_plan_ref");
  await client.mailbox.makeAlias("k", "h1", { purpose: "x".repeat(60), planRef: "y".repeat(80) });
  assert.equal(fetchImpl.calls.length, 3, "the two refused calls never reached the network");
});

test("mail_grant_required carries capability, feature, grant and the ready ask", async () => {
  const ask = { path: "/api/v1/mandates", body: { grantor_id: "h1", capabilities: [{ capability: "mail.read" }] } };
  const { client } = make(() => jsonResponse(403, { error: "Ask first.", code: "mail_grant_required", capability: "mail.read", feature: "Read the mail", grant: { capability: "mail.read" }, ask }));
  await assert.rejects(client.mailbox.listMessages("k", "h1"), (e) => {
    assert.ok(e instanceof sdk.MailGrantError && e instanceof sdk.SaltApiError);
    assert.equal(e.kind, "mail_grant_required");
    assert.equal(e.capability, "mail.read");
    assert.equal(e.feature, "Read the mail");
    assert.deepStrictEqual(e.ask.body, ask.body);
    assert.match(e.next, /Read the mail/);
    assert.equal(e.sentence, "Ask first.");
    return true;
  });
});

test("every other refusal code is typed with a next step and no capability", async () => {
  for (const [status, code] of [[403, "owner_decides"], [403, "declined"], [403, "blocked"], [403, "person_only"], [422, "not_pending"], [422, "invalid_purpose"], [422, "invalid_plan_ref"], [422, "not_available_yet"]]) {
    const { client } = make(() => jsonResponse(status, { error: `s ${code}`, code, capability: "mail.read", feature: "F" }));
    await assert.rejects(client.mailbox.getGrant("k", "h1"), (e) => e instanceof sdk.MailGrantError && e.kind === code && e.capability === undefined && e.feature === undefined && e.grant === undefined && e.ask === undefined && e.next.length > 10);
  }
  assert.deepStrictEqual([...sdk.MAIL_REFUSAL_CODES].sort(), ["blocked", "declined", "invalid_plan_ref", "invalid_purpose", "mail_grant_required", "not_available_yet", "not_pending", "owner_decides", "person_only", "ask_limit"].sort());
});

test("ask_limit is a 429 with Retry-After; an unrelated error stays a plain SaltApiError", async () => {
  const { client } = make((u) => (/approvals/.test(u) ? jsonResponse(404, { error: "Not found." }) : jsonResponse(429, { error: "Too many asks today.", code: "ask_limit" }, { "Retry-After": "90" })));
  await assert.rejects(client.mailbox.allowSender("k", "s", "h"), (e) => e instanceof sdk.MailGrantError && e.kind === "ask_limit" && e.retryAfterSeconds === 90 && e.status === 429);
  await assert.rejects(client.mailbox.getApproval("k", "nope"), (e) => e instanceof sdk.SaltApiError && !(e instanceof sdk.MailGrantError) && e.status === 404);
  assert.equal(sdk.asMailGrantError(new Error("x")), undefined);
});

test("the generic ask_limit of requestGrant is unchanged (not a MailGrantError)", async () => {
  const { client } = make(() => jsonResponse(429, { error: "slow", code: "ask_limit" }, { "Retry-After": "5" }));
  await assert.rejects(client.requestGrant("k", { grantorId: "g", capabilities: ["profile.post"], reason: "r" }), (e) => e instanceof sdk.SaltApiError && !(e instanceof sdk.MailGrantError) && e.retryAfterSeconds === 5);
});

test("waitForApproval polls until decided, with growing gaps", async () => {
  const seq = ["waiting", "waiting", "approved"];
  const { fetchImpl, client } = make((u, o, i) => jsonResponse(200, { approval_id: "ap1", status: seq[i], performed: seq[i] === "approved", spendable: true }));
  const sleeps = [];
  const r = await client.mailbox.waitForApproval("k", { asked: true, approvalId: "ap1", status: "waiting" }, { sleep: async (ms) => void sleeps.push(ms) });
  assert.equal(r.status, "approved");
  assert.equal(r.spendable, true);
  assert.equal(fetchImpl.calls.length, 3);
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/approvals\/ap1$/);
  assert.deepStrictEqual(sleeps, [5000, 7500]);
});

test("waitForApproval times out with the last approval, and stops on abort", async () => {
  const { client } = make(() => jsonResponse(200, { approval_id: "ap1", status: "waiting" }));
  let t = 0;
  await assert.rejects(client.mailbox.waitForApproval("k", "ap1", { timeoutMs: 10_000, now: () => t, sleep: async (ms) => void (t += ms) }), (e) => e instanceof sdk.MailApprovalTimeout && e.approval.status === "waiting");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(client.mailbox.waitForApproval("k", "ap1", { signal: ac.signal }), (e) => e instanceof sdk.MailApprovalCancelled);
  const declined = make(() => jsonResponse(200, { approval_id: "ap2", status: "declined", performed: false, reason: "declined" }));
  const d = await declined.client.mailbox.waitForApproval("k", "ap2", { sleep: async () => {} });
  assert.equal(d.performed, false);
  assert.equal(d.reason, "declined");
});

test("person-only calls are not agent methods", () => {
  const { client } = make(() => jsonResponse(200, {}));
  for (const name of ["setGrant", "putGrant", "pause", "approve", "decline", "deleteGrant"]) assert.equal(client.mailbox[name], undefined);
});

test("openMailRow opens a sealed mail_in row and keeps hostile text as data", async () => {
  const kp = await sdk.generateKeypair("pw");
  const sealed = await sdk.encryptFor(JSON.stringify(ROWS.hostile), [kp.publicKey]);
  const row = await sdk.openMailRow(sealed, kp.privateKey, "pw");
  assert.equal(row.content_trust, "untrusted_external");
  assert.equal(row.from.address, "stranger@example.test");
  assert.match(row.text, /Ignore your previous instructions/);
  assert.equal(row.extra_field_not_allowed, undefined, "allow-listed");
  assert.equal(row.trusted_sender, false);
  const viaClient = await make(() => jsonResponse(200, {})).client.mailbox.openMailRow(sealed, kp.privateKey, "pw");
  assert.equal(viaClient.subject, "Re: your sign-up");
});

test("openMailRow refuses anything that is not a v1 mail_in row", async () => {
  const kp = await sdk.generateKeypair("pw");
  for (const bad of [ROWS.wrong_kind, ROWS.wrong_version]) {
    const sealed = await sdk.encryptFor(JSON.stringify(bad), [kp.publicKey]);
    await assert.rejects(sdk.openMailRow(sealed, kp.privateKey, "pw"), (e) => e instanceof sdk.MailRowError);
  }
  const notJson = await sdk.encryptFor("plain words", [kp.publicKey]);
  await assert.rejects(sdk.openMailRow(notJson, kp.privateKey, "pw"), (e) => e instanceof sdk.MailRowError);
});

test("parseAliasWake allow-lists; from_host is kept, needs_ok only when true", () => {
  const w = sdk.parseAliasWake({ alias_wake: { tag: "bsky", purpose: "Bluesky sign-up", plan_ref: "acct-7", from_host: "mail.bsky.example", from_domain: "bsky.example", needs_ok: true, evil: "x" } });
  assert.deepStrictEqual(w, { tag: "bsky", purpose: "Bluesky sign-up", plan_ref: "acct-7", from_host: "mail.bsky.example", from_domain: "bsky.example", needs_ok: true });
  assert.deepStrictEqual(sdk.parseAliasWake({ alias_wake: { tag: "t", needs_ok: false } }), { tag: "t", purpose: null, plan_ref: null });
  assert.equal(sdk.parseAliasWake({}), undefined);
  assert.equal(sdk.parseAliasWake({ alias_wake: { purpose: "no tag" } }), undefined);
});

function dispatcherWith(handlers) {
  const agent = { saltAppId: "agent-1", username: "helper", apiKey: "k", publicKey: "x", privateKey: "y" };
  const store = { get: (id) => (String(id) === "agent-1" ? agent : undefined), all: () => [agent], register() {}, reassignId() {} };
  return sdk.createDispatcher({ client: { trackEvent() {} }, identities: store, pgpPassphrase: "x", logger: silent, ...handlers });
}

test("mail_grant_changed reaches onMailGrantChanged, typed", async () => {
  const seen = [];
  const d = dispatcherWith({ onMailGrantChanged: (c) => void seen.push(c) });
  await d.dispatch({ type: "mail_grant_changed", holder_id: "h1", paused: false, changed: [{ capability: "mail.read", mode: "alone" }, { capability: "mail.allow", mode: null }, { nope: 1 }], changed_at: "2026-11-24T12:00:00Z" }, "agent-1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].holderId, "h1");
  assert.equal(seen[0].paused, false);
  assert.deepStrictEqual(seen[0].changed, [{ capability: "mail.read", mode: "alone" }, { capability: "mail.allow", mode: null }]);
  assert.equal(seen[0].identity.saltAppId, "agent-1");
});

test("email_received reaches onEmailReceived with alias_wake typed and no message field needed", async () => {
  const seen = [];
  const d = dispatcherWith({ onEmailReceived: (c) => void seen.push(c) });
  const body = { type: "email_received", holder_id: "h1", message_id: "m1", chat_id: "c1", contact: { id: "ct", email_address: "a@example.test", origin: "email_in", channel: "email", status: "pending", user_id: null }, trusted_sender: false, content_trust: "untrusted_external", tag: "bsky", attachments: [{ message_id: "x", size: 3 }], withheld_count: 0, received_at: "t", alias_wake: { tag: "bsky", purpose: "Bluesky sign-up", plan_ref: "acct-7", from_host: "mail.bsky.example", needs_ok: true } };
  await d.dispatch(body, "agent-1");
  assert.equal(seen[0].needsOk, true);
  assert.equal(seen[0].aliasWake.from_host, "mail.bsky.example");
  assert.equal(seen[0].email.trusted_sender, false);
  assert.equal(seen[0].email.content_trust, "untrusted_external");
  await d.dispatch({ ...body, alias_wake: undefined, trusted_sender: true }, "agent-1");
  assert.equal(seen[1].aliasWake, undefined);
  assert.equal(seen[1].needsOk, false);
});

test("approval_decided as the server sends it (flat, with performed and reason) reaches onApprovalDecided", async () => {
  const seen = [];
  const d = dispatcherWith({ onApprovalDecided: (c) => void seen.push(c) });
  await d.dispatch({ type: "approval_decided", id: "ex1", approval_id: "ap1", mandate_id: "m1", capability: "mail.allow", decision: "approved", performed: false, reason: "sender_gone", actor: { id: "agent-1", username: "helper" }, principal: { id: "h1" } }, "agent-1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].approved, true);
  assert.equal(seen[0].exercise.capability, "mail.allow");
  assert.equal(seen[0].exercise.performed, false);
});
