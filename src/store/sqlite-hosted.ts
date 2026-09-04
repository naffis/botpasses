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
} from "./schema.ts";
import { mapClientRow } from "./map-client.ts";
import {
  oidcPayloadIndex,
  parseCallsUsed,
  parseNullableInt,
  parseRequestedScope,
  parseScopeList,
  requestedScopeJson,
  scopeListJson,
  type AuditListFilter,
  type IdentityKeyRecord,
  type InviteRecord,
  type MemberRow,
  type OidcPayloadRow,
  type OperatorSessionRow,
  type SweepCounts,
  type UserRow,
  type UserSecurityState,
  type VaultStore,
} from "./types.ts";

function mapOrg(r: Record<string, unknown>): OrgRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    wrappedDekIv: String(r.wrapped_dek_iv),
    wrappedDekCiphertext: String(r.wrapped_dek_ciphertext),
    wrappedDekTag: String(r.wrapped_dek_tag),
    createdAt: String(r.created_at),
  };
}

function mapItem(r: Record<string, unknown>): ItemRecord {
  return {
    id: String(r.id),
    environmentId: String(r.environment_id),
    folderId: r.folder_id == null ? null : String(r.folder_id),
    kind: r.kind as ItemRecord["kind"],
    name: String(r.name),
    last4: String(r.last4),
    username: r.username == null ? null : String(r.username),
    allowedHostsJson: String(r.allowed_hosts_json),
    inject: String(r.inject),
    iv: String(r.iv),
    ciphertext: String(r.ciphertext),
    tag: String(r.tag),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapGrant(r: Record<string, unknown>): HostedGrantRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    clientId: String(r.client_id),
    itemId: r.item_id == null ? null : String(r.item_id),
    folderId: r.folder_id == null ? null : String(r.folder_id),
    environmentId: String(r.environment_id),
    policy: r.policy as HostedGrantRecord["policy"],
    status: r.status as HostedGrantRecord["status"],
    expiresAt: r.expires_at == null ? null : String(r.expires_at),
    createdAt: String(r.created_at),
    approvedAt: r.approved_at == null ? null : String(r.approved_at),
    consumedAt: r.consumed_at == null ? null : String(r.consumed_at),
    taskId: r.task_id == null ? null : String(r.task_id),
    taskDescription: r.task_description == null ? null : String(r.task_description),
    methods: parseScopeList(r.methods),
    pathPrefixes: parseScopeList(r.path_prefixes),
    hosts: parseScopeList(r.hosts),
    maxCalls: parseNullableInt(r.max_calls),
    callsUsed: parseCallsUsed(r.calls_used),
    requestedScope: parseRequestedScope(r.requested_scope_json),
  };
}

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
  for (const alter of [
    HOSTED_SCHEMA_IDENTITY_ALTER_SQLITE,
    HOSTED_SCHEMA_OAUTH_ALTER_SQLITE,
    HOSTED_SCHEMA_SCOPE_ALTER_SQLITE,
  ]) {
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
  for (const alter of [HOSTED_SCHEMA_IDENTITY_ALTER2_SQLITE, HOSTED_SCHEMA_TEAM_ALTER_SQLITE]) {
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
  return new SqliteHostedStore(db);
}

function mapInvite(r: Record<string, unknown>): InviteRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    email: String(r.email),
    role: r.role as InviteRecord["role"],
    tokenHash: String(r.token_hash),
    invitedBy: String(r.invited_by),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    acceptedAt: r.accepted_at == null ? null : String(r.accepted_at),
  };
}

