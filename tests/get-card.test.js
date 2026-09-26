// client.getCard (salt-api 0.96.0's GET /api/v1/cards/:id): a card's OWNER
// polling its own tap history instead of the agent's socket-mode outbox,
// which has exactly one forward-only cursor per agent and races concurrent
// pollers. Same recordingFetch/createSaltClient style as act-for.test.js,
// which is the other place this file's request() layer is exercised
// directly rather than through a fake client.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {} });
    return respond(url, opts, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("getCard with no `after` hits the plain card path and returns the card as-is", async () => {
  const card = {
    id: "card-1",
    state: { blocks: [{ type: "divider" }] },
    owner_id: "agent-1",
    interactions: [],
  };
  const fetchImpl = recordingFetch(() => jsonResponse(200, card));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const result = await client.getCard("agent-key", "card-1");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/cards/card-1");
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
  assert.deepStrictEqual(result, card);
});

test("getCard threads `after` as an encoded query param", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { id: "card-1", state: {}, owner_id: "agent-1", interactions: [] }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  // An ISO 8601 timestamp -- the colons must survive encodeURIComponent as %3A,
  // proving this isn't a naive template-literal interpolation.
  await client.getCard("agent-key", "card-1", { after: "2026-09-26T00:00:00Z" });
  assert.strictEqual(
    fetchImpl.calls[0].url,
    "https://salt.test/api/v1/cards/card-1?after=2026-09-26T00%3A00%3A00Z"
  );

  await client.getCard("agent-key", "card-1", { after: "int-42" });
  assert.strictEqual(fetchImpl.calls[1].url, "https://salt.test/api/v1/cards/card-1?after=int-42");
});

test("getCard rejects with SaltApiError on a 404 (owner-only, byte-identical to unknown id)", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(404, { error: "Not found" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(
    client.getCard("someone-elses-key", "card-1"),
    (err) => {
      assert.ok(err instanceof sdk.SaltApiError);
      assert.strictEqual(err.status, 404);
      assert.match(err.message, /Not found/);
      return true;
    }
  );
});

test("getCard through actFor still authenticates with the delegate's own api-key and carries the acting headers", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { id: "card-1", state: {}, owner_id: "agent-1", interactions: [] }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const acting = client.actFor("principal-1");

  await acting.getCard("agent-key", "card-1");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "agent-key");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], "principal-1");
  // GET must never carry an auto-generated Idempotency-Key -- same rule act-for.test.js pins for getChatMembers.
  assert.strictEqual(fetchImpl.calls[0].headers["Idempotency-Key"], undefined);
});
