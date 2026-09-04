import { Pool, type PoolConfig } from "pg";
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
  HOSTED_SCHEMA_IDENTITY_ALTER_PG,
  HOSTED_SCHEMA_IDENTITY_ALTER2_PG,
  HOSTED_SCHEMA_IDENTITY_INDEXES,
  HOSTED_SCHEMA_OAUTH_ALTER_PG,
  HOSTED_SCHEMA_SCOPE_ALTER_PG,
  HOSTED_SCHEMA_SQLITE,
  HOSTED_SCHEMA_TEAM,
  HOSTED_SCHEMA_TEAM_ALTER_PG,
} from "./schema.ts";
import { mapClientRow } from "./map-client.ts";
import {
  GRANT_INSERT_COLUMNS,
  grantValues,
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
  type MemberRow,
  type OidcPayloadRow,
  type OperatorSessionRow,
  type SweepCounts,
  type UserRow,
  type UserSecurityState,
  type VaultStore,
} from "./types.ts";

function asRecord(row: unknown): Record<string, unknown> {
  return row as Record<string, unknown>;
}

/** `rows[0]` may be absent; map it when present. */
function opt<T>(row: unknown, map: (r: Record<string, unknown>) => T): T | undefined {
  return row ? map(asRecord(row)) : undefined;
}

const GRANT_INSERT_SQL = `INSERT INTO grants (${GRANT_INSERT_COLUMNS}) VALUES (${placeholders(20, "pg")})`;

export type PostgresOpenOptions = {
  /** Suffix for application_name (`botpasses-<plane>`), visible in pg_stat_activity. */
  plane?: string;
  /** Override the pool size (default 10). */
  max?: number;
  /** Per-statement timeout in ms (default 15 s). */
  statementTimeoutMs?: number;
};

export class PostgresStore implements VaultStore {
  readonly #pool: Pool;
  constructor(pool: Pool) {
    this.#pool = pool;
  }

  static poolOptions(connectionString: string, opts: PostgresOpenOptions = {}): PoolConfig {
    const statementTimeout = opts.statementTimeoutMs ?? 15_000;
    return {
      connectionString,
      max: opts.max ?? 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      application_name: `botpasses-${opts.plane ?? "hosted"}`,
      statement_timeout: statementTimeout,
      options: `-c statement_timeout=${statementTimeout}`,
    };
  }

  /**
   * Connect and make sure the schema is present. Throws (does not exit) on a bad URL or an
   * unreachable database; the caller decides the exit code.
   */
  static async open(connectionString: string, opts: PostgresOpenOptions = {}): Promise<PostgresStore> {
    const pool = new Pool(PostgresStore.poolOptions(connectionString, opts));
    // Without this a lost connection in the idle pool becomes an uncaught 'error' event.
    pool.on("error", (err) => {
      console.error(JSON.stringify({ event: "pg_pool_error", message: err.message, at: new Date().toISOString() }));
    });
    const store = new PostgresStore(pool);
    try {
      await store.migrate();
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
    return store;
  }

  /**
   * If `schema_migrations` exists, scripts/migrate.ts (the Fly release_command) owns DDL and
   * this is a no-op. Otherwise this is a dev/test database: bootstrap from the schema.ts
   * constants, as before, and say so.
   */
  async migrate(): Promise<void> {
    const r = await this.#pool.query<{ ok: boolean }>(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS ok",
    );
    if (r.rows[0]?.ok) return;
    await this.#pool.query(HOSTED_SCHEMA_SQLITE);
    await this.#pool.query(HOSTED_SCHEMA_IDENTITY);
    await this.#pool.query(HOSTED_SCHEMA_IDENTITY_ALTER_PG);
    await this.#pool.query(HOSTED_SCHEMA_IDENTITY_ALTER2_PG);
    await this.#pool.query(HOSTED_SCHEMA_OAUTH_ALTER_PG);
    await this.#pool.query(HOSTED_SCHEMA_SCOPE_ALTER_PG);
    await this.#pool.query(HOSTED_SCHEMA_IDENTITY_INDEXES);
    await this.#pool.query(HOSTED_SCHEMA_TEAM);
    await this.#pool.query(HOSTED_SCHEMA_TEAM_ALTER_PG);
    console.error(JSON.stringify({ event: "schema_bootstrap", source: "schema.ts", at: new Date().toISOString() }));
  }

