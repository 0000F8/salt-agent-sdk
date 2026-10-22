// client.live / streamCredentials / media / video against a mock shaped like salt-api's media endpoints.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sdk = require("../dist/index.js");

const json = (status, body, headers = {}) => ({
  ok: status < 300,
  status,
  headers: { get: (k) => headers[k] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function recordingFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers ?? {}, rawBody: opts?.body, body: typeof opts?.body === "string" ? JSON.parse(opts.body) : undefined });
    return respond(url, opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const mk = (fetchImpl) => sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

test("live.start posts the session and returns the publish block", async () => {
  const publish = { ingest_endpoint: "x.global-contribute.live-video.net", stream_key: "sk_secret", rtmps_url: "rtmps://x.global-contribute.live-video.net:443/app/" };
  const f = recordingFetch(() => json(201, { live_session: { id: "ls1" }, publish }));
  const out = await mk(f).live.start("k", { chatId: "c1", title: "hi", sourceType: "rtmp", record: true }, { idempotencyKey: "i1" });
  const c = f.calls[0];
  assert.strictEqual(c.url, "https://salt.test/api/v1/live_sessions");
  assert.strictEqual(c.headers["Idempotency-Key"], "i1");
  assert.deepStrictEqual(c.body, { chat_id: "c1", title: "hi", source_type: "rtmp", record: true });
  assert.strictEqual(out.publish.stream_key, "sk_secret");
});

test("live get, forChat, end, playback and report hit their paths", async () => {
  const f = recordingFetch(() => json(200, {}));
  const c = mk(f);
  await c.live.get("k", "ls1");
  await c.live.forChat("k", "c1");
  await c.live.end("k", "ls1");
  await c.live.playback("k", "ls1");
  await c.live.report("k", "ls1", { reason: "spam" });
  assert.deepStrictEqual(f.calls.map((x) => `${x.method} ${x.url.replace("https://salt.test", "")}`), [
    "GET /api/v1/live_sessions/ls1",
    "GET /api/v1/chats/c1/live",
    "POST /api/v1/live_sessions/ls1/end",
    "POST /api/v1/live_sessions/ls1/playback",
    "POST /api/v1/live_sessions/ls1/reports",
  ]);
});

test("live.start surfaces the server's sentence on 409", async () => {
  const c = mk(recordingFetch(() => json(409, { error: "You are already live." })));
  await assert.rejects(() => c.live.start("k", { chatId: "c1", sourceType: "rtmp" }), (e) => e instanceof sdk.SaltApiError && e.status === 409 && e.message.endsWith(": You are already live."));
});

test("streamCredentials list, create, update, rotate, remove", async () => {
  const f = recordingFetch((url, o) => (o.method === "DELETE" ? json(204, undefined) : json(200, {})));
  const c = mk(f);
  await c.streamCredentials.list("k");
  await c.streamCredentials.create("k", { chatId: "c1", label: "ffmpeg", persistent: true });
  await c.streamCredentials.update("k", 5, { enabled: false });
  await c.streamCredentials.rotate("k", 5);
  await c.streamCredentials.remove("k", 5);
  assert.deepStrictEqual(f.calls.map((x) => `${x.method} ${x.url.replace("https://salt.test", "")}`), [
    "GET /api/v1/stream_credentials",
    "POST /api/v1/stream_credentials",
    "PATCH /api/v1/stream_credentials/5",
    "POST /api/v1/stream_credentials/5/rotate",
    "DELETE /api/v1/stream_credentials/5",
  ]);
  assert.deepStrictEqual(f.calls[1].body, { chat_id: "c1", label: "ffmpeg", persistent: true });
});

function uploadFetch({ failFirstPut = false } = {}) {
  let puts = 0;
  return recordingFetch((url, o) => {
    if (url.startsWith("https://s3.test/")) {
      puts += 1;
      if (failFirstPut && puts === 1) return json(500, {});
      return json(200, {}, { ETag: `"etag-${url.slice(-1)}"` });
    }
    if (url.endsWith("/api/v1/media")) {
      return json(201, { media: { id: "m1", state: "uploading" }, upload: { upload_id: "u1", part_size: 4, parts: [{ n: 1, url: "https://s3.test/p1" }, { n: 2, url: "https://s3.test/p2" }] } });
    }
    if (url.endsWith("/complete")) return json(200, { media: { id: "m1", state: "processing" } });
    return json(404, { error: "nope" });
  });
}

test("media.uploadVideo from bytes: creates, PUTs each part, completes", async () => {
  const f = uploadFetch();
  const media = await mk(f).media.uploadVideo("k", new Uint8Array([1, 2, 3, 4, 5, 6]), { contentType: "video/mp4", filename: "a.mp4" });
  assert.strictEqual(media.state, "processing");
  assert.deepStrictEqual(f.calls[0].body, { kind: "video", byte_size: 6, content_type: "video/mp4", filename: "a.mp4" });
  assert.deepStrictEqual(Array.from(f.calls[1].rawBody), [1, 2, 3, 4]);
  assert.deepStrictEqual(Array.from(f.calls[2].rawBody), [5, 6]);
  assert.strictEqual(f.calls[1].method, "PUT");
  assert.strictEqual(f.calls[1].headers["api-key"], undefined);
  assert.deepStrictEqual(f.calls[3].body, { upload_id: "u1", parts: [{ n: 1, etag: '"etag-1"' }, { n: 2, etag: '"etag-2"' }] });
});

test("media.uploadVideo from a path retries a failed part", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "salt-up-")), "clip.mp4");
  fs.writeFileSync(file, Buffer.from([9, 8, 7, 6, 5]));
  const f = uploadFetch({ failFirstPut: true });
  const media = await mk(f).media.uploadVideo("k", file, { contentType: "video/mp4", retries: 2 });
  assert.strictEqual(media.id, "m1");
  const puts = f.calls.filter((c) => c.method === "PUT");
  assert.strictEqual(puts.length, 3);
  assert.deepStrictEqual(Array.from(puts[2].rawBody), [5]);
});

