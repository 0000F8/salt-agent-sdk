// browser_grants / browser_step (src/browser.ts): the step is posted with a fresh step_id, its sealed result is waited
// for on the delivery rail (the `browser_step` event) or fetched by the ONE GET after the wait, opened with the agent's
// own private key, and handed back as {status, reason?, summary, result?} with pictures as {mime, base64}.
const test = require("node:test");
const assert = require("node:assert");

const sdk = require("../dist/index.js");
const pgp = require("../dist/crypto.js");

const PASS = "test-pass";
let caller;
test.before(async () => {
  const keys = await pgp.generateKeypair(PASS);
  caller = { saltAppId: "agent-1", username: "helper", apiKey: "k", publicKey: keys.publicKey, privateKey: keys.privateKey };
});

const seal = (obj) => pgp.encryptFor(JSON.stringify(obj), [caller.publicKey]);

let seq = 0;
function fakeClient(over = {}) {
  const sid = `s${++seq}-${Math.random().toString(36).slice(2)}`; // Salt's step ids are unique; the event buffer is process-wide
  const calls = { post: [], get: [] };
  const client = {
    calls,
    sid,
    async getBrowserGrants() {
      return { grants: [{ browser_client_id: "bc1", mode: "full", status: "active" }, { browser_client_id: "bc2", status: "revoked" }] };
    },
    async postBrowserStep(_key, body) {
      calls.post.push(body);
      return { id: sid, step_id: body.step_id, status: "queued", summary: "Opening a page" };
    },
    async getBrowserStep(_key, id) {
      calls.get.push(id);
      return { id, status: "running" };
    },
    trackEvent() {},
    ...over,
  };
  return client;
}

const tools = (client) => sdk.createBrowserTools({ client, pgpPassphrase: PASS });

test("browser_grants lists active grants only", async () => {
  const t = tools(fakeClient());
  const res = await t.grants(caller);
  assert.deepStrictEqual(res.grants.map((g) => g.browser_client_id), ["bc1"]);
});

test("both actions are registered by createActions with schemas for the whole vocabulary", () => {
  const actions = sdk.createActions({ client: fakeClient(), identities: { get() {}, all: () => [], register() {}, reassignId() {} }, pgpPassphrase: PASS, publicWebhookUrl: "https://x" });
  const names = actions.definitions.map((d) => d.name);
  assert.ok(names.includes("browser_grants") && names.includes("browser_step"));
  const def = actions.definitions.find((d) => d.name === "browser_step");
  assert.deepStrictEqual(def.schema.properties.action.enum, [...sdk.BROWSER_ACTIONS]);
  for (const a of ["press", "select", "hover", "drag", "upload", "wait_for", "console", "eval", "dialog", "network", "emulate", "recording", "demonstrate", "webmcp", "screenshot_diff"]) {
    assert.ok(sdk.BROWSER_ACTIONS.includes(a), a);
    assert.ok(def.description.includes(`- ${a}:`), `description covers ${a}`);
  }
});

test("step: posts a fresh step_id, takes the event result, unseals it", async () => {
  const client = fakeClient({
    async postBrowserStep(_key, body) {
      client.calls.post.push(body);
      // The result event beats the POST's own answer; the waiter was registered before posting.
      const armor = await seal({ url: "https://a.test/", title: "A" });
      sdk.recordBrowserStepEvent({ type: "browser_step", step: { id: "ev-1", step_id: body.step_id, status: "done", summary: "Opened", result_armor: armor } });
      return { id: "ev-1", step_id: body.step_id, status: "queued" };
    },
  });
  const res = await tools(client).step(caller, { action: "open", args: { url: "https://a.test/" }, browser_client_id: "bc1" });
  assert.strictEqual(res.status, "done");
  assert.deepStrictEqual(res.result, { url: "https://a.test/", title: "A" });
  assert.strictEqual(client.calls.get.length, 0, "no GET when the event arrived");
  assert.match(client.calls.post[0].step_id, /^[0-9a-f]{32}$/);
  assert.strictEqual(client.calls.post[0].browser_client_id, "bc1");
});

test("step: event arriving after the POST answer resolves the wait", async () => {
  const client = fakeClient();
  const p = tools(client).step(caller, { action: "read", timeout_ms: 5000 });
  await new Promise((r) => setTimeout(r, 20));
  const armor = await seal({ text: "hello" });
  sdk.recordBrowserStepEvent({ step: { id: client.sid, status: "done", result: armor } });
  const res = await p;
  assert.strictEqual(res.status, "done");
  assert.strictEqual(res.result.text, "hello");
});

test("step: falls back to the single GET when no event comes", async () => {
  const armor = await seal({ clicked: "Buy" });
  const client = fakeClient({
    async getBrowserStep(_k, id) {
      client.calls.get.push(id);
      return { id, status: "done", summary: "Clicked", result: armor };
    },
  });
  const res = await tools(client).step(caller, { action: "click", args: { ref: "e1" }, timeout_ms: 30 });
  assert.strictEqual(res.status, "done");
  assert.strictEqual(res.result.clicked, "Buy");
  assert.deepStrictEqual(client.calls.get, [client.sid]);
});

test("step: a screenshot comes back as {image:{mime, base64}}; a diff as diff_image", async () => {
  const shot = await seal({ data: "AAAA", mime: "image/jpeg" });
  const diff = await seal({ changed_percent: 4.5, diff_jpeg_base64: "BBBB", baseline: "x", current: "y" });
  let n = 0;
  const client = fakeClient({
    async getBrowserStep(_k, id) {
      return { id, status: "done", result: n++ === 0 ? shot : diff };
    },
  });
  const t = tools(client);
  const a = await t.step(caller, { action: "screenshot", timeout_ms: 10 });
  assert.deepStrictEqual(a.result.image, { mime: "image/jpeg", base64: "AAAA" });
  assert.strictEqual(a.result.data, undefined);
  const b = await t.step(caller, { action: "screenshot_diff", args: { baseline: "x" }, timeout_ms: 10 });
  assert.deepStrictEqual(b.result.diff_image, { mime: "image/jpeg", base64: "BBBB" });
  assert.strictEqual(b.result.changed_percent, 4.5);
});

