import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decrypt,
  encrypt,
  generateMasterKey,
  keyFingerprint,
  parseMasterKey,
  zeroKey,
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

test("wrong AAD fails closed", () => {
  const key = parseMasterKey(generateMasterKey());
  const envelope = encrypt("sk_live_value", key, "STRIPE_KEY");
  assert.equal(decrypt(envelope, key, "STRIPE_KEY"), "sk_live_value");
  assert.throws(() => decrypt(envelope, key, "OTHER_KEY"));
  assert.throws(() => decrypt(envelope, key, ""));
});

test("zeroKey overwrites the buffer", () => {
  const buf = Buffer.from("aa".repeat(32), "hex");
  assert.notEqual(buf[0], 0);
  zeroKey(buf);
  assert.equal(buf.every((b) => b === 0), true);
});
