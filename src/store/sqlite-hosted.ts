import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AccessEventRecord,
  ApprovalChallengeRecord,
  ClientRecord,
  EmailOtpRecord,
  EnvironmentRecord,
  FolderRecord,
  HostedAuditRecord,
  HostedGrantRecord,
  ItemRecord,
  MemberRecord,
  NeedItemRecord,
  OrgRecord,
  PersistFulfillInput,
  PolicyRecord,
  UserRecord,
  VaultEnvName,
  VaultRecord,
} from "../hosted-types.ts";
import { isUniqueViolation, StoreConflictError } from "./conflict.ts";
import {
  HOSTED_SCHEMA_IDENTITY,
  HOSTED_SCHEMA_IDENTITY_ALTER_SQLITE,
  HOSTED_SCHEMA_IDENTITY_ALTER2_SQLITE,
  HOSTED_SCHEMA_IDENTITY_INDEXES,
  HOSTED_SCHEMA_OAUTH_ALTER_SQLITE,
  HOSTED_SCHEMA_SCOPE_ALTER_SQLITE,
  HOSTED_SCHEMA_SQLITE,
  HOSTED_SCHEMA_TEAM,
  HOSTED_SCHEMA_TEAM_ALTER_SQLITE,
  HOSTED_SCHEMA_V10_ALTER_SQLITE,
  HOSTED_SCHEMA_V10_INDEXES,
} from "./schema.ts";
import { mapClientRow } from "./map-client.ts";
import {
  GRANT_INSERT_COLUMNS,
  grantValues,
  ITEM_AAD_VERSION,
  ITEM_INSERT_COLUMNS,
  itemValues,
  mapAccess,
  mapChallenge,
  mapEnv,
  mapFolder,
  mapGrant,
  mapIdentityKey,
  mapInvite,
  mapItem,
  mapMember,
  mapMemberRecord,
  mapNeed,
  mapOidcRow,
  mapOrg,
  mapOtp,
  mapPolicy,
  mapSess,
  mapUser,
  mapVault,
  NEED_INSERT_COLUMNS,
  needValues,
  placeholders,
} from "./rows.ts";
import {
  oidcPayloadIndex,
  requestedScopeJson,
  scopeListJson,
  type AuditListFilter,
  type IdentityKeyRecord,
  type InviteRecord,
  type LegacyAadItem,
  type MemberRow,
  type OidcPayloadRow,
  type OperatorSessionRow,
  type RateHitKind,
  type SweepCounts,
  type UserRow,
  type UserSecurityState,
  type VaultStore,
} from "./types.ts";

const GRANT_INSERT_SQL = `INSERT INTO grants (${GRANT_INSERT_COLUMNS}) VALUES (${placeholders(20, "sqlite")})`;
const TERMINAL_GRANT_STATUSES = "('revoked', 'consumed', 'expired')";

/** Column additions shipped after the base schema; "duplicate column" means the database has them. */
const SQLITE_ALTERS = [
  HOSTED_SCHEMA_IDENTITY_ALTER_SQLITE,
  HOSTED_SCHEMA_OAUTH_ALTER_SQLITE,
  HOSTED_SCHEMA_SCOPE_ALTER_SQLITE,
  HOSTED_SCHEMA_IDENTITY_ALTER2_SQLITE,
  HOSTED_SCHEMA_TEAM_ALTER_SQLITE,
  HOSTED_SCHEMA_V10_ALTER_SQLITE,
];

export function openHostedSqlite(path: string): SqliteHostedStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(HOSTED_SCHEMA_SQLITE);
  db.exec(HOSTED_SCHEMA_IDENTITY);
  // clients_org_oauth shipped once as a plain index; CREATE UNIQUE ... IF NOT EXISTS would keep it.
  const orgOauthIndex = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'clients_org_oauth'")
    .get() as { sql: string | null } | undefined;
  if (orgOauthIndex && !/UNIQUE/i.test(orgOauthIndex.sql ?? "")) {
    db.exec("DROP INDEX clients_org_oauth");
  }
  for (const alter of SQLITE_ALTERS) {
    for (const stmt of alter.trim().split(";")) {
      const sql = stmt.trim();
      if (!sql) continue;
      try {
        db.exec(sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column")) throw err;
      }
    }
  }
  db.exec(HOSTED_SCHEMA_IDENTITY_INDEXES);
  db.exec(HOSTED_SCHEMA_TEAM);
  db.exec(HOSTED_SCHEMA_V10_INDEXES);
  return new SqliteHostedStore(db);
}

