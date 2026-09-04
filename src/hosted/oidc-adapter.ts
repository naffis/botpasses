import { errors as oidcErrors } from "oidc-provider";
import type { OidcPayloadRow, VaultStore } from "../store/types.ts";
import { orgFromGrantResources } from "./oauth-clients.ts";

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

/** Kinds that carry a `grantId` and die with their grant. */
const GRANT_BOUND_OIDC_KINDS = ["RefreshToken", "AuthorizationCode", "DeviceCode", "AccessToken"] as const;

type RevokedClientScope = {
  /** The org whose vault client is being revoked. */
  orgId: string;
  /** Members of that org: legacy grants (no org marker) are matched by account. */
  memberUserIds: readonly string[];
};

function grantOrg(payload: Payload): string | undefined {
  const resources = payload.resources;
  if (!resources || typeof resources !== "object") return undefined;
  return orgFromGrantResources(resources as Record<string, unknown>);
}

/**
 * Destroy adapter rows owned by this vault client for the org that revoked it.
 *
 * Two orgs can share one DCR client id, so rows are matched by the org bound into the
 * Grant at consent (`org:<id>` resource scope); every token under such a grant goes with
 * it, whichever org member consented. Grants written before the org marker existed are
 * matched by account: any org member's grant for this client id. The account-scoped
 * sweep for the recorded consenting account (rows with no grant id) is kept as before;
 * a client with no recorded consenting account only loses rows that carry no account.
 */
export async function destroyOidcPayloadsForClient(
  store: VaultStore,
  client: {
    id: string;
    oauthClientId: string | null;
    clerkOauthUserId: string | null;
    consentedByUserId: string | null;
  },
  scope?: RevokedClientScope,
): Promise<void> {
  const ids = [client.id, client.oauthClientId, client.clerkOauthUserId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (scope) {
    const members = new Set<string>(scope.memberUserIds);
    if (client.consentedByUserId) members.add(client.consentedByUserId);
    const grants = await store.listOidcPayloadsForClient("Grant", ids);
    for (const row of grants) {
      const payload = parsePayload(row.payload);
      const org = grantOrg(payload);
      const account = typeof payload.accountId === "string" ? payload.accountId : undefined;
      const owned = org ? org === scope.orgId : account !== undefined && members.has(account);
      if (!owned) continue;
      for (const kind of GRANT_BOUND_OIDC_KINDS) {
        await store.deleteOidcPayloadsByGrantId(kind, row.id);
      }
      await store.deleteOidcPayload(row.id, "Grant");
    }
  }
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

    /**
     * Marks the row consumed without extending its life: the original expiry is kept.
     * The stamp is one conditional UPDATE, so of two concurrent exchanges of the same
     * code exactly one wins; the loser (and a row that is already gone) fails the grant.
     */
    async consume(id: string): Promise<void> {
      const consumed = await store.consumeOidcPayload(id, this.#kind, epochSeconds());
      if (!consumed) throw new oidcErrors.InvalidGrant("grant source already consumed");
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
