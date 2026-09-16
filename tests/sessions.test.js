// Sessions (sessions.ts): a hosted identity's memory of one chat -- recent
// turns plus a short note. Pinned here: appendTurn/boundNote's caps, that
// FileSessionStore round-trips a session through the filesystem atomically,
// that the hand-off note wire format round-trips, and that a cold start (no
// stored session yet) rebuilds transcriptTail from the chat's own history via
// the webhook server -- exactly once, never again once a session exists.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");

const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };

function tempStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "identities.json");
}

function signedPost(port, body, agentId, secret) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Salt-Agent-Id": agentId, "X-Salt-Signature": `t=${t},v1=${v1}` },
    body: raw,
  });
}

test("appendTurn keeps at most MAX_TRANSCRIPT_TURNS, dropping the oldest first", () => {
  const session = sdk.emptySession("chat-1", "chat-1");
  for (let i = 0; i < sdk.MAX_TRANSCRIPT_TURNS + 5; i++) {
    sdk.appendTurn(session, { role: "user", content: `turn ${i}`, at: i });
  }
  assert.strictEqual(session.transcriptTail.length, sdk.MAX_TRANSCRIPT_TURNS);
  assert.strictEqual(session.transcriptTail[0].content, "turn 5");
  assert.strictEqual(session.transcriptTail[session.transcriptTail.length - 1].content, `turn ${sdk.MAX_TRANSCRIPT_TURNS + 4}`);
});

test("boundNote drops the oldest consulted entries first to stay under budget, and leaves an oversized goal alone", () => {
  const note = { consulted: [] };
  for (let i = 0; i < 100; i++) note.consulted.push({ handle: `agent${i}`, laneId: `lane-${i}-${"x".repeat(20)}` });
  const bounded = sdk.boundNote(note);
  assert.ok(JSON.stringify(bounded).length <= sdk.MAX_NOTE_CHARS);
  assert.ok(bounded.consulted.length < note.consulted.length, "oldest entries were dropped");
  assert.strictEqual(bounded.consulted[bounded.consulted.length - 1].handle, "agent99", "the newest entry survives");

  const stuffed = { goal: "g".repeat(sdk.MAX_NOTE_CHARS * 2), consulted: [] };
  const stillBig = sdk.boundNote(stuffed);
  assert.strictEqual(stillBig.goal, stuffed.goal, "nothing left to drop -- an oversized goal is left as-is, not silently truncated");
});

test("formatSessionNoteLine / extractSessionNote / stripSessionNoteLines round-trip, and an empty note produces no line at all", () => {
  assert.strictEqual(sdk.formatSessionNoteLine(undefined), undefined);
  assert.strictEqual(sdk.formatSessionNoteLine({ consulted: [] }), undefined, "nothing worth carrying forward");

  const note = { goal: "book a flight", waitingOn: "departure date", consulted: [{ handle: "weather", laneId: "lane-9" }], lastReportId: "w_1" };
  const line = sdk.formatSessionNoteLine(note);
  assert.match(line, /^\[\[SALT-SESSION-NOTE\]\] /);

  const briefing = `[[SALT-HANDOFF-BRIEFING]]\nHere's where things stand.\n${line}`;
  assert.deepStrictEqual(sdk.extractSessionNote(briefing), note);
  assert.strictEqual(sdk.extractSessionNote("no marker here"), undefined);
  assert.strictEqual(sdk.extractSessionNote("[[SALT-SESSION-NOTE]] not json"), undefined);

  const stripped = sdk.stripSessionNoteLines(briefing);
  assert.doesNotMatch(stripped, /SALT-SESSION-NOTE/);
  assert.match(stripped, /Here's where things stand\.$/);
});

test("FileSessionStore round-trips a session through the filesystem atomically, and forget/get-miss behave", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-sessions-file-"));
  const store = sdk.FileSessionStore(dir);

  assert.strictEqual(await store.get("agent-1", "chat-1"), null);

  const session = sdk.emptySession("chat-1", "room-1", "lane");
  sdk.appendTurn(session, { role: "user", content: "hi", at: 1 });
  await store.put("agent-1", "chat-1", session);

  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1, "one file per (identity, chat)");
  assert.ok(!files[0].endsWith(".tmp"), "the temp file was renamed into place, not left behind");

  const loaded = await store.get("agent-1", "chat-1");
  assert.deepStrictEqual(loaded, session);

  // A different chat for the same identity is a different file.
  await store.put("agent-1", "chat-2", sdk.emptySession("chat-2", "chat-2"));
  assert.strictEqual(fs.readdirSync(dir).length, 2);

  await store.forget("agent-1", "chat-1");
  assert.strictEqual(await store.get("agent-1", "chat-1"), null);
  await store.forget("agent-1", "chat-1"); // missing -- must not throw
});

