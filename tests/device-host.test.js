// The device side (device/host.ts): the gates around the two injected seams.
// Every handler here is a fake; NO real capture or input runs. These tests
// prove the host decides correctly WHETHER a handler runs, not how it would.
const test = require("node:test");
const assert = require("node:assert");
const sdk = require("../dist/index.js");

const READERS = { chatId: "chat-1", publicKeys: ["-----PUB-----"] };

function recordingHandlers() {
  const calls = [];
  const mk = (op, ret) => async (args) => {
    calls.push({ op, args });
    return ret;
  };
  return {
    calls,
    observe: mk("observe", { obs: "o1", width: 10, height: 10, scale: 1, format: "png", image_b64: "AA" }),
    click: mk("click"),
    type: mk("type"),
    key: mk("key"),
    scroll: mk("scroll"),
    focusApp: mk("focus_app"),
    listApps: mk("list_apps", { apps: [{ id: "com.apple.Safari", name: "Safari", frontmost: true }] }),
    readFile: mk("read_file", { path: "/x", size: 1, content_b64: "AA" }),
    writeFile: mk("write_file"),
  };
}

function recordingTransport() {
  const results = [];
  const counts = [];
  let stopped = null;
  return {
    results,
    counts,
    getStopped: () => stopped,
    async postResult(plaintext) {
      results.push(sdk.decodeDeviceMessage(plaintext));
    },
    async beat() {},
    async reportCounts(_sid, c) {
      counts.push(c);
    },
    async stop(_sid, reason) {
      stopped = reason;
    },
  };
}

function snapshot(caps, extra = {}) {
  return {
    sessionId: "sess-1",
    agentId: "ag",
    readers: READERS,
    caps,
    ...extra,
  };
}

function cmd(seq, op, body) {
  return sdk.encodeDeviceMessage({ v: 1, id: `c${seq}`, seq, op, session: "sess-1" }, body);
}

async function lastResult(tx) {
  // microtask flush for coalesced counts
  await Promise.resolve();
  return tx.results[tx.results.length - 1];
}

test("an in-scope auto command runs the handler and acks", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.act": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "click", { x: 5, y: 6 }));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].op, "click");
  const r = await lastResult(tx);
  assert.equal(r.header.op, "ack");
  assert.equal(r.header.re, "c1");
});

test("observe runs the capture seam and returns an observation", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.observe": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "observe", { target: "screen" }));
  const r = await lastResult(tx);
  assert.equal(r.header.op, "observation");
  assert.equal(r.body.obs, "o1");
});

test("a capability not in the mandate is out_of_scope and the handler never runs", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.observe": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "click", { x: 1, y: 1 }));
  assert.equal(h.calls.length, 0);
  const r = await lastResult(tx);
  assert.equal(r.header.op, "error");
  assert.equal(r.body.code, "out_of_scope");
});

test("shell is always forbidden", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.shell": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "shell", { cmd: "rm -rf /" }));
  const r = await lastResult(tx);
  assert.equal(r.body.code, "forbidden");
});

test("ask mode refuses with needs_approval until the person approves", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  let answer = false;
  const host = sdk.createDeviceHost(
    snapshot({ "device.act": { mode: "ask" } }),
    h,
    tx,
    { requestLocalApproval: async () => answer }
  );
  await host.handleCommand(cmd(1, "type", { text: "x" }));
  assert.equal(h.calls.length, 0);
  assert.equal((await lastResult(tx)).body.code, "needs_approval");

  answer = true;
  await host.handleCommand(cmd(2, "type", { text: "y" }));
  assert.equal(h.calls.length, 1);
  assert.equal((await lastResult(tx)).header.op, "ack");
});

test("a seq that does not strictly increase is out_of_order; a replay is a no-op", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.act": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "type", { text: "a" }));
  await host.handleCommand(cmd(3, "type", { text: "skip" })); // gap
  assert.equal((await lastResult(tx)).body.code, "out_of_order");
  await host.handleCommand(cmd(1, "type", { text: "replay" })); // already processed
  assert.equal(h.calls.length, 1); // only the first ran
});

test("a never-allowed app is forbidden even with device.apps granted", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.apps": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "focus_app", { app: "com.1password.1password" }));
  assert.equal(h.calls.length, 0);
  assert.equal((await lastResult(tx)).body.code, "forbidden");
});

test("an app outside the selector is out_of_scope", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.apps": { mode: "auto", apps: ["com.apple.Safari"] } }), h, tx);
  await host.handleCommand(cmd(1, "focus_app", { app: "com.apple.Terminal" }));
  assert.equal((await lastResult(tx)).body.code, "out_of_scope");
});

test("a file outside every root is out_of_scope; inside a root runs", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.files.read": { mode: "auto", fileRoots: ["/Users/me/work"] } }), h, tx);
  await host.handleCommand(cmd(1, "read_file", { path: "/etc/passwd" }));
  assert.equal((await lastResult(tx)).body.code, "out_of_scope");
  await host.handleCommand(cmd(2, "read_file", { path: "/Users/me/work/notes.txt" }));
  assert.equal(h.calls.length, 1);
  assert.equal((await lastResult(tx)).header.op, "file");
});

test("files need an explicit root even when the capability is granted", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.files.read": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "read_file", { path: "/anything" }));
  assert.equal((await lastResult(tx)).body.code, "out_of_scope");
});

test("a spent action budget ends the session with budget_exhausted", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.act": { mode: "auto" } }, { budget: { maxActions: 1 } }), h, tx);
  await host.handleCommand(cmd(1, "type", { text: "a" })); // spends the one action
  await host.handleCommand(cmd(2, "type", { text: "b" })); // refused + ends
  assert.equal(h.calls.length, 1);
  assert.equal(tx.getStopped(), "budget_exhausted");
});

test("counts are reported per class", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.act": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "click", { x: 1, y: 1 }));
  await Promise.resolve();
  await Promise.resolve();
  const merged = Object.assign({}, ...tx.counts);
  assert.equal(merged.click, 1);
});

test("a stop command ends the session", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.act": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "stop", {}));
  assert.equal(tx.getStopped(), "stopped_by_agent");
  const r = tx.results.find((x) => x.header.op === "ended");
  assert.ok(r);
});

test("a handler that throws becomes error failed, counted as an error", async () => {
  const h = recordingHandlers();
  h.type = async () => { throw new Error("boom"); };
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.act": { mode: "auto" } }), h, tx);
  await host.handleCommand(cmd(1, "type", { text: "x" }));
  assert.equal((await lastResult(tx)).body.code, "failed");
});

test("a command for another session is dropped", async () => {
  const h = recordingHandlers();
  const tx = recordingTransport();
  const host = sdk.createDeviceHost(snapshot({ "device.act": { mode: "auto" } }), h, tx);
  const stray = sdk.encodeDeviceMessage({ v: 1, id: "c1", seq: 1, op: "type", session: "OTHER" }, { text: "x" });
  const consumed = await host.handleCommand(stray);
  assert.equal(consumed, false);
  assert.equal(h.calls.length, 0);
});
