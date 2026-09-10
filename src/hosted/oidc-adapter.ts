import { errors as oidcErrors } from "oidc-provider";
import type { OidcPayloadRow, VaultStore } from "../store/types.ts";
import { hashesOidcId } from "./oidc-directory.ts";
import type { OidcDirectory } from "./oidc-directory.ts";
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
 * sweep for the recorded consenting account then removes only rows that carry no grant id:
 * a grant-bound row belongs to its Grant, and the consenter's grants for the same client id
 * in other orgs (and their tokens) must survive. Without an org scope the legacy account
 * sweep runs over every kind; a client with no recorded consenting account only loses rows
 * that carry no account.
 */
export async function destroyOidcPayloadsForClient(
  store: VaultStore,
  directory: OidcDirectory,
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
      const opened = await directory.unwrap("Grant", row.id, row.payload);
      const payload = opened?.body ?? parsePayload(row.payload);
      const org = grantOrg(payload);
      const account = typeof payload.accountId === "string" ? payload.accountId : undefined;
      const owned = org ? org === scope.orgId : account !== undefined && members.has(account);
      if (!owned) continue;
      for (const kind of GRANT_BOUND_OIDC_KINDS) {
        await store.deleteOidcPayloadsByGrantId(kind, row.id);
      }
      await store.deleteOidcPayload(row.id, "Grant");
    }
    // Grants were handled by org above; the account sweep must not reach a Grant row (its
    // grant_id is null) or any token under one, so only the grant-bound kinds are visited
    // and only their grantless rows go.
    for (const kind of GRANT_BOUND_OIDC_KINDS) {
      await store.deleteOidcPayloadsForClient(kind, ids, client.consentedByUserId, true);
    }
    return;
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
 * Bearer kinds store HMAC ids and wrap `{ id, body }`. Grant id stays plaintext.
 * Secondary lookups (uid, user code, grant id) hit indexed columns the adapter
 * computes from plaintext before wrap.
 */
export function createStoreAdapter(store: VaultStore, directory: OidcDirectory) {
  return class StoreAdapter {
    readonly #kind: string;
    constructor(kind: string) {
      this.#kind = kind;
    }

    async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
      const expiresAt =
        typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
      const packed = await directory.wrap(this.#kind, id, payload);
      const index = await directory.indexFromPlaintext(payload);
      await store.upsertOidcPayload({
        id: packed.storedId,
        kind: this.#kind,
        payload: packed.payload,
        expiresAt,
        index,
      });
    }

    async find(id: string): Promise<Payload | undefined> {
      const storedId = await directory.storedId(this.#kind, id);
      let row = await store.getOidcPayload(storedId, this.#kind);
      let rowId = storedId;
      if (!row && hashesOidcId(this.#kind)) {
        row = await store.getOidcPayload(id, this.#kind);
        rowId = id;
      }
      if (!row) return undefined;
      return this.#live({ id: rowId, ...row });
    }

    async findByUserCode(userCode: string): Promise<Payload | undefined> {
      const hashed = await directory.storedUserCode(userCode);
      const row =
        (await store.findOidcPayloadByUserCode(this.#kind, hashed)) ??
        (await store.findOidcPayloadByUserCode(this.#kind, userCode));
      return row ? this.#live(row) : undefined;
    }

    async findByUid(uid: string): Promise<Payload | undefined> {
      const hashed = await directory.storedUid(uid);
      const row =
        (await store.findOidcPayloadByUid(this.#kind, hashed)) ?? (await store.findOidcPayloadByUid(this.#kind, uid));
      return row ? this.#live(row) : undefined;
    }

    async destroy(id: string): Promise<void> {
      const storedId = await directory.storedId(this.#kind, id);
      await store.deleteOidcPayload(storedId, this.#kind);
      if (hashesOidcId(this.#kind) && storedId !== id) {
        await store.deleteOidcPayload(id, this.#kind);
      }
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
      const storedId = await directory.storedId(this.#kind, id);
      let consumed = await store.consumeOidcPayload(storedId, this.#kind, epochSeconds());
      if (!consumed && hashesOidcId(this.#kind) && storedId !== id) {
        consumed = await store.consumeOidcPayload(id, this.#kind, epochSeconds());
      }
      if (!consumed) throw new oidcErrors.InvalidGrant("grant source already consumed");
    }

    /** Returns the payload body unless the row has expired, in which case the row is deleted. */
    async #live(row: OidcPayloadRow): Promise<Payload | undefined> {
      if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
        await store.deleteOidcPayload(row.id, this.#kind);
        return undefined;
      }
      const opened = await directory.unwrap(this.#kind, row.id, row.payload);
      if (!opened) return undefined;
      const body: Payload = { ...opened.body };
      if (row.consumedAt != null) body.consumed = row.consumedAt;
      return body;
    }
  };
}
