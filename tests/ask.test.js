// ctx.ask/ctx.approve (K3, ask.ts): a card with one button per option (plus
// a free-text invitation), resolved by whichever answer arrives first --
// a tap (routed through webhook.ts's handleCardInteraction) or a plain
// reply (routed through handleMessage). Exercised over the real webhook
// HTTP route (createWebhookServer) exactly like the rest of this test
// suite, since that's what proves ask.ts's resolve hooks are actually
// wired into the shared dispatcher and not just unit-testable in isolation.
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

async function encryptForPublicKey(text, publicKeyArmored) {
  return openpgp.encrypt({
    message: await openpgp.createMessage({ text }),
    encryptionKeys: await openpgp.readKey({ armoredKey: publicKeyArmored }),
  });
}

function baseApi(overrides = {}) {
  return {
    async getChatMembers() {
      return [];
    },
    async postMessage() {
      return {};
    },
    async signalTyping() {},
    trackEvent() {},
    ...overrides,
  };
}

async function startAgent(t, { onMessage, api } = {}) {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const AGENT_ID = `ask-${Math.random().toString(16).slice(2)}`;
  const store = sdk.createIdentityStore(tempStore("salt-ask-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const server = sdk.createWebhookServer({
    client: api ?? baseApi(),
    identities: store,
    pgpPassphrase: "agent-pass",
    logger: silent,
    async onMessage(ctx) {
      if (onMessage) await onMessage(ctx);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  async function postMessageFrom(sender, chatId, text) {
    const armored = await encryptForPublicKey(text, agentKeys.publicKey);
    return signedPost(
      port,
      { chat: { id: chatId }, message: { chat_id: chatId, message_id: `m-${Math.random()}`, message: armored, sender_message: armored, user: sender, created_at: new Date().toISOString() } },
      AGENT_ID,
      "secret-agent"
    );
  }

  async function postCardInteraction(chatId, cardId, actionId, user) {
    return signedPost(port, { type: "card_interaction", owner_id: AGENT_ID, chat_id: chatId, card_id: cardId, action_id: actionId, user, state: { blocks: [] } }, AGENT_ID, "secret-agent");
  }

  return { AGENT_ID, port, postMessageFrom, postCardInteraction, identity: { saltAppId: AGENT_ID, apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey } };
}

// api.getWebhookSecret must answer "secret-agent" for key-agent -- shared setup.
function withSecret(overrides = {}) {
  return baseApi({
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
    },
    ...overrides,
  });
}

test("ask() posts a card with one button per option, and a matching tap resolves it via ctx.ask inside onMessage", async (t) => {
  const posted = [];
  const updated = [];
  const api = withSecret({
    async postCard(apiKey, chatId, blocks, text) {
      posted.push({ chatId, blocks, text });
      return { id: "card-1" };
    },
    async updateCard(apiKey, cardId, blocks) {
      updated.push({ cardId, blocks });
      return {};
    },
  });

  let askResult;
  const { postMessageFrom, postCardInteraction } = await startAgent(t, {
    api,
    async onMessage(ctx) {
      askResult = await ctx.ask("Continue?", { options: ["Yes", "No"] });
    },
  });

  await postMessageFrom({ id: "human-1", username: "dan", account_type: "User" }, "chat-ask-1", "hello");
  await new Promise((r) => setTimeout(r, 100));

  assert.strictEqual(posted.length, 1, "the question was posted as a card");
  const actionId = posted[0].blocks.find((b) => b.type === "actions").elements[0].action_id;

  const res = await postCardInteraction("chat-ask-1", "card-1", actionId, { id: "human-1", username: "dan" });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 100));

  assert.deepStrictEqual(askResult, { answer: "Yes", by: "human-1", via: "button" });
  assert.strictEqual(updated.length, 1, "the card was updated to show the answer");
  assert.match(updated[0].blocks.map((b) => b.text).join(" "), /Answered: Yes/);
});

test("a plain reply also answers a free-text-eligible ask(), and never reaches onMessage as a fresh prompt", async (t) => {
  const api = withSecret({
    async postCard() {
      return { id: "card-2" };
    },
    async updateCard() {
      return {};
    },
  });

  let askResult;
  let onMessageCalls = 0;
  const { postMessageFrom } = await startAgent(t, {
    api,
    async onMessage(ctx) {
      onMessageCalls++;
      if (onMessageCalls === 1) {
        askResult = await ctx.ask("What's your favorite color?");
      }
    },
  });

  await postMessageFrom({ id: "human-2", username: "dan", account_type: "User" }, "chat-ask-2", "hello");
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(onMessageCalls, 1);

  await postMessageFrom({ id: "human-2", username: "dan", account_type: "User" }, "chat-ask-2", "blue");
  await new Promise((r) => setTimeout(r, 100));

  assert.deepStrictEqual(askResult, { answer: "blue", by: "human-2", via: "message" });
  assert.strictEqual(onMessageCalls, 1, "the answer was consumed by the pending ask, not treated as a new prompt");
});

