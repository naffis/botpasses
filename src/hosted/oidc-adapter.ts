import type { VaultStore } from "../store/types.ts";

type Payload = Record<string, unknown>;

export function oidcPayloadClientId(raw: string): string | undefined {
  try {
    const payload = parsePayload(raw);
    return typeof payload.clientId === "string" ? payload.clientId : undefined;
  } catch {
    return undefined;
  }
}

const CLIENT_OWNED_OIDC_KINDS = [
  "RefreshToken",
  "AuthorizationCode",
  "DeviceCode",
  "AccessToken",
  "Grant",
] as const;

export function oidcPayloadOwnedByClient(
  raw: string,
  client: { id: string; oauthClientId: string | null; clerkOauthUserId: string | null },
): boolean {
  const payloadClientId = oidcPayloadClientId(raw);
  if (!payloadClientId) return false;
  return (
    payloadClientId === client.id ||
    payloadClientId === client.oauthClientId ||
    payloadClientId === client.clerkOauthUserId
  );
}

/** Destroy adapter rows owned by this vault client. JWT access tokens are not stored here. */
export async function destroyOidcPayloadsForClient(
  store: VaultStore,
  client: { id: string; oauthClientId: string | null; clerkOauthUserId: string | null },
): Promise<void> {
  for (const kind of CLIENT_OWNED_OIDC_KINDS) {
    const rows = await store.listOidcPayloads(kind);
    for (const row of rows) {
      if (oidcPayloadOwnedByClient(row.payload, client)) {
        await store.deleteOidcPayload(row.id, kind);
      }
    }
  }
}

function parsePayload(raw: string): Payload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Payload;
}

/**
 * oidc-provider adapter backed by `oidc_payloads`.
 * JWT access tokens are not stored here; revoke them via clients.revoked_at + jti denylist.
 */
export function createStoreAdapter(store: VaultStore) {
  return class StoreAdapter {
    readonly #kind: string;
    constructor(kind: string) {
      this.#kind = kind;
    }

    async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
      const expiresAt =
        typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
      await store.upsertOidcPayload({
        id,
        kind: this.#kind,
        payload: JSON.stringify(payload),
        expiresAt,
      });
    }

    async find(id: string): Promise<Payload | undefined> {
      const row = await store.getOidcPayload(id, this.#kind);
      if (!row) return undefined;
      if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
        await store.deleteOidcPayload(id, this.#kind);
        return undefined;
      }
      return parsePayload(row.payload);
    }

    async findByUserCode(userCode: string): Promise<Payload | undefined> {
      return this.#findBy("userCode", userCode);
    }

    async findByUid(uid: string): Promise<Payload | undefined> {
      return this.#findBy("uid", uid);
    }

    async destroy(id: string): Promise<void> {
      await store.deleteOidcPayload(id, this.#kind);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      const rows = await store.listOidcPayloads(this.#kind);
      for (const row of rows) {
        const payload = parsePayload(row.payload);
        if (payload.grantId === grantId) {
          await store.deleteOidcPayload(row.id, this.#kind);
        }
      }
    }

    async consume(id: string): Promise<void> {
      const found = await this.find(id);
      if (!found) return;
      found.consumed = true;
      await this.upsert(id, found);
    }

    async #findBy(field: string, value: string): Promise<Payload | undefined> {
      const rows = await store.listOidcPayloads(this.#kind);
      for (const row of rows) {
        const payload = parsePayload(row.payload);
        if (payload[field] === value) return payload;
      }
      return undefined;
    }
  };
}
