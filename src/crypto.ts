import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;

export type Envelope = {
  iv: string;
  ciphertext: string;
  tag: string;
};

export function generateMasterKey(): string {
  return randomBytes(KEY_LEN).toString("hex");
}

export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const asB64 = Buffer.from(trimmed, "base64");
  if (asB64.length === KEY_LEN) {
    return asB64;
  }
  throw new Error(
    "VAULT_MASTER_KEY must be 32 bytes encoded as 64 hex characters or base64. Run `vault init`.",
  );
}

export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function encrypt(plaintext: string, key: Buffer): Envelope {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decrypt(envelope: Envelope, key: Buffer): string {
  const decipher = createDecipheriv(
    ALGO,
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
