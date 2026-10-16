// Money evidence (actions.ts's report_progress): claiming money work "done"
// is only trusted with a real, CONFIRMED transfer behind it, not the model's
// own say-so. The check fires only when evidence.transfer_id is actually
// supplied -- most 'done' reports aren't about money at all.
const test = require("node:test");
const assert = require("node:assert");
const openpgp = require("openpgp");
const sdk = require("../dist/index.js");

async function keypair(name) {
  const { privateKey, publicKey } = await openpgp.generateKey({ type: "ecc", curve: "curve25519", userIDs: [{ name }], format: "armored" });
  return { privateKey, publicKey };
}

function fakeClient({ agentKeys, personKeys, transferStatus }) {
  const posted = [];
  return {
    posted,
    async openSidechain(apiKey, chatId, withId) {
      return { session: { id: `lane-${chatId}`, users: [{ id: "agent-1", public_key: agentKeys.publicKey }, { id: withId, public_key: personKeys.publicKey }] } };
    },
    async getChatMembers() {
      return [];
    },
    async postMessage(apiKey, chatId, message, senderMessage, delegations, mentions, opts) {
      posted.push({ chatId, message, opts });
      return {};
    },
    async getTransfer(apiKey, transferId) {
      return { id: transferId, status: transferStatus };
    },
    trackEvent() {},
  };
}

test("report_progress refuses 'done' with evidence for a transfer that hasn't confirmed, and allows it once confirmed", async () => {
  const agentKeys = await keypair("agent");
  const personKeys = await keypair("person");
  const caller = { saltAppId: "agent-1", apiKey: "k", publicKey: agentKeys.publicKey };
  const ctx = { depth: 0, mainChatId: "chat-1", requesterId: "person-1" };

  const pending = sdk.createActions({ client: fakeClient({ agentKeys, personKeys, transferStatus: "Pending" }), identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  await assert.rejects(
    pending.execute("report_progress", { status: "done", title: "Paid the invoice", evidence: { transfer_id: "tr-1" } }, caller, ctx),
    /has not confirmed on-chain yet \(status: Pending\)/
  );

  const failed = sdk.createActions({ client: fakeClient({ agentKeys, personKeys, transferStatus: "Failed" }), identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  await assert.rejects(
    failed.execute("report_progress", { status: "done", title: "Paid the invoice", evidence: { transfer_id: "tr-2" } }, caller, ctx),
    /status: Failed/
  );

  const confirmed = sdk.createActions({ client: fakeClient({ agentKeys, personKeys, transferStatus: "Confirmed" }), identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const result = await confirmed.execute("report_progress", { status: "done", title: "Paid the invoice", evidence: { transfer_id: "tr-3" } }, caller, ctx);
  assert.strictEqual(result.reported, true);
});

test("report_progress without evidence is unaffected -- the check only fires when evidence is actually supplied", async () => {
  const agentKeys = await keypair("agent");
  const personKeys = await keypair("person");
  const caller = { saltAppId: "agent-1", apiKey: "k", publicKey: agentKeys.publicKey };
  const ctx = { depth: 0, mainChatId: "chat-1", requesterId: "person-1" };
  const client = fakeClient({ agentKeys, personKeys, transferStatus: "Pending" });
  let transferChecked = false;
  client.getTransfer = async () => {
    transferChecked = true;
    return { status: "Pending" };
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });

  const result = await actions.execute("report_progress", { status: "done", title: "Finished the summary" }, caller, ctx);
  assert.strictEqual(result.reported, true);
  assert.strictEqual(transferChecked, false, "no evidence means no transfer lookup at all");
});

test("'running' or 'failed' with evidence is never checked -- only a 'done' claim needs confirmation", async () => {
  const agentKeys = await keypair("agent");
  const personKeys = await keypair("person");
  const caller = { saltAppId: "agent-1", apiKey: "k", publicKey: agentKeys.publicKey };
  const ctx = { depth: 0, mainChatId: "chat-1", requesterId: "person-1" };
  const client = fakeClient({ agentKeys, personKeys, transferStatus: "Pending" });
  let transferChecked = false;
  client.getTransfer = async () => {
    transferChecked = true;
    return { status: "Pending" };
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });

  const running = await actions.execute("report_progress", { id: "w_1", status: "running", title: "Sending payment", evidence: { transfer_id: "tr-9" } }, caller, ctx);
  assert.strictEqual(running.reported, true);
  assert.strictEqual(transferChecked, false);
});

test("report_progress surfaces a getTransfer failure as a readable refusal rather than an opaque throw", async () => {
  const agentKeys = await keypair("agent");
  const personKeys = await keypair("person");
  const client = fakeClient({ agentKeys, personKeys, transferStatus: "Confirmed" });
  client.getTransfer = async () => {
    throw new sdk.SaltApiError("GET", "/api/v1/transfers/tr-4", 404, { error: "not found" });
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: "agent-1", apiKey: "k", publicKey: agentKeys.publicKey };

  await assert.rejects(
    actions.execute("report_progress", { status: "done", title: "Paid", evidence: { transfer_id: "tr-4" } }, caller, { depth: 0, mainChatId: "chat-1", requesterId: "person-1" }),
    /Could not verify transfer tr-4/
  );
});

test("evidence.transfer_id rides the SALT-WORK header as transfer=<id>, and the parser reads it back", async () => {
  const agentKeys = await keypair("agent");
  const personKeys = await keypair("person");
  const caller = { saltAppId: "agent-1", apiKey: "k", publicKey: agentKeys.publicKey };
  const ctx = { depth: 0, mainChatId: "chat-1", requesterId: "person-1" };
  const client = fakeClient({ agentKeys, personKeys, transferStatus: "Confirmed" });
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  await actions.execute("report_progress", { id: "w_1", status: "done", title: "Paid the invoice", evidence: { transfer_id: "tr-3" } }, caller, ctx);
  const msg = await openpgp.readMessage({ armoredMessage: client.posted[0].message });
  const { data } = await openpgp.decrypt({ message: msg, decryptionKeys: await openpgp.readPrivateKey({ armoredKey: personKeys.privateKey }) });
  assert.match(data.split("\n")[0], /^\[\[SALT-WORK id=w_1 status=done kind=task transfer=tr-3\]\]$/);
  assert.equal(sdk.parseWorkReport(data).transfer, "tr-3");
});

test("transfer survives format/parse; a bad transfer id is left off", () => {
  const text = sdk.formatWorkReport({ id: "w_2", status: "running", title: "Sending", transfer: "tr_9" });
  assert.match(text, /^\[\[SALT-WORK id=w_2 status=running transfer=tr_9\]\]/);
  assert.equal(sdk.parseWorkReport(text).transfer, "tr_9");
  assert.doesNotMatch(sdk.formatWorkReport({ id: "w_2", status: "running", title: "x", transfer: "bad id!" }), /transfer=/);
  assert.equal(sdk.parseWorkReport("[[SALT-WORK id=w_2 status=running transfer=a/b]]\nx").transfer, undefined);
  assert.equal(sdk.parseWorkReport("[[SALT-WORK id=w_2 status=running]]\nx").transfer, undefined);
});
