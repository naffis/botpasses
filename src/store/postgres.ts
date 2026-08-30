import { Pool } from "pg";
import type {
  ApprovalChallengeRecord,
  ClientRecord,
  EnvironmentRecord,
  FolderRecord,
  HostedAuditRecord,
  HostedGrantRecord,
  ItemRecord,
  MemberRecord,
  OrgRecord,
  PolicyRecord,
  VaultRecord,
} from "../hosted-types.ts";
import { HOSTED_SCHEMA_SQLITE } from "./schema.ts";
import type { VaultStore } from "./types.ts";

function asRecord(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

export class PostgresStore implements VaultStore {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  static async open(connectionString: string): Promise<PostgresStore> {
    const pool = new Pool({ connectionString, max: 10 });
    const store = new PostgresStore(pool);
    await store.migrate();
    return store;
  }

  async migrate(): Promise<void> {
    await this.#pool.query(HOSTED_SCHEMA_SQLITE);
  }

  async ping(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async insertOrg(row: OrgRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO orgs (id, name, wrapped_dek_iv, wrapped_dek_ciphertext, wrapped_dek_tag, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.id, row.name, row.wrappedDekIv, row.wrappedDekCiphertext, row.wrappedDekTag, row.createdAt],
    );
  }

  async getOrg(id: string): Promise<OrgRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM orgs WHERE id = $1", [id]);
    const row = r.rows[0];
    if (!row) return undefined;
    const rec = asRecord(row);
    return {
      id: String(rec.id),
      name: String(rec.name),
      wrappedDekIv: String(rec.wrapped_dek_iv),
      wrappedDekCiphertext: String(rec.wrapped_dek_ciphertext),
      wrappedDekTag: String(rec.wrapped_dek_tag),
      createdAt: String(rec.created_at),
    };
  }

  async deleteOrg(orgId: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM approval_challenges WHERE grant_id IN (SELECT id FROM grants WHERE org_id = $1)",
        [orgId],
      );
      await client.query("DELETE FROM grants WHERE org_id = $1", [orgId]);
      await client.query("DELETE FROM policies WHERE org_id = $1", [orgId]);
      await client.query("DELETE FROM clients WHERE org_id = $1", [orgId]);
      await client.query("DELETE FROM audit WHERE org_id = $1", [orgId]);
      await client.query("DELETE FROM agentpass_passes WHERE org_id = $1", [orgId]);
      await client.query(
        `DELETE FROM items WHERE environment_id IN (
           SELECT e.id FROM environments e JOIN vaults v ON v.id = e.vault_id WHERE v.org_id = $1
         )`,
        [orgId],
      );
      await client.query(
        `DELETE FROM folders WHERE environment_id IN (
           SELECT e.id FROM environments e JOIN vaults v ON v.id = e.vault_id WHERE v.org_id = $1
         )`,
        [orgId],
      );
      await client.query(
        "DELETE FROM environments WHERE vault_id IN (SELECT id FROM vaults WHERE org_id = $1)",
        [orgId],
      );
      await client.query("DELETE FROM vaults WHERE org_id = $1", [orgId]);
      await client.query("DELETE FROM org_members WHERE org_id = $1", [orgId]);
      await client.query("DELETE FROM orgs WHERE id = $1", [orgId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async insertMember(row: MemberRecord): Promise<void> {
    await this.#pool.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)", [
      row.orgId,
      row.userId,
      row.role,
    ]);
  }

  async getMember(orgId: string, userId: string): Promise<MemberRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, userId],
    );
    const rec = r.rows[0] ? asRecord(r.rows[0]) : undefined;
    if (!rec) return undefined;
    return { orgId: String(rec.org_id), userId: String(rec.user_id), role: rec.role as MemberRecord["role"] };
  }

  async insertVault(row: VaultRecord): Promise<void> {
    await this.#pool.query("INSERT INTO vaults (id, org_id, name) VALUES ($1,$2,$3)", [
      row.id,
      row.orgId,
      row.name,
    ]);
  }

  async listVaults(orgId: string): Promise<VaultRecord[]> {
    const r = await this.#pool.query("SELECT * FROM vaults WHERE org_id = $1", [orgId]);
    return r.rows.map((row) => {
      const rec = asRecord(row);
      return { id: String(rec.id), orgId: String(rec.org_id), name: String(rec.name) };
    });
  }

  async insertEnvironment(row: EnvironmentRecord): Promise<void> {
    await this.#pool.query("INSERT INTO environments (id, vault_id, name) VALUES ($1,$2,$3)", [
      row.id,
      row.vaultId,
      row.name,
    ]);
  }

  async getEnvironment(id: string): Promise<EnvironmentRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM environments WHERE id = $1", [id]);
    return mapEnv(r.rows[0]);
  }

  async getEnvironmentByName(vaultId: string, name: string): Promise<EnvironmentRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM environments WHERE vault_id = $1 AND name = $2", [
      vaultId,
      name,
    ]);
    return mapEnv(r.rows[0]);
  }

  async listEnvironments(vaultId: string): Promise<EnvironmentRecord[]> {
    const r = await this.#pool.query("SELECT * FROM environments WHERE vault_id = $1", [vaultId]);
    return r.rows.map((row) => mapEnv(row)!);
  }

  async insertFolder(row: FolderRecord): Promise<void> {
    await this.#pool.query("INSERT INTO folders (id, environment_id, name) VALUES ($1,$2,$3)", [
      row.id,
      row.environmentId,
      row.name,
    ]);
  }

  async getFolder(id: string): Promise<FolderRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM folders WHERE id = $1", [id]);
    return mapFolder(r.rows[0]);
  }

  async getFolderByName(environmentId: string, name: string): Promise<FolderRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM folders WHERE environment_id = $1 AND name = $2", [
      environmentId,
      name,
    ]);
    return mapFolder(r.rows[0]);
  }

  async insertItem(row: ItemRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO items (
        id, environment_id, folder_id, kind, name, last4, username, allowed_hosts_json,
        inject, iv, ciphertext, tag, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
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
      ],
    );
  }

  async updateItemEnvelope(
    id: string,
    patch: Pick<ItemRecord, "iv" | "ciphertext" | "tag" | "last4" | "updatedAt">,
  ): Promise<void> {
    await this.#pool.query(
      "UPDATE items SET iv=$1, ciphertext=$2, tag=$3, last4=$4, updated_at=$5 WHERE id=$6",
      [patch.iv, patch.ciphertext, patch.tag, patch.last4, patch.updatedAt, id],
    );
  }

  async deleteItem(id: string): Promise<void> {
    await this.#pool.query("DELETE FROM items WHERE id = $1", [id]);
  }

  async getItem(id: string): Promise<ItemRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM items WHERE id = $1", [id]);
    return mapItem(r.rows[0]);
  }

  async getItemByName(environmentId: string, name: string): Promise<ItemRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM items WHERE environment_id = $1 AND name = $2", [
      environmentId,
      name,
    ]);
    return mapItem(r.rows[0]);
  }

  async listItems(environmentId: string): Promise<ItemRecord[]> {
    const r = await this.#pool.query("SELECT * FROM items WHERE environment_id = $1 ORDER BY name", [
      environmentId,
    ]);
    return r.rows.map((row) => mapItem(row)!);
  }

  async countProductionItems(orgId: string): Promise<number> {
    const r = await this.#pool.query(
      `SELECT COUNT(*)::int AS n FROM items i
       JOIN environments e ON e.id = i.environment_id
       JOIN vaults v ON v.id = e.vault_id
       WHERE v.org_id = $1 AND e.name = 'production'`,
      [orgId],
    );
    return Number(asRecord(r.rows[0] ?? { n: 0 }).n);
  }

  async insertClient(row: ClientRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO clients (id, org_id, kind, name, hashed_secret, clerk_oauth_user_id, environment)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        row.id,
        row.orgId,
        row.kind,
        row.name,
        row.hashedSecret,
        row.clerkOauthUserId,
        row.environment,
      ],
    );
  }

  async getClient(id: string): Promise<ClientRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM clients WHERE id = $1", [id]);
    return mapClient(r.rows[0]);
  }

  async getClientByHashedSecret(orgId: string, hashedSecret: string): Promise<ClientRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM clients WHERE org_id = $1 AND hashed_secret = $2",
      [orgId, hashedSecret],
    );
    return mapClient(r.rows[0]);
  }

  async findClientByHashedSecret(hashedSecret: string): Promise<ClientRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM clients WHERE hashed_secret = $1", [hashedSecret]);
    return mapClient(r.rows[0]);
  }

  async listClients(orgId: string): Promise<ClientRecord[]> {
    const r = await this.#pool.query("SELECT * FROM clients WHERE org_id = $1", [orgId]);
    return r.rows.map((row) => mapClient(row)!);
  }

  async insertPolicy(row: PolicyRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO policies (id, org_id, client_id, item_id, folder_id, environment_id, kind, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id,
        row.orgId,
        row.clientId,
        row.itemId,
        row.folderId,
        row.environmentId,
        row.kind,
        row.createdAt,
      ],
    );
  }

  async deletePolicy(id: string): Promise<void> {
    await this.#pool.query("DELETE FROM policies WHERE id = $1", [id]);
  }

  async findItemPolicy(orgId: string, clientId: string, itemId: string): Promise<PolicyRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM policies WHERE org_id=$1 AND client_id=$2 AND item_id=$3 AND kind='item_standing'",
      [orgId, clientId, itemId],
    );
    return mapPolicy(r.rows[0]);
  }

  async findFolderPolicy(
    orgId: string,
    clientId: string,
    folderId: string | null,
    environmentId: string,
  ): Promise<PolicyRecord | undefined> {
    const r = await this.#pool.query(
      `SELECT * FROM policies WHERE org_id=$1 AND client_id=$2 AND environment_id=$3
       AND kind='folder_standing' AND ((folder_id IS NULL AND $4::text IS NULL) OR folder_id=$4)`,
      [orgId, clientId, environmentId, folderId],
    );
    return mapPolicy(r.rows[0]);
  }

  async listPoliciesForClient(orgId: string, clientId: string): Promise<PolicyRecord[]> {
    const r = await this.#pool.query("SELECT * FROM policies WHERE org_id=$1 AND client_id=$2", [
      orgId,
      clientId,
    ]);
    return r.rows.map((row) => mapPolicy(row)!);
  }

  async insertGrant(row: HostedGrantRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO grants (
        id, org_id, client_id, item_id, folder_id, environment_id, policy, status,
        expires_at, created_at, approved_at, consumed_at, task_id, task_description
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
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
      ],
    );
  }

  async getGrant(id: string): Promise<HostedGrantRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM grants WHERE id = $1", [id]);
    return mapGrant(r.rows[0]);
  }

  async listGrants(orgId: string): Promise<HostedGrantRecord[]> {
    const r = await this.#pool.query("SELECT * FROM grants WHERE org_id=$1 ORDER BY created_at DESC", [
      orgId,
    ]);
    return r.rows.map((row) => mapGrant(row)!);
  }

  async listPendingGrants(orgId: string): Promise<HostedGrantRecord[]> {
    const r = await this.#pool.query(
      "SELECT * FROM grants WHERE org_id=$1 AND status='pending' ORDER BY created_at DESC",
      [orgId],
    );
    return r.rows.map((row) => mapGrant(row)!);
  }

  async updateGrant(row: HostedGrantRecord): Promise<void> {
    await this.#pool.query(
      `UPDATE grants SET status=$1, policy=$2, expires_at=$3, approved_at=$4, consumed_at=$5,
       item_id=$6, folder_id=$7, task_id=$8, task_description=$9 WHERE id=$10`,
      [
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
      ],
    );
  }

  async consumeGrant(id: string, consumedAt: string): Promise<boolean> {
    const r = await this.#pool.query(
      "UPDATE grants SET status='consumed', consumed_at=$1 WHERE id=$2 AND status='active'",
      [consumedAt, id],
    );
    return r.rowCount === 1;
  }

  async insertChallenge(row: ApprovalChallengeRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO approval_challenges (id, grant_id, code_hash, expires_at, attempts, kind)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.id, row.grantId, row.codeHash, row.expiresAt, row.attempts, row.kind],
    );
  }

  async getChallenge(id: string): Promise<ApprovalChallengeRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM approval_challenges WHERE id=$1", [id]);
    return mapChallenge(r.rows[0]);
  }

  async getChallengeByGrant(grantId: string): Promise<ApprovalChallengeRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM approval_challenges WHERE grant_id=$1 ORDER BY expires_at DESC LIMIT 1",
      [grantId],
    );
    return mapChallenge(r.rows[0]);
  }

  async getChallengeByGrantKind(
    grantId: string,
    kind: ApprovalChallengeRecord["kind"],
  ): Promise<ApprovalChallengeRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM approval_challenges WHERE grant_id=$1 AND kind=$2 ORDER BY expires_at DESC LIMIT 1",
      [grantId, kind],
    );
    return mapChallenge(r.rows[0]);
  }

  async updateChallenge(row: ApprovalChallengeRecord): Promise<void> {
    await this.#pool.query("UPDATE approval_challenges SET attempts=$1 WHERE id=$2", [
      row.attempts,
      row.id,
    ]);
  }

  async deleteChallenge(id: string): Promise<void> {
    await this.#pool.query("DELETE FROM approval_challenges WHERE id=$1", [id]);
  }

  async insertAudit(row: HostedAuditRecord): Promise<void> {
    await this.#pool.query(
      "INSERT INTO audit (id, org_id, action, actor, item_name, client_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [row.id, row.orgId, row.action, row.actor, row.itemName, row.clientId, row.at],
    );
  }

  async listAudit(orgId: string, limit = 200): Promise<HostedAuditRecord[]> {
    const r = await this.#pool.query(
      "SELECT * FROM audit WHERE org_id=$1 ORDER BY at DESC LIMIT $2",
      [orgId, limit],
    );
    return r.rows.map((row) => {
      const rec = asRecord(row);
      return {
        id: String(rec.id),
        orgId: String(rec.org_id),
        action: String(rec.action),
        actor: String(rec.actor),
        itemName: rec.item_name == null ? null : String(rec.item_name),
        clientId: rec.client_id == null ? null : String(rec.client_id),
        at: String(rec.at),
      };
    });
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
    await this.#pool.query(
      `INSERT INTO agentpass_passes (id, org_id, status, holder_cnf, scope_json, task_id, created_at, consumed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id,
        row.orgId,
        row.status,
        row.holderCnf,
        row.scopeJson,
        row.taskId,
        row.createdAt,
        row.consumedAt,
      ],
    );
  }

  async getAgentPass(id: string) {
    const r = await this.#pool.query("SELECT * FROM agentpass_passes WHERE id=$1", [id]);
    const rec = r.rows[0] ? asRecord(r.rows[0]) : undefined;
    if (!rec) return undefined;
    return {
      id: String(rec.id),
      orgId: String(rec.org_id),
      status: String(rec.status),
      holderCnf: rec.holder_cnf == null ? null : String(rec.holder_cnf),
      scopeJson: String(rec.scope_json),
      taskId: rec.task_id == null ? null : String(rec.task_id),
      createdAt: String(rec.created_at),
      consumedAt: rec.consumed_at == null ? null : String(rec.consumed_at),
    };
  }

  async updateAgentPassStatus(id: string, status: string): Promise<void> {
    await this.#pool.query("UPDATE agentpass_passes SET status=$1 WHERE id=$2", [status, id]);
  }

  async consumeAgentPass(id: string, consumedAt: string): Promise<boolean> {
    const r = await this.#pool.query(
      "UPDATE agentpass_passes SET status='consumed', consumed_at=$1 WHERE id=$2 AND status='approved'",
      [consumedAt, id],
    );
    return r.rowCount === 1;
  }

  async listAgentPasses(orgId: string) {
    const r = await this.#pool.query(
      "SELECT * FROM agentpass_passes WHERE org_id=$1 ORDER BY created_at DESC",
      [orgId],
    );
    return r.rows.map((row) => {
      const rec = asRecord(row);
      return {
        id: String(rec.id),
        orgId: String(rec.org_id),
        status: String(rec.status),
        holderCnf: rec.holder_cnf == null ? null : String(rec.holder_cnf),
        scopeJson: String(rec.scope_json),
        taskId: rec.task_id == null ? null : String(rec.task_id),
        createdAt: String(rec.created_at),
        consumedAt: rec.consumed_at == null ? null : String(rec.consumed_at),
      };
    });
  }
}

function mapEnv(row: unknown): EnvironmentRecord | undefined {
  if (!row) return undefined;
  const rec = asRecord(row);
  return {
    id: String(rec.id),
    vaultId: String(rec.vault_id),
    name: rec.name as EnvironmentRecord["name"],
  };
}

function mapFolder(row: unknown): FolderRecord | undefined {
  if (!row) return undefined;
  const rec = asRecord(row);
  return { id: String(rec.id), environmentId: String(rec.environment_id), name: String(rec.name) };
}

function mapItem(row: unknown): ItemRecord | undefined {
  if (!row) return undefined;
  const rec = asRecord(row);
  return {
    id: String(rec.id),
    environmentId: String(rec.environment_id),
    folderId: rec.folder_id == null ? null : String(rec.folder_id),
    kind: rec.kind as ItemRecord["kind"],
    name: String(rec.name),
    last4: String(rec.last4),
    username: rec.username == null ? null : String(rec.username),
    allowedHostsJson: String(rec.allowed_hosts_json),
    inject: String(rec.inject),
    iv: String(rec.iv),
    ciphertext: String(rec.ciphertext),
    tag: String(rec.tag),
    createdAt: String(rec.created_at),
    updatedAt: String(rec.updated_at),
  };
}

function mapClient(row: unknown): ClientRecord | undefined {
  if (!row) return undefined;
  const rec = asRecord(row);
  return {
    id: String(rec.id),
    orgId: String(rec.org_id),
    kind: rec.kind as ClientRecord["kind"],
    name: String(rec.name),
    hashedSecret: rec.hashed_secret == null ? null : String(rec.hashed_secret),
    clerkOauthUserId: rec.clerk_oauth_user_id == null ? null : String(rec.clerk_oauth_user_id),
    environment: rec.environment as ClientRecord["environment"],
  };
}

function mapPolicy(row: unknown): PolicyRecord | undefined {
  if (!row) return undefined;
  const rec = asRecord(row);
  return {
    id: String(rec.id),
    orgId: String(rec.org_id),
    clientId: String(rec.client_id),
    itemId: rec.item_id == null ? null : String(rec.item_id),
    folderId: rec.folder_id == null ? null : String(rec.folder_id),
    environmentId: String(rec.environment_id),
    kind: rec.kind as PolicyRecord["kind"],
    createdAt: String(rec.created_at),
  };
}

function mapGrant(row: unknown): HostedGrantRecord | undefined {
  if (!row) return undefined;
  const rec = asRecord(row);
  return {
    id: String(rec.id),
    orgId: String(rec.org_id),
    clientId: String(rec.client_id),
    itemId: rec.item_id == null ? null : String(rec.item_id),
    folderId: rec.folder_id == null ? null : String(rec.folder_id),
    environmentId: String(rec.environment_id),
    policy: rec.policy as HostedGrantRecord["policy"],
    status: rec.status as HostedGrantRecord["status"],
    expiresAt: rec.expires_at == null ? null : String(rec.expires_at),
    createdAt: String(rec.created_at),
    approvedAt: rec.approved_at == null ? null : String(rec.approved_at),
    consumedAt: rec.consumed_at == null ? null : String(rec.consumed_at),
    taskId: rec.task_id == null ? null : String(rec.task_id),
    taskDescription: rec.task_description == null ? null : String(rec.task_description),
  };
}

function mapChallenge(row: unknown): ApprovalChallengeRecord | undefined {
  if (!row) return undefined;
  const rec = asRecord(row);
  return {
    id: String(rec.id),
    grantId: String(rec.grant_id),
    codeHash: String(rec.code_hash),
    expiresAt: String(rec.expires_at),
    attempts: Number(rec.attempts),
    kind: rec.kind as ApprovalChallengeRecord["kind"],
  };
}
