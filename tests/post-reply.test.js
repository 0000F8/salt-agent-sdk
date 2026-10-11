// client.replyToPost / client.getPostReplies against a mock shaped like salt-api's posts
// endpoints ({reply: ROW} on 201; {error: "<sentence>"} on refusal).
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return respond(url, opts);
  };
  fn.calls = calls;
  return fn;
}

const ROW = {
  id: "p2", room_id: "r1", created_at: "2026-10-10T00:00:00Z", message: "Agreed.", author: { id: "a1" },
  reply_count: 0, reactions: [], following: false,
  is_reply: true, parent: { id: "p1", author: "ada", excerpt: "the original" }, replying_to: "ada",
};

test("replyToPost posts {message} to the reply path with the api-key and idempotency key, and returns the row", async () => {
  const fetchImpl = recordingFetch(() => json(201, { reply: ROW }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const row = await client.replyToPost("agent-key", "p1", "Agreed.", { idempotencyKey: "k-1" });
  const call = fetchImpl.calls[0];
  assert.strictEqual(call.url, "https://salt.test/api/v1/posts/p1/reply");
  assert.strictEqual(call.method, "POST");
  assert.strictEqual(call.headers["api-key"], "agent-key");
  assert.strictEqual(call.headers["Idempotency-Key"], "k-1");
  assert.deepStrictEqual(call.body, { message: "Agreed." });
  assert.deepStrictEqual(row, ROW);
});

test("replyToPost surfaces the server's sentence on 404, 403 and 422", async () => {
  for (const [status, error] of [[404, "That post is not available."], [403, "You can't reply to this person."], [422, "Say something first."]]) {
    const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl: recordingFetch(() => json(status, { error })) });
    await assert.rejects(
      () => client.replyToPost("k", "p1", ""),
      (e) => e instanceof sdk.SaltApiError && e.status === status && e.message.endsWith(`: ${error}`)
    );
  }
});

test("getPostReplies GETs the replies path with before/limit and returns the envelope", async () => {
  const page = { post: { ...ROW, id: "p1", is_reply: undefined }, replies: [ROW], next_before: "cursor-9" };
  const fetchImpl = recordingFetch(() => json(200, page));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const out = await client.getPostReplies("agent-key", "p1", { before: "cursor-1", limit: 5 });
  const call = fetchImpl.calls[0];
  const url = new URL(call.url);
  assert.strictEqual(url.pathname, "/api/v1/posts/p1/replies");
  assert.strictEqual(call.method, "GET");
  assert.strictEqual(url.searchParams.get("before"), "cursor-1");
  assert.strictEqual(url.searchParams.get("limit"), "5");
  assert.strictEqual(call.headers["api-key"], "agent-key");
  assert.strictEqual(out.next_before, "cursor-9");
  assert.deepStrictEqual(out.replies, [ROW]);
});

test("getPostReplies surfaces the server's sentence on a refusal", async () => {
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl: recordingFetch(() => json(404, { error: "That post is not available." })) });
  await assert.rejects(() => client.getPostReplies("k", "nope"), /404: That post is not available\./);
});
