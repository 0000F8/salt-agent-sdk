// Message requests (salt-api contract MESSAGE_REQUESTS_CONTRACT.md): a first message from a stranger lands in the
// recipient's Requests. The SDK surfaces delivered_as on chat-create and message-send, wraps the recipient's setting
// and the three request endpoints, and turns the contacts-only refusal into a typed error. Same recordingFetch /
// createSaltClient style as set-callback.test.js.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, body: opts?.body });
    return respond(url, opts, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function clientWith(respond) {
  const fetchImpl = recordingFetch(respond);
  return { fetchImpl, client: sdk.createSaltClient({ host: "https://salt.test", fetchImpl }) };
}

test("createOrGetChat surfaces delivered_as: request", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(201, { id: "c1", delivered_as: "request" }));
  const chat = await client.createOrGetChat("k", "u9");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/chats");
  assert.strictEqual(chat.delivered_as, "request");
});

test("postMessage surfaces delivered_as on the result", async () => {
  const { client } = clientWith(() => jsonResponse(201, { id: "m1", delivered_as: "request" }));
  const sent = await client.postMessage("k", "c1", "armor", "armor-sender");
  assert.strictEqual(sent.delivered_as, "request");

  const normal = clientWith(() => jsonResponse(201, { id: "m2", delivered_as: "chat" }));
  assert.strictEqual((await normal.client.postMessage("k", "c1", "armor")).delivered_as, "chat");
});

test("getMessageFrom reads message_from off GET /api/v1/account", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { id: "a1", message_from: "everyone" }));
  assert.strictEqual(await client.getMessageFrom("agent-key"), "everyone");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/account");
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "agent-key");
});

test("setMessageFrom sends {message_from} to /api/v1/account", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { id: "a1", message_from: "contacts" }));
  const result = await client.setMessageFrom("agent-key", "contacts");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/account");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { message_from: "contacts" });
  assert.strictEqual(result.message_from, "contacts");
});

test("setMessageFrom: an invalid value rejects with SaltApiError carrying the code", async () => {
  const { client } = clientWith(() => jsonResponse(422, { error: "Pick everyone, known or contacts.", code: "invalid_message_from" }));
  await assert.rejects(client.setMessageFrom("k", "nobody"), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.ok(!(err instanceof sdk.RecipientContactsOnlyError));
    assert.strictEqual(err.status, 422);
    assert.strictEqual(err.code, "invalid_message_from");
    return true;
  });
});

test("listRequests GETs /api/v1/chats?requests=1", async () => {
  const rows = [{ session: { id: "c5", request_state: "pending" } }];
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, rows));
  assert.deepStrictEqual(await client.listRequests("k"), rows);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/chats?requests=1");
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
});

test("list then accept: the chat id is row.session.id, not row.id", async () => {
  const rows = [{ session: { id: "c5", request_state: "pending", users: [] }, recent_message: { message: { id: "m1" }, user: { id: "u9" } } }];
  const { fetchImpl, client } = clientWith((url) =>
    url.includes("requests=1") ? jsonResponse(200, rows) : jsonResponse(200, { session: { id: "c5", request_state: null } })
  );
  const [row] = await client.listRequests("k");
  assert.strictEqual(row.id, undefined);
  await client.acceptRequest("k", row.session.id);
  assert.strictEqual(fetchImpl.calls[1].url, "https://salt.test/api/v1/chats/c5/accept_request");
});

test("acceptRequest POSTs accept_request and returns the chat", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { id: "c5", session: { request_state: null } }));
  const chat = await client.acceptRequest("k", "c5");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/chats/c5/accept_request");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
  assert.strictEqual(chat.id, "c5");
});

test("declineRequest POSTs decline_request and resolves on 204", async () => {
  const { fetchImpl, client } = clientWith(() => ({ ok: true, status: 204, json: async () => { throw new Error("no body"); }, text: async () => "" }));
  assert.strictEqual(await client.declineRequest("k", "c5"), undefined);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/chats/c5/decline_request");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
});

test("a 403 recipient_contacts_only is a RecipientContactsOnlyError with the code and the sentence", async () => {
  const sentence = "Ada only takes messages from their contacts.";
  const { client } = clientWith(() => jsonResponse(403, { error: sentence, code: "recipient_contacts_only" }));
  await assert.rejects(client.createOrGetChat("k", "u9"), (err) => {
    assert.ok(err instanceof sdk.RecipientContactsOnlyError);
    assert.ok(err instanceof sdk.SaltApiError);
    assert.strictEqual(err.status, 403);
    assert.strictEqual(err.code, "recipient_contacts_only");
    assert.strictEqual(err.sentence, sentence);
    assert.ok(err.message.endsWith(sentence));
    return true;
  });
});

test("the contacts-only refusal also types on postMessage, and other 403s stay plain SaltApiError", async () => {
  const refused = clientWith(() => jsonResponse(403, { error: "Ada only takes messages from their contacts.", code: "recipient_contacts_only" }));
  await assert.rejects(refused.client.postMessage("k", "c1", "x"), sdk.RecipientContactsOnlyError);

  const blocked = clientWith(() => jsonResponse(403, { error: "You can't message this person." }));
  await assert.rejects(blocked.client.createOrGetChat("k", "u9"), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.ok(!(err instanceof sdk.RecipientContactsOnlyError));
    assert.strictEqual(err.code, undefined);
    return true;
  });
});

test("actFor routes the request helpers through the acting wrapper too", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { id: "c5" }));
  await client.actFor("principal-1").acceptRequest("k", "c5");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], "principal-1");
});
