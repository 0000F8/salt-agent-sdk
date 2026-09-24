// client.actFor (Mandates R2): a client bound to acting for one principal.
// Every call it makes must carry X-Salt-Act-For (+ X-Salt-Mandate when one
// is pinned) and an auto-generated Idempotency-Key on POST/PATCH -- and an
// ask-mode 202 `{status: "asked", ...}` response must resolve typed
// (isAsked(result) === true), never throw. The base (non-acting) client
// must never send these headers at all -- an ordinary call is unaffected.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, body: opts?.body ? JSON.parse(opts.body) : undefined });
    return respond(url, opts, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("actFor sends X-Salt-Act-For on every call, and X-Salt-Mandate only when a mandate is pinned", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { id: "chat-1" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const unpinned = client.actFor("principal-1");
  await unpinned.createOrGetChat("agent-key", "contact-1");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], "principal-1");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Mandate"], undefined);

  const pinned = client.actFor("principal-1", { mandateId: "mandate-9" });
  await pinned.createOrGetChat("agent-key", "contact-1");
  assert.strictEqual(fetchImpl.calls[1].headers["X-Salt-Act-For"], "principal-1");
  assert.strictEqual(fetchImpl.calls[1].headers["X-Salt-Mandate"], "mandate-9");

  // The api-key is still the DELEGATE's own, passed per call exactly like the base client --
  // actFor only adds headers, it never substitutes whose key authenticates the request.
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "agent-key");
});

test("the base (non-acting) client never sends X-Salt-Act-For or X-Salt-Mandate", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { id: "chat-1" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await client.createOrGetChat("agent-key", "contact-1");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], undefined);
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Mandate"], undefined);
});

test("actFor auto-generates an Idempotency-Key on POST/PATCH when the caller didn't supply one, but never on GET", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { ok: true }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const acting = client.actFor("principal-1");

  await acting.postMessage("agent-key", "chat-1", "hi");
  const postCall = fetchImpl.calls.find((c) => c.method === "POST" && c.url.includes("/messages"));
  assert.ok(postCall.headers["Idempotency-Key"], "POST must carry an auto-generated Idempotency-Key");

  await acting.getChatMembers("agent-key", "chat-1");
  const getCall = fetchImpl.calls.find((c) => c.method === "GET");
  assert.strictEqual(getCall.headers["Idempotency-Key"], undefined, "GET must never carry an Idempotency-Key");
});

test("actFor honours an explicitly supplied idempotencyKey rather than overwriting it", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, {}));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const acting = client.actFor("principal-1");

  await acting.createInvoice("agent-key", {
    chatId: "chat-1",
    receiverId: "contact-1",
    amount: "5.00",
    lineItems: [{ name: "thing", qty: 1, unit_price: "5.00", subtotal: "5.00" }],
    idempotencyKey: "my-own-key",
  });
  assert.strictEqual(fetchImpl.calls[0].headers["Idempotency-Key"], "my-own-key");
});

test("a 202 {status: 'asked'} response resolves to a typed AskedResult, never throws, through actFor", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(202, { status: "asked", exercise_id: "ex-1", expires_at: "2026-09-24T00:00:00Z" }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const acting = client.actFor("principal-1", { mandateId: "mandate-1" });

  const result = await acting.postMessage("agent-key", "chat-1", "please send $5");
  assert.strictEqual(sdk.isAsked(result), true);
  assert.deepStrictEqual(result, { asked: true, exerciseId: "ex-1", expiresAt: "2026-09-24T00:00:00Z" });
});

test("prepareTransfer always resolves an AskedResult -- money.pay is forced ask-mode", async () => {
  const fetchImpl = recordingFetch((url) => {
    assert.ok(url.includes("/api/v1/transfers/prepare"));
    return jsonResponse(202, { status: "asked", exercise_id: "ex-2", expires_at: "2026-09-24T01:00:00Z" });
  });
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const acting = client.actFor("principal-1");

  const result = await acting.prepareTransfer("agent-key", { walletId: "w-1", receiverId: "u-2", amount: "5.00" });
  assert.strictEqual(sdk.isAsked(result), true);
  assert.strictEqual(result.exerciseId, "ex-2");
});

test("isAsked narrows correctly: true only for the {asked: true, ...} shape", () => {
  assert.strictEqual(sdk.isAsked({ asked: true, exerciseId: "x" }), true);
  assert.strictEqual(sdk.isAsked({ id: "chat-1" }), false);
  assert.strictEqual(sdk.isAsked(null), false);
  assert.strictEqual(sdk.isAsked(undefined), false);
  assert.strictEqual(sdk.isAsked("asked"), false);
});

test("an ordinary (non-202) response through actFor is unaffected -- normal payload, no AskedResult wrapping", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { id: "chat-1", session: { users: [] } }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const acting = client.actFor("principal-1");

  const chat = await acting.createOrGetChat("agent-key", "contact-1");
  assert.strictEqual(sdk.isAsked(chat), false);
  assert.strictEqual(chat.id, "chat-1");
});

// --- client.mandates: always as yourself, never through actFor -------------

test("client.mandates.* calls the right endpoints and never carries acting headers even when built from an acting client's sibling", async () => {
  const fetchImpl = recordingFetch((url) => {
    if (url.includes("/api/v1/mandates/exercises/open")) return jsonResponse(200, { exercises: [] });
    if (url.includes("/api/v1/mandates/mandate-1/exercises")) return jsonResponse(200, { exercises: [] });
    if (url.includes("/api/v1/mandates/exercises/ex-1/decide")) return jsonResponse(200, { id: "ex-1", decision: "approved" });
    if (url.includes("/api/v1/mandates/mandate-1/accept")) return jsonResponse(200, { id: "mandate-1", status: "active" });
    if (url.startsWith("https://salt.test/api/v1/mandates?")) return jsonResponse(200, { mandates: [] });
    return jsonResponse(404, { error: "not found" });
  });
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await client.mandates.list("owner-key", { role: "grantor" });
  assert.ok(fetchImpl.calls[0].url.includes("role=grantor"));

  await client.mandates.accept("agent-key", "mandate-1");
  const acceptCall = fetchImpl.calls.find((c) => c.url.includes("/accept"));
  assert.strictEqual(acceptCall.method, "POST");
  assert.strictEqual(acceptCall.headers["X-Salt-Act-For"], undefined);

  await client.mandates.decide("owner-key", "ex-1", "approve", "looks right");
  const decideCall = fetchImpl.calls.find((c) => c.url.includes("/decide"));
  assert.deepStrictEqual(decideCall.body, { decision: "approve", note: "looks right" });

  await client.mandates.exercises("owner-key", "mandate-1");
  await client.mandates.openExercises("owner-key");
  assert.ok(fetchImpl.calls.some((c) => c.url.includes("/mandates/exercises/open")));
});