test("MemorySessionStore keeps sessions separate per (identity, chat) and forgets cleanly", async () => {
  const store = sdk.MemorySessionStore();
  await store.put("a", "c1", sdk.emptySession("c1", "c1"));
  await store.put("b", "c1", sdk.emptySession("c1", "c1"));
  assert.notStrictEqual(await store.get("a", "c1"), null);
  assert.notStrictEqual(await store.get("b", "c1"), null);
  assert.strictEqual(await store.get("a", "c2"), null);
  await store.forget("a", "c1");
  assert.strictEqual(await store.get("a", "c1"), null);
  assert.notStrictEqual(await store.get("b", "c1"), null, "forgetting one identity's session leaves another's alone");
});

test("a cold start rebuilds transcriptTail from the chat's own history exactly once; a warm session skips the rebuild", async (t) => {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const AGENT_ID = "10000000-0000-0000-0000-0000000000a1";
  const HUMAN_ID = "10000000-0000-0000-0000-0000000000b2";

  const store = sdk.createIdentityStore(tempStore("salt-sessions-webhook-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const priorHuman = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: "what's the weather" }),
    encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }),
  });
  const priorAgent = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: "sunny today" }),
    encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }),
  });

  let getChatMessagesCalls = 0;
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
    },
    async getChatMessages() {
      getChatMessagesCalls++;
      return [
        { event_type: null, message: priorHuman, user: { id: HUMAN_ID, username: "dan" }, created_at: "2026-09-15T10:00:00Z" },
        { event_type: null, message: priorAgent, user: { id: AGENT_ID, username: "helper" }, created_at: "2026-09-15T10:00:05Z" },
      ];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
  };

  const seenTails = [];
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "agent-pass",
    logger: silent,
    async onMessage(ctx) {
      // Snapshot BEFORE this turn's own persistence step mutates the same
      // (mutable) session object -- the point of the assertion below is what
      // the handler sees on entry, not the final on-disk shape.
      seenTails.push(ctx.session.transcriptTail.map((turn) => [turn.role, turn.content]));
      await ctx.reply("ok");
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: "anything new?" }),
    encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }),
  });
  const body = {
    chat: { id: "chat-1", name: null, public: false, managed: false, open_invite: false, mode: "auto" },
    message: {
      chat_id: "chat-1",
      message_id: "m-1",
      message: armored,
      sender_message: armored,
      user: { id: HUMAN_ID, username: "dan", display_name: "Dan", account_type: "User" },
      created_at: new Date().toISOString(),
    },
  };
  const res = await signedPost(port, body, AGENT_ID, "secret-agent");
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(seenTails.length, 1);
  assert.deepStrictEqual(seenTails[0], [
    ["user", "what's the weather"],
    ["assistant", "sunny today"],
  ]);
  assert.equal(getChatMessagesCalls, 1, "rebuilt from history exactly once");

  // A second message in the SAME chat: the session persisted after the first
  // turn, so this is a warm start -- no second rebuild, and the first turn's
  // own exchange carries forward too.
  const armored2 = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: "and tomorrow?" }),
    encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }),
  });
  const body2 = { ...body, message: { ...body.message, message_id: "m-2", message: armored2, sender_message: armored2 } };
  const res2 = await signedPost(port, body2, AGENT_ID, "secret-agent");
  assert.equal(res2.status, 200);
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(seenTails.length, 2);
  assert.equal(getChatMessagesCalls, 1, "no second rebuild -- the persisted session was reused");
  assert.deepStrictEqual(seenTails[1], [
    ["user", "what's the weather"],
    ["assistant", "sunny today"],
    ["user", "anything new?"],
    ["assistant", "ok"],
  ]);
});
