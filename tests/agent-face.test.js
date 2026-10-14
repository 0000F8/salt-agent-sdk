// The owner's agent face (salt-api PUT /api/v1/agents/:id/admin_update, partial): photo, drawing, remove.
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

const FACE = { avatar_url: "https://salt.test/a.png", face: "photo", face_set_by: "owner" };

function clientWith(respond) {
  const fetchImpl = recordingFetch(respond);
  return { fetchImpl, client: sdk.createSaltClient({ host: "https://salt.test", fetchImpl }) };
}

test("setAgentPhoto PUTs a partial update with the photo as base64 and its content type", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { id: "a1", ...FACE }));
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const result = await client.setAgentPhoto("k", "a1", { bytes, contentType: "image/png" });

  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/agents/a1/admin_update");
  assert.strictEqual(fetchImpl.calls[0].method, "PUT");
  assert.strictEqual(fetchImpl.calls[0].headers["api-key"], "k");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), {
    partial: true,
    avatar: Buffer.from(bytes).toString("base64"),
    avatar_content_type: "image/png",
  });
  assert.strictEqual(result.face, "photo");
});

test("setAgentFace sends only partial and face", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { id: "a1", ...FACE, face: "drawing" }));
  const result = await client.setAgentFace("k", "a1", "drawing");
  assert.strictEqual(fetchImpl.calls[0].method, "PUT");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { partial: true, face: "drawing" });
  assert.strictEqual(result.face, "drawing");
});

test("removeAgentPhoto sends partial and remove_avatar", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, { id: "a1", avatar_url: null, face: null, face_set_by: null }));
  const result = await client.removeAgentPhoto("k", "a1");
  assert.strictEqual(fetchImpl.calls[0].url, "https://salt.test/api/v1/agents/a1/admin_update");
  assert.deepStrictEqual(JSON.parse(fetchImpl.calls[0].body), { partial: true, remove_avatar: true });
  assert.strictEqual(result.avatar_url, null);
});

test("a refusal rejects with SaltApiError carrying the sentence", async () => {
  const { client } = clientWith(() => jsonResponse(422, { error: "Upload a photo first." }));
  await assert.rejects(client.setAgentFace("k", "a1", "photo"), (err) => {
    assert.ok(err instanceof sdk.SaltApiError);
    assert.strictEqual(err.status, 422);
    assert.ok(err.message.endsWith("Upload a photo first."));
    return true;
  });
});

test("the face helpers go through actFor too", async () => {
  const { fetchImpl, client } = clientWith(() => jsonResponse(200, FACE));
  await client.actFor("principal-1").removeAgentPhoto("k", "a1");
  assert.strictEqual(fetchImpl.calls[0].headers["X-Salt-Act-For"], "principal-1");
});
