// client.apps (contract 2026-09-28, §1): create / newVersion / get / install
// / installations / state / setState. Same recordingFetch/createSaltClient
// style as get-card.test.js and act-for.test.js, which exercise this file's
// request() layer directly.
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

test("apps.create posts name/description/html plus for_id/chat_id (snake_case) and returns the app+version+installation", async () => {
  const result = { app: { id: "app-1", name: "Notes" }, version: { id: "ver-1", number: 1 }, installation: { id: "inst-1" } };
  const fetchImpl = recordingFetch(() => jsonResponse(200, result));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const out = await client.apps.create("agent-key", {
    name: "Notes",
    description: "Shared notes",
    html: "<html></html>",
    forId: "person-1",
    chatId: "chat-1",
  });

  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/apps");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
  assert.deepStrictEqual(fetchImpl.calls[0].body, {
    name: "Notes",
    description: "Shared notes",
    html: "<html></html>",
    for_id: "person-1",
    chat_id: "chat-1",
  });
  assert.deepStrictEqual(out, result);
});

test("apps.create omits for_id/chat_id when not given", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { app: {}, version: {} }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await client.apps.create("agent-key", { name: "Notes", html: "<html></html>" });
  assert.strictEqual(fetchImpl.calls[0].body.for_id, undefined);
  assert.strictEqual(fetchImpl.calls[0].body.chat_id, undefined);
});

test("apps.newVersion posts html to /apps/:id/versions", async () => {
  const result = { app: { id: "app-1" }, version: { id: "ver-2", number: 2 } };
  const fetchImpl = recordingFetch(() => jsonResponse(200, result));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const out = await client.apps.newVersion("agent-key", "app-1", "<html>v2</html>");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/apps/app-1/versions");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
  assert.deepStrictEqual(fetchImpl.calls[0].body, { html: "<html>v2</html>" });
  assert.deepStrictEqual(out, result);
});

test("apps.get fetches /apps/:id", async () => {
  const app = { id: "app-1", name: "Notes", owner: { id: "u1", username: "dan", display_name: "Dan" } };
  const fetchImpl = recordingFetch(() => jsonResponse(200, app));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const out = await client.apps.get("agent-key", "app-1");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/apps/app-1");
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
  assert.deepStrictEqual(out, app);
});

test("apps.install posts chat_id/copy_state_from (snake_case) to /apps/:id/install", async () => {
  const installation = { id: "inst-2", chat_id: "chat-1" };
  const fetchImpl = recordingFetch(() => jsonResponse(200, installation));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const out = await client.apps.install("agent-key", "app-1", { chatId: "chat-1", copyStateFrom: "inst-old" });
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/apps/app-1/install");
  assert.strictEqual(fetchImpl.calls[0].method, "POST");
  assert.deepStrictEqual(fetchImpl.calls[0].body, { chat_id: "chat-1", copy_state_from: "inst-old" });
  assert.deepStrictEqual(out, installation);
});

test("apps.install with no params installs personally (empty body, chat_id absent)", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { id: "inst-3", chat_id: null }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await client.apps.install("agent-key", "app-1");
  assert.deepStrictEqual(fetchImpl.calls[0].body, {});
});

test("apps.installations with chatId hits the chat-scoped listing", async () => {
  const rows = [{ id: "inst-1", chat_id: "chat-1" }];
  const fetchImpl = recordingFetch(() => jsonResponse(200, rows));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const out = await client.apps.installations("agent-key", { chatId: "chat-1" });
  assert.match(fetchImpl.calls[0].url, /^https:\/\/salt\.test\/api\/v1\/app_installations\?chat_id=chat-1&_=\d+$/);
  assert.deepStrictEqual(out, rows);
});

test("apps.installations with no chatId hits /mine", async () => {
  const rows = [{ id: "inst-2", chat_id: null }];
  const fetchImpl = recordingFetch(() => jsonResponse(200, rows));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const out = await client.apps.installations("agent-key");
  assert.match(fetchImpl.calls[0].url, /^https:\/\/salt\.test\/api\/v1\/app_installations\/mine\?_=\d+$/);
  assert.deepStrictEqual(out, rows);
});

test("apps.state fetches the installation's doc+version, cache-busted", async () => {
  const state = { doc: { notes: ["a"] }, version: 3 };
  const fetchImpl = recordingFetch(() => jsonResponse(200, state));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const out = await client.apps.state("agent-key", "inst-1");
  assert.match(fetchImpl.calls[0].url, /^https:\/\/salt\.test\/api\/v1\/app_installations\/inst-1\/state\?_=\d+$/);
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
  assert.deepStrictEqual(out, state);
});

test("apps.setState PUTs {doc, if_version} and returns {doc, version} on success", async () => {
  const doc = { notes: ["a", "b"] };
  const result = { doc, version: 4 };
  const fetchImpl = recordingFetch(() => jsonResponse(200, result));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const out = await client.apps.setState("agent-key", "inst-1", doc, 3);
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/app_installations/inst-1/state");
  assert.strictEqual(fetchImpl.calls[0].method, "PUT");
  assert.deepStrictEqual(fetchImpl.calls[0].body, { doc, if_version: 3 });
  assert.deepStrictEqual(out, result);
});

test("apps.setState on a 409 throws AppStateConflictError carrying the CURRENT {doc, version} from the response body", async () => {
  const currentDoc = { notes: ["a", "b", "c (someone else's edit)"] };
  const fetchImpl = recordingFetch(() => jsonResponse(409, { doc: currentDoc, version: 7 }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(
    client.apps.setState("agent-key", "inst-1", { notes: ["a"] }, 3),
    (err) => {
      assert.ok(err instanceof sdk.AppStateConflictError);
      assert.strictEqual(err.name, "AppStateConflictError");
      assert.deepStrictEqual(err.doc, currentDoc);
      assert.strictEqual(err.version, 7);
      return true;
    }
  );
});

test("apps.setState on a 409 with a malformed body falls back to {} / the caller's ifVersion rather than throwing a second error", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(409, {}));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(
    client.apps.setState("agent-key", "inst-1", { notes: [] }, 5),
    (err) => {
      assert.ok(err instanceof sdk.AppStateConflictError);
      assert.deepStrictEqual(err.doc, {});
      assert.strictEqual(err.version, 5);
      return true;
    }
  );
});

test("apps.setState on a non-409 error rethrows the ordinary SaltApiError untouched", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(413, { error: "State too large." }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(
    client.apps.setState("agent-key", "inst-1", { big: "doc" }, 1),
    (err) => {
      assert.ok(err instanceof sdk.SaltApiError);
      assert.ok(!(err instanceof sdk.AppStateConflictError));
      assert.strictEqual(err.status, 413);
      return true;
    }
  );
});

test("apps.* through actFor still authenticates with the delegate's own api-key and carries the acting headers", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { doc: {}, version: 1 }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });
  const acting = client.actFor("principal-1");

  await acting.apps.state("agent-key", "inst-1");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "agent-key");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], "principal-1");
  assert.strictEqual(fetchImpl.calls[0].headers["Idempotency-Key"], undefined, "GET must never carry an auto-generated Idempotency-Key");
});
