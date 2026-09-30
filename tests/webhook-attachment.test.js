// Inbound Attachment messages (files plan step 1): webhook.ts's
// decryptAttachmentIfPresent used to hand a non-image attachment nothing but
// an "only images are viewable" note. It now decrypts bytes for ANY content
// type (bounded by MAX_ATTACHMENT_BYTES) and additionally decodes `text` for
// text-shaped files (text/*, JSON, CSV, Markdown) -- a PDF gets bytes only,
// since the SDK carries no pure-JS PDF parser. Same createWebhookServer +
// signed-POST harness as reply-addressing.test.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHmac } = require("node:crypto");
const openpgp = require("openpgp");

const sdk = require("../dist/index.js");

const silent = process.env.SDK_DEBUG ? console : { info() {}, error() {} };
const AGENT_ID = "00000000-0000-0000-0000-0000000000a1";
const HUMAN_ID = "00000000-0000-0000-0000-0000000000b2";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "salt-webhook-attachment-"));
  return path.join(dir, "identities.json");
}

function signedPost(port, body, agentId, secret) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Salt-Agent-Id": agentId, "X-Salt-Signature": `t=${t},v1=${v1}` },
    body: raw,
  });
}

// Delivers one Attachment-resource message to a freshly-set-up agent and
// returns whatever ctx.attachment the handler observed.
async function deliverAttachment(t, { contentType, filename, bytes, declaredSize, ciphertextBytesOverride, skipGetAttachmentCheck } = {}) {
  const agentKeys = await sdk.generateKeypair("agent-pass");
  const store = sdk.createIdentityStore(tempStore());
  store.register({ saltAppId: AGENT_ID, username: "helper", apiKey: "key-agent", publicKey: agentKeys.publicKey, privateKey: agentKeys.privateKey });

  const plaintext = bytes ?? Buffer.from("hello file");
  const { ciphertext, keyB64, ivB64 } = sdk.encryptAttachment(plaintext);
  const meta = { key: keyB64, iv: ivB64, filename: filename ?? "notes.txt", content_type: contentType ?? "text/plain", size: declaredSize ?? plaintext.length };
  const encryptedKey = await sdk.encryptFor(JSON.stringify(meta), [agentKeys.publicKey]);
  const captionArmored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: `📎 ${meta.filename}` }),
    encryptionKeys: await openpgp.readKey({ armoredKey: agentKeys.publicKey }),
  });

  const getAttachmentCalls = [];
  const api = {
    async getWebhookSecret(apiKey) {
      return apiKey === "key-agent" ? "secret-agent" : undefined;
    },
    async getChatMembers() {
      return [{ id: AGENT_ID, public_key: agentKeys.publicKey, account_type: "Agent" }, { id: HUMAN_ID, public_key: agentKeys.publicKey, account_type: "User" }];
    },
    async getAttachment() {
      getAttachmentCalls.push(1);
      return ciphertextBytesOverride ?? ciphertext;
    },
    async postMessage() {},
    async signalTyping() {},
    trackEvent() {},
  };

  const seen = [];
  const server = sdk.createWebhookServer({
    client: api,
    identities: store,
    pgpPassphrase: "agent-pass",
    logger: silent,
    async onMessage(ctx) {
      seen.push(ctx.attachment);
    },
  });
  const listening = server.app.listen(0);
  t.after(() => listening.close());
  const port = listening.address().port;

  const res = await signedPost(
    port,
    {
      chat: { id: "chat-1", name: "Room", public: false, managed: false, open_invite: false, mode: "auto" },
      message: {
        chat_id: "chat-1",
        message_id: "m-1",
        message: captionArmored,
        resource_type: "Attachment",
        resource: { encrypted_key: encryptedKey },
        user: { id: HUMAN_ID, username: "dan", account_type: "User" },
        created_at: new Date().toISOString(),
      },
    },
    AGENT_ID,
    "secret-agent"
  );
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  return { attachment: seen[0], getAttachmentCallCount: getAttachmentCalls.length };
}

test("a text/plain attachment decrypts to both bytes and decoded text", async (t) => {
  const { attachment } = await deliverAttachment(t, { contentType: "text/plain", filename: "notes.txt", bytes: Buffer.from("line one\nline two") });
  assert.ok(attachment, "onMessage saw ctx.attachment");
  assert.equal(attachment.filename, "notes.txt");
  assert.equal(attachment.contentType, "text/plain");
  assert.equal(attachment.data.toString("utf8"), "line one\nline two");
  assert.equal(attachment.text, "line one\nline two");
  assert.equal(attachment.unsupportedNote, undefined);
});

for (const contentType of ["application/json", "text/csv", "text/markdown"]) {
  test(`a ${contentType} attachment also decodes to text`, async (t) => {
    const body = contentType === "application/json" ? '{"ok":true}' : "a,b,c\n1,2,3";
    const { attachment } = await deliverAttachment(t, { contentType, filename: `data.${contentType.split("/")[1]}`, bytes: Buffer.from(body) });
    assert.equal(attachment.text, body);
    assert.equal(attachment.data.toString("utf8"), body);
  });
}

test("a PDF attachment gets bytes only -- no text field, since the SDK has no PDF parser in its dependency tree", async (t) => {
  const pdfBytes = Buffer.from("%PDF-1.4 fake pdf bytes");
  const { attachment } = await deliverAttachment(t, { contentType: "application/pdf", filename: "report.pdf", bytes: pdfBytes });
  assert.equal(attachment.contentType, "application/pdf");
  assert.deepEqual(attachment.data, pdfBytes);
  assert.equal(attachment.text, undefined);
});

test("an image attachment keeps its existing bytes-only behavior, with no text field", async (t) => {
  const imgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const { attachment } = await deliverAttachment(t, { contentType: "image/jpeg", filename: "photo.jpg", bytes: imgBytes });
  assert.deepEqual(attachment.data, imgBytes);
  assert.equal(attachment.text, undefined);
});

test("a declared size over the cap is refused WITHOUT ever calling getAttachment", async (t) => {
  const { attachment, getAttachmentCallCount } = await deliverAttachment(t, {
    contentType: "application/octet-stream",
    filename: "huge.bin",
    bytes: Buffer.from("small ciphertext, lying metadata"),
    declaredSize: sdk.MAX_ATTACHMENT_BYTES + 1,
  });
  assert.equal(getAttachmentCallCount, 0, "a lying size field must not trigger a download");
  assert.equal(attachment.data, undefined);
  assert.match(attachment.unsupportedNote, /too large/);
});
