import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApprovalChallengeRecord,
  ClientRecord,
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
  VaultRecord,
} from "../hosted-types.ts";
import { isUniqueViolation, StoreConflictError } from "./conflict.ts";
import { HOSTED_SCHEMA_SQLITE } from "./schema.ts";
import type { VaultStore } from "./types.ts";

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
  };
}

export function openHostedSqlite(path: string): SqliteHostedStore {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(HOSTED_SCHEMA_SQLITE);
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

  async getOrg(id: string): Promise<OrgRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM orgs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? mapOrg(r) : undefined;
  }

  async deleteOrg(orgId: string): Promise<void> {
    this.#db.exec("BEGIN");
    try {
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
      this.#db.prepare("DELETE FROM org_members WHERE org_id = ?").run(orgId);
      this.#db.prepare("DELETE FROM orgs WHERE id = ?").run(orgId);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  async insertMember(row: MemberRecord): Promise<void> {
    this.#db
      .prepare("INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)")
      .run(row.orgId, row.userId, row.role);
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
        `INSERT INTO clients (id, org_id, kind, name, hashed_secret, clerk_oauth_user_id, environment)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.orgId,
        row.kind,
        row.name,
        row.hashedSecret,
        row.clerkOauthUserId,
        row.environment,
      );
  }

  async getClient(id: string): Promise<ClientRecord | undefined> {
    const r = this.#db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      orgId: String(r.org_id),
      kind: r.kind as ClientRecord["kind"],
      name: String(r.name),
      hashedSecret: r.hashed_secret == null ? null : String(r.hashed_secret),
      clerkOauthUserId: r.clerk_oauth_user_id == null ? null : String(r.clerk_oauth_user_id),
      environment: r.environment as ClientRecord["environment"],
    };
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

  async insertPolicy(row: PolicyRecord): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO policies (id, org_id, client_id, item_id, folder_id, environment_id, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
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
    this.#db
      .prepare(
        `INSERT INTO grants (
          id, org_id, client_id, item_id, folder_id, environment_id, policy, status,
          expires_at, created_at, approved_at, consumed_at, task_id, task_description
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
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
         item_id = ?, folder_id = ?, task_id = ?, task_description = ? WHERE id = ?`,
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
        row.id,
      );
  }

  async consumeGrant(id: string, consumedAt: string): Promise<boolean> {
    const result = this.#db
      .prepare(
        "UPDATE grants SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'active'",
      )
      .run(consumedAt, id);
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

  async listAudit(orgId: string, limit = 200): Promise<HostedAuditRecord[]> {
    const rows = this.#db
      .prepare("SELECT * FROM audit WHERE org_id = ? ORDER BY at DESC LIMIT ?")
      .all(orgId, limit) as Record<string, unknown>[];
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
      this.#db
        .prepare(
          `INSERT INTO grants (
            id, org_id, client_id, item_id, folder_id, environment_id, policy, status,
            expires_at, created_at, approved_at, consumed_at, task_id, task_description
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.grant.id,
          input.grant.orgId,
          input.grant.clientId,
          input.grant.itemId,
          input.grant.folderId,
          input.grant.environmentId,
          input.grant.policy,
          input.grant.status,
          input.grant.expiresAt,
          input.grant.createdAt,
          input.grant.approvedAt,
          input.grant.consumedAt,
          input.grant.taskId,
          input.grant.taskDescription,
        );
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
  };
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
