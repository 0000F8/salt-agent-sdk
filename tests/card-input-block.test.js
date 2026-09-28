// The card `input` block type (NEW) and `values` on a card interaction:
// salt-api's card_interaction webhook carries every `input` block's current
// value, keyed by block_id, alongside the tapped action_id -- this SDK's
// job is just to plumb it through to onCardInteraction untouched (never
// transforming it) and default it to {} when the payload carries none (an
// older salt-api, or a card with no input blocks). Same signedPost/no-op
// identity style as reply-context-sessions.test.js's card_interaction test.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");

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

async function makeServer(t, extraOptions) {
  const agentKeys = await sdk.generateKeypair("card-values-pass");
  const AGENT_ID = "60000000-0000-0000-0000-0000000000b1";
  const store = sdk.createIdentityStore(tempStore("salt-card-values-"));
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
    },
    async getChatMembers() {
      return [];
    },
    async getChatMessages() {
      return [];
    },
    trackEvent() {},
  };

  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "card-values-pass",
    logger: silent,
    ...extraOptions,
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  return { port: listening.address().port, AGENT_ID };
}

test("a card_interaction carrying values passes them through to ctx.values untouched", async (t) => {
  let seen = null;
  const { port, AGENT_ID } = await makeServer(t, {
    async onCardInteraction(ctx) {
      seen = ctx;
    },
  });

  const res = await signedPost(
    port,
    {
      type: "card_interaction",
      owner_id: AGENT_ID,
      chat_id: "chat-1",
      card_id: "card-1",
      action_id: "submit",
      user: { id: "human-1", username: "dan", account_type: "User" },
      state: { blocks: [{ type: "input", block_id: "note", label: "Note" }] },
      values: { note: "call me back after 5" },
    },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(seen, "onCardInteraction fired");
  assert.deepStrictEqual(seen.values, { note: "call me back after 5" });
  assert.strictEqual(seen.actionId, "submit");
});

test("a card_interaction with no values field defaults ctx.values to {} (an older salt-api, or a card with no input blocks)", async (t) => {
  let seen = null;
  const { port, AGENT_ID } = await makeServer(t, {
    async onCardInteraction(ctx) {
      seen = ctx;
    },
  });

  const res = await signedPost(
    port,
    {
      type: "card_interaction",
      owner_id: AGENT_ID,
      chat_id: "chat-1",
      card_id: "card-2",
      action_id: "vote_a",
      user: { id: "human-1", username: "dan", account_type: "User" },
      state: { blocks: [] },
    },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 150));

  assert.ok(seen, "onCardInteraction fired");
  assert.deepStrictEqual(seen.values, {});
});

test("the input block type is documented in the post_card/update_card actions' shared BLOCKS_SCHEMA", () => {
  const actions = sdk.createActions({ client: {}, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const postCard = actions.definitions.find((d) => d.name === "post_card");
  assert.ok(postCard, "post_card is a defined action");
  const description = postCard.schema.properties.blocks.description;
  assert.match(description, /type:"input"/);
  assert.match(description, /block_id/);
  assert.match(description, /max_length/);
});
