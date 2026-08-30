import { randomBytes } from "node:crypto";
import { decrypt, encrypt, parseMasterKey, type Envelope } from "../crypto.ts";

export function parseKek(raw: string): Buffer {
  return parseMasterKey(raw);
}

export function generateDek(): Buffer {
  return randomBytes(32);
}

export function wrapDek(dek: Buffer, kek: Buffer, orgId: string): Envelope {
  return encrypt(dek.toString("hex"), kek, orgId);
}

export function unwrapDek(envelope: Envelope, kek: Buffer, orgId: string): Buffer {
  const hex = decrypt(envelope, kek, orgId);
  return Buffer.from(hex, "hex");
}
