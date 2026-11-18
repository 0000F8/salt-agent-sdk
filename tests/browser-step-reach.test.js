// The Firefox-reach actions (locate, route, download, cookies, clipboard) and the new args of eval, dialog, control.
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
// A client whose step answers immediately with `result` (sealed) and records what was posted.
function clientAnswering(result, extra = {}) {
  const sid = `r${++seq}-${Math.random().toString(36).slice(2)}`;
  const posted = [];
  return {
    posted,
    async postBrowserStep(_k, body) {
      posted.push(body);
      const armor = result === undefined ? undefined : await seal(result);
      return { id: sid, step_id: body.step_id, status: "done", summary: "ok", result: armor, ...extra };
    },
    async getBrowserStep() {
      throw new Error("no GET expected");
    },
    trackEvent() {},
  };
}
const run = (client, input) => sdk.createBrowserTools({ client, pgpPassphrase: PASS }).step(caller, input);

test("the new actions are in the vocabulary with specs and show up in the step description", () => {
  for (const a of ["locate", "route", "download", "cookies", "clipboard"]) {
    assert.ok(sdk.BROWSER_ACTIONS.includes(a), a);
    assert.ok(sdk.BROWSER_ACTION_SPECS[a].use.length > 20, a);
  }
  const tools = sdk.createBrowserTools({ client: {}, pgpPassphrase: PASS });
  const def = tools.definitions.find((d) => d.name === "browser_step");
  assert.deepStrictEqual(def.schema.properties.action.enum, [...sdk.BROWSER_ACTIONS]);
  for (const a of ["locate", "route", "download", "cookies", "clipboard"]) assert.ok(def.description.includes(`- ${a}:`), a);
  assert.match(def.description, /needs_permission/);
});

test("new args: eval world, dialog mode, control hide are accepted; bad enums-by-name are not", () => {
  const props = (a) => Object.keys(sdk.BROWSER_ACTION_SPECS[a].args.properties);
  assert.ok(props("eval").includes("world"));
  assert.ok(props("dialog").includes("mode"));
  assert.deepStrictEqual(sdk.BROWSER_ACTION_SPECS.eval.args.properties.world.enum, ["page", "isolated"]);
  assert.deepStrictEqual(sdk.BROWSER_ACTION_SPECS.dialog.args.properties.mode.enum, ["next", "always"]);
  assert.match(sdk.BROWSER_ACTION_SPECS.control.use, /tabs\.hide/);
  assert.match(sdk.BROWSER_ACTION_SPECS.control.use, /tabs\.show/);
  sdk.checkBrowserArgs("eval", { code: "return 1", world: "isolated" });
  sdk.checkBrowserArgs("dialog", { accept: true, mode: "always" });
  sdk.checkBrowserArgs("control", { method: "tabs.hide", args: { tab: 3 } });
});

test("args checks: locate needs ref, route add needs match+action, download/cookies need an http address, clipboard write needs text", () => {
  assert.throws(() => sdk.checkBrowserArgs("locate", {}), /needs ref/);
  assert.throws(() => sdk.checkBrowserArgs("route", {}), /needs op/);
  assert.throws(() => sdk.checkBrowserArgs("route", { op: "add", match: "*.png" }), /match and action/);
  assert.throws(() => sdk.checkBrowserArgs("route", { op: "remove" }), /needs id/);
  sdk.checkBrowserArgs("route", { op: "add", match: "*/ads/*", action: "block" });
  sdk.checkBrowserArgs("route", { op: "list" });
  assert.throws(() => sdk.checkBrowserArgs("download", { url: "file:///etc/passwd" }), /http/);
  sdk.checkBrowserArgs("download", { url: "https://a.test/x.pdf", save: true, filename: "x.pdf" });
  assert.throws(() => sdk.checkBrowserArgs("cookies", { op: "get", url: "a.test" }), /http/);
  assert.throws(() => sdk.checkBrowserArgs("cookies", { url: "https://a.test" }), /needs op/);
  sdk.checkBrowserArgs("cookies", { op: "set", url: "https://a.test", name: "a", value: "b", same_site: "lax" });
  assert.throws(() => sdk.checkBrowserArgs("clipboard", { op: "write" }), /needs text/);
  sdk.checkBrowserArgs("clipboard", { op: "read" });
  assert.throws(() => sdk.checkBrowserArgs("locate", { ref: "e1", bogus: 1 }), /does not take bogus/);
});

