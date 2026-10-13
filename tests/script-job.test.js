// runScriptJob: deterministic-first scheduled work. Pins the contract the
// header comment in src/scriptJob.ts promises -- each source once with a
// timeout, one failing source never stops the others, nothing new means no
// compose and no post, items are marked seen only after post succeeds -- and
// both SeenStore implementations (per-key TTL, atomic file).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sdk = require("../dist/index.js");
const silent = { error() {} };

const item = (url, title = url) => ({ url, title });
const byUrl = (i) => i.url;

function recorder() {
  const calls = { compose: [], post: [] };
  return {
    calls,
    compose: async (fresh) => {
      calls.compose.push(fresh);
      return `digest of ${fresh.length}`;
    },
    post: async (text, fresh) => {
      calls.post.push({ text, fresh });
    },
  };
}

test("runScriptJob: fetches, composes only the new items, posts, and reports the counts", async () => {
  const seen = sdk.MemorySeenStore();
  await seen.mark(["https://old"]);
  const rec = recorder();
  const result = await sdk.runScriptJob({
    sources: { hn: async () => [item("https://a"), item("https://old")], rss: async () => [item("https://b")] },
    key: byUrl,
    seen,
    compose: rec.compose,
    post: rec.post,
    logger: silent,
  });
  assert.deepStrictEqual(result, { fetched: 3, fresh: 2, posted: true, failedSources: [] });
  assert.strictEqual(rec.calls.compose.length, 1);
  assert.deepStrictEqual(rec.calls.compose[0].map(byUrl), ["https://a", "https://b"]);
  assert.strictEqual(rec.calls.post[0].text, "digest of 2");
});

test("runScriptJob: nothing new means no compose and no post", async () => {
  const seen = sdk.MemorySeenStore();
  await seen.mark(["https://a"]);
  const rec = recorder();
  const result = await sdk.runScriptJob({ sources: [async () => [item("https://a")]], key: byUrl, seen, compose: rec.compose, post: rec.post, logger: silent });
  assert.deepStrictEqual(result, { fetched: 1, fresh: 0, posted: false, failedSources: [] });
  assert.strictEqual(rec.calls.compose.length, 0, "compose (the model) was not called");
  assert.strictEqual(rec.calls.post.length, 0);
});

test("runScriptJob: no sources returning anything is also silent", async () => {
  const rec = recorder();
  const result = await sdk.runScriptJob({ sources: { empty: async () => [] }, key: byUrl, seen: sdk.MemorySeenStore(), compose: rec.compose, post: rec.post, logger: silent });
  assert.deepStrictEqual(result, { fetched: 0, fresh: 0, posted: false, failedSources: [] });
  assert.strictEqual(rec.calls.post.length, 0);
});

test("runScriptJob: one failing source never stops the others, and is named", async () => {
  const rec = recorder();
  const logged = [];
  const result = await sdk.runScriptJob({
    sources: {
      broken: async () => {
        throw new Error("503 from the feed");
      },
      working: async () => [item("https://ok")],
    },
    key: byUrl,
    seen: sdk.MemorySeenStore(),
    compose: rec.compose,
    post: rec.post,
    logger: { error: (m) => logged.push(m) },
  });
  assert.deepStrictEqual(result, { fetched: 1, fresh: 1, posted: true, failedSources: ["broken"] });
  assert.match(logged[0], /broken failed: 503 from the feed/);
});

test("runScriptJob: a source that hangs is cut off by its timeout (and told to abort) while the others finish", async () => {
  let aborted = false;
  const result = await sdk.runScriptJob({
    sources: {
      hangs: ({ signal }) =>
        new Promise(() => {
          signal.addEventListener("abort", () => (aborted = true));
        }),
      fast: async () => [item("https://x")],
    },
    key: byUrl,
    seen: sdk.MemorySeenStore(),
    post: async () => {},
    sourceTimeoutMs: 30,
    logger: silent,
  });
  assert.deepStrictEqual(result.failedSources, ["hangs"]);
  assert.strictEqual(result.posted, true);
  assert.strictEqual(aborted, true, "the source's AbortSignal fired");
});

test("runScriptJob: each source runs exactly once per call", async () => {
  let runs = 0;
  await sdk.runScriptJob({
    sources: [
      async function counted() {
        runs += 1;
        return [item("https://a")];
      },
    ],
    key: byUrl,
    seen: sdk.MemorySeenStore(),
    post: async () => {},
    logger: silent,
  });
  assert.strictEqual(runs, 1);
});

test("runScriptJob: items are marked seen only after post succeeds -- a failed post leaves them for the next run", async () => {
  const seen = sdk.MemorySeenStore();
  const sources = { s: async () => [item("https://a")] };
  await assert.rejects(
    sdk.runScriptJob({
      sources,
      key: byUrl,
      seen,
      post: async () => {
        throw new Error("chat unreachable");
      },
      logger: silent,
    }),
    /chat unreachable/
  );
  assert.strictEqual(await seen.has("https://a"), false, "not marked after a failed post");

  const rec = recorder();
  const second = await sdk.runScriptJob({ sources, key: byUrl, seen, post: rec.post, logger: silent });
  assert.strictEqual(second.posted, true, "the retry sends it");
  assert.strictEqual(await seen.has("https://a"), true, "marked once the post succeeded");

  const third = await sdk.runScriptJob({ sources, key: byUrl, seen, post: rec.post, logger: silent });
  assert.deepStrictEqual(third, { fetched: 1, fresh: 0, posted: false, failedSources: [] });
});

