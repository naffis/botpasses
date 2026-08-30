import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decrypt,
  encrypt,
  generateMasterKey,
  keyFingerprint,
  parseMasterKey,
} from "../src/crypto.ts";

test("AES-256-GCM roundtrip", () => {
  const key = parseMasterKey(generateMasterKey());
  const envelope = encrypt("hello-agent", key);
  assert.notEqual(envelope.ciphertext, "hello-agent");
  assert.equal(decrypt(envelope, key), "hello-agent");
});

test("wrong key fails closed", () => {
  const a = parseMasterKey(generateMasterKey());
  const b = parseMasterKey(generateMasterKey());
  const envelope = encrypt("hello-agent", a);
  assert.throws(() => decrypt(envelope, b));
});

test("accepts hex and base64 master keys", () => {
  const hex = generateMasterKey();
  const key = parseMasterKey(hex);
  const b64 = key.toString("base64");
  assert.equal(keyFingerprint(parseMasterKey(b64)), keyFingerprint(key));
});

test("rejects short keys", () => {
  assert.throws(() => parseMasterKey("deadbeef"));
});