test("options-only ask() (freeText not requested) ignores a plain reply and waits for a tap", async (t) => {
  const api = withSecret({
    async postCard() {
      return { id: "card-3" };
    },
    async updateCard() {
      return {};
    },
  });

  // A short timeoutMs so this ask() cleans itself up (and this test process
  // exits) even though nothing in the test ever answers it -- the point
  // under test is that a plain reply does NOT count, not what eventually
  // happens to the ask itself.
  let askOutcome = "pending";
  let onMessageCalls = 0;
  const { postMessageFrom } = await startAgent(t, {
    api,
    async onMessage(ctx) {
      onMessageCalls++;
      if (onMessageCalls === 1) {
        ctx.ask("Pick one", { options: ["A", "B"], freeText: false, timeoutMs: 500 }).then(
          () => (askOutcome = "resolved"),
          () => (askOutcome = "timed-out")
        );
      }
    },
  });

  await postMessageFrom({ id: "human-3", username: "dan", account_type: "User" }, "chat-ask-3", "hello");
  await new Promise((r) => setTimeout(r, 100));
  await postMessageFrom({ id: "human-3", username: "dan", account_type: "User" }, "chat-ask-3", "A");
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(askOutcome, "pending", "a plain reply doesn't answer a buttons-only ask");
  assert.strictEqual(onMessageCalls, 2, "the plain reply fell through to a fresh onMessage instead");

  // Let the short timeout actually fire so no timer outlives this test.
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(askOutcome, "timed-out");
});

test("approve() resolves approved:true on Yes and approved:false on No, by either button or a typed word", async (t) => {
  const api = withSecret({
    async postCard() {
      return { id: `card-${Math.random()}` };
    },
    async updateCard() {
      return {};
    },
  });

  const results = [];
  let n = 0;
  const { postMessageFrom, postCardInteraction } = await startAgent(t, {
    api,
    async onMessage(ctx) {
      n++;
      if (n % 2 === 1) {
        results.push(await ctx.approve(`Approve step ${n}?`));
      }
    },
  });

  // Tap "Yes".
  await postMessageFrom({ id: "human-4", username: "dan", account_type: "User" }, "chat-approve-1", "go");
  await new Promise((r) => setTimeout(r, 80));
  await postMessageFrom({ id: "human-4", username: "dan", account_type: "User" }, "chat-approve-1", "no thanks");
  await new Promise((r) => setTimeout(r, 80));

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].approved, false, "a typed non-affirmative reply resolves approved:false");
  assert.strictEqual(results[0].via, "message");
});

