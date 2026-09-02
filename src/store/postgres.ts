import { Pool } from "pg";
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
  OperatorSessionRecord,
  OrgRecord,
  PersistFulfillInput,
  PolicyRecord,
  UserRecord,
  VaultRecord,
} from "../hosted-types.ts";
import { isUniqueViolation, StoreConflictError } from "./conflict.ts";
import { HOSTED_SCHEMA_IDENTITY, HOSTED_SCHEMA_IDENTITY_ALTER_PG, HOSTED_SCHEMA_SQLITE } from "./schema.ts";
import { mapClientRow } from "./map-client.ts";
import type { AuditListFilter, VaultStore } from "./types.ts";

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
    await this.#pool.query(HOSTED_SCHEMA_IDENTITY);
    await this.#pool.query(HOSTED_SCHEMA_IDENTITY_ALTER_PG);
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

  async listOrgs(): Promise<OrgRecord[]> {
    const r = await this.#pool.query("SELECT * FROM orgs");
    return r.rows.map((row) => {
      const rec = asRecord(row);
      return {
        id: String(rec.id),
        name: String(rec.name),
        wrappedDekIv: String(rec.wrapped_dek_iv),
        wrappedDekCiphertext: String(rec.wrapped_dek_ciphertext),
        wrappedDekTag: String(rec.wrapped_dek_tag),
        createdAt: String(rec.created_at),
      };
    });
  }

  async updateOrgWrappedDek(
    id: string,
    patch: Pick<OrgRecord, "wrappedDekIv" | "wrappedDekCiphertext" | "wrappedDekTag">,
  ): Promise<void> {
    await this.#pool.query(
      `UPDATE orgs SET wrapped_dek_iv = $1, wrapped_dek_ciphertext = $2, wrapped_dek_tag = $3 WHERE id = $4`,
      [patch.wrappedDekIv, patch.wrappedDekCiphertext, patch.wrappedDekTag, id],
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
      await client.query("DELETE FROM need_items WHERE org_id = $1", [orgId]);
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

  async updateItemMeta(
    id: string,
    patch: Pick<
      ItemRecord,
      "name" | "kind" | "environmentId" | "username" | "inject" | "allowedHostsJson" | "updatedAt"
    >,
  ): Promise<void> {
    await this.#pool.query(
      "UPDATE items SET name=$1, kind=$2, environment_id=$3, username=$4, inject=$5, allowed_hosts_json=$6, updated_at=$7 WHERE id=$8",
      [
        patch.name,
        patch.kind,
        patch.environmentId,
        patch.username,
        patch.inject,
        patch.allowedHostsJson,
        patch.updatedAt,
        id,
      ],
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
      `INSERT INTO clients (id, org_id, kind, name, hashed_secret, clerk_oauth_user_id, environment,
        oauth_client_id, revoked_at, last_token_at, last_seen_at, last4, consented_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
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
      ],
    );
  }

  async updateClientHashedSecret(id: string, hashedSecret: string, tokenLast4: string): Promise<void> {
    await this.#pool.query("UPDATE clients SET hashed_secret = $1, last4 = $2 WHERE id = $3", [
      hashedSecret,
      tokenLast4,
      id,
    ]);
  }

  async incrementRateHit(orgId: string, kind: "grant" | "need", windowStart: string): Promise<number> {
    const r = await this.#pool.query(
      `INSERT INTO rate_hits (org_id, kind, window_start, count) VALUES ($1,$2,$3,1)
       ON CONFLICT (org_id, kind, window_start) DO UPDATE SET count = rate_hits.count + 1
       RETURNING count`,
      [orgId, kind, windowStart],
    );
    return Number(asRecord(r.rows[0] ?? { count: 0 }).count);
  }

  async countRateHits(orgId: string, kind: "grant" | "need", windowStart: string): Promise<number> {
    const r = await this.#pool.query(
      "SELECT count FROM rate_hits WHERE org_id = $1 AND kind = $2 AND window_start = $3",
      [orgId, kind, windowStart],
    );
    if (!r.rows[0]) return 0;
    return Number(asRecord(r.rows[0]).count);
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

  async findClientByOauthId(oauthClientId: string): Promise<ClientRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM clients WHERE oauth_client_id = $1 OR clerk_oauth_user_id = $1 LIMIT 1",
      [oauthClientId],
    );
    return r.rows[0] ? mapClient(r.rows[0]) : undefined;
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

  async reactivateGrant(id: string): Promise<boolean> {
    const r = await this.#pool.query(
      "UPDATE grants SET status='active', consumed_at=NULL WHERE id=$1 AND status='consumed' AND policy='prompt'",
      [id],
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

  async listAudit(orgId: string, limit = 200, filter?: AuditListFilter): Promise<HostedAuditRecord[]> {
    const clauses = ["org_id=$1"];
    const params: Array<string | number> = [orgId];
    if (filter?.clientId) {
      params.push(filter.clientId);
      clauses.push(`client_id=$${params.length}`);
    }
    if (filter?.itemName) {
      params.push(filter.itemName);
      clauses.push(`item_name=$${params.length}`);
    }
    if (filter?.action) {
      params.push(filter.action);
      clauses.push(`action=$${params.length}`);
    }
    params.push(limit);
    const r = await this.#pool.query(
      `SELECT * FROM audit WHERE ${clauses.join(" AND ")} ORDER BY at DESC LIMIT $${params.length}`,
      params,
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

  async insertPendingNeed(row: NeedItemRecord): Promise<NeedItemRecord> {
    try {
      await this.#pool.query(
        `INSERT INTO need_items (
          id, org_id, client_id, environment_id, suggested_name, host, task_description,
          status, item_id, grant_id, expires_at, created_at, fulfilled_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        needValues(row),
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
    const r = await this.#pool.query("SELECT * FROM need_items WHERE id = $1", [id]);
    return mapNeed(r.rows[0]);
  }

  async getPendingNeed(input: {
    orgId: string;
    clientId: string;
    environmentId: string;
    suggestedName: string;
    host: string;
  }): Promise<NeedItemRecord | undefined> {
    const r = await this.#pool.query(
      `SELECT * FROM need_items WHERE org_id=$1 AND client_id=$2 AND environment_id=$3
       AND suggested_name=$4 AND host=$5 AND status='pending'`,
      [input.orgId, input.clientId, input.environmentId, input.suggestedName, input.host],
    );
    return mapNeed(r.rows[0]);
  }

  async listPendingNeeds(orgId: string): Promise<NeedItemRecord[]> {
    const r = await this.#pool.query(
      "SELECT * FROM need_items WHERE org_id=$1 AND status='pending' ORDER BY created_at DESC",
      [orgId],
    );
    return r.rows.map((row) => mapNeed(row)!);
  }

  async cancelNeed(id: string): Promise<void> {
    await this.#pool.query(
      "UPDATE need_items SET status='cancelled' WHERE id=$1 AND status='pending'",
      [id],
    );
  }

  async refreshNeedExpires(id: string, expiresAt: string): Promise<void> {
    await this.#pool.query(
      "UPDATE need_items SET expires_at=$1 WHERE id=$2 AND status='pending'",
      [expiresAt, id],
    );
  }

  async persistFulfill(input: PersistFulfillInput): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO items (
          id, environment_id, folder_id, kind, name, last4, username, allowed_hosts_json,
          inject, iv, ciphertext, tag, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        itemValues(input.item),
      );
      await client.query(
        `INSERT INTO grants (
          id, org_id, client_id, item_id, folder_id, environment_id, policy, status,
          expires_at, created_at, approved_at, consumed_at, task_id, task_description
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        grantValues(input.grant),
      );
      const claimed = await client.query(
        `UPDATE need_items SET status='fulfilled', item_id=$1, grant_id=$2, fulfilled_at=$3
         WHERE id=$4 AND status='pending'`,
        [input.item.id, input.grant.id, input.fulfilledAt, input.needId],
      );
      if (claimed.rowCount !== 1) {
        throw new StoreConflictError("Need is not pending");
      }
      await client.query(
        "INSERT INTO audit (id, org_id, action, actor, item_name, client_id, at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          input.audit.id,
          input.audit.orgId,
          input.audit.action,
          input.audit.actor,
          input.audit.itemName,
          input.audit.clientId,
          input.audit.at,
        ],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof StoreConflictError) throw err;
      if (isUniqueViolation(err)) {
        throw new StoreConflictError("Item name already exists in this environment");
      }
      throw err;
    } finally {
      client.release();
    }
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

  async listMembers(orgId: string): Promise<MemberRecord[]> {
    const r = await this.#pool.query("SELECT * FROM org_members WHERE org_id = $1", [orgId]);
    return r.rows.map((row) => {
      const rec = asRecord(row);
      return {
        orgId: String(rec.org_id),
        userId: String(rec.user_id),
        role: rec.role as MemberRecord["role"],
      };
    });
  }

  async listMembershipsForUser(userId: string): Promise<MemberRecord[]> {
    const r = await this.#pool.query("SELECT * FROM org_members WHERE user_id = $1", [userId]);
    return r.rows.map((row) => {
      const rec = asRecord(row);
      return {
        orgId: String(rec.org_id),
        userId: String(rec.user_id),
        role: rec.role as MemberRecord["role"],
      };
    });
  }

  async upsertOidcPayload(row: { id: string; kind: string; payload: string; expiresAt: string | null }): Promise<void> {
    await this.#pool.query(
      `INSERT INTO oidc_payloads (id, kind, payload, expires_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id, kind) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
      [row.id, row.kind, row.payload, row.expiresAt],
    );
  }

  async getOidcPayload(id: string, kind: string): Promise<{ payload: string; expiresAt: string | null } | undefined> {
    const r = await this.#pool.query("SELECT * FROM oidc_payloads WHERE id = $1 AND kind = $2", [id, kind]);
    if (!r.rows[0]) return undefined;
    const rec = asRecord(r.rows[0]);
    return {
      payload: String(rec.payload),
      expiresAt: rec.expires_at == null ? null : String(rec.expires_at),
    };
  }

  async deleteOidcPayload(id: string, kind: string): Promise<void> {
    await this.#pool.query("DELETE FROM oidc_payloads WHERE id = $1 AND kind = $2", [id, kind]);
  }

  async listOidcPayloads(kind: string): Promise<{ id: string; payload: string }[]> {
    const r = await this.#pool.query("SELECT id, payload FROM oidc_payloads WHERE kind = $1", [kind]);
    return r.rows.map((row) => {
      const rec = asRecord(row);
      return { id: String(rec.id), payload: String(rec.payload) };
    });
  }

  async insertUser(row: UserRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO users (id, email, email_verified_at, totp_wrapped_iv, totp_wrapped_ciphertext, totp_wrapped_tag, totp_last_step, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        row.id, row.email, row.emailVerifiedAt, row.totpWrappedIv, row.totpWrappedCiphertext,
        row.totpWrappedTag, row.totpLastStep, row.createdAt,
      ],
    );
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return r.rows[0] ? mapUserPg(asRecord(r.rows[0])) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    return r.rows[0] ? mapUserPg(asRecord(r.rows[0])) : undefined;
  }

  async updateUser(row: UserRecord): Promise<void> {
    await this.#pool.query(
      `UPDATE users SET email_verified_at=$1, totp_wrapped_iv=$2, totp_wrapped_ciphertext=$3,
       totp_wrapped_tag=$4, totp_last_step=$5 WHERE id=$6`,
      [row.emailVerifiedAt, row.totpWrappedIv, row.totpWrappedCiphertext, row.totpWrappedTag, row.totpLastStep, row.id],
    );
  }

  async insertEmailOtp(row: EmailOtpRecord): Promise<void> {
    await this.#pool.query(
      "INSERT INTO email_otp_challenges (id, email, code_scrypt, expires_at, attempts, sent_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [row.id, row.email, row.codeScrypt, row.expiresAt, row.attempts, row.sentAt],
    );
  }

  async latestEmailOtp(email: string): Promise<EmailOtpRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM email_otp_challenges WHERE email = $1 ORDER BY sent_at DESC LIMIT 1",
      [email.toLowerCase()],
    );
    return r.rows[0] ? mapOtpPg(asRecord(r.rows[0])) : undefined;
  }

  async updateEmailOtp(row: EmailOtpRecord): Promise<void> {
    await this.#pool.query("UPDATE email_otp_challenges SET attempts=$1, expires_at=$2 WHERE id=$3", [
      row.attempts,
      row.expiresAt,
      row.id,
    ]);
  }

  async countEmailOtpSince(email: string, sinceIso: string): Promise<number> {
    const r = await this.#pool.query(
      "SELECT COUNT(*)::int AS n FROM email_otp_challenges WHERE email = $1 AND sent_at >= $2",
      [email.toLowerCase(), sinceIso],
    );
    return Number(asRecord(r.rows[0] ?? { n: 0 }).n);
  }

  async insertBackupCode(userId: string, codeScrypt: string): Promise<void> {
    await this.#pool.query("INSERT INTO backup_codes (user_id, code_scrypt) VALUES ($1,$2)", [userId, codeScrypt]);
  }

  async listBackupCodes(userId: string): Promise<{ codeScrypt: string; usedAt: string | null }[]> {
    const r = await this.#pool.query("SELECT * FROM backup_codes WHERE user_id = $1", [userId]);
    return r.rows.map((row) => {
      const rec = asRecord(row);
      return {
        codeScrypt: String(rec.code_scrypt),
        usedAt: rec.used_at == null ? null : String(rec.used_at),
      };
    });
  }

  async markBackupUsed(userId: string, codeScrypt: string, usedAt: string): Promise<void> {
    await this.#pool.query(
      "UPDATE backup_codes SET used_at = $1 WHERE user_id = $2 AND code_scrypt = $3 AND used_at IS NULL",
      [usedAt, userId, codeScrypt],
    );
  }

  async insertSession(row: OperatorSessionRecord): Promise<void> {
    await this.#pool.query(
      "INSERT INTO operator_sessions (id_hash, user_id, created_at, last_seen_at, expires_at) VALUES ($1,$2,$3,$4,$5)",
      [row.idHash, row.userId, row.createdAt, row.lastSeenAt, row.expiresAt],
    );
  }

  async getSession(idHash: string): Promise<OperatorSessionRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM operator_sessions WHERE id_hash = $1", [idHash]);
    return r.rows[0] ? mapSessPg(asRecord(r.rows[0])) : undefined;
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.#pool.query("DELETE FROM operator_sessions WHERE id_hash = $1", [idHash]);
  }

  async deleteOtherSessions(userId: string, keepHash: string): Promise<void> {
    await this.#pool.query("DELETE FROM operator_sessions WHERE user_id = $1 AND id_hash != $2", [userId, keepHash]);
  }

  async listOperatorSessions(orgId: string): Promise<OperatorSessionRecord[]> {
    const r = await this.#pool.query(
      `SELECT s.* FROM operator_sessions s JOIN org_members m ON m.user_id = s.user_id WHERE m.org_id = $1`,
      [orgId],
    );
    return r.rows.map((row) => mapSessPg(asRecord(row)));
  }

  async touchSession(idHash: string, lastSeenAt: string, expiresAt: string): Promise<void> {
    await this.#pool.query("UPDATE operator_sessions SET last_seen_at=$1, expires_at=$2 WHERE id_hash=$3", [
      lastSeenAt,
      expiresAt,
      idHash,
    ]);
  }

  async insertAccessEvent(row: AccessEventRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO access_events (id, org_id, client_id, actor_user_id, kind, jti_hash, issued_at, expires_at, revoked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.id, row.orgId, row.clientId, row.actorUserId, row.kind, row.jtiHash,
        row.issuedAt, row.expiresAt, row.revokedAt,
      ],
    );
  }

  async listAccessEvents(orgId: string, limit = 200): Promise<AccessEventRecord[]> {
    const r = await this.#pool.query(
      "SELECT * FROM access_events WHERE org_id = $1 ORDER BY issued_at DESC LIMIT $2",
      [orgId, limit],
    );
    return r.rows.map((row) => mapAccessPg(asRecord(row)));
  }

  async getAccessEventByJti(jtiHash: string): Promise<AccessEventRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM access_events WHERE jti_hash = $1", [jtiHash]);
    return r.rows[0] ? mapAccessPg(asRecord(r.rows[0])) : undefined;
  }

  async revokeAccessEventsForClient(clientId: string, at: string): Promise<void> {
    await this.#pool.query(
      "UPDATE access_events SET revoked_at = $1 WHERE client_id = $2 AND revoked_at IS NULL",
      [at, clientId],
    );
  }

  async revokeAccessEvent(jtiHash: string, at: string): Promise<void> {
    await this.#pool.query("UPDATE access_events SET revoked_at = $1 WHERE jti_hash = $2", [at, jtiHash]);
  }

  async setClientRevoked(id: string, at: string): Promise<void> {
    await this.#pool.query("UPDATE clients SET revoked_at = $1 WHERE id = $2", [at, id]);
  }

  async touchClientLastSeen(id: string, at: string): Promise<void> {
    await this.#pool.query(
      `UPDATE clients SET last_seen_at = $1 WHERE id = $2 AND (last_seen_at IS NULL OR last_seen_at < $3)`,
      [at, id, new Date(Date.parse(at) - 60_000).toISOString()],
    );
  }

  async setClientLastTokenAt(id: string, at: string): Promise<void> {
    await this.#pool.query("UPDATE clients SET last_token_at = $1 WHERE id = $2", [at, id]);
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
  return mapClientRow(asRecord(row));
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

function mapUserPg(rec: Record<string, unknown>): UserRecord {
  return {
    id: String(rec.id),
    email: String(rec.email),
    emailVerifiedAt: rec.email_verified_at == null ? null : String(rec.email_verified_at),
    totpWrappedIv: rec.totp_wrapped_iv == null ? null : String(rec.totp_wrapped_iv),
    totpWrappedCiphertext: rec.totp_wrapped_ciphertext == null ? null : String(rec.totp_wrapped_ciphertext),
    totpWrappedTag: rec.totp_wrapped_tag == null ? null : String(rec.totp_wrapped_tag),
    totpLastStep: rec.totp_last_step == null ? null : Number(rec.totp_last_step),
    createdAt: String(rec.created_at),
  };
}

function mapOtpPg(rec: Record<string, unknown>): EmailOtpRecord {
  return {
    id: String(rec.id),
    email: String(rec.email),
    codeScrypt: String(rec.code_scrypt),
    expiresAt: String(rec.expires_at),
    attempts: Number(rec.attempts),
    sentAt: String(rec.sent_at),
  };
}

function mapSessPg(rec: Record<string, unknown>): OperatorSessionRecord {
  return {
    idHash: String(rec.id_hash),
    userId: String(rec.user_id),
    createdAt: String(rec.created_at),
    lastSeenAt: String(rec.last_seen_at),
    expiresAt: String(rec.expires_at),
  };
}

function mapAccessPg(rec: Record<string, unknown>): AccessEventRecord {
  return {
    id: String(rec.id),
    orgId: String(rec.org_id),
    clientId: rec.client_id == null ? null : String(rec.client_id),
    actorUserId: rec.actor_user_id == null ? null : String(rec.actor_user_id),
    kind: rec.kind as AccessEventRecord["kind"],
    jtiHash: String(rec.jti_hash),
    issuedAt: String(rec.issued_at),
    expiresAt: rec.expires_at == null ? null : String(rec.expires_at),
    revokedAt: rec.revoked_at == null ? null : String(rec.revoked_at),
  };
}

function mapNeed(row: unknown): NeedItemRecord | undefined {
  if (!row) return undefined;
  const rec = asRecord(row);
  return {
    id: String(rec.id),
    orgId: String(rec.org_id),
    clientId: String(rec.client_id),
    environmentId: String(rec.environment_id),
    suggestedName: String(rec.suggested_name),
    host: String(rec.host),
    taskDescription: rec.task_description == null ? null : String(rec.task_description),
    status: rec.status as NeedItemRecord["status"],
    itemId: rec.item_id == null ? null : String(rec.item_id),
    grantId: rec.grant_id == null ? null : String(rec.grant_id),
    expiresAt: String(rec.expires_at),
    createdAt: String(rec.created_at),
    fulfilledAt: rec.fulfilled_at == null ? null : String(rec.fulfilled_at),
  };
}

function needValues(row: NeedItemRecord): unknown[] {
  return [
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
  ];
}

function itemValues(row: ItemRecord): unknown[] {
  return [
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
  ];
}

function grantValues(row: HostedGrantRecord): unknown[] {
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
  ];
}