test("media.uploadVideo gives up after the retries and never completes", async () => {
  const f = recordingFetch((url) => (url.endsWith("/api/v1/media") ? json(201, { media: { id: "m1" }, upload: { upload_id: "u1", part_size: 4, parts: [{ n: 1, url: "https://s3.test/p1" }] } }) : json(500, {})));
  await assert.rejects(() => mk(f).media.uploadVideo("k", new Uint8Array([1]), { contentType: "video/mp4", retries: 2 }), /upload -> 500/);
  assert.ok(!f.calls.some((c) => c.url.endsWith("/complete")));
});

test("media get, playback and feedPlayback", async () => {
  const f = recordingFetch(() => json(200, { expires_at: "t", cookies: { a: "b" } }));
  const c = mk(f);
  await c.media.get("k", "m1");
  const p = await c.media.playback("k", "m1");
  await c.media.feedPlayback("k");
  assert.deepStrictEqual(p.cookies, { a: "b" });
  assert.deepStrictEqual(f.calls.map((x) => `${x.method} ${x.url.replace("https://salt.test", "")}`), ["GET /api/v1/media/m1", "POST /api/v1/media/m1/playback", "POST /api/v1/media/playback"]);
});

test("video posts: publish, get, mine, update, remove, report", async () => {
  const f = recordingFetch((url, o) => (o.method === "DELETE" ? json(204, undefined) : json(200, {})));
  const c = mk(f);
  await c.video.publish("k", { mediaId: "m1", caption: "hi", chatId: "c1" });
  await c.video.get("k", "v1");
  await c.video.mine("k", { status: "draft" });
  await c.video.update("k", "v1", { status: "published", alsoInChatId: "c2" });
  await c.video.remove("k", "v1");
  await c.video.report("k", "v1", { reason: "spam", note: "n" });
  assert.deepStrictEqual(f.calls.map((x) => `${x.method} ${x.url.replace("https://salt.test", "")}`), [
    "POST /api/v1/video_posts",
    "GET /api/v1/video_posts/v1",
    "GET /api/v1/video_posts/mine?status=draft",
    "PATCH /api/v1/video_posts/v1",
    "DELETE /api/v1/video_posts/v1",
    "POST /api/v1/video_posts/v1/reports",
  ]);
  assert.deepStrictEqual(f.calls[0].body, { media_id: "m1", caption: "hi", chat_id: "c1" });
  assert.deepStrictEqual(f.calls[3].body, { status: "published", also_in_chat_id: "c2" });
});

test("video.feed pages with before_seq and video.sendEvents posts the batch", async () => {
  const f = recordingFetch((url) => (url.includes("/events") ? json(202, {}) : json(200, { items: [], live: [], next_before_seq: null })));
  const c = mk(f);
  await c.video.feed("k", { scope: "room", chatId: "c1", beforeSeq: 40, limit: 10 });
  await c.video.sendEvents("k", [{ post_id: "v1", kind: "view", at: "2026-10-21T00:00:00Z" }]);
  const u = new URL(f.calls[0].url);
  assert.strictEqual(u.pathname, "/api/v1/video/feed");
  assert.strictEqual(u.searchParams.get("scope"), "room");
  assert.strictEqual(u.searchParams.get("chat_id"), "c1");
  assert.strictEqual(u.searchParams.get("before_seq"), "40");
  assert.strictEqual(u.searchParams.get("limit"), "10");
  assert.strictEqual(f.calls[1].url, "https://salt.test/api/v1/video/events");
  assert.strictEqual(f.calls[1].body.events.length, 1);
});
