// client.sendAttachment (files plan step 1): encrypts a file exactly the way
// salt-fe's chatbox.jsx sendOneAttachment does -- a fresh one-time AES-256-GCM
// key over the bytes, that key/iv/filename/content_type/size PGP-encrypted
// for every current chat member, one `attachment`/`attachment_encrypted_key`
// POST to /api/v1/messages. Same recordingFetch/createSaltClient harness as
// apps-client.test.js.
const test = require("node:test");
const assert = require("node:assert");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");

async function keypair(name) {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519",
    userIDs: [{ name }],
    format: "armored",
  });
  return { privateKey, publicKey };
}

async function decryptArmored(armoredPrivate, armoredMessage) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey: armoredPrivate });
  const message = await openpgp.readMessage({ armoredMessage });
  const { data } = await openpgp.decrypt({ message, decryptionKeys: privateKey });
  return data;
}

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

test("sendAttachment encrypts bytes with a fresh AES key, PGP-wraps key+metadata for every member, and posts both fields", async () => {
  const agent = await keypair("agent");
  const human = await keypair("human");
  const chatUsers = [
    { id: "agent-1", public_key: agent.publicKey, account_type: "Agent" },
    { id: "human-1", public_key: human.publicKey, account_type: "User" },
  ];

  const fetchImpl = recordingFetch((url) => {
    if (url.includes("/api/v1/chats/chat-1")) return jsonResponse(200, { session: { users: chatUsers } });
    return jsonResponse(200, { id: "msg-1" });
  });
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  const bytes = Buffer.from("hello, this is a file", "utf8");
  const result = await client.sendAttachment("agent-key", "chat-1", {
    bytes,
    filename: "notes.txt",
    contentType: "text/plain",
    caption: "here you go",
  });
  assert.deepStrictEqual(result, { id: "msg-1" });

  assert.strictEqual(fetchImpl.calls.length, 2);
  assert.strictEqual(fetchImpl.calls[0].method, "GET");
  assert.match(fetchImpl.calls[0].url, /\/api\/v1\/chats\/chat-1/);

  const post = fetchImpl.calls[1];
  assert.strictEqual(post.method, "POST");
  assert.strictEqual(post.url, "https://salt.test/api/v1/messages");
  assert.strictEqual(post.body.chat_id, "chat-1");
  assert.ok(post.body.attachment, "ciphertext is posted as base64");
  assert.ok(post.body.attachment_encrypted_key, "the key/metadata blob is posted PGP-armored");
  assert.match(post.body.attachment_encrypted_key, /^-----BEGIN PGP MESSAGE-----/);
  assert.match(post.body.message, /^-----BEGIN PGP MESSAGE-----/);

  // Every member (human recipient AND the sending agent's own key -- there's
  // no separate sender_message field for an attachment, see Attachment's
  // encrypted_key) can decrypt the metadata blob and the caption.
  for (const kp of [agent, human]) {
    const metaJson = await decryptArmored(kp.privateKey, post.body.attachment_encrypted_key);
    const meta = JSON.parse(metaJson);
    assert.strictEqual(meta.filename, "notes.txt");
    assert.strictEqual(meta.content_type, "text/plain");
    assert.strictEqual(meta.size, bytes.length);
    assert.ok(meta.key && meta.iv);

    // And the ciphertext itself decrypts back to the original bytes with
    // that key/iv, using the SAME decrypt routine an inbound webhook uses.
    const ciphertext = Buffer.from(post.body.attachment, "base64");
    const plaintext = sdk.decryptAttachment(ciphertext, meta.key, meta.iv);
    assert.strictEqual(plaintext.toString("utf8"), "hello, this is a file");

    const caption = await decryptArmored(kp.privateKey, post.body.message);
    assert.strictEqual(caption, "here you go");
  }
});

test("sendAttachment defaults the caption to '📎 <sanitized filename>', matching salt-fe's fallback", async () => {
  const agent = await keypair("agent");
  const chatUsers = [{ id: "agent-1", public_key: agent.publicKey }];
  const fetchImpl = recordingFetch((url) => {
    if (url.includes("/api/v1/chats/")) return jsonResponse(200, { session: { users: chatUsers } });
    return jsonResponse(200, {});
  });
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await client.sendAttachment("agent-key", "chat-1", {
    bytes: Buffer.from("x"),
    filename: "../../etc/passwd",
    contentType: "text/plain",
  });

  const post = fetchImpl.calls[1];
  const caption = await decryptArmored(agent.privateKey, post.body.message);
  assert.strictEqual(caption, "📎 passwd", "the filename is sanitized before it becomes part of the caption too");

  const metaJson = await decryptArmored(agent.privateKey, post.body.attachment_encrypted_key);
  assert.strictEqual(JSON.parse(metaJson).filename, "passwd");
});

test("sendAttachment refuses an oversized file and a disallowed content type before touching the network", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { session: { users: [] } }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(
    () => client.sendAttachment("k", "chat-1", { bytes: Buffer.alloc(sdk.MAX_ATTACHMENT_BYTES + 1), filename: "big.bin", contentType: "application/octet-stream" }),
    /too large/
  );
  await assert.rejects(
    () => client.sendAttachment("k", "chat-1", { bytes: Buffer.from("x"), filename: "run.exe", contentType: "application/x-msdownload" }),
    /content type not allowed/
  );
  assert.strictEqual(fetchImpl.calls.length, 0, "neither rejection should have made a network call");
});

test("sendAttachment refuses when the chat has no member with a public key", async () => {
  const fetchImpl = recordingFetch(() => jsonResponse(200, { session: { users: [{ id: "u-1" }] } }));
  const client = sdk.createSaltClient({ host: "https://salt.test", fetchImpl });

  await assert.rejects(
    () => client.sendAttachment("k", "chat-1", { bytes: Buffer.from("x"), filename: "a.txt", contentType: "text/plain" }),
    /no recipient public keys/
  );
  assert.strictEqual(fetchImpl.calls.length, 1, "only the membership fetch happened -- no doomed POST");
});

test("sanitizeAttachmentFilename strips path components, control chars, and falls back to a safe default", () => {
  assert.strictEqual(sdk.sanitizeAttachmentFilename("../../etc/passwd"), "passwd");
  assert.strictEqual(sdk.sanitizeAttachmentFilename("C:\\Users\\dan\\report.csv"), "report.csv");
  assert.strictEqual(sdk.sanitizeAttachmentFilename("..\u0000.hidden"), "hidden");
  assert.strictEqual(sdk.sanitizeAttachmentFilename(""), "attachment");
  assert.strictEqual(sdk.sanitizeAttachmentFilename(undefined), "attachment");
  assert.strictEqual(sdk.sanitizeAttachmentFilename("a".repeat(300)).length, 200);
});