  async ping(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  async sweepExpired(nowIso: string): Promise<SweepCounts> {
    const dayAgo = new Date(Date.parse(nowIso) - 24 * 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.parse(nowIso) - 2 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.parse(nowIso) - 7 * 24 * 60 * 60 * 1000).toISOString();
    const count = async (sql: string, params: string[]): Promise<number> => {
      const res = await this.#pool.query(sql, params);
      return res.rowCount ?? 0;
    };
    return {
      emailOtpChallenges: await count("DELETE FROM email_otp_challenges WHERE expires_at < $1", [nowIso]),
      operatorSessions: await count("DELETE FROM operator_sessions WHERE expires_at < $1", [nowIso]),
      approvalChallenges: await count("DELETE FROM approval_challenges WHERE expires_at < $1", [nowIso]),
      needItems: await count(
        `DELETE FROM need_items
         WHERE (status = 'cancelled' AND created_at < $1)
            OR (status = 'pending' AND expires_at < $1)`,
        [dayAgo],
      ),
      rateHits: await count("DELETE FROM rate_hits WHERE window_start < $1", [twoHoursAgo]),
      oidcPayloads: await count("DELETE FROM oidc_payloads WHERE expires_at IS NOT NULL AND expires_at < $1", [
        nowIso,
      ]),
      orgInvites: await count("DELETE FROM org_invites WHERE accepted_at IS NULL AND expires_at < $1", [weekAgo]),
    };
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
    return r.rows.map((row) => mapOrg(asRecord(row)));
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
    return opt(r.rows[0], mapOrg);
  }

  async deleteOrg(orgId: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM oidc_payloads WHERE account_id IN (
           SELECT user_id FROM org_members WHERE org_id = $1
         ) AND (
           client_id IN (SELECT id FROM clients WHERE org_id = $1)
           OR (client_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM org_members m2 WHERE m2.user_id = oidc_payloads.account_id AND m2.org_id <> $1
           ))
         )`,
        [orgId],
      );
      await client.query("DELETE FROM access_events WHERE org_id = $1", [orgId]);
      await client.query("DELETE FROM rate_hits WHERE org_id = $1", [orgId]);
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
      await client.query("DELETE FROM org_invites WHERE org_id = $1", [orgId]);
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

  async insertMember(row: MemberRecord & { joinedAt?: string }): Promise<void> {
    await this.#pool.query("INSERT INTO org_members (org_id, user_id, role, joined_at) VALUES ($1,$2,$3,$4)", [
      row.orgId,
      row.userId,
      row.role,
      row.joinedAt ?? null,
    ]);
  }

  async getMember(orgId: string, userId: string): Promise<MemberRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM org_members WHERE org_id = $1 AND user_id = $2",
      [orgId, userId],
    );
    return opt(r.rows[0], mapMemberRecord);
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
    return r.rows.map((row) => mapVault(asRecord(row)));
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
    return opt(r.rows[0], mapEnv);
  }

  async getEnvironmentByName(vaultId: string, name: string): Promise<EnvironmentRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM environments WHERE vault_id = $1 AND name = $2", [
      vaultId,
      name,
    ]);
    return opt(r.rows[0], mapEnv);
  }

  async listEnvironments(vaultId: string): Promise<EnvironmentRecord[]> {
    const r = await this.#pool.query("SELECT * FROM environments WHERE vault_id = $1", [vaultId]);
    return r.rows.map((row) => mapEnv(asRecord(row)));
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
    return opt(r.rows[0], mapFolder);
  }

  async getFolderByName(environmentId: string, name: string): Promise<FolderRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM folders WHERE environment_id = $1 AND name = $2", [
      environmentId,
      name,
    ]);
    return opt(r.rows[0], mapFolder);
  }

  async insertItem(row: ItemRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO items (${ITEM_INSERT_COLUMNS}) VALUES (${placeholders(14, "pg")})`,
      itemValues(row),
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
    return opt(r.rows[0], mapItem);
  }