export class SqliteHostedStore implements VaultStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  async ping(): Promise<void> {
    this.#db.exec("SELECT 1");
  }

  async close(): Promise<void> {
    this.#db.close();
  }

  async insertOrg(row: OrgRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO orgs (id, name, wrapped_dek_iv, wrapped_dek_ciphertext, wrapped_dek_tag, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.wrappedDekIv,
        row.wrappedDekCiphertext,
        row.wrappedDekTag,
        row.createdAt,
        row.createdBy,
      );
  }

  async listOrgs(): Promise<OrgRecord[]> {
    const rows = this.#db.prepare("SELECT * FROM orgs").all() as Record<string, unknown>[];
    return rows.map(mapOrg);
  }

  async listOrgsCreatedBy(userId: string): Promise<OrgRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM orgs WHERE created_by = ? ORDER BY created_at, id")
      .all(userId) as Record<string, unknown>[];
    return rows.map(mapOrg);
  }

  async updateOrgWrappedDek(
    id: string,
    patch: Pick<OrgRecord, "wrappedDekIv" | "wrappedDekCiphertext" | "wrappedDekTag">,
  ): Promise<void> {
    this.#db
      .prepare(
        `UPDATE orgs SET wrapped_dek_iv = ?, wrapped_dek_ciphertext = ?, wrapped_dek_tag = ? WHERE id = ?`,
      )
      .run(patch.wrappedDekIv, patch.wrappedDekCiphertext, patch.wrappedDekTag, id);
  }

  async getOrg(id: string): Promise<OrgRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapOrg(r) : undefined;
  }

  async deleteOrg(orgId: string): Promise<void> {
    this.#db.exec("BEGIN");
    try {
      this.#db
        .prepare(
          `DELETE FROM oidc_payloads WHERE account_id IN (
            SELECT user_id FROM org_members WHERE org_id = ?
          ) AND (
            client_id IN (SELECT id FROM clients WHERE org_id = ?)
            OR (client_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM org_members m2 WHERE m2.user_id = oidc_payloads.account_id AND m2.org_id <> ?
            ))
          )`,
        )
        .run(orgId, orgId, orgId);
      this.#db.prepare("DELETE FROM access_events WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM rate_hits WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM need_items WHERE org_id = ?").run(orgId);
      this.#db
        .prepare(
          "DELETE FROM approval_challenges WHERE grant_id IN (SELECT id FROM grants WHERE org_id = ?)",
        )
        .run(orgId);
      this.#db.prepare("DELETE FROM grants WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM policies WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM clients WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM audit WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM agentpass_passes WHERE org_id = ?").run(orgId);
      this.#db
        .prepare(
          `DELETE FROM items WHERE environment_id IN (
            SELECT e.id FROM environments e JOIN vaults v ON v.id = e.vault_id WHERE v.org_id = ?
          )`,
        )
        .run(orgId);
      this.#db
        .prepare(
          `DELETE FROM folders WHERE environment_id IN (
            SELECT e.id FROM environments e JOIN vaults v ON v.id = e.vault_id WHERE v.org_id = ?
          )`,
        )
        .run(orgId);
      this.#db
        .prepare(
          `DELETE FROM environments WHERE vault_id IN (SELECT id FROM vaults WHERE org_id = ?)`,
        )
        .run(orgId);
      this.#db.prepare("DELETE FROM vaults WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM org_invites WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM org_members WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM orgs WHERE id = ?").run(orgId);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  async insertMember(row: MemberRecord & { joinedAt?: string }): Promise<void> {
    this.#db
      .prepare("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)")
      .run(row.orgId, row.userId, row.role, row.joinedAt ?? null);
  }

  async getMember(orgId: string, userId: string): Promise<MemberRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM org_members WHERE org_id = ? AND user_id = ?")
      .get(orgId, userId) as Record<string, unknown> | undefined;
    return r ? mapMemberRecord(r) : undefined;
  }

  async insertVault(row: VaultRecord): Promise<void> {
    this.#db.prepare("INSERT INTO vaults (id, org_id, name) VALUES (?, ?, ?)").run(row.id, row.orgId, row.name);
  }

  async listVaults(orgId: string): Promise<VaultRecord[]> {
    const rows = this.#db.prepare("SELECT * FROM vaults WHERE org_id = ?").all(orgId) as Record<
      string,
      unknown
    >[];
    return rows.map(mapVault);
  }

  async insertEnvironment(row: EnvironmentRecord): Promise<void> {
    this.#db
      .prepare("INSERT INTO environments (id, vault_id, name) VALUES (?, ?, ?)")
      .run(row.id, row.vaultId, row.name);
  }

  async getEnvironment(id: string): Promise<EnvironmentRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapEnv(r) : undefined;
  }

  async getEnvironmentByName(
    vaultId: string,
    name: string,
  ): Promise<EnvironmentRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM environments WHERE vault_id = ? AND name = ?")
      .get(vaultId, name) as Record<string, unknown> | undefined;
    return r ? mapEnv(r) : undefined;
  }

  async listEnvironments(vaultId: string): Promise<EnvironmentRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM environments WHERE vault_id = ?")
      .all(vaultId) as Record<string, unknown>[];
    return rows.map(mapEnv);
  }

  async insertFolder(row: FolderRecord): Promise<void> {
    this.#db
      .prepare("INSERT INTO folders (id, environment_id, name) VALUES (?, ?, ?)")
      .run(row.id, row.environmentId, row.name);
  }

  async getFolder(id: string): Promise<FolderRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapFolder(r) : undefined;
  }

  async getFolderByName(environmentId: string, name: string): Promise<FolderRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM folders WHERE environment_id = ? AND name = ?")
      .get(environmentId, name) as Record<string, unknown> | undefined;
    return r ? mapFolder(r) : undefined;
  }

  async insertItem(row: ItemRecord): Promise<void> {
    this.#db
      .prepare(`INSERT INTO items (${ITEM_INSERT_COLUMNS}) VALUES (${placeholders(15, "sqlite")})`)
      .run(...itemValues(row));
  }

  async updateItemEnvelope(
    id: string,
    patch: Pick<ItemRecord, "iv" | "ciphertext" | "tag" | "last4" | "updatedAt">,
  ): Promise<void> {
    this.#db
      .prepare(
        "UPDATE items SET iv = ?, ciphertext = ?, tag = ?, last4 = ?, updated_at = ?, aad_version = ? WHERE id = ?",
      )
      .run(patch.iv, patch.ciphertext, patch.tag, patch.last4, patch.updatedAt, ITEM_AAD_VERSION, id);
  }

  async updateItemEnvelopeAndMeta(
    id: string,
    patch: Pick<
      ItemRecord,
      | "iv"
      | "ciphertext"
      | "tag"
      | "last4"
      | "name"
      | "kind"
      | "environmentId"
      | "username"
      | "inject"
      | "allowedHostsJson"
      | "updatedAt"
    >,
  ): Promise<void> {
    this.#db
      .prepare(
        `UPDATE items SET iv = ?, ciphertext = ?, tag = ?, last4 = ?, name = ?, kind = ?, environment_id = ?,
         username = ?, inject = ?, allowed_hosts_json = ?, updated_at = ?, aad_version = ? WHERE id = ?`,
      )
      .run(
        patch.iv,
        patch.ciphertext,
        patch.tag,
        patch.last4,
        patch.name,
        patch.kind,
        patch.environmentId,
        patch.username,
        patch.inject,
        patch.allowedHostsJson,
        patch.updatedAt,
        ITEM_AAD_VERSION,
        id,
      );
  }

  async listItemsWithLegacyAad(): Promise<LegacyAadItem[]> {
    const rows = this.#db
      .prepare(
        `SELECT i.*, v.org_id AS org_id FROM items i
         JOIN environments e ON e.id = i.environment_id
         JOIN vaults v ON v.id = e.vault_id
         WHERE i.aad_version < ? ORDER BY v.org_id, i.id`,
      )
      .all(ITEM_AAD_VERSION) as Record<string, unknown>[];
    return rows.map((r) => ({ item: mapItem(r), orgId: String(r.org_id) }));
  }

  async setItemAadVersion(id: string, version: number): Promise<void> {
    this.#db.prepare("UPDATE items SET aad_version = ? WHERE id = ?").run(version, id);
  }

  async updateItemMeta(
    id: string,
    patch: Pick<
      ItemRecord,
      "name" | "kind" | "environmentId" | "username" | "inject" | "allowedHostsJson" | "updatedAt"
    >,
  ): Promise<void> {
    this.#db
      .prepare(
        "UPDATE items SET name = ?, kind = ?, environment_id = ?, username = ?, inject = ?, allowed_hosts_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.name,
        patch.kind,
        patch.environmentId,
        patch.username,
        patch.inject,
        patch.allowedHostsJson,
        patch.updatedAt,
        id,
      );
  }

  async deleteItem(id: string): Promise<void> {
    this.#db.prepare("DELETE FROM items WHERE id = ?").run(id);
  }

  async getItem(id: string): Promise<ItemRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM items WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapItem(r) : undefined;
  }

  async getItemByName(environmentId: string, name: string): Promise<ItemRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM items WHERE environment_id = ? AND name = ?")
      .get(environmentId, name) as Record<string, unknown> | undefined;
    return r ? mapItem(r) : undefined;
  }

  async listItems(environmentId: string): Promise<ItemRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM items WHERE environment_id = ? ORDER BY name")
      .all(environmentId) as Record<string, unknown>[];
    return rows.map(mapItem);
  }

  async countProductionItems(orgId: string): Promise<number> {
    const r = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i
         JOIN environments e ON e.id = i.environment_id
         JOIN vaults v ON v.id = e.vault_id
         WHERE v.org_id = ? AND e.name = 'production'`,
      )
      .get(orgId) as { n: number };
    return Number(r.n);
  }

  async insertClient(row: ClientRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO clients (id, org_id, kind, name, hashed_secret, clerk_oauth_user_id, environment,
          oauth_client_id, revoked_at, last_token_at, last_seen_at, last4, consented_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.orgId,
        row.kind,
        row.name,
        row.hashedSecret,
        row.clerkOauthUserId,
        row.environment,
        row.oauthClientId,
        row.revokedAt,
        row.lastTokenAt,
        row.lastSeenAt,
        row.last4,
        row.consentedByUserId,
      );
  }

  async updateClientHashedSecret(id: string, hashedSecret: string, tokenLast4: string): Promise<void> {
    this.#db
      .prepare("UPDATE clients SET hashed_secret = ?, last4 = ? WHERE id = ?")
      .run(hashedSecret, tokenLast4, id);
  }

  async updateClientEnvironment(id: string, environment: VaultEnvName): Promise<void> {
    this.#db.prepare("UPDATE clients SET environment = ? WHERE id = ?").run(environment, id);
  }

  async incrementRateHit(orgId: string, kind: RateHitKind, windowStart: string): Promise<number> {
    this.#db
      .prepare(
        `INSERT INTO rate_hits (org_id, kind, window_start, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(org_id, kind, window_start) DO UPDATE SET count = count + 1`,
      )
      .run(orgId, kind, windowStart);
    const r = this.#db
      .prepare("SELECT count FROM rate_hits WHERE org_id = ? AND kind = ? AND window_start = ?")
      .get(orgId, kind, windowStart) as { count: number };
    return Number(r.count);
  }

  async countRateHits(orgId: string, kind: RateHitKind, windowStart: string): Promise<number> {
    const r = this.#db
      .prepare("SELECT count FROM rate_hits WHERE org_id = ? AND kind = ? AND window_start = ?")
      .get(orgId, kind, windowStart) as { count: number } | undefined;
    return r ? Number(r.count) : 0;
  }

  async getClient(id: string): Promise<ClientRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return mapClientRow(r);
  }

  async findClientByHashedSecret(hashedSecret: string): Promise<ClientRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM clients WHERE hashed_secret = ?")
      .get(hashedSecret) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return this.getClient(String(r.id));
  }

  async listClients(orgId: string): Promise<ClientRecord[]> {
    const rows = this.#db.prepare("SELECT id FROM clients WHERE org_id = ?").all(orgId) as {
      id: string;
    }[];
    const out: ClientRecord[] = [];
    for (const row of rows) {
      const c = await this.getClient(row.id);
      if (c) out.push(c);
    }
    return out;
  }

  async findClientByOauthId(oauthClientId: string): Promise<ClientRecord | undefined> {
    const r = this.#db
      .prepare(
        "SELECT id FROM clients WHERE oauth_client_id = ? OR clerk_oauth_user_id = ? LIMIT 1",
      )
      .get(oauthClientId, oauthClientId) as { id: string } | undefined;
    return r ? this.getClient(r.id) : undefined;
  }

  async insertPolicy(row: PolicyRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO policies (
          id, org_id, client_id, item_id, folder_id, environment_id, kind, created_at,
          methods, path_prefixes, hosts, max_calls, calls_used, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.orgId,
        row.clientId,
        row.itemId,
        row.folderId,
        row.environmentId,
        row.kind,
        row.createdAt,
        scopeListJson(row.methods),
        scopeListJson(row.pathPrefixes),
        scopeListJson(row.hosts),
        row.maxCalls,
        row.callsUsed,
        row.expiresAt,
      );
  }

  async recordPolicyCall(id: string): Promise<boolean> {
    const result = this.#db
      .prepare(
        "UPDATE policies SET calls_used = calls_used + 1 WHERE id = ? AND (max_calls IS NULL OR calls_used < max_calls)",
      )
      .run(id);
    return result.changes === 1;
  }

  async deletePolicy(id: string): Promise<void> {
    this.#db.prepare("DELETE FROM policies WHERE id = ?").run(id);
  }

  async findItemPolicy(
    orgId: string,
    clientId: string,
    itemId: string,
  ): Promise<PolicyRecord | undefined> {
    const r = this.#db
      .prepare(
        "SELECT * FROM policies WHERE org_id = ? AND client_id = ? AND item_id = ? AND kind = 'item_standing'",
      )
      .get(orgId, clientId, itemId) as Record<string, unknown> | undefined;
    return r ? mapPolicy(r) : undefined;
  }

  async findFolderPolicy(
    orgId: string,
    clientId: string,
    folderId: string | null,
    environmentId: string,
  ): Promise<PolicyRecord | undefined> {
    const r = this.#db
      .prepare(
        `SELECT * FROM policies WHERE org_id = ? AND client_id = ? AND environment_id = ?
         AND kind = 'folder_standing' AND ((folder_id IS NULL AND ? IS NULL) OR folder_id = ?)`,
      )
      .get(orgId, clientId, environmentId, folderId, folderId) as Record<string, unknown> | undefined;
    return r ? mapPolicy(r) : undefined;
  }

  async listPoliciesForClient(orgId: string, clientId: string): Promise<PolicyRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM policies WHERE org_id = ? AND client_id = ?")
      .all(orgId, clientId) as Record<string, unknown>[];
    return rows.map(mapPolicy);
  }

  async insertGrant(row: HostedGrantRecord): Promise<void> {
    this.#db.prepare(GRANT_INSERT_SQL).run(...grantValues(row));
  }

  async getGrant(id: string): Promise<HostedGrantRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapGrant(r) : undefined;
  }

  async listGrants(orgId: string): Promise<HostedGrantRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM grants WHERE org_id = ? ORDER BY created_at DESC")
      .all(orgId) as Record<string, unknown>[];
    return rows.map(mapGrant);
  }

  async listPendingGrants(orgId: string): Promise<HostedGrantRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM grants WHERE org_id = ? AND status = 'pending' ORDER BY created_at DESC")
      .all(orgId) as Record<string, unknown>[];
    return rows.map(mapGrant);
  }

  async listGrantsForPair(orgId: string, clientId: string, itemId: string): Promise<HostedGrantRecord[]> {
    const rows = this.#db
      .prepare(
        "SELECT * FROM grants WHERE client_id = ? AND item_id = ? AND org_id = ? ORDER BY created_at DESC",
      )
      .all(clientId, itemId, orgId) as Record<string, unknown>[];
    return rows.map(mapGrant);
  }

  async updateGrant(row: HostedGrantRecord): Promise<void> {
    this.#db
      .prepare(
        `UPDATE grants SET status = ?, policy = ?, expires_at = ?, approved_at = ?, consumed_at = ?,
         item_id = ?, folder_id = ?, task_id = ?, task_description = ?,
         methods = ?, path_prefixes = ?, hosts = ?, max_calls = ?, requested_scope_json = ? WHERE id = ?`,
      )
      .run(
        row.status,
        row.policy,
        row.expiresAt,
        row.approvedAt,
        row.consumedAt,
        row.itemId,
        row.folderId,
        row.taskId,
        row.taskDescription,
        scopeListJson(row.methods),
        scopeListJson(row.pathPrefixes),
        scopeListJson(row.hosts),
        row.maxCalls,
        requestedScopeJson(row.requestedScope),
        row.id,
      );
  }

  async recordGrantCall(id: string, at: string): Promise<boolean> {
    const result = this.#db
      .prepare(
        `UPDATE grants SET
           calls_used = calls_used + 1,
           status = CASE WHEN max_calls IS NOT NULL AND calls_used + 1 >= max_calls THEN 'consumed' ELSE status END,
           consumed_at = CASE WHEN max_calls IS NOT NULL AND calls_used + 1 >= max_calls THEN ? ELSE consumed_at END
         WHERE id = ? AND status = 'active' AND (max_calls IS NULL OR calls_used < max_calls)`,
      )
      .run(at, id);
    return result.changes === 1;
  }

  async consumeGrant(id: string, consumedAt: string): Promise<boolean> {
    const result = this.#db
      .prepare(
        "UPDATE grants SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'active'",
      )
      .run(consumedAt, id);
    return result.changes === 1;
  }

  async reactivateGrant(id: string): Promise<boolean> {
    const result = this.#db
      .prepare(
        "UPDATE grants SET status = 'active', consumed_at = NULL WHERE id = ? AND status = 'consumed' AND policy = 'prompt'",
      )
      .run(id);
    return result.changes === 1;
  }

  async insertChallenge(row: ApprovalChallengeRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO approval_challenges (id, grant_id, code_hash, expires_at, attempts, kind)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.grantId, row.codeHash, row.expiresAt, row.attempts, row.kind);
  }

  async getChallenge(id: string): Promise<ApprovalChallengeRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM approval_challenges WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapChallenge(r) : undefined;
  }

  async getChallengeByGrant(grantId: string): Promise<ApprovalChallengeRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM approval_challenges WHERE grant_id = ? ORDER BY expires_at DESC LIMIT 1")
      .get(grantId) as Record<string, unknown> | undefined;
    return r ? mapChallenge(r) : undefined;
  }

  async getChallengeByGrantKind(
    grantId: string,
    kind: ApprovalChallengeRecord["kind"],
  ): Promise<ApprovalChallengeRecord | undefined> {
    const r = this.#db
      .prepare(
        "SELECT * FROM approval_challenges WHERE grant_id = ? AND kind = ? ORDER BY expires_at DESC LIMIT 1",
      )
      .get(grantId, kind) as Record<string, unknown> | undefined;
    return r ? mapChallenge(r) : undefined;
  }

  async updateChallenge(row: ApprovalChallengeRecord): Promise<void> {
    this.#db
      .prepare("UPDATE approval_challenges SET attempts = ? WHERE id = ?")
      .run(row.attempts, row.id);
  }

  async deleteChallenge(id: string): Promise<void> {
    this.#db.prepare("DELETE FROM approval_challenges WHERE id = ?").run(id);
  }

  async insertAudit(row: HostedAuditRecord): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO audit (id, org_id, action, actor, item_name, client_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.orgId, row.action, row.actor, row.itemName, row.clientId, row.at);
  }

  async insertAgentPass(row: {
    id: string;
    orgId: string;
    status: string;
    holderCnf: string | null;
    scopeJson: string;
    taskId: string | null;
    createdAt: string;
    consumedAt: string | null;
  }): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO agentpass_passes (id, org_id, status, holder_cnf, scope_json, task_id, created_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.orgId,
        row.status,
        row.holderCnf,
        row.scopeJson,
        row.taskId,
        row.createdAt,
        row.consumedAt,
      );
  }

  async getAgentPass(id: string) {
    const r = this.#db.prepare("SELECT * FROM agentpass_passes WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      orgId: String(r.org_id),
      status: String(r.status),
      holderCnf: r.holder_cnf == null ? null : String(r.holder_cnf),
      scopeJson: String(r.scope_json),
      taskId: r.task_id == null ? null : String(r.task_id),
      createdAt: String(r.created_at),
      consumedAt: r.consumed_at == null ? null : String(r.consumed_at),
    };
  }

  async updateAgentPassStatus(id: string, status: string): Promise<void> {
    this.#db.prepare("UPDATE agentpass_passes SET status = ? WHERE id = ?").run(status, id);
  }

  async consumeAgentPass(id: string, consumedAt: string): Promise<boolean> {
    const result = this.#db
      .prepare(
        "UPDATE agentpass_passes SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'",
      )
      .run(consumedAt, id);
    return result.changes === 1;
  }

  async listAgentPasses(orgId: string) {
    const rows = this.#db
      .prepare("SELECT * FROM agentpass_passes WHERE org_id = ? ORDER BY created_at DESC")
      .all(orgId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      orgId: String(r.org_id),
      status: String(r.status),
      holderCnf: r.holder_cnf == null ? null : String(r.holder_cnf),
      scopeJson: String(r.scope_json),
      taskId: r.task_id == null ? null : String(r.task_id),
      createdAt: String(r.created_at),
      consumedAt: r.consumed_at == null ? null : String(r.consumed_at),
    }));
  }

  async listAudit(orgId: string, limit = 200, filter?: AuditListFilter): Promise<HostedAuditRecord[]> {
    const clauses = ["org_id = ?"];
    const params: Array<string | number> = [orgId];
    if (filter?.clientId) {
      clauses.push("client_id = ?");
      params.push(filter.clientId);
    }
    if (filter?.itemName) {
      clauses.push("item_name = ?");
      params.push(filter.itemName);
    }
    if (filter?.action) {
      clauses.push("action = ?");
      params.push(filter.action);
    }
    params.push(limit);
    const rows = this.#db
      .prepare(`SELECT * FROM audit WHERE ${clauses.join(" AND ")} ORDER BY at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      orgId: String(r.org_id),
      action: String(r.action),
      actor: String(r.actor),
      itemName: r.item_name == null ? null : String(r.item_name),
      clientId: r.client_id == null ? null : String(r.client_id),
      at: String(r.at),
    }));
  }

  async insertPendingNeed(row: NeedItemRecord): Promise<NeedItemRecord> {
    try {
      this.#db
        .prepare(`INSERT INTO need_items (${NEED_INSERT_COLUMNS}) VALUES (${placeholders(13, "sqlite")})`)
        .run(...needValues(row));
      return row;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.getPendingNeed({
        orgId: row.orgId,
        clientId: row.clientId,
        environmentId: row.environmentId,
        suggestedName: row.suggestedName,
        host: row.host,
      });
      if (existing) return existing;
      throw err;
    }
  }

  async getNeed(id: string): Promise<NeedItemRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM need_items WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapNeed(r) : undefined;
  }

  async getPendingNeed(input: {
    orgId: string;
    clientId: string;
    environmentId: string;
    suggestedName: string;
    host: string;
  }): Promise<NeedItemRecord | undefined> {
    const r = this.#db
      .prepare(
        `SELECT * FROM need_items WHERE org_id = ? AND client_id = ? AND environment_id = ?
         AND suggested_name = ? AND host = ? AND status = 'pending'`,
      )
      .get(input.orgId, input.clientId, input.environmentId, input.suggestedName, input.host) as
      | Record<string, unknown>
      | undefined;
    return r ? mapNeed(r) : undefined;
  }

  async listPendingNeeds(orgId: string): Promise<NeedItemRecord[]> {
    const rows = this.#db
      .prepare(
        "SELECT * FROM need_items WHERE org_id = ? AND status = 'pending' ORDER BY created_at DESC",
      )
      .all(orgId) as Record<string, unknown>[];
    return rows.map(mapNeed);
  }

  async cancelNeed(id: string): Promise<void> {
    this.#db.prepare("UPDATE need_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id);
  }

  async refreshNeedExpires(id: string, expiresAt: string): Promise<void> {
    this.#db
      .prepare("UPDATE need_items SET expires_at = ? WHERE id = ? AND status = 'pending'")
      .run(expiresAt, id);
  }

  async persistFulfill(input: PersistFulfillInput): Promise<void> {
    this.#db.exec("BEGIN");
    try {
      this.#db
        .prepare(`INSERT INTO items (${ITEM_INSERT_COLUMNS}) VALUES (${placeholders(15, "sqlite")})`)
        .run(...itemValues(input.item));
      this.#db.prepare(GRANT_INSERT_SQL).run(...grantValues(input.grant));
      const claimed = this.#db
        .prepare(
          `UPDATE need_items SET status = 'fulfilled', item_id = ?, grant_id = ?, fulfilled_at = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(input.item.id, input.grant.id, input.fulfilledAt, input.needId);
      if (claimed.changes !== 1) {
        throw new StoreConflictError("Need is not pending");
      }
      this.#db
        .prepare(
          "INSERT INTO audit (id, org_id, action, actor, item_name, client_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          input.audit.id,
          input.audit.orgId,
          input.audit.action,
          input.audit.actor,
          input.audit.itemName,
          input.audit.clientId,
          input.audit.at,
        );
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      if (err instanceof StoreConflictError) throw err;
      if (isUniqueViolation(err)) {
        throw new StoreConflictError("Item name already exists in this environment");
      }
      throw err;
    }
  }

  async listMembers(orgId: string): Promise<MemberRow[]> {
    const rows = this.#db
      .prepare("SELECT * FROM org_members WHERE org_id = ? ORDER BY joined_at, user_id")
      .all(orgId) as Record<string, unknown>[];
    return rows.map(mapMember);
  }

  async listMembershipsForUser(userId: string): Promise<MemberRecord[]> {
    const rows = this.#db.prepare("SELECT * FROM org_members WHERE user_id = ?").all(userId) as Record<
      string,
      unknown
    >[];
    return rows.map(mapMemberRecord);
  }

  async listMemberEmails(orgId: string): Promise<string[]> {
    const rows = this.#db
      .prepare(
        `SELECT u.email AS email FROM org_members m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = ? AND u.email_verified_at IS NOT NULL ORDER BY u.email`,
      )
      .all(orgId) as { email: string }[];
    return rows.map((r) => String(r.email));
  }

  async upsertOidcPayload(row: { id: string; kind: string; payload: string; expiresAt: string | null }): Promise<void> {
    const idx = oidcPayloadIndex(row.payload);
    this.#db
      .prepare(
        `INSERT INTO oidc_payloads (id, kind, payload, expires_at, uid, user_code, grant_id, client_id, account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, kind) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at,
           uid = excluded.uid, user_code = excluded.user_code, grant_id = excluded.grant_id,
           client_id = excluded.client_id, account_id = excluded.account_id`,
      )
      .run(row.id, row.kind, row.payload, row.expiresAt, idx.uid, idx.userCode, idx.grantId, idx.clientId, idx.accountId);
  }

  async getOidcPayload(id: string, kind: string): Promise<{ payload: string; expiresAt: string | null } | undefined> {
    const r = this.#db.prepare("SELECT * FROM oidc_payloads WHERE id = ? AND kind = ?").get(id, kind) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      payload: String(r.payload),
      expiresAt: r.expires_at == null ? null : String(r.expires_at),
    };
  }

  async deleteOidcPayload(id: string, kind: string): Promise<void> {
    this.#db.prepare("DELETE FROM oidc_payloads WHERE id = ? AND kind = ?").run(id, kind);
  }

  async listOidcPayloads(kind: string): Promise<{ id: string; payload: string }[]> {
    const rows = this.#db.prepare("SELECT id, payload FROM oidc_payloads WHERE kind = ?").all(kind) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({ id: String(r.id), payload: String(r.payload) }));
  }

  async insertUser(row: UserRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO users (id, email, email_verified_at, totp_wrapped_iv, totp_wrapped_ciphertext, totp_wrapped_tag, totp_last_step, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.email,
        row.emailVerifiedAt,
        row.totpWrappedIv,
        row.totpWrappedCiphertext,
        row.totpWrappedTag,
        row.totpLastStep,
        row.createdAt,
      );
  }

  async getUser(id: string): Promise<UserRow | undefined> {
    const r = this.#db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapUser(r) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserRow | undefined> {
    const r = this.#db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as
      | Record<string, unknown>
      | undefined;
    return r ? mapUser(r) : undefined;
  }

  async updateUser(row: UserRecord): Promise<void> {
    this.#db
      .prepare(
        `UPDATE users SET email_verified_at = ?, totp_wrapped_iv = ?, totp_wrapped_ciphertext = ?,
         totp_wrapped_tag = ?, totp_last_step = ? WHERE id = ?`,
      )
      .run(
        row.emailVerifiedAt,
        row.totpWrappedIv,
        row.totpWrappedCiphertext,
        row.totpWrappedTag,
        row.totpLastStep,
        row.id,
      );
  }

  async insertEmailOtp(row: EmailOtpRecord): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO email_otp_challenges (id, email, code_scrypt, expires_at, attempts, sent_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.id, row.email, row.codeScrypt, row.expiresAt, row.attempts, row.sentAt);
  }

  async latestEmailOtp(email: string): Promise<EmailOtpRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM email_otp_challenges WHERE email = ? ORDER BY sent_at DESC LIMIT 1")
      .get(email.toLowerCase()) as Record<string, unknown> | undefined;
    return r ? mapOtp(r) : undefined;
  }

  async updateEmailOtp(row: EmailOtpRecord): Promise<void> {
    this.#db
      .prepare("UPDATE email_otp_challenges SET attempts = ?, expires_at = ? WHERE id = ?")
      .run(row.attempts, row.expiresAt, row.id);
  }

  async countEmailOtpSince(email: string, sinceIso: string): Promise<number> {
    const r = this.#db
      .prepare("SELECT COUNT(*) AS n FROM email_otp_challenges WHERE email = ? AND sent_at >= ?")
      .get(email.toLowerCase(), sinceIso) as { n: number };
    return Number(r.n);
  }

  async insertBackupCode(userId: string, codeScrypt: string): Promise<void> {
    this.#db.prepare("INSERT INTO backup_codes (user_id, code_scrypt, used_at) VALUES (?, ?, NULL)").run(
      userId,
      codeScrypt,
    );
  }

  async listBackupCodes(userId: string): Promise<{ codeScrypt: string; usedAt: string | null }[]> {
    const rows = this.#db.prepare("SELECT * FROM backup_codes WHERE user_id = ?").all(userId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({
      codeScrypt: String(r.code_scrypt),
      usedAt: r.used_at == null ? null : String(r.used_at),
    }));
  }

  async markBackupUsed(userId: string, codeScrypt: string, usedAt: string): Promise<void> {
    this.#db
      .prepare("UPDATE backup_codes SET used_at = ? WHERE user_id = ? AND code_scrypt = ? AND used_at IS NULL")
      .run(usedAt, userId, codeScrypt);
  }

  async insertSession(row: OperatorSessionRow): Promise<void> {
    this.#db
      .prepare(
        "INSERT INTO operator_sessions (id_hash, user_id, created_at, last_seen_at, expires_at, mfa_at, active_org_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(row.idHash, row.userId, row.createdAt, row.lastSeenAt, row.expiresAt, row.mfaAt, row.activeOrgId ?? null);
  }

  async getSession(idHash: string): Promise<OperatorSessionRow | undefined> {
    const r = this.#db.prepare("SELECT * FROM operator_sessions WHERE id_hash = ?").get(idHash) as
      | Record<string, unknown>
      | undefined;
    return r ? mapSess(r) : undefined;
  }

  async deleteSession(idHash: string): Promise<void> {
    this.#db.prepare("DELETE FROM operator_sessions WHERE id_hash = ?").run(idHash);
  }

  async deleteOtherSessions(userId: string, keepHash: string): Promise<void> {
    this.#db.prepare("DELETE FROM operator_sessions WHERE user_id = ? AND id_hash != ?").run(userId, keepHash);
  }

  async listOperatorSessions(orgId: string): Promise<OperatorSessionRow[]> {
    const rows = this.#db
      .prepare(
        `SELECT s.* FROM operator_sessions s
         JOIN org_members m ON m.user_id = s.user_id
         WHERE m.org_id = ?`,
      )
      .all(orgId) as Record<string, unknown>[];
    return rows.map(mapSess);
  }

  async touchSession(idHash: string, lastSeenAt: string, expiresAt: string): Promise<void> {
    this.#db
      .prepare("UPDATE operator_sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?")
      .run(lastSeenAt, expiresAt, idHash);
  }

  async updateUserSecurity(userId: string, patch: UserSecurityState): Promise<void> {
    this.#db
      .prepare(
        `UPDATE users SET totp_failures = ?, totp_locked_until = ?, totp_pending_wrapped_iv = ?,
         totp_pending_wrapped_ciphertext = ?, totp_pending_wrapped_tag = ?, totp_pending_at = ? WHERE id = ?`,
      )
      .run(
        patch.totpFailures,
        patch.totpLockedUntil,
        patch.totpPendingWrappedIv,
        patch.totpPendingWrappedCiphertext,
        patch.totpPendingWrappedTag,
        patch.totpPendingAt,
        userId,
      );
  }

  async listUsersWithTotp(): Promise<UserRow[]> {
    const rows = this.#db
      .prepare("SELECT * FROM users WHERE totp_wrapped_iv IS NOT NULL OR totp_pending_wrapped_iv IS NOT NULL")
      .all() as Record<string, unknown>[];
    return rows.map(mapUser);
  }

  async deleteUnusedBackupCodes(userId: string): Promise<void> {
    this.#db.prepare("DELETE FROM backup_codes WHERE user_id = ? AND used_at IS NULL").run(userId);
  }

  async deletePendingSessions(userId: string, keepHash: string): Promise<void> {
    this.#db
      .prepare("DELETE FROM operator_sessions WHERE user_id = ? AND mfa_at IS NULL AND id_hash != ?")
      .run(userId, keepHash);
  }

  async getIdentityKey(id: string): Promise<IdentityKeyRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM identity_keys WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapIdentityKey(r) : undefined;
  }

  async insertIdentityKey(row: IdentityKeyRecord): Promise<void> {
    this.#db
      .prepare(
        "INSERT OR IGNORE INTO identity_keys (id, wrapped_iv, wrapped_ciphertext, wrapped_tag, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.id, row.wrappedIv, row.wrappedCiphertext, row.wrappedTag, row.createdAt);
  }

  async updateIdentityKey(
    id: string,
    patch: Pick<IdentityKeyRecord, "wrappedIv" | "wrappedCiphertext" | "wrappedTag">,
  ): Promise<void> {
    this.#db
      .prepare("UPDATE identity_keys SET wrapped_iv = ?, wrapped_ciphertext = ?, wrapped_tag = ? WHERE id = ?")
      .run(patch.wrappedIv, patch.wrappedCiphertext, patch.wrappedTag, id);
  }

  async insertAccessEvent(row: AccessEventRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO access_events (id, org_id, client_id, actor_user_id, kind, jti_hash, issued_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.orgId,
        row.clientId,
        row.actorUserId,
        row.kind,
        row.jtiHash,
        row.issuedAt,
        row.expiresAt,
        row.revokedAt,
      );
  }

  async listAccessEvents(orgId: string, limit = 200): Promise<AccessEventRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM access_events WHERE org_id = ? ORDER BY issued_at DESC LIMIT ?")
      .all(orgId, limit) as Record<string, unknown>[];
    return rows.map(mapAccess);
  }

  async getAccessEventByJti(jtiHash: string): Promise<AccessEventRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM access_events WHERE jti_hash = ?").get(jtiHash) as
      | Record<string, unknown>
      | undefined;
    return r ? mapAccess(r) : undefined;
  }

  async revokeAccessEventsForClient(clientId: string, at: string): Promise<void> {
    this.#db
      .prepare("UPDATE access_events SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL")
      .run(at, clientId);
  }

  async revokeAccessEvent(jtiHash: string, at: string): Promise<void> {
    this.#db.prepare("UPDATE access_events SET revoked_at = ? WHERE jti_hash = ?").run(at, jtiHash);
  }

  async setClientRevoked(id: string, at: string | null): Promise<void> {
    this.#db.prepare("UPDATE clients SET revoked_at = ? WHERE id = ?").run(at, id);
  }

  async touchClientLastSeen(id: string, at: string): Promise<void> {
    this.#db
      .prepare(
        `UPDATE clients SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      )
      .run(at, id, new Date(Date.parse(at) - 60_000).toISOString());
  }

  async setClientLastTokenAt(id: string, at: string): Promise<void> {
    this.#db.prepare("UPDATE clients SET last_token_at = ? WHERE id = ?").run(at, id);
  }

  async sweepExpired(nowIso: string): Promise<SweepCounts> {
    const dayAgo = new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.parse(nowIso) - 2 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.parse(nowIso) - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.parse(nowIso) - 30 * 24 * 60 * 60 * 1000).toISOString();
    const run = (sql: string, ...params: string[]): number =>
      Number(this.#db.prepare(sql).run(...params).changes);
    return {
      emailOtpChallenges: run("DELETE FROM email_otp_challenges WHERE expires_at < ?", nowIso),
      operatorSessions: run("DELETE FROM operator_sessions WHERE expires_at < ?", nowIso),
      approvalChallenges: run("DELETE FROM approval_challenges WHERE expires_at < ?", nowIso),
      needItems: run(
        `DELETE FROM need_items
         WHERE (status = 'cancelled' AND created_at < ?)
            OR (status = 'pending' AND expires_at < ?)`,
        dayAgo,
        dayAgo,
      ),
      rateHits: run("DELETE FROM rate_hits WHERE window_start < ?", twoHoursAgo),
      oidcPayloads: run("DELETE FROM oidc_payloads WHERE expires_at IS NOT NULL AND expires_at < ?", nowIso),
      orgInvites: run("DELETE FROM org_invites WHERE accepted_at IS NULL AND expires_at < ?", weekAgo),
      grants: run(
        `DELETE FROM grants WHERE status IN ${TERMINAL_GRANT_STATUSES}
         AND COALESCE(consumed_at, expires_at, approved_at, created_at) < ?`,
        thirtyDaysAgo,
      ),
    };
  }

  async findClientByOrgAndOauthId(orgId: string, oauthClientId: string): Promise<ClientRecord | undefined> {
    const r = this.#db
      .prepare(
        `SELECT id FROM clients WHERE org_id = ? AND (oauth_client_id = ? OR clerk_oauth_user_id = ?)
         ORDER BY revoked_at IS NOT NULL, id LIMIT 1`,
      )
      .get(orgId, oauthClientId, oauthClientId) as { id: string } | undefined;
    return r ? this.getClient(r.id) : undefined;
  }

  async setClientConsentedBy(id: string, userId: string): Promise<void> {
    this.#db
      .prepare("UPDATE clients SET consented_by_user_id = ? WHERE id = ? AND consented_by_user_id IS NULL")
      .run(userId, id);
  }

  async findOidcPayloadByUid(kind: string, uid: string): Promise<OidcPayloadRow | undefined> {
    const r = this.#db
      .prepare("SELECT id, payload, expires_at FROM oidc_payloads WHERE kind = ? AND uid = ? LIMIT 1")
      .get(kind, uid) as Record<string, unknown> | undefined;
    return r ? mapOidcRow(r) : undefined;
  }

  async findOidcPayloadByUserCode(kind: string, userCode: string): Promise<OidcPayloadRow | undefined> {
    const r = this.#db
      .prepare("SELECT id, payload, expires_at FROM oidc_payloads WHERE kind = ? AND user_code = ? LIMIT 1")
      .get(kind, userCode) as Record<string, unknown> | undefined;
    return r ? mapOidcRow(r) : undefined;
  }

  async deleteOidcPayloadsByGrantId(kind: string, grantId: string): Promise<void> {
    this.#db.prepare("DELETE FROM oidc_payloads WHERE kind = ? AND grant_id = ?").run(kind, grantId);
  }

  async deleteOidcPayloadsForClient(kind: string, clientIds: string[], accountId: string | null): Promise<void> {
    if (clientIds.length === 0) return;
    const marks = clientIds.map(() => "?").join(", ");
    this.#db
      .prepare(
        `DELETE FROM oidc_payloads WHERE kind = ? AND client_id IN (${marks})
         AND ((? IS NULL AND account_id IS NULL) OR account_id = ?)`,
      )
      .run(kind, ...clientIds, accountId, accountId);
  }

  async purgeExpiredOidcPayloads(nowIso: string): Promise<number> {
    const r = this.#db
      .prepare("DELETE FROM oidc_payloads WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(nowIso);
    return Number(r.changes);
  }

  /* ---- team (3.7) and plan limits (3.9) ---- */

  async removeMember(orgId: string, userId: string): Promise<void> {
    this.#db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").run(orgId, userId);
    this.#db
      .prepare("UPDATE operator_sessions SET active_org_id = NULL WHERE user_id = ? AND active_org_id = ?")
      .run(userId, orgId);
  }

  async updateMemberRole(orgId: string, userId: string, role: MemberRow["role"]): Promise<void> {
    this.#db.prepare("UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?").run(role, orgId, userId);
  }

  async insertInvite(row: InviteRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO org_invites (id, org_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.orgId,
        row.email,
        row.role,
        row.tokenHash,
        row.invitedBy,
        row.createdAt,
        row.expiresAt,
        row.acceptedAt,
      );
  }

  async getInvite(id: string): Promise<InviteRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM org_invites WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapInvite(r) : undefined;
  }

  async getInviteByTokenHash(tokenHash: string): Promise<InviteRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM org_invites WHERE token_hash = ?").get(tokenHash) as
      | Record<string, unknown>
      | undefined;
    return r ? mapInvite(r) : undefined;
  }

  async listInvites(orgId: string): Promise<InviteRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM org_invites WHERE org_id = ? AND accepted_at IS NULL ORDER BY created_at DESC")
      .all(orgId) as Record<string, unknown>[];
    return rows.map(mapInvite);
  }

  async acceptInvite(id: string, acceptedAt: string): Promise<void> {
    this.#db.prepare("UPDATE org_invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL").run(acceptedAt, id);
  }

  async deleteInvite(id: string): Promise<void> {
    this.#db.prepare("DELETE FROM org_invites WHERE id = ?").run(id);
  }

  async setSessionActiveOrg(idHash: string, orgId: string | null): Promise<void> {
    this.#db.prepare("UPDATE operator_sessions SET active_org_id = ? WHERE id_hash = ?").run(orgId, idHash);
  }

  async countAuditSince(orgId: string, action: string, sinceIso: string): Promise<number> {
    const r = this.#db
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE org_id = ? AND action = ? AND at >= ?")
      .get(orgId, action, sinceIso) as { n: number };
    return Number(r.n);
  }

  async countItemsForOrg(orgId: string): Promise<number> {
    const r = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM items i
         JOIN environments e ON e.id = i.environment_id
         JOIN vaults v ON v.id = e.vault_id
         WHERE v.org_id = ?`,
      )
      .get(orgId) as { n: number };
    return Number(r.n);
  }
}