function mapMember(r: Record<string, unknown>): MemberRow {
  return {
    orgId: String(r.org_id),
    userId: String(r.user_id),
    role: r.role as MemberRow["role"],
    joinedAt: r.joined_at == null ? null : String(r.joined_at),
  };
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
        `INSERT INTO orgs (id, name, wrapped_dek_iv, wrapped_dek_ciphertext, wrapped_dek_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.wrappedDekIv,
        row.wrappedDekCiphertext,
        row.wrappedDekTag,
        row.createdAt,
      );
  }

  async listOrgs(): Promise<OrgRecord[]> {
    const rows = this.#db.prepare("SELECT * FROM orgs").all() as Record<string, unknown>[];
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
          `DELETE FROM oidc_payloads WHERE json_extract(payload, '$.accountId') IN (
            SELECT user_id FROM org_members WHERE org_id = ?
          )`,
        )
        .run(orgId);
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
    if (!r) return undefined;
    return { orgId: String(r.org_id), userId: String(r.user_id), role: r.role as MemberRecord["role"] };
  }

  async insertVault(row: VaultRecord): Promise<void> {
    this.#db.prepare("INSERT INTO vaults (id, org_id, name) VALUES (?, ?, ?)").run(row.id, row.orgId, row.name);
  }

  async listVaults(orgId: string): Promise<VaultRecord[]> {
    const rows = this.#db.prepare("SELECT * FROM vaults WHERE org_id = ?").all(orgId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => ({ id: String(r.id), orgId: String(r.org_id), name: String(r.name) }));
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
    if (!r) return undefined;
    return {
      id: String(r.id),
      vaultId: String(r.vault_id),
      name: r.name as EnvironmentRecord["name"],
    };
  }

  async getEnvironmentByName(
    vaultId: string,
    name: string,
  ): Promise<EnvironmentRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM environments WHERE vault_id = ? AND name = ?")
      .get(vaultId, name) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      vaultId: String(r.vault_id),
      name: r.name as EnvironmentRecord["name"],
    };
  }

  async listEnvironments(vaultId: string): Promise<EnvironmentRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM environments WHERE vault_id = ?")
      .all(vaultId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      vaultId: String(r.vault_id),
      name: r.name as EnvironmentRecord["name"],
    }));
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
    if (!r) return undefined;
    return { id: String(r.id), environmentId: String(r.environment_id), name: String(r.name) };
  }

  async getFolderByName(environmentId: string, name: string): Promise<FolderRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM folders WHERE environment_id = ? AND name = ?")
      .get(environmentId, name) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return { id: String(r.id), environmentId: String(r.environment_id), name: String(r.name) };
  }

  async insertItem(row: ItemRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO items (
          id, environment_id, folder_id, kind, name, last4, username, allowed_hosts_json,
          inject, iv, ciphertext, tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.environmentId,
        row.folderId,
        row.kind,
        row.name,
        row.last4,
        row.username,
        row.allowedHostsJson,
        row.inject,
        row.iv,
        row.ciphertext,
        row.tag,
        row.createdAt,
        row.updatedAt,
      );
  }

  async updateItemEnvelope(
    id: string,
    patch: Pick<ItemRecord, "iv" | "ciphertext" | "tag" | "last4" | "updatedAt">,
  ): Promise<void> {
    this.#db
      .prepare(
        "UPDATE items SET iv = ?, ciphertext = ?, tag = ?, last4 = ?, updated_at = ? WHERE id = ?",
      )
      .run(patch.iv, patch.ciphertext, patch.tag, patch.last4, patch.updatedAt, id);
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

  async incrementRateHit(orgId: string, kind: "grant" | "need", windowStart: string): Promise<number> {
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

  async countRateHits(orgId: string, kind: "grant" | "need", windowStart: string): Promise<number> {
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

  async getClientByHashedSecret(
    orgId: string,
    hashedSecret: string,
  ): Promise<ClientRecord | undefined> {
    const r = this.#db
      .prepare("SELECT * FROM clients WHERE org_id = ? AND hashed_secret = ?")
      .get(orgId, hashedSecret) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return this.getClient(String(r.id));
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
    this.#db.prepare(GRANT_INSERT_SQL).run(...grantInsertValues(row));
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
        .prepare(
          `INSERT INTO need_items (
            id, org_id, client_id, environment_id, suggested_name, host, task_description,
            status, item_id, grant_id, expires_at, created_at, fulfilled_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.orgId,
          row.clientId,
          row.environmentId,
          row.suggestedName,
          row.host,
          row.taskDescription,
          row.status,
          row.itemId,
          row.grantId,
          row.expiresAt,
          row.createdAt,
          row.fulfilledAt,
        );
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
        .prepare(
          `INSERT INTO items (
            id, environment_id, folder_id, kind, name, last4, username, allowed_hosts_json,
            inject, iv, ciphertext, tag, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.item.id,
          input.item.environmentId,
          input.item.folderId,
          input.item.kind,
          input.item.name,
          input.item.last4,
          input.item.username,
          input.item.allowedHostsJson,
          input.item.inject,
          input.item.iv,
          input.item.ciphertext,
          input.item.tag,
          input.item.createdAt,
          input.item.updatedAt,
        );
      this.#db.prepare(GRANT_INSERT_SQL).run(...grantInsertValues(input.grant));
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
    return rows.map((r) => ({
      orgId: String(r.org_id),
      userId: String(r.user_id),
      role: r.role as MemberRecord["role"],
    }));
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
         AND (account_id IS NULL OR account_id = ?)`,
      )
      .run(kind, ...clientIds, accountId);
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

function mapOidcRow(r: Record<string, unknown>): OidcPayloadRow {
  return {
    id: String(r.id),
    payload: String(r.payload),
    expiresAt: r.expires_at == null ? null : String(r.expires_at),
  };
}

function mapPolicy(r: Record<string, unknown>): PolicyRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    clientId: String(r.client_id),
    itemId: r.item_id == null ? null : String(r.item_id),
    folderId: r.folder_id == null ? null : String(r.folder_id),
    environmentId: String(r.environment_id),
    kind: r.kind as PolicyRecord["kind"],
    createdAt: String(r.created_at),
    methods: parseScopeList(r.methods),
    pathPrefixes: parseScopeList(r.path_prefixes),
    hosts: parseScopeList(r.hosts),
    maxCalls: parseNullableInt(r.max_calls),
    callsUsed: parseCallsUsed(r.calls_used),
    expiresAt: r.expires_at == null ? null : String(r.expires_at),
  };
}

