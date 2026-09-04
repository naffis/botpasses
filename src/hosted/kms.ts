import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { deployPlaneRaw } from "../brand.ts";
import { parseMasterKey } from "../crypto.ts";
import { parseKek } from "./kek.ts";

export type KekEncryptionContext = {
  purpose: string;
  plane: string;
  app: string;
};

export type KekDecryptFn = (cipher: Buffer, context: KekEncryptionContext) => Promise<Buffer>;
export type KekEncryptFn = (plain: Buffer, context: KekEncryptionContext) => Promise<Buffer>;

export type KekProvider = { unwrap(): Promise<Buffer> };

export const KEK_CONTEXT_PURPOSE = "vault-kek";

export function kekEncryptionContext(input: { plane: string; app: string }): KekEncryptionContext {
  return { purpose: KEK_CONTEXT_PURPOSE, plane: input.plane, app: input.app };
}

function contextEqual(a: KekEncryptionContext, b: KekEncryptionContext): boolean {
  return a.purpose === b.purpose && a.plane === b.plane && a.app === b.app;
}

export class LocalKekProvider implements KekProvider {
  readonly #raw: string;

  constructor(raw: string) {
    this.#raw = raw;
  }

  async unwrap(): Promise<Buffer> {
    return parseKek(this.#raw);
  }
}

export class FakeKms {
  readonly #key: Buffer;
  readonly #expected: KekEncryptionContext;

  constructor(key: Buffer, expected: KekEncryptionContext) {
    this.#key = key;
    this.#expected = expected;
  }

  async decrypt(cipher: Buffer, context: KekEncryptionContext): Promise<Buffer> {
    if (!contextEqual(context, this.#expected)) {
      throw new Error("InvalidCiphertextException");
    }
    if (cipher.length === 0) throw new Error("InvalidCiphertextException");
    return Buffer.from(this.#key);
  }

  async encrypt(plain: Buffer, context: KekEncryptionContext): Promise<Buffer> {
    if (!contextEqual(context, this.#expected)) {
      throw new Error("InvalidCiphertextException");
    }
    return Buffer.from(plain);
  }
}

export class KmsKekProvider implements KekProvider {
  readonly #wrappedB64: string;
  readonly #context: KekEncryptionContext;
  readonly #decryptFn: KekDecryptFn;

  constructor(wrappedB64: string, context: KekEncryptionContext, decryptFn: KekDecryptFn) {
    this.#wrappedB64 = wrappedB64;
    this.#context = context;
    this.#decryptFn = decryptFn;
  }

  async unwrap(): Promise<Buffer> {
    const plain = await this.#decryptFn(Buffer.from(this.#wrappedB64, "base64"), this.#context);
    if (plain.length === 32) return Buffer.from(plain);
    return parseMasterKey(plain.toString("utf8"));
  }
}

export function usedRawKekFallback(env: NodeJS.ProcessEnv): boolean {
  const onPlane = deployPlaneRaw(env) !== undefined;
  const wrapped = Boolean(env.VAULT_KEK_WRAPPED?.trim() && env.VAULT_KMS_KEY_ID?.trim());
  return onPlane && !wrapped && Boolean(env.VAULT_KEK?.trim());
}

export function selectKekProvider(
  env: NodeJS.ProcessEnv,
  decryptFn?: KekDecryptFn,
): KekProvider {
  const plane = deployPlaneRaw(env);
  const wrapped = env.VAULT_KEK_WRAPPED?.trim() ?? "";
  const keyId = env.VAULT_KMS_KEY_ID?.trim() ?? "";
  if (plane && wrapped && keyId) {
    const app = env.FLY_APP_NAME?.trim() ?? "";
    if (!app) throw new Error("KMS unwrap requires FLY_APP_NAME");
    return new KmsKekProvider(
      wrapped,
      kekEncryptionContext({ plane, app }),
      decryptFn ?? awsKmsDecrypt(keyId),
    );
  }
  return new LocalKekProvider(env.VAULT_KEK ?? "");
}

/**
 * The KEK a rotation is moving away from, accepted at boot so envelopes still wrapped under it
 * open (and are re-wrapped under the current KEK in place). `VAULT_KEK_PREVIOUS_WRAPPED` with
 * `VAULT_KMS_KEY_ID` on a plane, else raw `VAULT_KEK_PREVIOUS`; undefined when neither is set.
 */
export function selectPreviousKekProvider(
  env: NodeJS.ProcessEnv,
  decryptFn?: KekDecryptFn,
): KekProvider | undefined {
  const plane = deployPlaneRaw(env);
  const wrapped = env.VAULT_KEK_PREVIOUS_WRAPPED?.trim() ?? "";
  const keyId = env.VAULT_KMS_KEY_ID?.trim() ?? "";
  if (plane && wrapped && keyId) {
    const app = env.FLY_APP_NAME?.trim() ?? "";
    if (!app) throw new Error("KMS unwrap requires FLY_APP_NAME");
    return new KmsKekProvider(wrapped, kekEncryptionContext({ plane, app }), decryptFn ?? awsKmsDecrypt(keyId));
  }
  const raw = env.VAULT_KEK_PREVIOUS?.trim() ?? "";
  return raw ? new LocalKekProvider(raw) : undefined;
}

export function isTransientKmsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof rec.name === "string" ? rec.name : "";
  if (name === "ThrottlingException" || name === "ServiceUnavailableException") return true;
  const status = rec.$metadata?.httpStatusCode;
  return typeof status === "number" && status >= 500;
}

export async function decryptWithOneRetry(
  send: () => Promise<Buffer>,
  sleepMs: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Buffer> {
  try {
    return await send();
  } catch (err) {
    if (!isTransientKmsError(err)) throw err;
    await sleepMs(1000);
    return await send();
  }
}

export function awsKmsDecrypt(keyId: string): KekDecryptFn {
  const client = new KMSClient({});
  return async (cipher, context) => {
    const send = async (): Promise<Buffer> => {
      const out = await client.send(
        new DecryptCommand({
          CiphertextBlob: cipher,
          KeyId: keyId,
          EncryptionContext: {
            purpose: context.purpose,
            plane: context.plane,
            app: context.app,
          },
        }),
      );
      if (!out.Plaintext) throw new Error("KMS Decrypt returned empty plaintext");
      return Buffer.from(out.Plaintext);
    };
    return decryptWithOneRetry(send);
  };
}

export function awsKmsEncrypt(keyId: string): KekEncryptFn {
  const client = new KMSClient({});
  return async (plain, context) => {
    const out = await client.send(
      new EncryptCommand({
        KeyId: keyId,
        Plaintext: plain,
        EncryptionContext: {
          purpose: context.purpose,
          plane: context.plane,
          app: context.app,
        },
      }),
    );
    if (!out.CiphertextBlob) throw new Error("KMS Encrypt returned empty ciphertext");
    return Buffer.from(out.CiphertextBlob);
  };
}