test("a card_interaction unrelated to any pending ask still reaches the consumer's own onCardInteraction", async (t) => {
  const api = withSecret();
  const agentKeys = await sdk.generateKeypair("agent-pass-2");
  const AGENT_ID = `ask-cc-${Math.random().toString(16).slice(2)}`;
  const store = sdk.createIdentityStore(tempStore("salt-ask-cc-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const interactions = [];
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "agent-pass-2",
    logger: silent,
    async onCardInteraction(ctx) {
      interactions.push(ctx.actionId);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const res = await signedPost(
    port,
    { type: "card_interaction", owner_id: AGENT_ID, chat_id: "chat-x", card_id: "some-other-card", action_id: "pay_now", user: { id: "human-5" }, state: { blocks: [] } },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(interactions, ["pay_now"]);
});

test("ask() rejects on timeout, and clears its pending state so a later ask() in the same chat can proceed", async (t) => {
  const api = withSecret({
    async postCard() {
      return { id: "card-timeout" };
    },
  });

  const errors = [];
  let secondAskSettled = false;
  const { postMessageFrom } = await startAgent(t, {
    api,
    async onMessage(ctx) {
      try {
        await ctx.ask("Quick!", { options: ["Yes"], timeoutMs: 30 });
      } catch (err) {
        errors.push(err.message);
        // A fresh ask() in the same chat must not be refused as "already waiting".
        ctx.ask("Again?", { options: ["Yes"], timeoutMs: 30 }).catch(() => {
          secondAskSettled = true;
        });
      }
    },
  });

  await postMessageFrom({ id: "human-6", username: "dan", account_type: "User" }, "chat-ask-timeout", "hello");
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /No answer within/);
  assert.strictEqual(secondAskSettled, true);
});

// --- M2 (security review, 2026-09-18) ---------------------------------------

test("the posted card's buttons carry restricted_to: [answererId] (the message's sender, by default)", async (t) => {
  const posted = [];
  const api = withSecret({
    async postCard(apiKey, chatId, blocks, text) {
      posted.push({ chatId, blocks, text });
      return { id: "card-restrict" };
    },
    async updateCard() {
      return {};
    },
  });

  const { postMessageFrom } = await startAgent(t, {
    api,
    async onMessage(ctx) {
      ctx.ask("Continue?", { options: ["Yes", "No"], timeoutMs: 30 }).catch(() => {});
    },
  });

  await postMessageFrom({ id: "human-restrict", username: "dan", account_type: "User" }, "chat-restrict", "hello");
  await new Promise((r) => setTimeout(r, 100));

  assert.strictEqual(posted.length, 1);
  const actions = posted[0].blocks.find((b) => b.type === "actions");
  for (const button of actions.elements) {
    assert.deepStrictEqual(button.restricted_to, ["human-restrict"]);
  }
});

test("a tap or reply from someone other than the named answerer is ignored, and the ask keeps waiting", async (t) => {
  const api = withSecret({
    async postCard() {
      return { id: "card-other" };
    },
    async updateCard() {
      return {};
    },
  });

  let askResult;
  let asked = false;
  const { postMessageFrom, postCardInteraction } = await startAgent(t, {
    api,
    async onMessage(ctx) {
      // A bystander's message that ask.ts correctly refuses to consume
      // falls through to a fresh onMessage call, same as any other new
      // message -- guard on `asked`, not `askResult`, or this would try
      // (and synchronously fail) to start a SECOND ask while one is
      // already pending for this (identity, chat).
      if (!asked) {
        asked = true;
        ctx.ask("Continue?", { options: ["Yes"], freeText: true, timeoutMs: 5000 }).then((r) => (askResult = r));
      }
    },
  });

  await postMessageFrom({ id: "human-owner", username: "dan", account_type: "User" }, "chat-other", "hello");
  await new Promise((r) => setTimeout(r, 100));

  // A DIFFERENT human's tap on the same card/action must be ignored.
  const posted = await postCardInteraction("chat-other", "card-other", "ask_0_ignored", { id: "human-bystander", username: "bystander", account_type: "User" });
  assert.equal(posted.status, 200);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(askResult, undefined, "a bystander's tap must not resolve the ask");

  // A different human's typed reply must also be ignored (never even a fresh onMessage).
  await postMessageFrom({ id: "human-bystander", username: "bystander", account_type: "User" }, "chat-other", "Yes");
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(askResult, undefined, "a bystander's typed reply must not resolve the ask either");

  // The actual owner can still answer afterwards.
  await postMessageFrom({ id: "human-owner", username: "dan", account_type: "User" }, "chat-other", "Yes");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(askResult, { answer: "Yes", by: "human-owner", via: "message" });
});

test("approve(): an exact 'yes'/'y' (optionally with . or !) approves; a near-miss like 'yeah' does not", async (t) => {
  const api = withSecret({
    async postCard() {
      return { id: `card-${Math.random()}` };
    },
    async updateCard() {
      return {};
    },
  });

  const results = [];
  const { postMessageFrom } = await startAgent(t, {
    api,
    async onMessage(ctx) {
      if (results.length === 0) {
        results.push(await ctx.approve("Proceed?", { timeoutMs: 5000 }));
      }
    },
  });

  await postMessageFrom({ id: "human-yeah", username: "dan", account_type: "User" }, "chat-yeah", "hello");
  await new Promise((r) => setTimeout(r, 80));
  await postMessageFrom({ id: "human-yeah", username: "dan", account_type: "User" }, "chat-yeah", "yeah");
  await new Promise((r) => setTimeout(r, 80));

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].approved, false, "'yeah' is a near-miss, not an exact yes/y");
});

test("approve(): 'Yes.' with a trailing period still approves", async (t) => {
  const api = withSecret({
    async postCard() {
      return { id: `card-${Math.random()}` };
    },
    async updateCard() {
      return {};
    },
  });

  const results = [];
  const { postMessageFrom } = await startAgent(t, {
    api,
    async onMessage(ctx) {
      if (results.length === 0) {
        results.push(await ctx.approve("Proceed?", { timeoutMs: 5000 }));
      }
    },
  });

  await postMessageFrom({ id: "human-period", username: "dan", account_type: "User" }, "chat-period", "hello");
  await new Promise((r) => setTimeout(r, 80));
  await postMessageFrom({ id: "human-period", username: "dan", account_type: "User" }, "chat-period", "Yes.");
  await new Promise((r) => setTimeout(r, 80));

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].approved, true);
});

test("ask() without any resolvable answerer (e.g. from a hand-off context) rejects synchronously", async (t) => {
  const api = withSecret();
  const agentKeys = await sdk.generateKeypair("agent-pass-noanswerer");
  const AGENT_ID = `ask-noans-${Math.random().toString(16).slice(2)}`;
  const store = sdk.createIdentityStore(tempStore("salt-ask-noans-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  let caught;
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "agent-pass-noanswerer",
    logger: silent,
    async onHandoffConfirmed(ctx) {
      try {
        await ctx.ask("Anything to hand off?");
      } catch (err) {
        caught = err;
      }
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const res = await signedPost(port, { type: "handoff_confirmed", from_agent_id: AGENT_ID, chat_id: "chat-noans", reason: "done" }, AGENT_ID, "secret-agent");
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(caught, "expected ask() to reject synchronously without a resolvable answerer");
  assert.match(caught.message, /needs an answerer/);
});
