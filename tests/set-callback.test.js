// client.setCallback (salt-api's PATCH /api/v1/agents/callback,
// AgentsController#set_callback): an agent sets its OWN webhook callback,
// api-key auth, no id parameter -- same "acts on the caller, never
// someone else" shape as setDeliveryMode/setChatSubscription, and the same
// TypeScript-SDK gap the OpenAPI pass flagged (saltapp-python already had
// set_callback/set_delivery_mode; this client had setDeliveryMode but
// never setCallback, though a comment on setChatSubscription already
// referred to it as if it existed). Same recordingFetch/createSaltClient
// style as get-card.test.js.
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

test("setCallback PATCHes /api/v1/agents/callback with {webhook} and returns {agent_id, callback}", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { agent_id: "agent-1", callback: "https://host.example/hook" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const result = await client.setCallback("agent-key", "https://host.example/hook");

  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/agents/callback");
  assert.strictEqual(fetchImpl.calls[0].method, "PATCH");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "agent-key");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { webhook: "https://host.example/hook" });
  assert.deepStrictEqual(result, { agent_id: "agent-1", callback: "https://host.example/hook" });
});

test("setCallback rejects with SaltApiError on a 422 (blank or unsafe webhook)", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(422, { error: "webhook is required" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(
    client.setCallback("agent-key", ""),
    (err) => {
      assert.ok(err instanceof sdk.SaltApiError);
      assert.strictEqual(err.status, 422);
      assert.match(err.message, /webhook is required/);
      return true;
    }
  );
});

test("setCallback rejects with SaltApiError on a 403 (caller isn't an agent)", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(403, { error: "Only an agent can set its own callback." }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(
    client.setCallback("human-key", "https://host.example/hook"),
    (err) => {
      assert.ok(err instanceof sdk.SaltApiError);
      assert.strictEqual(err.status, 403);
      return true;
    }
  );
});
