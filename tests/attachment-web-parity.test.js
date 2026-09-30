// Cross-check (files plan gate): proves an SDK-encrypted attachment decrypts
// with the SAME routine the web uses, and vice versa.
//
// This is not "two AES-GCM implementations that should agree" asserted from
// memory -- the web's own algorithm (salt-fe/src/utilities/attachments.js
// encryptFileBytes/decryptFileBytes) is ported byte-for-byte below, swapping
// only `window.crypto.subtle` for `require("node:crypto").webcrypto.subtle`
// (Node's WebCrypto implementation, the same spec-level AES-GCM primitive a
// browser's SubtleCrypto uses -- not salt-agent-sdk's own node:crypto
// createCipheriv-based encryptAttachment/decryptAttachment). If the SDK's
// wire format ever drifted from the browser's (e.g. tag placement, key
// length, IV length), this is what would catch it.
const test = require("node:test");
const assert = require("node:assert");
const { webcrypto } = require("node:crypto");

const sdk = require("../dist/index.js");

const subtle = webcrypto.subtle;

// --- Ported verbatim from salt-fe/src/utilities/attachments.js -----------
// (arrayBufferToBase64/base64ToArrayBuffer collapsed to Buffer equivalents
// since this runs in Node, not a browser -- the crypto calls themselves are
// untouched.)

async function webEncryptFileBytes(arrayBuffer) {
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, arrayBuffer);
  const rawKey = await subtle.exportKey("raw", key);
  return {
    ciphertext, // ArrayBuffer
    keyB64: Buffer.from(rawKey).toString("base64"),
    ivB64: Buffer.from(iv).toString("base64"),
  };
}

async function webDecryptFileBytes(ciphertextArrayBuffer, keyB64, ivB64) {
  const key = await subtle.importKey("raw", Buffer.from(keyB64, "base64"), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const iv = Buffer.from(ivB64, "base64");
  return subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, ciphertextArrayBuffer);
}
// --- end port --------------------------------------------------------------

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test("an attachment encrypted by the SDK (node:crypto) decrypts with the web's exact routine (WebCrypto AES-GCM)", async () => {
  const plaintext = Buffer.from("Q4 numbers, don't forward this.", "utf8");
  const { ciphertext, keyB64, ivB64 } = sdk.encryptAttachment(plaintext);

  const decrypted = await webDecryptFileBytes(toArrayBuffer(ciphertext), keyB64, ivB64);
  assert.strictEqual(Buffer.from(decrypted).toString("utf8"), plaintext.toString("utf8"));
});

test("an attachment encrypted by the web's routine (WebCrypto AES-GCM) decrypts with the SDK's exact routine (node:crypto)", async () => {
  const plaintext = Buffer.from("the deploy password is on the wiki", "utf8");
  const { ciphertext, keyB64, ivB64 } = await webEncryptFileBytes(toArrayBuffer(plaintext));

  const decrypted = sdk.decryptAttachment(Buffer.from(ciphertext), keyB64, ivB64);
  assert.strictEqual(decrypted.toString("utf8"), plaintext.toString("utf8"));
});

test("round-trips a larger binary payload both directions, byte for byte", async () => {
  const plaintext = Buffer.from(Array.from({ length: 50_000 }, (_, i) => i % 256));

  const sdkSide = sdk.encryptAttachment(plaintext);
  const viaWeb = await webDecryptFileBytes(toArrayBuffer(sdkSide.ciphertext), sdkSide.keyB64, sdkSide.ivB64);
  assert.deepStrictEqual(Buffer.from(viaWeb), plaintext);

  const webSide = await webEncryptFileBytes(toArrayBuffer(plaintext));
  const viaSdk = sdk.decryptAttachment(Buffer.from(webSide.ciphertext), webSide.keyB64, webSide.ivB64);
  assert.deepStrictEqual(viaSdk, plaintext);
});

test("the full send-time envelope (client.sendAttachment's metaJson shape) is exactly what AttachmentMessage.jsx expects, and its ciphertext decrypts with the web routine", async () => {
  // Mirrors salt-fe's chatbox.jsx sendOneAttachment: JSON.stringify({key, iv,
  // filename, content_type, size}) alongside the AES-GCM ciphertext -- this
  // is the literal shape client.sendAttachment PGP-encrypts into
  // attachment_encrypted_key (see client.ts).
  const plaintext = Buffer.from("board meeting notes", "utf8");
  const { ciphertext, keyB64, ivB64 } = sdk.encryptAttachment(plaintext);
  const metaJson = JSON.stringify({ key: keyB64, iv: ivB64, filename: "board-notes.txt", content_type: "text/plain", size: plaintext.length });

  // salt-fe's AttachmentMessage.jsx: JSON.parse(decrypted metadata), then
  // decryptFileBytes(ciphertextFromServer, metadata.key, metadata.iv).
  const meta = JSON.parse(metaJson);
  const plaintextBack = await webDecryptFileBytes(toArrayBuffer(ciphertext), meta.key, meta.iv);
  assert.strictEqual(Buffer.from(plaintextBack).toString("utf8"), "board meeting notes");
  assert.strictEqual(meta.filename, "board-notes.txt");
  assert.strictEqual(meta.content_type, "text/plain");
  assert.strictEqual(meta.size, plaintext.length);
});
