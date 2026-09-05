import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { generateDek, unwrapDek, wrapDek } from "../src/hosted/kek.ts";
import { encrypt } from "../src/crypto.ts";
import { hostedKekBootError, previousKekBootError } from "../src/hosted/boot.ts";
import {
  decryptWithOneRetry,
  FakeKms,
  isTransientKmsError,
  kekEncryptionContext,
  KmsKekProvider,
  LocalKekProvider,
  selectPreviousKekProvider,
} from "../src/hosted/kms.ts";
import { CANARY } from "./helpers.ts";

test("VAULT_KEK_PREVIOUS is optional, raw or KMS-wrapped, and follows the current KEK's rules (G4)", async () => {
  const hex = generateMasterKey();
  assert.equal(selectPreviousKekProvider({}), undefined);
  const raw = selectPreviousKekProvider({ VAULT_KEK_PREVIOUS: hex });
  assert.ok(raw instanceof LocalKekProvider);
  assert.equal((await raw.unwrap()).length, 32);

  const kek = parseMasterKey(generateMasterKey());
  const ctx = kekEncryptionContext({ plane: "staging", app: "botpasses-staging" });
  const fake = new FakeKms(kek, ctx);
  const wrapped = selectPreviousKekProvider(
    {
      VAULT_DEPLOY_PLANE: "staging",
      FLY_APP_NAME: "botpasses-staging",
      VAULT_KMS_KEY_ID: "arn:aws:kms:x",
      VAULT_KEK_PREVIOUS_WRAPPED: Buffer.from("blob").toString("base64"),
    },
    (c, x) => fake.decrypt(c, x),
  );
  assert.ok(wrapped instanceof KmsKekProvider);
  assert.deepEqual(await wrapped.unwrap(), kek);

  const base = { VAULT_KEK: hex, VAULT_DEPLOY_PLANE: "staging", FLY_APP_NAME: "botpasses-staging" };
  assert.equal(previousKekBootError({}), undefined);
  assert.equal(previousKekBootError({ VAULT_KEK_PREVIOUS: hex }), undefined);
  assert.match(previousKekBootError({ VAULT_KEK_PREVIOUS: "short" }) ?? "", /32-byte/);
  assert.match(previousKekBootError({ VAULT_KEK_PREVIOUS: hex, VAULT_KEK_PREVIOUS_WRAPPED: "x" }) ?? "", /not both/);
  assert.match(previousKekBootError({ VAULT_KEK_PREVIOUS_WRAPPED: "x" }) ?? "", /VAULT_DEPLOY_PLANE and VAULT_KMS_KEY_ID/);
  assert.match(
    previousKekBootError({ ...base, VAULT_KEK_PREVIOUS: hex, VAULT_KEK_REQUIRE_KMS: "1" }) ?? "",
    /VAULT_KEK_REQUIRE_KMS=1 refuses raw VAULT_KEK_PREVIOUS/,
  );
  assert.equal(
    previousKekBootError({ ...base, VAULT_KMS_KEY_ID: "arn", VAULT_KEK_PREVIOUS_WRAPPED: "x", VAULT_KEK_REQUIRE_KMS: "1" }),
    undefined,
  );
  assert.match(hostedKekBootError({ ...base, VAULT_KEK_PREVIOUS: "short" }) ?? "", /VAULT_KEK_PREVIOUS/, "boot refuses a bad previous key");
});

test("FakeKms unwrap yields a 32-byte key that wrapDek round-trips", async () => {
  const kek = parseMasterKey(generateMasterKey());
  const ctx = kekEncryptionContext({ plane: "staging", app: "botpasses-staging" });
  const fake = new FakeKms(kek, ctx);
  const provider = new KmsKekProvider(Buffer.from("wrapped-blob").toString("base64"), ctx, (c, x) =>
    fake.decrypt(c, x),
  );
  const unwrapped = await provider.unwrap();
  assert.equal(unwrapped.length, 32);
  const dek = generateDek();
  const orgId = "org_test";
  const envelope = wrapDek(dek, unwrapped, orgId);
  assert.deepEqual(unwrapDek(envelope, unwrapped, orgId), dek);
});

test("FakeKms rejects a mismatched EncryptionContext", async () => {
  const kek = parseMasterKey(generateMasterKey());
  const expected = kekEncryptionContext({ plane: "staging", app: "botpasses-staging" });
  const fake = new FakeKms(kek, expected);
  const provider = new KmsKekProvider(
    Buffer.from("wrapped-blob").toString("base64"),
    kekEncryptionContext({ plane: "production", app: "botpasses-prod" }),
    (c, x) => fake.decrypt(c, x),
  );
  await assert.rejects(() => provider.unwrap(), /InvalidCiphertextException/);
});

test("dump plus guessed KEK cannot unwrap a DEK (AC-01)", () => {
  const kek = parseMasterKey(generateMasterKey());
  const guessed = parseMasterKey(generateMasterKey());
  const dek = generateDek();
  const orgId = "org_dump";
  const wrapped = wrapDek(dek, kek, orgId);
  const item = encrypt(CANARY, dek, orgId);
  assert.throws(() => unwrapDek(wrapped, guessed, orgId));
  assert.throws(() => unwrapDek(wrapped, Buffer.alloc(32), orgId));
  assert.doesNotMatch(JSON.stringify(wrapped), new RegExp(CANARY));
  assert.doesNotMatch(JSON.stringify(item), new RegExp(CANARY));
});

test("FakeKms that refuses Decrypt cannot yield a KEK (AC-01)", async () => {
  const ctx = kekEncryptionContext({ plane: "production", app: "botpasses-prod" });
  const fake = new FakeKms(parseMasterKey(generateMasterKey()), ctx);
  const provider = new KmsKekProvider("", ctx, (c, x) => fake.decrypt(c, x));
  await assert.rejects(() => provider.unwrap(), /InvalidCiphertextException/);
});

test("transient KMS 5xx retries once then succeeds", async () => {
  let calls = 0;
  let slept = 0;
  const out = await decryptWithOneRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("throttled");
        err.name = "ThrottlingException";
        throw err;
      }
      return Buffer.alloc(32, 7);
    },
    async (ms) => {
      slept = ms;
    },
  );
  assert.equal(calls, 2);
  assert.equal(slept, 1000);
  assert.equal(out.length, 32);
  assert.equal(isTransientKmsError({ name: "ThrottlingException" }), true);
  assert.equal(isTransientKmsError({ $metadata: { httpStatusCode: 503 } }), true);
  assert.equal(isTransientKmsError(new Error("InvalidCiphertextException")), false);
});

test("LocalKekProvider parses VAULT_KEK", async () => {
  const hex = generateMasterKey();
  const provider = new LocalKekProvider(hex);
  const key = await provider.unwrap();
  assert.equal(key.length, 32);
});