test("download: bytes come back as result.file {mime, base64, size}; wire names are gone", async () => {
  const client = clientAnswering({ url: "https://a.test/x.pdf", mime: "application/pdf", size: 3, data_base64: "AQID" });
  const res = await run(client, { action: "download", args: { url: "https://a.test/x.pdf" } });
  assert.strictEqual(res.status, "done");
  assert.deepStrictEqual(res.result.file, { mime: "application/pdf", base64: "AQID", size: 3 });
  assert.strictEqual(res.result.data_base64, undefined);
  assert.strictEqual(res.result.url, "https://a.test/x.pdf");
});

test("download with save keeps saved and filename, and makes no file", async () => {
  const client = clientAnswering({ url: "https://a.test/x.pdf", saved: true, filename: "x.pdf" });
  const res = await run(client, { action: "download", args: { url: "https://a.test/x.pdf", save: true } });
  assert.strictEqual(res.result.saved, true);
  assert.strictEqual(res.result.filename, "x.pdf");
  assert.strictEqual(res.result.file, undefined);
});

test("locate, route, cookies, clipboard, eval world, dialog seen pass through typed and unchanged", async () => {
  const locate = { tab: 2, screen: { x: 10, y: 20, width: 30, height: 40 }, viewport: { x: 0, y: 80, width: 800, height: 600 }, device_pixel_ratio: 2, in_front: true };
  let res = await run(clientAnswering(locate), { action: "locate", args: { ref: "e3" } });
  assert.deepStrictEqual(res.result, locate);

  const routes = { tab: 2, routes: [{ id: "r1", match: "*/ads/*", action: "block", hits: 4 }] };
  res = await run(clientAnswering(routes), { action: "route", args: { op: "list" } });
  assert.deepStrictEqual(res.result.routes, routes.routes);

  const cookies = { cookies: [{ name: "sid", value: "v", domain: "a.test", path: "/", secure: true, http_only: true, same_site: "lax", expires: null }] };
  res = await run(clientAnswering(cookies), { action: "cookies", args: { op: "get", url: "https://a.test/" } });
  assert.deepStrictEqual(res.result.cookies, cookies.cookies);

  res = await run(clientAnswering({ text: "copied" }), { action: "clipboard", args: { op: "read" } });
  assert.strictEqual(res.result.text, "copied");

  res = await run(clientAnswering({ value: 1, world: "isolated" }), { action: "eval", args: { code: "return 1" } });
  assert.strictEqual(res.result.world, "isolated");

  const dlg = { tab: 2, armed: true, mode: "always", seen: [{ type: "confirm", message: "Sure?", answered: true, at: "2026-11-17T10:00:00Z" }] };
  res = await run(clientAnswering(dlg), { action: "dialog", args: { accept: true, mode: "always" } });
  assert.deepStrictEqual(res.result.seen, dlg.seen);
});

test("needs_permission is passed through as the step's reason", async () => {
  const client = clientAnswering(undefined, { status: "refused", reason: "needs_permission", summary: "Salt needs the cookies permission in this browser. Turn the switch off and on in the Salt panel to allow it." });
  const res = await run(client, { action: "cookies", args: { op: "get", url: "https://a.test/" } });
  assert.strictEqual(res.status, "refused");
  assert.strictEqual(res.reason, "needs_permission");
  assert.match(res.summary, /cookies permission/);
});

test("a grant carries identity and hidden through browser_grants", async () => {
  const client = {
    async getBrowserGrants() {
      return { grants: [{ browser_client_id: "bc1", mode: "full", status: "active", identity: "own", hidden: true }] };
    },
  };
  const { grants } = await sdk.browserGrants(client, caller);
  assert.strictEqual(grants[0].identity, "own");
  assert.strictEqual(grants[0].hidden, true);
});
