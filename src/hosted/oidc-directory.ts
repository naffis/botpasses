import { createHmac, hkdfSync } from "node:crypto";
import { decrypt, encrypt } from "../crypto.ts";
import { oidcPayloadIndex, type OidcPayloadIndex, type VaultStore } from "../store/types.ts";
import type { IdentityKeyring } from "./identity-keys.ts";
import { logVaultEvent } from "./observe.ts";

export const OIDC_LOOKUP_INFO = "botpasses/oidc-lookup/v1";

export const HMAC_ID_KINDS = [
  "RefreshToken",
  "AuthorizationCode",
  "DeviceCode",
  "AccessToken",
  "Session",
  "Interaction",
] as const;

export type HmacIdKind = (typeof HMAC_ID_KINDS)[number];

export function hashesOidcId(kind: string): kind is HmacIdKind {
  return (HMAC_ID_KINDS as readonly string[]).includes(kind);
}

export function isLegacyOidcId(id: string): boolean {
  return !/^[0-9a-f]{64}$/.test(id);
}

function lookupKey(dek: Buffer, message: string): string {
  const key = Buffer.from(hkdfSync("sha256", dek, "", OIDC_LOOKUP_INFO, 32));
  return createHmac("sha256", key).update(message).digest("hex");
}

export function oidcLookupKey(dek: Buffer, kind: string, token: string): string {
  return lookupKey(dek, `oidc:${kind}:${token}`);
}

export function userCodeLookupKey(dek: Buffer, code: string): string {
  return lookupKey(dek, `oidc-user-code:${code}`);
}

export function uidLookupKey(dek: Buffer, uid: string): string {
  return lookupKey(dek, `oidc-uid:${uid}`);
}

export type OidcEnvelopeBody = { id: string; body: Record<string, unknown> };

type EnvelopeJson = { v: 1; iv: string; ciphertext: string; tag: string };

export function isOidcEnvelopePayload(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    const rec = parsed as Record<string, unknown>;
    return rec.v === 1 && typeof rec.iv === "string" && typeof rec.ciphertext === "string" && typeof rec.tag === "string";
  } catch {
    return false;
  }
}

export class OidcDirectory {
  readonly #keys: IdentityKeyring;
  readonly #store: VaultStore;

  constructor(keys: IdentityKeyring, store: VaultStore) {
    this.#keys = keys;
    this.#store = store;
  }

  async storedId(kind: string, presented: string): Promise<string> {
    if (!hashesOidcId(kind)) return presented;
    return oidcLookupKey(await this.#keys.dek(), kind, presented);
  }

  async storedUserCode(code: string): Promise<string> {
    return userCodeLookupKey(await this.#keys.dek(), code);
  }

  async storedUid(uid: string): Promise<string> {
    return uidLookupKey(await this.#keys.dek(), uid);
  }

  async indexFromPlaintext(payload: Record<string, unknown>): Promise<OidcPayloadIndex> {
    const idx = oidcPayloadIndex(JSON.stringify(payload));
    const dek = await this.#keys.dek();
    return {
      uid: idx.uid ? uidLookupKey(dek, idx.uid) : null,
      userCode: idx.userCode ? userCodeLookupKey(dek, idx.userCode) : null,
      grantId: idx.grantId,
      clientId: idx.clientId,
      accountId: idx.accountId,
    };
  }

  async wrap(kind: string, presentedId: string, body: Record<string, unknown>): Promise<{ storedId: string; payload: string }> {
    const storedId = await this.storedId(kind, presentedId);
    const dek = await this.#keys.dek();
    const inner = JSON.stringify({ id: presentedId, body } satisfies OidcEnvelopeBody);
    const env = encrypt(inner, dek, `oidc:${kind}:${storedId}`);
    const envelope: EnvelopeJson = { v: 1, iv: env.iv, ciphertext: env.ciphertext, tag: env.tag };
    return { storedId, payload: JSON.stringify(envelope) };
  }

  async unwrap(kind: string, storedId: string, payload: string): Promise<OidcEnvelopeBody | undefined> {
    if (!isOidcEnvelopePayload(payload)) {
      try {
        const parsed: unknown = JSON.parse(payload);
        if (parsed && typeof parsed === "object") {
          return { id: storedId, body: parsed as Record<string, unknown> };
        }
      } catch {
        return undefined;
      }
      return undefined;
    }
    const rec = JSON.parse(payload) as EnvelopeJson;
    try {
      const dek = await this.#keys.dek();
      const opened = decrypt(
        { iv: rec.iv, ciphertext: rec.ciphertext, tag: rec.tag },
        dek,
        `oidc:${kind}:${storedId}`,
      );
      const inner: unknown = JSON.parse(opened);
      if (!inner || typeof inner !== "object") return undefined;
      const pack = inner as { id?: unknown; body?: unknown };
      if (typeof pack.id !== "string" || !pack.body || typeof pack.body !== "object") return undefined;
      return { id: pack.id, body: pack.body as Record<string, unknown> };
    } catch {
      logVaultEvent("oidc_unwrap_failed", { kind });
      return undefined;
    }
  }

  async rebind(shouldStop: () => boolean): Promise<{ rebound: number }> {
    let rebound = 0;
    for (const row of await this.#store.listAllOidcPayloads()) {
      if (shouldStop()) break;
      const enveloped = isOidcEnvelopePayload(row.payload);
      const idDone = !hashesOidcId(row.kind) || !isLegacyOidcId(row.id);
      if (enveloped && idDone) continue;
      const opened = await this.unwrap(row.kind, row.id, row.payload);
      if (!opened) continue;
      const packed = await this.wrap(row.kind, opened.id, opened.body);
      const index = await this.indexFromPlaintext(opened.body);
      if (hashesOidcId(row.kind) && isLegacyOidcId(row.id)) {
        await this.#store.replaceOidcPayloadId(row.kind, row.id, {
          id: packed.storedId,
          payload: packed.payload,
          expiresAt: row.expiresAt,
          index,
        });
      } else {
        await this.#store.upsertOidcPayload({
          id: packed.storedId,
          kind: row.kind,
          payload: packed.payload,
          expiresAt: row.expiresAt,
          index,
        });
      }
      rebound += 1;
    }
    return { rebound };
  }

  async restorePlaintext(shouldStop: () => boolean): Promise<{ restored: number }> {
    let restored = 0;
    for (const row of await this.#store.listAllOidcPayloads()) {
      if (shouldStop()) break;
      if (!isOidcEnvelopePayload(row.payload)) continue;
      const opened = await this.unwrap(row.kind, row.id, row.payload);
      if (!opened) continue;
      const idx = oidcPayloadIndex(JSON.stringify(opened.body));
      if (hashesOidcId(row.kind) && row.id !== opened.id) {
        await this.#store.replaceOidcPayloadId(row.kind, row.id, {
          id: opened.id,
          payload: JSON.stringify(opened.body),
          expiresAt: row.expiresAt,
          index: idx,
        });
      } else {
        await this.#store.upsertOidcPayload({
          id: opened.id,
          kind: row.kind,
          payload: JSON.stringify(opened.body),
          expiresAt: row.expiresAt,
          index: idx,
        });
      }
      restored += 1;
    }
    return { restored };
  }
}
