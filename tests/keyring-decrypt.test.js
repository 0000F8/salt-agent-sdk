import { test } from "node:test";
import assert from "node:assert/strict";
import { decrypt, encryptFor, generateKeypair } from "../dist/index.js";

const PASS = "pw";
test("keyring decrypt: old, new and both keys; unopenable skipped", async () => {
  const oldK = await generateKeypair(PASS);
  const newK = await generateKeypair(PASS);
  const toOld = await encryptFor("old msg", [oldK.publicKey]);
  const toNew = await encryptFor("new msg", [newK.publicKey]);
  // single-key API unchanged
  assert.equal(await decrypt(toOld, oldK.privateKey, PASS), "old msg");
  await assert.rejects(decrypt(toOld, newK.privateKey, PASS));
  // keyring opens both generations, active first
  const ring = [newK.privateKey, oldK.privateKey];
  assert.equal(await decrypt(toOld, ring, PASS), "old msg");
  assert.equal(await decrypt(toNew, ring, PASS), "new msg");
  // only the new key: old history does not open
  await assert.rejects(decrypt(toOld, [newK.privateKey], PASS));
  // garbage rows are skipped, a good key still works
  assert.equal(await decrypt(toOld, ["not a key", newK.privateKey, oldK.privateKey], PASS), "old msg");
  // per-entry passphrase
  assert.equal(await decrypt(toOld, [{ armoredKey: oldK.privateKey, passphrase: PASS }], "wrong"), "old msg");
  // nothing usable
  await assert.rejects(decrypt(toOld, ["junk"], PASS), /No usable/);
});
