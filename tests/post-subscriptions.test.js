// Get an account's posts by email (salt-api contract EMAIL_SUBSCRIBE_0242_CONTRACT.md): subscribe (always-202
// "check_your_email", or 201 "active" for the caller's own verified email), the owner's subscriber count, and the
// caller's own subscriptions. Same recordingFetch style as message-requests.test.js.
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

test("subscribeToPostsByEmail signed out: 202 check_your_email, no api-key header", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(202, { status: "check_your_email" }));
  const r = await client.subscribeToPostsByEmail("dana", { email: "a@b.co", cadence: "weekly", timeZone: "Europe/London" });
  assert.deepStrictEqual(r, { status: "check_your_email" });
  const c = fetchImpl.calls[0];
  assert.strictEqual(c.url, "https://salt.test/api/v1/users/dana/post_subscriptions");
  assert.strictEqual(c.method, "POST");
  assert.strictEqual("api-key" in c.headers, false);
  assert.deepStrictEqual(JSON.parse(c.body), { email: "a@b.co", cadence: "weekly", time_zone: "Europe/London" });
});

test("subscribeToPostsByEmail omits time_zone when not given and escapes the username", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(202, { status: "check_your_email" }));
  await client.subscribeToPostsByEmail("a/b", { email: "a@b.co", cadence: "daily" });
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/users/a%2Fb/post_subscriptions");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { email: "a@b.co", cadence: "daily" });
});

test("subscribeToPostsByEmail signed in with own verified email: 201 active", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(201, { status: "active", cadence: "instant" }));
  const r = await client.subscribeToPostsByEmail("dana", { email: "me@x.co", cadence: "instant", apiKey: "agent-key" });
  assert.deepStrictEqual(r, { status: "active", cadence: "instant" });
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "agent-key");
});

test("subscribeToPostsByEmail 422 rejects with the plain sentence", async () => {
  const { client } = clientWith(() => jsonResponse(422, { error: "Choose as they happen, daily or weekly." }));
  await assert.rejects(
    () => client.subscribeToPostsByEmail("dana", { email: "a@b.co", cadence: "hourly" }),
    (e) => e instanceof sdk.SaltApiError && e.status === 422 && e.body.error === "Choose as they happen, daily or weekly."
  );
});

test("postSubscriberCount reads GET /api/v1/me/post_subscribers", async () => {
  const body = { count: 12, by_cadence: { instant: 2, daily: 4, weekly: 6 } };
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, body));
  assert.deepStrictEqual(await client.postSubscriberCount("k"), body);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/me/post_subscribers");
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "k");
});

test("myPostSubscriptions lists GET /api/v1/me/post_subscriptions", async () => {
  const rows = [{ id: "s1", cadence: "weekly", status: "active", account: { username: "dana", display_name: "Dana" } }];
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, rows));
  assert.deepStrictEqual(await client.myPostSubscriptions("k"), rows);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/me/post_subscriptions");
});

test("cancelPostSubscription sends DELETE and tolerates 204", async () => {
  const { fetchImpl, client } = clientWith(() => ({ ok: true, status: 204, json: async () => undefined, text: async () => "" }));
  assert.strictEqual(await client.cancelPostSubscription("k", "s1"), undefined);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/me/post_subscriptions/s1");
  assert.strictEqual(fetchImpl.calls[0].method, "DELETE");
});