  async getItemByName(environmentId: string, name: string): Promise<ItemRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM items WHERE environment_id = $1 AND name = $2", [
      environmentId,
      name,
    ]);
    return opt(r.rows[0], mapItem);
  }

  async listItems(environmentId: string): Promise<ItemRecord[]> {
    const r = await this.#pool.query("SELECT * FROM items WHERE environment_id = $1 ORDER BY name", [
      environmentId,
    ]);
    return r.rows.map((row) => mapItem(asRecord(row)));
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

  async updateClientEnvironment(id: string, environment: VaultEnvName): Promise<void> {
    await this.#pool.query("UPDATE clients SET environment = $1 WHERE id = $2", [environment, id]);
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
    return opt(r.rows[0], mapClientRow);
  }

  async findClientByHashedSecret(hashedSecret: string): Promise<ClientRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM clients WHERE hashed_secret = $1", [hashedSecret]);
    return opt(r.rows[0], mapClientRow);
  }

  async listClients(orgId: string): Promise<ClientRecord[]> {
    const r = await this.#pool.query("SELECT * FROM clients WHERE org_id = $1", [orgId]);
    return r.rows.map((row) => mapClientRow(asRecord(row)));
  }

  async findClientByOauthId(oauthClientId: string): Promise<ClientRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM clients WHERE oauth_client_id = $1 OR clerk_oauth_user_id = $1 LIMIT 1",
      [oauthClientId],
    );
    return opt(r.rows[0], mapClientRow);
  }

  async insertPolicy(row: PolicyRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO policies (
        id, org_id, client_id, item_id, folder_id, environment_id, kind, created_at,
        methods, path_prefixes, hosts, max_calls, calls_used, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
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
      ],
    );
  }

  async recordPolicyCall(id: string): Promise<boolean> {
    const r = await this.#pool.query(
      "UPDATE policies SET calls_used = calls_used + 1 WHERE id=$1 AND (max_calls IS NULL OR calls_used < max_calls)",
      [id],
    );
    return r.rowCount === 1;
  }

  async deletePolicy(id: string): Promise<void> {
    await this.#pool.query("DELETE FROM policies WHERE id = $1", [id]);
  }

  async findItemPolicy(orgId: string, clientId: string, itemId: string): Promise<PolicyRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM policies WHERE org_id=$1 AND client_id=$2 AND item_id=$3 AND kind='item_standing'",
      [orgId, clientId, itemId],
    );
    return opt(r.rows[0], mapPolicy);
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
    return opt(r.rows[0], mapPolicy);
  }

  async listPoliciesForClient(orgId: string, clientId: string): Promise<PolicyRecord[]> {
    const r = await this.#pool.query("SELECT * FROM policies WHERE org_id=$1 AND client_id=$2", [
      orgId,
      clientId,
    ]);
    return r.rows.map((row) => mapPolicy(asRecord(row)));
  }

  async insertGrant(row: HostedGrantRecord): Promise<void> {
    await this.#pool.query(GRANT_INSERT_SQL, grantValues(row));
  }

  async getGrant(id: string): Promise<HostedGrantRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM grants WHERE id = $1", [id]);
    return opt(r.rows[0], mapGrant);
  }

  async listGrants(orgId: string): Promise<HostedGrantRecord[]> {
    const r = await this.#pool.query("SELECT * FROM grants WHERE org_id=$1 ORDER BY created_at DESC", [
      orgId,
    ]);
    return r.rows.map((row) => mapGrant(asRecord(row)));
  }

  async listPendingGrants(orgId: string): Promise<HostedGrantRecord[]> {
    const r = await this.#pool.query(
      "SELECT * FROM grants WHERE org_id=$1 AND status='pending' ORDER BY created_at DESC",
      [orgId],
    );
    return r.rows.map((row) => mapGrant(asRecord(row)));
  }

  async updateGrant(row: HostedGrantRecord): Promise<void> {
    await this.#pool.query(
      `UPDATE grants SET status=$1, policy=$2, expires_at=$3, approved_at=$4, consumed_at=$5,
       item_id=$6, folder_id=$7, task_id=$8, task_description=$9,
       methods=$10, path_prefixes=$11, hosts=$12, max_calls=$13, requested_scope_json=$14 WHERE id=$15`,
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
        scopeListJson(row.methods),
        scopeListJson(row.pathPrefixes),
        scopeListJson(row.hosts),
        row.maxCalls,
        requestedScopeJson(row.requestedScope),
        row.id,
      ],
    );
  }

  async recordGrantCall(id: string, at: string): Promise<boolean> {
    const r = await this.#pool.query(
      `UPDATE grants SET
         calls_used = calls_used + 1,
         status = CASE WHEN max_calls IS NOT NULL AND calls_used + 1 >= max_calls THEN 'consumed' ELSE status END,
         consumed_at = CASE WHEN max_calls IS NOT NULL AND calls_used + 1 >= max_calls THEN $1 ELSE consumed_at END
       WHERE id=$2 AND status='active' AND (max_calls IS NULL OR calls_used < max_calls)`,
      [at, id],
    );
    return r.rowCount === 1;
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
    return opt(r.rows[0], mapChallenge);
  }

  async getChallengeByGrant(grantId: string): Promise<ApprovalChallengeRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM approval_challenges WHERE grant_id=$1 ORDER BY expires_at DESC LIMIT 1",
      [grantId],
    );
    return opt(r.rows[0], mapChallenge);
  }

  async getChallengeByGrantKind(
    grantId: string,
    kind: ApprovalChallengeRecord["kind"],
  ): Promise<ApprovalChallengeRecord | undefined> {
    const r = await this.#pool.query(
      "SELECT * FROM approval_challenges WHERE grant_id=$1 AND kind=$2 ORDER BY expires_at DESC LIMIT 1",
      [grantId, kind],
    );
    return opt(r.rows[0], mapChallenge);
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
        `INSERT INTO need_items (${NEED_INSERT_COLUMNS}) VALUES (${placeholders(13, "pg")})`,
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
    return opt(r.rows[0], mapNeed);
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
    return opt(r.rows[0], mapNeed);
  }

  async listPendingNeeds(orgId: string): Promise<NeedItemRecord[]> {
    const r = await this.#pool.query(
      "SELECT * FROM need_items WHERE org_id=$1 AND status='pending' ORDER BY created_at DESC",
      [orgId],
    );
    return r.rows.map((row) => mapNeed(asRecord(row)));
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
        `INSERT INTO items (${ITEM_INSERT_COLUMNS}) VALUES (${placeholders(14, "pg")})`,
        itemValues(input.item),
      );
      await client.query(GRANT_INSERT_SQL, grantValues(input.grant));
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

  async listMembers(orgId: string): Promise<MemberRow[]> {
    const r = await this.#pool.query("SELECT * FROM org_members WHERE org_id = $1 ORDER BY joined_at, user_id", [orgId]);
    return r.rows.map((row) => mapMember(asRecord(row)));
  }

  async listMembershipsForUser(userId: string): Promise<MemberRecord[]> {
    const r = await this.#pool.query(
      "SELECT * FROM org_members WHERE user_id = $1 ORDER BY joined_at NULLS FIRST, org_id",
      [userId],
    );
    return r.rows.map((row) => {
      const rec = asRecord(row);
      return {
        orgId: String(rec.org_id),
        userId: String(rec.user_id),
        role: rec.role as MemberRecord["role"],
      };
    });
  }

  async listMemberEmails(orgId: string): Promise<string[]> {
    const r = await this.#pool.query(
      `SELECT u.email AS email FROM org_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 AND u.email_verified_at IS NOT NULL ORDER BY u.email`,
      [orgId],
    );
    return r.rows.map((row) => String(asRecord(row).email));
  }

  async upsertOidcPayload(row: { id: string; kind: string; payload: string; expiresAt: string | null }): Promise<void> {
    const idx = oidcPayloadIndex(row.payload);
    await this.#pool.query(
      `INSERT INTO oidc_payloads (id, kind, payload, expires_at, uid, user_code, grant_id, client_id, account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id, kind) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at,
         uid = excluded.uid, user_code = excluded.user_code, grant_id = excluded.grant_id,
         client_id = excluded.client_id, account_id = excluded.account_id`,
      [row.id, row.kind, row.payload, row.expiresAt, idx.uid, idx.userCode, idx.grantId, idx.clientId, idx.accountId],
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

  async getUser(id: string): Promise<UserRow | undefined> {
    const r = await this.#pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return r.rows[0] ? mapUser(asRecord(r.rows[0])) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserRow | undefined> {
    const r = await this.#pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
    return r.rows[0] ? mapUser(asRecord(r.rows[0])) : undefined;
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
    // A resend expires the previous challenge in the same instant; the live one sorts first.
    const r = await this.#pool.query(
      "SELECT * FROM email_otp_challenges WHERE email = $1 ORDER BY sent_at DESC, expires_at DESC LIMIT 1",
      [email.toLowerCase()],
    );
    return r.rows[0] ? mapOtp(asRecord(r.rows[0])) : undefined;
  }

  async updateEmailOtp(row: EmailOtpRecord): Promise<void> {
    await this.#pool.query("UPDATE email_otp_challenges SET attempts=$1, expires_at=$2 WHERE id=$3", [
      row.attempts,
      row.expiresAt,
      row.id,
    ]);
  }

  async claimOtpAttempt(id: string, nowIso: string, maxAttempts: number): Promise<number | undefined> {
    const r = await this.#pool.query(
      `UPDATE email_otp_challenges SET attempts = attempts + 1
       WHERE id = $1 AND attempts < $2 AND expires_at > $3 RETURNING attempts`,
      [id, maxAttempts, nowIso],
    );
    return r.rows[0] ? Number(asRecord(r.rows[0]).attempts) : undefined;
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

  async markBackupUsed(userId: string, codeScrypt: string, usedAt: string): Promise<boolean> {
    const r = await this.#pool.query(
      "UPDATE backup_codes SET used_at = $1 WHERE user_id = $2 AND code_scrypt = $3 AND used_at IS NULL",
      [usedAt, userId, codeScrypt],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async insertSession(row: OperatorSessionRow): Promise<void> {
    await this.#pool.query(
      "INSERT INTO operator_sessions (id_hash, user_id, created_at, last_seen_at, expires_at, mfa_at, active_org_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [row.idHash, row.userId, row.createdAt, row.lastSeenAt, row.expiresAt, row.mfaAt, row.activeOrgId ?? null],
    );
  }

  async getSession(idHash: string): Promise<OperatorSessionRow | undefined> {
    const r = await this.#pool.query("SELECT * FROM operator_sessions WHERE id_hash = $1", [idHash]);
    return r.rows[0] ? mapSess(asRecord(r.rows[0])) : undefined;
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.#pool.query("DELETE FROM operator_sessions WHERE id_hash = $1", [idHash]);
  }

  async deleteOtherSessions(userId: string, keepHash: string): Promise<void> {
    await this.#pool.query("DELETE FROM operator_sessions WHERE user_id = $1 AND id_hash != $2", [userId, keepHash]);
  }

  async listOperatorSessions(orgId: string): Promise<OperatorSessionRow[]> {
    const r = await this.#pool.query(
      `SELECT s.* FROM operator_sessions s
       WHERE (
         s.active_org_id = $1
         AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = s.active_org_id AND m.user_id = s.user_id)
       ) OR (
         (s.active_org_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = s.active_org_id AND m.user_id = s.user_id))
         AND $1 = (SELECT f.org_id FROM org_members f WHERE f.user_id = s.user_id
                   ORDER BY f.joined_at NULLS FIRST, f.org_id LIMIT 1)
       )`,
      [orgId],
    );
    return r.rows.map((row) => mapSess(asRecord(row)));
  }

  async touchSession(idHash: string, lastSeenAt: string, expiresAt: string): Promise<void> {
    await this.#pool.query("UPDATE operator_sessions SET last_seen_at=$1, expires_at=$2 WHERE id_hash=$3", [
      lastSeenAt,
      expiresAt,
      idHash,
    ]);
  }

  async updateUserSecurity(userId: string, patch: UserSecurityState): Promise<void> {
    await this.#pool.query(
      `UPDATE users SET totp_failures=$1, totp_locked_until=$2, totp_pending_wrapped_iv=$3,
       totp_pending_wrapped_ciphertext=$4, totp_pending_wrapped_tag=$5, totp_pending_at=$6 WHERE id=$7`,
      [
        patch.totpFailures,
        patch.totpLockedUntil,
        patch.totpPendingWrappedIv,
        patch.totpPendingWrappedCiphertext,
        patch.totpPendingWrappedTag,
        patch.totpPendingAt,
        userId,
      ],
    );
  }

  async claimTotpAttempt(userId: string, nowIso: string): Promise<number | undefined> {
    const r = await this.#pool.query(
      `UPDATE users SET
         totp_failures = CASE WHEN totp_locked_until IS NOT NULL THEN 1 ELSE totp_failures + 1 END,
         totp_locked_until = NULL
       WHERE id = $1 AND (totp_locked_until IS NULL OR totp_locked_until <= $2)
       RETURNING totp_failures`,
      [userId, nowIso],
    );
    return r.rows[0] ? Number(asRecord(r.rows[0]).totp_failures) : undefined;
  }

  async consumeTotpStep(userId: string, step: number): Promise<boolean> {
    const r = await this.#pool.query(
      "UPDATE users SET totp_last_step = $1 WHERE id = $2 AND (totp_last_step IS NULL OR totp_last_step < $1)",
      [step, userId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async lockTotp(userId: string, untilIso: string): Promise<void> {
    await this.#pool.query("UPDATE users SET totp_locked_until = $1 WHERE id = $2", [untilIso, userId]);
  }

  async resetTotpFailures(userId: string): Promise<void> {
    await this.#pool.query("UPDATE users SET totp_failures = 0, totp_locked_until = NULL WHERE id = $1", [userId]);
  }

  async listUsersWithTotp(): Promise<UserRow[]> {
    const r = await this.#pool.query(
      "SELECT * FROM users WHERE totp_wrapped_iv IS NOT NULL OR totp_pending_wrapped_iv IS NOT NULL",
    );
    return r.rows.map((row) => mapUser(asRecord(row)));
  }

  async deleteUnusedBackupCodes(userId: string): Promise<void> {
    await this.#pool.query("DELETE FROM backup_codes WHERE user_id = $1 AND used_at IS NULL", [userId]);
  }

  async deletePendingSessions(userId: string, keepHash: string): Promise<void> {
    await this.#pool.query(
      "DELETE FROM operator_sessions WHERE user_id = $1 AND mfa_at IS NULL AND id_hash != $2",
      [userId, keepHash],
    );
  }

  async getIdentityKey(id: string): Promise<IdentityKeyRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM identity_keys WHERE id = $1", [id]);
    return r.rows[0] ? mapIdentityKey(asRecord(r.rows[0])) : undefined;
  }

  async insertIdentityKey(row: IdentityKeyRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO identity_keys (id, wrapped_iv, wrapped_ciphertext, wrapped_tag, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [row.id, row.wrappedIv, row.wrappedCiphertext, row.wrappedTag, row.createdAt],
    );
  }

  async updateIdentityKey(
    id: string,
    patch: Pick<IdentityKeyRecord, "wrappedIv" | "wrappedCiphertext" | "wrappedTag">,
  ): Promise<void> {
    await this.#pool.query(
      "UPDATE identity_keys SET wrapped_iv=$1, wrapped_ciphertext=$2, wrapped_tag=$3 WHERE id=$4",
      [patch.wrappedIv, patch.wrappedCiphertext, patch.wrappedTag, id],
    );
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
    return r.rows.map((row) => mapAccess(asRecord(row)));
  }

  async getAccessEventByJti(jtiHash: string): Promise<AccessEventRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM access_events WHERE jti_hash = $1", [jtiHash]);
    return r.rows[0] ? mapAccess(asRecord(r.rows[0])) : undefined;
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

  async setClientRevoked(id: string, at: string | null): Promise<void> {
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

  async findClientByOrgAndOauthId(orgId: string, oauthClientId: string): Promise<ClientRecord | undefined> {
    const r = await this.#pool.query(
      `SELECT * FROM clients WHERE org_id = $1 AND (oauth_client_id = $2 OR clerk_oauth_user_id = $2)
       ORDER BY (revoked_at IS NOT NULL), id LIMIT 1`,
      [orgId, oauthClientId],
    );
    return opt(r.rows[0], mapClientRow);
  }

  async setClientConsentedBy(id: string, userId: string): Promise<void> {
    await this.#pool.query(
      "UPDATE clients SET consented_by_user_id = $1 WHERE id = $2 AND consented_by_user_id IS NULL",
      [userId, id],
    );
  }

  async findOidcPayloadByUid(kind: string, uid: string): Promise<OidcPayloadRow | undefined> {
    const r = await this.#pool.query(
      "SELECT id, payload, expires_at FROM oidc_payloads WHERE kind = $1 AND uid = $2 LIMIT 1",
      [kind, uid],
    );
    return r.rows[0] ? mapOidcRow(asRecord(r.rows[0])) : undefined;
  }

  async findOidcPayloadByUserCode(kind: string, userCode: string): Promise<OidcPayloadRow | undefined> {
    const r = await this.#pool.query(
      "SELECT id, payload, expires_at FROM oidc_payloads WHERE kind = $1 AND user_code = $2 LIMIT 1",
      [kind, userCode],
    );
    return r.rows[0] ? mapOidcRow(asRecord(r.rows[0])) : undefined;
  }

  async deleteOidcPayloadsByGrantId(kind: string, grantId: string): Promise<void> {
    await this.#pool.query("DELETE FROM oidc_payloads WHERE kind = $1 AND grant_id = $2", [kind, grantId]);
  }

  async deleteOidcPayloadsForClient(kind: string, clientIds: string[], accountId: string | null): Promise<void> {
    if (clientIds.length === 0) return;
    await this.#pool.query(
      `DELETE FROM oidc_payloads WHERE kind = $1 AND client_id = ANY($2::text[])
       AND (($3::text IS NULL AND account_id IS NULL) OR account_id = $3)`,
      [kind, clientIds, accountId],
    );
  }

  async purgeExpiredOidcPayloads(nowIso: string): Promise<number> {
    const r = await this.#pool.query(
      "DELETE FROM oidc_payloads WHERE expires_at IS NOT NULL AND expires_at <= $1",
      [nowIso],
    );
    return r.rowCount ?? 0;
  }

  /* ---- team (3.7) and plan limits (3.9) ---- */

  async removeMember(orgId: string, userId: string): Promise<void> {
    await this.#pool.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
    await this.#pool.query(
      "UPDATE operator_sessions SET active_org_id = NULL WHERE user_id = $1 AND active_org_id = $2",
      [userId, orgId],
    );
  }

  async updateMemberRole(orgId: string, userId: string, role: MemberRow["role"]): Promise<void> {
    await this.#pool.query("UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3", [role, orgId, userId]);
  }

  async insertInvite(row: InviteRecord): Promise<void> {
    await this.#pool.query(
      `INSERT INTO org_invites (id, org_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.id, row.orgId, row.email, row.role, row.tokenHash, row.invitedBy, row.createdAt, row.expiresAt, row.acceptedAt],
    );
  }

  async getInvite(id: string): Promise<InviteRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM org_invites WHERE id = $1", [id]);
    return r.rows[0] ? mapInvite(asRecord(r.rows[0])) : undefined;
  }

  async getInviteByTokenHash(tokenHash: string): Promise<InviteRecord | undefined> {
    const r = await this.#pool.query("SELECT * FROM org_invites WHERE token_hash = $1", [tokenHash]);
    return r.rows[0] ? mapInvite(asRecord(r.rows[0])) : undefined;
  }

  async listInvites(orgId: string): Promise<InviteRecord[]> {
    const r = await this.#pool.query(
      "SELECT * FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL ORDER BY created_at DESC",
      [orgId],
    );
    return r.rows.map((row) => mapInvite(asRecord(row)));
  }

  async acceptInvite(id: string, acceptedAt: string): Promise<void> {
    await this.#pool.query("UPDATE org_invites SET accepted_at = $1 WHERE id = $2 AND accepted_at IS NULL", [
      acceptedAt,
      id,
    ]);
  }

  async deleteInvite(id: string): Promise<void> {
    await this.#pool.query("DELETE FROM org_invites WHERE id = $1", [id]);
  }

  async setSessionActiveOrg(idHash: string, orgId: string | null): Promise<void> {
    await this.#pool.query("UPDATE operator_sessions SET active_org_id = $1 WHERE id_hash = $2", [orgId, idHash]);
  }

  async countAuditSince(orgId: string, action: string, sinceIso: string): Promise<number> {
    const r = await this.#pool.query(
      "SELECT COUNT(*)::int AS n FROM audit WHERE org_id = $1 AND action = $2 AND at >= $3",
      [orgId, action, sinceIso],
    );
    return Number(asRecord(r.rows[0] ?? { n: 0 }).n);
  }

  async countItemsForOrg(orgId: string): Promise<number> {
    const r = await this.#pool.query(
      `SELECT COUNT(*)::int AS n FROM items i
       JOIN environments e ON e.id = i.environment_id
       JOIN vaults v ON v.id = e.vault_id
       WHERE v.org_id = $1`,
      [orgId],
    );
    return Number(asRecord(r.rows[0] ?? { n: 0 }).n);
  }
}