test("step: still running after the wait and the GET reports timed_out without repeating", async () => {
  const client = fakeClient();
  const res = await tools(client).step(caller, { action: "wait_for", args: { text: "x" }, timeout_ms: 20 });
  assert.strictEqual(res.status, "running");
  assert.strictEqual(res.reason, "timed_out");
  assert.strictEqual(res.step_id, client.sid);
  assert.strictEqual(client.calls.get.length, 1);
  assert.strictEqual(client.calls.post.length, 1);
});

test("step: needs_human and refusals carry the reason, no result", async () => {
  const client = fakeClient({
    async getBrowserStep(_k, id) {
      return { id, status: "needs_human", reason: "captcha", summary: "A CAPTCHA needs the person" };
    },
  });
  const res = await tools(client).step(caller, { action: "click", args: { ref: "e2" }, timeout_ms: 10 });
  assert.strictEqual(res.status, "needs_human");
  assert.strictEqual(res.reason, "captcha");
  assert.strictEqual(res.result, undefined);
});

test("step: a 5xx on POST retries with the SAME step_id; a 4xx is final and structured", async () => {
  const ids = [];
  let n = 0;
  const flaky = fakeClient({
    async postBrowserStep(_k, body) {
      ids.push(body.step_id);
      if (n++ < 2) throw new sdk.SaltApiError("POST", "u", 503, { error: "down" });
      return { id: "s9", status: "done", summary: "ok" };
    },
  });
  const ok = await tools(flaky).step(caller, { action: "tabs" });
  assert.strictEqual(ok.status, "done");
  assert.strictEqual(new Set(ids).size, 1);
  assert.strictEqual(ids.length, 3);

  const refused = fakeClient({
    async postBrowserStep() {
      throw new sdk.SaltApiError("POST", "u", 409, { error: "The grant needs renewing.", code: "grant_needs_renewal" });
    },
  });
  const r = await tools(refused).step(caller, { action: "read" });
  assert.strictEqual(r.status, "refused");
  assert.strictEqual(r.reason, "grant_needs_renewal");
  assert.strictEqual(refused.calls.post.length, 0 + 0);

  const gone = fakeClient({
    async postBrowserStep() {
      throw new sdk.SaltApiError("POST", "u", 404, { error: "no" });
    },
  });
  assert.strictEqual((await tools(gone).step(caller, { action: "read" })).reason, "no_grant");
});

test("step: a result not sealed for the agent is refused, an unreadable one is reported without its armor", async () => {
  const plain = fakeClient({ async getBrowserStep(_k, id) { return { id, status: "done", result: "{\"a\":1}" }; } });
  assert.strictEqual((await tools(plain).step(caller, { action: "read", timeout_ms: 10 })).reason, "not_sealed");

  const other = await pgp.generateKeypair(PASS);
  const foreign = await pgp.encryptFor("{}", [other.publicKey]);
  const wrong = fakeClient({ async getBrowserStep(_k, id) { return { id, status: "done", result: foreign }; } });
  const res = await tools(wrong).step(caller, { action: "read", timeout_ms: 10 });
  assert.strictEqual(res.reason, "unreadable");
  assert.ok(!JSON.stringify(res).includes("BEGIN PGP"));
});

test("step: bad args are caught before anything is posted", async () => {
  const client = fakeClient();
  const t = tools(client);
  await assert.rejects(t.step(caller, { action: "click", args: {} }), /needs ref/);
  await assert.rejects(t.step(caller, { action: "select", args: { ref: "e1" } }), /one of: value, label/);
  await assert.rejects(t.step(caller, { action: "drag", args: { ref: "e1" } }), /one of: to_ref, to/);
  await assert.rejects(t.step(caller, { action: "wait_for", args: {} }), /one of: text, url, ref, selector/);
  await assert.rejects(t.step(caller, { action: "open", args: { url: "javascript:1" } }), /http/);
  await assert.rejects(t.step(caller, { action: "hover", args: { ref: "e1", bogus: 1 } }), /does not take bogus/);
  await assert.rejects(t.step(caller, { action: "nope" }), /Unknown browser action/);
  assert.strictEqual(client.calls.post.length, 0);
});

test("the dispatcher consumes a browser_step event without running any handler", async () => {
  assert.strictEqual(sdk.recordBrowserStepEvent({ type: "browser_step", step: { id: "z", status: "running" } }), true);
  assert.strictEqual(sdk.recordBrowserStepEvent({ type: "browser_step" }), false);
});

test("both transports' dispatcher routes a browser_step event to the waiting step", async () => {
  const dispatcher = sdk.createDispatcher({ client: { trackEvent() {} }, identities: { get() {}, all: () => [], register() {}, reassignId() {} }, pgpPassphrase: PASS, logger: { info() {}, error() {} }, verifySignatures: false });
  const client = fakeClient();
  const p = tools(client).step(caller, { action: "read", timeout_ms: 5000 });
  await new Promise((r) => setTimeout(r, 20));
  const armor = await seal({ text: "via dispatcher" });
  const body = { type: "browser_step", step: { id: client.sid, status: "done", result_armor: armor } };
  assert.strictEqual(await dispatcher.resolveAnswer(body), true);
  assert.strictEqual((await p).result.text, "via dispatcher");
  await dispatcher.dispatch(body); // the queued path takes it too and runs no handler
});
