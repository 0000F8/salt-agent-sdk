// Work reports (work.ts): an agent keeps the person it is working for up to
// date, privately, in the lane they share. Pinned here: the wire format both
// sides read, that a report goes to that person's lane (once per pair, quiet
// unless the agent is waiting on them) and is readable by them, that a report
// never breaks the work it describes, and that delegate_to_agent reports
// itself -- only for a turn that answers a person.
const test = require("node:test");
const assert = require("node:assert");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");

async function keypair(name) {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519",
    userIDs: [{ name }],
    format: "armored",
  });
  return { privateKey, publicKey };
}

async function decryptWith(armoredPrivate, armoredMessage) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivate });
  const message = await openpgp.readMessage({ armoredMessage });
  const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey });
  return data;
}

test("the wire format round-trips and refuses what it cannot name", () => {
  const text = sdk.formatWorkReport({ id: "w_abc123", status: "running", kind: "delegation", with: "@weather", title: "Asking @weather", detail: "Lisbon tomorrow?" });
  assert.strictEqual(text, "[[SALT-WORK id=w_abc123 status=running kind=delegation with=weather]]\nAsking @weather\nLisbon tomorrow?");
  assert.deepStrictEqual(sdk.parseWorkReport(text), { id: "w_abc123", status: "running", kind: "delegation", with: "weather", title: "Asking @weather", detail: "Lisbon tomorrow?" });

  assert.strictEqual(sdk.parseWorkReport("hello"), null);
  assert.strictEqual(sdk.parseWorkReport("[[SALT-WORK id=w_1 status=sleeping]]\nx"), null);
  assert.throws(() => sdk.formatWorkReport({ id: "bad id", status: "done", title: "x" }));
  assert.throws(() => sdk.formatWorkReport({ id: "w_1", status: "done", title: "   " }));
  const long = sdk.formatWorkReport({ id: "w_1", status: "done", title: "a".repeat(400) });
  assert.strictEqual(long.split("\n")[1].length, sdk.MAX_WORK_TITLE);
  assert.match(sdk.newWorkId(), /^w_[0-9a-f]{12}$/);
});

function fakeClient({ agent, person, laneStatus = 200, chatMembers = [] }) {
  const posted = [];
  const opened = [];
  return {
    posted,
    opened,
    async openSidechain(apiKey, chatId, withId) {
      opened.push({ chatId, withId });
      if (laneStatus !== 200) throw new sdk.SaltApiError("POST", `/api/v1/chats/${chatId}/sidechain`, laneStatus, { error: "This is already a private lane." });
      return { session: { id: `lane-of-${chatId}`, coaching_for_chat_id: chatId, users: [{ id: agent.id, public_key: agent.publicKey }, { id: person.id, public_key: person.publicKey }] } };
    },
    async getChatMembers() {
      return chatMembers;
    },
    async postMessage(apiKey, chatId, message, senderMessage, delegations, mentions, opts) {
      posted.push({ chatId, message, senderMessage, opts });
      return {};
    },
    trackEvent() {},
  };
}

test("a report goes to that person's lane, readable by them, quiet unless the agent waits on them", async () => {
  const agentKeys = await keypair("agent");
  const personKeys = await keypair("person");
  const agent = { id: "agent-1", publicKey: agentKeys.publicKey };
  const person = { id: "person-1", publicKey: personKeys.publicKey };
  const client = fakeClient({ agent, person });
  const reporter = sdk.createWorkReporter(client);
  const caller = { saltAppId: agent.id, apiKey: "k", publicKey: agentKeys.publicKey };
  const target = { chatId: "chat-1", requesterId: person.id };

  assert.strictEqual(await reporter.report(caller, target, { id: "w_1", status: "running", title: "Comparing flights" }), true);
  assert.strictEqual(await reporter.report(caller, target, { id: "w_1", status: "waiting", title: "I need your date" }), true);

  assert.strictEqual(client.opened.length, 1, "the lane is opened once per pair and remembered");
  assert.deepStrictEqual(client.opened[0], { chatId: "chat-1", withId: person.id });
  assert.deepStrictEqual(client.posted.map((p) => [p.chatId, p.opts.quiet]), [["lane-of-chat-1", true], ["lane-of-chat-1", false]]);
  const plain = await decryptWith(personKeys.privateKey, client.posted[1].message);
  assert.deepStrictEqual(sdk.parseWorkReport(plain), { id: "w_1", status: "waiting", title: "I need your date" });
  const own = await decryptWith(agentKeys.privateKey, client.posted[1].senderMessage);
  assert.strictEqual(own, plain);
});

