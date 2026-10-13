// The ack carries what the handler reported (a typed text: typed, method, verified, note), and still says ok.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

function host(handlers) {
  const results = [];
  const noop = async () => {};
  const h = { observe: noop, click: noop, type: noop, key: noop, scroll: noop, submit: noop, focusApp: noop, listApps: noop, readFile: noop, writeFile: noop, ...handlers };
  const tx = {
    results,
    async postResult(pt) { results.push(sdk.decodeDeviceMessage(pt)); },
    async beat() {}, async reportCounts() {}, async stop() {},
  };
  const snap = { sessionId: "sess-1", agentId: "ag", readers: { chatId: "chat-1", publicKeys: ["K"] }, caps: { "device.act": { mode: "auto" }, "device.files.write": { mode: "auto", fileRoots: ["/tmp"] } } };
  return { tx, host: sdk.createDeviceHost(snap, h, tx) };
}
const cmd = (seq, op, body) => sdk.encodeDeviceMessage({ v: 1, id: `c${seq}`, seq, op, session: "sess-1", exp: Date.now() + 30000 }, body);

test("a type handler's outcome rides in the ack, with ok kept", async () => {
  const { tx, host: h } = host({ type: async () => ({ typed: 5, method: "keys", verified: false, note: "could not be checked" }) });
  await h.handleCommand(cmd(1, "type", { text: "hello" }));
  const r = tx.results.at(-1);
  assert.equal(r.header.op, "ack");
  assert.deepEqual(r.body, { typed: 5, method: "keys", verified: false, note: "could not be checked", ok: true });
});

test("handlers that return nothing still ack exactly {ok:true}", async () => {
  const { tx, host: h } = host({});
  await h.handleCommand(cmd(1, "click", { x: 1, y: 2 }));
  assert.deepEqual(tx.results.at(-1).body, { ok: true });
});

test("only the allow-list passes (typed, method, verified, note); every other field, objects, arrays and a handler's own ok are dropped; notes are bounded", async () => {
  const { tx, host: h } = host({ type: async () => ({ ok: false, method: "keys", verified: true, screen: { text: "secret" }, list: [1], value: "the field text", text: "hunter2", bytes: 9, note: "x".repeat(1000) }) });
  await h.handleCommand(cmd(1, "type", { text: "hi" }));
  const b = tx.results.at(-1).body;
  assert.equal(b.ok, true);
  assert.equal(b.method, "keys");
  assert.equal(b.verified, true);
  assert.equal(b.screen, undefined);
  assert.equal(b.list, undefined);
  assert.equal(b.value, undefined);
  assert.equal(b.text, undefined);
  assert.equal(b.bytes, undefined);
  assert.equal(b.note.length, 300);
  assert.deepEqual(Object.keys(b).sort(), ["method", "note", "ok", "verified"]);
});

test("allow-listed fields must have their own type: a string typed, a number verified, an object note are dropped", async () => {
  const { tx, host: h } = host({ type: async () => ({ typed: "5", method: 7, verified: "yes", note: { a: 1 } }) });
  await h.handleCommand(cmd(1, "type", { text: "hi" }));
  assert.deepEqual(tx.results.at(-1).body, { ok: true });
});

test("write_file and key acks carry a handler result too", async () => {
  const { tx, host: h } = host({ key: async () => ({ method: "chord" }), writeFile: async () => ({ bytes: 3, method: "fs" }) });
  await h.handleCommand(cmd(1, "key", { keys: ["cmd", "s"] }));
  assert.deepEqual(tx.results.at(-1).body, { method: "chord", ok: true });
  await h.handleCommand(cmd(2, "write_file", { path: "/tmp/x", content_b64: "YWJj" }));
  assert.deepEqual(tx.results.at(-1).body, { method: "fs", ok: true });
});
