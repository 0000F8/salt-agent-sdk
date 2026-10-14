// "Someone added you": list the accounts that added the caller, accept one (the ordinary add-contact call) or
// dismiss it. Same recordingFetch / createSaltClient style as message-requests.test.js.
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

const ROW = {
  user: { id: "u7", username: "ada", display_name: "Ada", avatar_url: null, account_type: "User", nickname: "A" },
  added_at: "2026-10-13T10:00:00Z",
};

test("listIncomingContacts GETs /api/v1/contacts/incoming", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, [ROW]));
  assert.deepStrictEqual(await client.listIncomingContacts("k"), [ROW]);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/contacts/incoming");
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "k");
});

test("acceptContact POSTs the existing add-contact path with {contact_id}", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(201, { id: "ct1" }));
  await client.acceptContact("k", "u7");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/contacts");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { contact_id: "u7" });
});

test("dismissIncomingContact POSTs .../dismiss and resolves on 204", async () => {
  const { fetchImpl, client } = clientWith(() => ({ ok: true, status: 204, json: async () => { throw new Error("no body"); }, text: async () => "" }));
  assert.strictEqual(await client.dismissIncomingContact("k", "u7"), undefined);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/contacts/incoming/u7/dismiss");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
});

test("list then accept uses row.user.id; a refusal rejects with SaltApiError", async () => {
  const { fetchImpl, client } = clientWith((url, opts) =>
    opts.method === "GET" ? jsonResponse(200, [ROW]) : jsonResponse(422, { error: "You can't add this account." })
  );
  const [row] = await client.listIncomingContacts("k");
  await assert.rejects(client.acceptContact("k", row.user.id), (err) => err instanceof sdk.SaltApiError && err.status === 422);
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[1].body), { contact_id: "u7" });
});

test("incoming-contact helpers go through actFor too", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, []));
  await client.actFor("principal-1").listIncomingContacts("k");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], "principal-1");
});
