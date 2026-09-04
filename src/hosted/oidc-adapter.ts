import type { OidcPayloadRow, VaultStore } from "../store/types.ts";

type Payload = Record<string, unknown>;

/**
 * Adapter kinds that belong to a (client, account) consent. JWT access tokens are
 * never stored, so revoking a vault client means dropping these rows.
 */
const CLIENT_OWNED_OIDC_KINDS = [
  "RefreshToken",
  "AuthorizationCode",
  "DeviceCode",
  "AccessToken",
  "Grant",
] as const;

/**
 * Destroy adapter rows owned by this vault client for the account that consented to it.
 * Two orgs can share one DCR client id, so the account scope is what keeps org A's
 * revoke from killing org B's refresh tokens. A client with no recorded consenting
 * account only loses rows that carry no account either.
 */
export async function destroyOidcPayloadsForClient(
  store: VaultStore,
  client: {
    id: string;
    oauthClientId: string | null;
    clerkOauthUserId: string | null;
    consentedByUserId: string | null;
  },
): Promise<void> {
  const ids = [client.id, client.oauthClientId, client.clerkOauthUserId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  for (const kind of CLIENT_OWNED_OIDC_KINDS) {
    await store.deleteOidcPayloadsForClient(kind, ids, client.consentedByUserId);
  }
}

/** Drops every expired adapter row. Returns how many were removed. Call from a periodic sweep. */
export async function purgeExpired(store: VaultStore, now: Date = new Date()): Promise<number> {
  return store.purgeExpiredOidcPayloads(now.toISOString());
}

function parsePayload(raw: string): Payload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as Payload;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * oidc-provider adapter backed by `oidc_payloads`.
 * Secondary lookups (uid, user code, grant id) hit indexed columns the store derives
 * from the payload on upsert. JWT access tokens are not stored here; revoke them via
 * clients.revoked_at + the jti denylist.
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
      return this.#live({ id, ...row });
    }

    async findByUserCode(userCode: string): Promise<Payload | undefined> {
      const row = await store.findOidcPayloadByUserCode(this.#kind, userCode);
      return row ? this.#live(row) : undefined;
    }

    async findByUid(uid: string): Promise<Payload | undefined> {
      const row = await store.findOidcPayloadByUid(this.#kind, uid);
      return row ? this.#live(row) : undefined;
    }

    async destroy(id: string): Promise<void> {
      await store.deleteOidcPayload(id, this.#kind);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await store.deleteOidcPayloadsByGrantId(this.#kind, grantId);
    }

    /** Marks the row consumed without extending its life: the original expiry is kept. */
    async consume(id: string): Promise<void> {
      const row = await store.getOidcPayload(id, this.#kind);
      if (!row) return;
      const payload = parsePayload(row.payload);
      payload.consumed = epochSeconds();
      await store.upsertOidcPayload({
        id,
        kind: this.#kind,
        payload: JSON.stringify(payload),
        expiresAt: row.expiresAt,
      });
    }

    /** Returns the payload unless the row has expired, in which case the row is deleted. */
    async #live(row: OidcPayloadRow): Promise<Payload | undefined> {
      if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
        await store.deleteOidcPayload(row.id, this.#kind);
        return undefined;
      }
      return parsePayload(row.payload);
    }
  };
}
