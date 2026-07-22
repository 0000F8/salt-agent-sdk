// PGP message crypto, wallet-payload crypto, and attachment decryption.
// Ported from salt-claude-agent/src/{pgp,walletCrypto,attachments}.js --
// zero LLM/agent-loop dependency in the original, moved verbatim with types.

import * as openpgp from "openpgp";
import * as nodeCrypto from "node:crypto";

export interface GeneratedKeypair {
  publicKey: string;
  privateKey: string;
  revocationCertificate: string;
  fingerprint: string;
}

/**
 * Decrypt an armored PGP message with the agent's private key. Salt
 * encrypts each message to every chat member's public key, so the agent's
 * own key is among the recipients and can read the ciphertext directly.
 */
export async function decrypt(
  armoredMessage: string,
  armoredPrivateKey: string,
  passphrase: string
): Promise<string> {
  const privateKey = await openpgp.decryptKey({
    privateKey: await openpgp.readPrivateKey({ armoredKey: armoredPrivateKey }),
    passphrase,
  });
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage }),
    decryptionKeys: [privateKey],
  });
  return data as string;
}

/**
 * Encrypt plaintext to one or more armored public keys. Passing every
 * non-agent member's key produces a single ciphertext all of them can read
 * -- what Salt stores in a message's `message` field.
 */
export async function encryptFor(plaintext: string, armoredPublicKeys: string[]): Promise<string> {
  const keys = await Promise.all(armoredPublicKeys.map((k) => openpgp.readKey({ armoredKey: k })));
  const result = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: plaintext }),
    encryptionKeys: keys,
  });
  return result as string;
}

/**
 * Generate a fresh agent keypair -- same curve/format the Salt frontend
 * uses (salt-fe's src/utilities/encrypt.jsx generateKeys()), so a key
 * minted here is indistinguishable from one a human created through the UI.
 */
export async function generateKeypair(passphrase: string): Promise<GeneratedKeypair> {
  const { privateKey, publicKey, revocationCertificate } = await openpgp.generateKey({
    type: "ecc",
    curve: "curve25519",
    userIDs: [{}],
    passphrase,
    format: "armored",
  });
  const fingerprint = await (await openpgp.readKey({ armoredKey: publicKey })).getFingerprint();
  return { publicKey, privateKey, revocationCertificate, fingerprint };
}

export interface WalletSecrets {
  private_key: string;
  mnemonic?: string | null;
}

/**
 * Encrypt a wallet's secrets for upload via client.createWallet. Byte
 * compatible with salt-fe's walletVault.js wire format: base64 of a
 * 12-byte random IV || AES-256-GCM ciphertext || 16-byte auth tag. AAD
 * binds the ciphertext to the wallet's public_address (same as the browser
 * vault), so a payload can't be replayed onto a different wallet row.
 * There is no human-memorable recovery phrase here -- the master key
 * (WALLET_MASTER_KEY) is the only key, held by this process alone.
 */
export function encryptWalletPayload(masterKeyHex: string, secrets: WalletSecrets, publicAddress: string): string {
  const key = Buffer.from(masterKeyHex, "hex");
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(publicAddress, "utf8"));
  const plaintext = Buffer.from(JSON.stringify({ private_key: secrets.private_key, mnemonic: secrets.mnemonic || null }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");
}

/**
 * Decrypt a message attachment's ciphertext bytes (see client.getAttachment).
 * Mirrors salt-fe's src/utilities/attachments.js: Web Crypto AES-256-GCM
 * output is ciphertext with the 16-byte auth tag appended, so Node's crypto
 * module needs that tag split off and set explicitly via setAuthTag.
 */
export function decryptAttachment(ciphertextBuffer: Buffer, keyB64: string, ivB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const tag = ciphertextBuffer.subarray(ciphertextBuffer.length - 16);
  const encrypted = ciphertextBuffer.subarray(0, ciphertextBuffer.length - 16);

  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