const GRANT_INSERT_SQL = `INSERT INTO grants (
  id, org_id, client_id, item_id, folder_id, environment_id, policy, status,
  expires_at, created_at, approved_at, consumed_at, task_id, task_description,
  methods, path_prefixes, hosts, max_calls, calls_used, requested_scope_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function grantInsertValues(row: HostedGrantRecord): (string | number | null)[] {
  return [
    row.id,
    row.orgId,
    row.clientId,
    row.itemId,
    row.folderId,
    row.environmentId,
    row.policy,
    row.status,
    row.expiresAt,
    row.createdAt,
    row.approvedAt,
    row.consumedAt,
    row.taskId,
    row.taskDescription,
    scopeListJson(row.methods),
    scopeListJson(row.pathPrefixes),
    scopeListJson(row.hosts),
    row.maxCalls,
    row.callsUsed,
    requestedScopeJson(row.requestedScope),
  ];
}

function mapChallenge(r: Record<string, unknown>): ApprovalChallengeRecord {
  return {
    id: String(r.id),
    grantId: String(r.grant_id),
    codeHash: String(r.code_hash),
    expiresAt: String(r.expires_at),
    attempts: Number(r.attempts),
    kind: r.kind as ApprovalChallengeRecord["kind"],
  };
}

function mapUser(r: Record<string, unknown>): UserRow {
  return {
    id: String(r.id),
    email: String(r.email),
    emailVerifiedAt: r.email_verified_at == null ? null : String(r.email_verified_at),
    totpWrappedIv: r.totp_wrapped_iv == null ? null : String(r.totp_wrapped_iv),
    totpWrappedCiphertext: r.totp_wrapped_ciphertext == null ? null : String(r.totp_wrapped_ciphertext),
    totpWrappedTag: r.totp_wrapped_tag == null ? null : String(r.totp_wrapped_tag),
    totpLastStep: r.totp_last_step == null ? null : Number(r.totp_last_step),
    createdAt: String(r.created_at),
    totpFailures: r.totp_failures == null ? 0 : Number(r.totp_failures),
    totpLockedUntil: r.totp_locked_until == null ? null : String(r.totp_locked_until),
    totpPendingWrappedIv: r.totp_pending_wrapped_iv == null ? null : String(r.totp_pending_wrapped_iv),
    totpPendingWrappedCiphertext:
      r.totp_pending_wrapped_ciphertext == null ? null : String(r.totp_pending_wrapped_ciphertext),
    totpPendingWrappedTag: r.totp_pending_wrapped_tag == null ? null : String(r.totp_pending_wrapped_tag),
    totpPendingAt: r.totp_pending_at == null ? null : String(r.totp_pending_at),
  };
}

function mapIdentityKey(r: Record<string, unknown>): IdentityKeyRecord {
  return {
    id: String(r.id),
    wrappedIv: String(r.wrapped_iv),
    wrappedCiphertext: String(r.wrapped_ciphertext),
    wrappedTag: String(r.wrapped_tag),
    createdAt: String(r.created_at),
  };
}

function mapOtp(r: Record<string, unknown>): EmailOtpRecord {
  return {
    id: String(r.id),
    email: String(r.email),
    codeScrypt: String(r.code_scrypt),
    expiresAt: String(r.expires_at),
    attempts: Number(r.attempts),
    sentAt: String(r.sent_at),
  };
}

function mapSess(r: Record<string, unknown>): OperatorSessionRow {
  return {
    idHash: String(r.id_hash),
    userId: String(r.user_id),
    createdAt: String(r.created_at),
    lastSeenAt: String(r.last_seen_at),
    expiresAt: String(r.expires_at),
    mfaAt: r.mfa_at == null ? null : String(r.mfa_at),
    activeOrgId: r.active_org_id == null ? null : String(r.active_org_id),
  };
}

function mapAccess(r: Record<string, unknown>): AccessEventRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    clientId: r.client_id == null ? null : String(r.client_id),
    actorUserId: r.actor_user_id == null ? null : String(r.actor_user_id),
    kind: r.kind as AccessEventRecord["kind"],
    jtiHash: String(r.jti_hash),
    issuedAt: String(r.issued_at),
    expiresAt: r.expires_at == null ? null : String(r.expires_at),
    revokedAt: r.revoked_at == null ? null : String(r.revoked_at),
  };
}

function mapNeed(r: Record<string, unknown>): NeedItemRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    clientId: String(r.client_id),
    environmentId: String(r.environment_id),
    suggestedName: String(r.suggested_name),
    host: String(r.host),
    taskDescription: r.task_description == null ? null : String(r.task_description),
    status: r.status as NeedItemRecord["status"],
    itemId: r.item_id == null ? null : String(r.item_id),
    grantId: r.grant_id == null ? null : String(r.grant_id),
    expiresAt: String(r.expires_at),
    createdAt: String(r.created_at),
    fulfilledAt: r.fulfilled_at == null ? null : String(r.fulfilled_at),
  };
}