test("work that came from inside a lane reports into that lane; an undeliverable report never throws", async () => {
  const agentKeys = await keypair("agent");
  const personKeys = await keypair("person");
  const agent = { id: "agent-1", publicKey: agentKeys.publicKey };
  const person = { id: "person-1", publicKey: personKeys.publicKey };
  const caller = { saltAppId: agent.id, apiKey: "k", publicKey: agentKeys.publicKey };

  const inLane = fakeClient({ agent, person, laneStatus: 422, chatMembers: [{ id: agent.id, public_key: agent.publicKey }, { id: person.id, public_key: person.publicKey }] });
  assert.strictEqual(await sdk.createWorkReporter(inLane).report(caller, { chatId: "lane-9", requesterId: person.id }, { id: "w_2", status: "done", title: "Booked" }), true);
  assert.strictEqual(inLane.posted[0].chatId, "lane-9");

  const broken = fakeClient({ agent, person, laneStatus: 403 });
  assert.strictEqual(await sdk.createWorkReporter(broken).report(caller, { chatId: "chat-2", requesterId: person.id }, { id: "w_3", status: "running", title: "Working" }), false);
  assert.strictEqual(broken.posted.length, 0);
});

test("delegate_to_agent reports running then done to the person the turn answers, and nothing without one", async () => {
  const agentKeys = await keypair("agent");
  const personKeys = await keypair("person");
  const targetKeys = await keypair("weather");
  const agent = { id: "agent-1", publicKey: agentKeys.publicKey };
  const person = { id: "person-1", publicKey: personKeys.publicKey };
  const client = fakeClient({ agent, person });
  client.getAgent = async (apiKey, id) => ({ id, username: "weather", display_name: "Weather", account_type: "Agent" });
  client.createOrGetChat = async () => ({ id: "deleg-1", users: [{ id: agent.id, public_key: agent.publicKey }, { id: "weather-1", public_key: targetKeys.publicKey }] });
  const originalPost = client.postMessage;
  client.postMessage = async (...args) => {
    const result = await originalPost(...args);
    // The delegate answers as soon as it is asked, the way its webhook would.
    if (args[1] === "deleg-1") setTimeout(() => sdk.resolveIfPending("deleg-1", "weather-1", "Sunny, 24C"), 5);
    return result;
  };
  const actions = sdk.createActions({ client, identities: {}, pgpPassphrase: "", publicWebhookUrl: "" });
  const caller = { saltAppId: agent.id, apiKey: "k", publicKey: agentKeys.publicKey };

  const result = await actions.execute("delegate_to_agent", { target_agent_id: "weather-1", task: "Forecast for Lisbon tomorrow?\nThanks" }, caller, { depth: 0, mainChatId: "chat-1", requesterId: person.id });
  assert.strictEqual(result.reply, "Sunny, 24C");
  const laneReports = client.posted.filter((p) => p.chatId === "lane-of-chat-1");
  const reports = await Promise.all(laneReports.map(async (p) => sdk.parseWorkReport(await decryptWith(personKeys.privateKey, p.message))));
  assert.deepStrictEqual(reports.map((r) => [r.status, r.title]), [["running", "Asking @weather"], ["done", "@weather answered"]]);
  assert.strictEqual(reports[0].id, reports[1].id);
  assert.strictEqual(reports[0].kind, "delegation");
  assert.strictEqual(reports[0].with, "weather");
  assert.strictEqual(reports[0].detail, "Forecast for Lisbon tomorrow?");
  // Each step carries its own detail (0.6.1): the reply's first line on done.
  assert.strictEqual(reports[1].detail, "Sunny, 24C");
  assert.match(result.note, /NOT a member of the chat you are replying in/);

  client.posted.length = 0;
  await actions.execute("delegate_to_agent", { target_agent_id: "weather-1", task: "Again?" }, caller, { depth: 0, mainChatId: "chat-1" });
  assert.deepStrictEqual(client.posted.map((p) => p.chatId), ["deleg-1"], "no requester, no report");

  await assert.rejects(
    actions.execute("report_progress", { status: "running", title: "x" }, caller, { depth: 0, mainChatId: "chat-1" }),
    /only available while answering a person/
  );
  const reported = await actions.execute("report_progress", { status: "waiting", title: "I need your date" }, caller, { depth: 0, mainChatId: "chat-1", requesterId: person.id });
  assert.strictEqual(reported.reported, true);
  assert.match(reported.id, /^w_/);
  assert.strictEqual(client.posted[client.posted.length - 1].opts.quiet, false);
});