test("runScriptJob: a compose that throws posts nothing and marks nothing", async () => {
  const seen = sdk.MemorySeenStore();
  let posted = false;
  await assert.rejects(
    sdk.runScriptJob({
      sources: [async () => [item("https://a")]],
      key: byUrl,
      seen,
      compose: async () => {
        throw new Error("model down");
      },
      post: async () => {
        posted = true;
      },
      logger: silent,
    }),
    /model down/
  );
  assert.strictEqual(posted, false);
  assert.strictEqual(await seen.has("https://a"), false);
});

test("runScriptJob: compose returning nothing posts nothing and marks nothing", async () => {
  const seen = sdk.MemorySeenStore();
  let posted = false;
  const result = await sdk.runScriptJob({
    sources: [async () => [item("https://a")]],
    key: byUrl,
    seen,
    compose: async () => "   ",
    post: async () => {
      posted = true;
    },
    logger: silent,
  });
  assert.strictEqual(result.posted, false);
  assert.strictEqual(posted, false);
  assert.strictEqual(await seen.has("https://a"), false);
});

test("runScriptJob: without compose a plain list is posted; the same story from two sources counts once", async () => {
  const rec = recorder();
  const result = await sdk.runScriptJob({
    sources: {
      hn: async () => [item("https://a", "Story A")],
      rss: async () => [item("https://a", "Story A again"), { url: "https://b" }],
    },
    key: byUrl,
    seen: sdk.MemorySeenStore(),
    post: rec.post,
    logger: silent,
  });
  assert.strictEqual(result.fetched, 3);
  assert.strictEqual(result.fresh, 2);
  assert.strictEqual(rec.calls.post[0].text, "- Story A\n  https://a\n- https://b");
});

test("runScriptJob: an item whose key() throws is skipped, not fatal", async () => {
  const rec = recorder();
  const result = await sdk.runScriptJob({
    sources: [async () => [item("https://a"), null]],
    key: (i) => i.url,
    seen: sdk.MemorySeenStore(),
    post: rec.post,
    logger: silent,
  });
  assert.deepStrictEqual(result, { fetched: 2, fresh: 1, posted: true, failedSources: [] });
});

test("runScriptJob: seenTtlMs reaches the store, so posted items can come back later", async () => {
  let now = 1_000;
  const seen = sdk.MemorySeenStore({ now: () => now });
  const sources = [async () => [item("https://a")]];
  const rec = recorder();
  await sdk.runScriptJob({ sources, key: byUrl, seen, post: rec.post, seenTtlMs: 100, logger: silent });
  assert.strictEqual((await sdk.runScriptJob({ sources, key: byUrl, seen, post: rec.post, logger: silent })).posted, false);
  now += 101;
  assert.strictEqual((await sdk.runScriptJob({ sources, key: byUrl, seen, post: rec.post, logger: silent })).posted, true);
});

test("MemorySeenStore: per-key ttl overrides the default, Infinity never expires, forget works", async () => {
  let now = 0;
  const store = sdk.MemorySeenStore({ ttlMs: 1000, now: () => now });
  await store.mark(["default"]);
  await store.mark(["short"], { ttlMs: 10 });
  await store.mark(["forever"], { ttlMs: Infinity });
  now = 11;
  assert.strictEqual(await store.has("short"), false);
  assert.strictEqual(await store.has("default"), true);
  now = 5000;
  assert.strictEqual(await store.has("default"), false);
  assert.strictEqual(await store.has("forever"), true);
  await store.forget("forever");
  assert.strictEqual(await store.has("forever"), false);
  await store.forget("never-marked");
});

test("FileSeenStore: survives a new instance, honours per-key ttl, prunes on write, writes atomically", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-seen-"));
  const file = path.join(dir, "nested", "seen.json");
  let now = 1_000_000;
  const a = sdk.FileSeenStore(file, { ttlMs: 60_000, now: () => now });
  assert.strictEqual(await a.has("x"), false, "a missing file is an empty store");
  await a.mark(["x", "y"]);
  await a.mark(["short"], { ttlMs: 10 });

  const b = sdk.FileSeenStore(file, { now: () => now });
  assert.strictEqual(await b.has("x"), true, "a fresh instance reads what the first wrote");

  now += 11;
  assert.strictEqual(await b.has("short"), false, "per-key ttl expired");
  assert.strictEqual(await b.has("y"), true);

  await b.mark(["z"]);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(!("short" in onDisk), "expired keys are dropped on rewrite");
  assert.deepStrictEqual(Object.keys(onDisk).sort(), ["x", "y", "z"]);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ["seen.json"], "no temp file left behind");

  await b.forget("x");
  assert.strictEqual(await sdk.FileSeenStore(file, { now: () => now }).has("x"), false);
});

test("FileSeenStore: overlapping marks in one process do not lose keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-seen-"));
  const store = sdk.FileSeenStore(path.join(dir, "seen.json"));
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.mark([`k${i}`])));
  for (let i = 0; i < 20; i++) assert.strictEqual(await store.has(`k${i}`), true);
});

test("FileSeenStore: a corrupt file throws rather than silently re-sending everything", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-seen-"));
  const file = path.join(dir, "seen.json");
  fs.writeFileSync(file, "{not json");
  await assert.rejects(sdk.FileSeenStore(file).has("x"));
});

test("FileSeenStore: the file is owner-only (0600) and new directories 0700", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-seen-"));
  const file = path.join(dir, "fresh", "seen.json");
  await sdk.FileSeenStore(file).mark(["x"]);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});
