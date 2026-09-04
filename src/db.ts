import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuditAction, AuditRecord, GrantRecord, GrantScope, GrantStatus, SecretMeta } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vault_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tag TEXT NOT NULL,
  last4 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  secret_name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  secret_name TEXT,
  agent_id TEXT,
  tool_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS grants_lookup
  ON grants (secret_name, agent_id, tool_id, status);
CREATE INDEX IF NOT EXISTS audit_created ON audit (created_at);
`;

/** Local items carry the same connector metadata as hosted items (3.8): hosts, mode, username. */
export type LocalItemMeta = SecretMeta & { allowedHosts: string[]; inject: string; username: string | null };

export const LOCAL_DEFAULT_INJECT = "bearer";

/** Bumped when `migrateLocalSchema` gains a step; stored in `vault_meta.local_schema`. */
export const LOCAL_SCHEMA_VERSION = "3";

export function dbPath(home: string): string {
  return join(home, "vault.sqlite");
}

/**
 * Expand-only migration on open, like `aad_version` in vault.ts. Version 2 adds the connector
 * columns to `secrets`; version 3 adds `username` (HTTP Basic user, OAuth client id, AWS access
 * key id). The column check makes a half-applied run safe to repeat.
 */
function migrateLocalSchema(db: DatabaseSync): void {
  if (getMeta(db, "local_schema") === LOCAL_SCHEMA_VERSION) return;
  const columns = new Set(
    (db.prepare("PRAGMA table_info(secrets)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!columns.has("allowed_hosts_json")) {
    db.exec("ALTER TABLE secrets ADD COLUMN allowed_hosts_json TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has("inject")) {
    db.exec(`ALTER TABLE secrets ADD COLUMN inject TEXT NOT NULL DEFAULT '${LOCAL_DEFAULT_INJECT}'`);
  }
  if (!columns.has("username")) {
    db.exec("ALTER TABLE secrets ADD COLUMN username TEXT");
  }
  setMeta(db, "local_schema", LOCAL_SCHEMA_VERSION);
}

export function openDb(home: string): DatabaseSync {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath(home));
  db.exec("PRAGMA journal_mode = WAL;");
  // A second writer (`vault serve` next to `vault set`) waits up to 5 s for the lock instead of
  // failing at once with "database is locked" (the default busy_timeout is 0).
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrateLocalSchema(db);
  return db;
}

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

type SecretRow = {
  name: string;
  iv: string;
  ciphertext: string;
  tag: string;
  last4: string;
  allowed_hosts_json: string;
  inject: string;
  username: string | null;
  created_at: string;
  updated_at: string;
};

type MetaRow = Pick<SecretRow, "name" | "last4" | "allowed_hosts_json" | "inject" | "username" | "created_at" | "updated_at">;
const META_COLUMNS = "name, last4, allowed_hosts_json, inject, username, created_at, updated_at";

function parseHostsJson(json: unknown): string[] {
  if (typeof json !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
}

type GrantRow = {
  id: string;
  secret_name: string;
  agent_id: string;
  tool_id: string;
  scope: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  approved_at: string | null;
  revoked_at: string | null;
};

type AuditRow = {
  id: string;
  action: string;
  actor: string;
  secret_name: string | null;
  agent_id: string | null;
  tool_id: string | null;
  created_at: string;
};

export function getMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM vault_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO vault_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/**
 * Insert or re-encrypt a secret. `allowedHosts`, `inject`, and `username` replace the stored
 * values when given and are kept otherwise, so a plain `vault set NAME` rotation does not drop
 * the hosts. `username: null` clears it.
 */
export function upsertSecret(
  db: DatabaseSync,
  row: {
    name: string;
    iv: string;
    ciphertext: string;
    tag: string;
    last4: string;
    at: string;
    allowedHosts?: string[];
    inject?: string;
    username?: string | null;
  },
): LocalItemMeta {
  const existing = db
    .prepare("SELECT created_at, allowed_hosts_json, inject, username FROM secrets WHERE name = ?")
    .get(row.name) as Pick<SecretRow, "created_at" | "allowed_hosts_json" | "inject" | "username"> | undefined;
  const createdAt = existing?.created_at ?? row.at;
  const allowedHosts = row.allowedHosts ?? parseHostsJson(existing?.allowed_hosts_json);
  const inject = row.inject ?? existing?.inject ?? LOCAL_DEFAULT_INJECT;
  const username = row.username !== undefined ? row.username : existing?.username ?? null;
  db.prepare(
    `INSERT INTO secrets (name, iv, ciphertext, tag, last4, allowed_hosts_json, inject, username, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       iv = excluded.iv,
       ciphertext = excluded.ciphertext,
       tag = excluded.tag,
       last4 = excluded.last4,
       allowed_hosts_json = excluded.allowed_hosts_json,
       inject = excluded.inject,
       username = excluded.username,
       updated_at = excluded.updated_at`,
  ).run(row.name, row.iv, row.ciphertext, row.tag, row.last4, JSON.stringify(allowedHosts), inject, username, createdAt, row.at);
  return {
    name: row.name,
    last4: row.last4,
    allowedHosts,
    inject,
    username,
    createdAt,
    updatedAt: row.at,
  };
}

function mapMeta(r: MetaRow): LocalItemMeta {
  return {
    name: r.name,
    last4: r.last4,
    allowedHosts: parseHostsJson(r.allowed_hosts_json),
    inject: r.inject,
    username: r.username ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listSecretMeta(db: DatabaseSync): LocalItemMeta[] {
  const rows = db.prepare(`SELECT ${META_COLUMNS} FROM secrets ORDER BY name`).all() as MetaRow[];
  return rows.map(mapMeta);
}

export function getSecretMeta(db: DatabaseSync, name: string): LocalItemMeta | undefined {
  const row = db.prepare(`SELECT ${META_COLUMNS} FROM secrets WHERE name = ?`).get(name) as MetaRow | undefined;
  return row ? mapMeta(row) : undefined;
}

/** Items whose `allowed_hosts` list the exact hostname (lowercased). */
export function findSecretsByHost(db: DatabaseSync, host: string): LocalItemMeta[] {
  const wanted = host.trim().toLowerCase();
  return listSecretMeta(db).filter((m) => m.allowedHosts.includes(wanted));
}

export type SecretEnvelopeRow = {
  iv: string;
  ciphertext: string;
  tag: string;
  last4: string;
  allowedHosts: string[];
  inject: string;
  username: string | null;
};

export function getSecretEnvelope(db: DatabaseSync, name: string): SecretEnvelopeRow | undefined {
  const row = db
    .prepare("SELECT iv, ciphertext, tag, last4, allowed_hosts_json, inject, username FROM secrets WHERE name = ?")
    .get(name) as Pick<SecretRow, "iv" | "ciphertext" | "tag" | "last4" | "allowed_hosts_json" | "inject" | "username"> | undefined;
  if (!row) return undefined;
  return {
    iv: row.iv,
    ciphertext: row.ciphertext,
    tag: row.tag,
    last4: row.last4,
    allowedHosts: parseHostsJson(row.allowed_hosts_json),
    inject: row.inject,
    username: row.username ?? null,
  };
}

export function listSecretEnvelopes(
  db: DatabaseSync,
): { name: string; iv: string; ciphertext: string; tag: string; last4: string }[] {
  return db
    .prepare("SELECT name, iv, ciphertext, tag, last4 FROM secrets ORDER BY name")
    .all() as Pick<SecretRow, "name" | "iv" | "ciphertext" | "tag" | "last4">[];
}

export function insertGrant(db: DatabaseSync, grant: GrantRecord): void {
  db.prepare(
    `INSERT INTO grants (
      id, secret_name, agent_id, tool_id, scope, status,
      expires_at, created_at, approved_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    grant.id,
    grant.secretName,
    grant.agentId,
    grant.toolId,
    grant.scope,
    grant.status,
    grant.expiresAt,
    grant.createdAt,
    grant.approvedAt,
    grant.revokedAt,
  );
}

export function updateGrant(
  db: DatabaseSync,
  id: string,
  patch: Partial<
    Pick<GrantRecord, "status" | "scope" | "expiresAt" | "approvedAt" | "revokedAt">
  >,
): void {
  const current = getGrant(db, id);
  if (!current) throw new Error(`Unknown grant ${id}`);
  const next = { ...current, ...patch };
  db.prepare(
    `UPDATE grants SET status = ?, scope = ?, expires_at = ?, approved_at = ?, revoked_at = ?
     WHERE id = ?`,
  ).run(next.status, next.scope, next.expiresAt, next.approvedAt, next.revokedAt, id);
}

function mapGrant(row: GrantRow): GrantRecord {
  return {
    id: row.id,
    secretName: row.secret_name,
    agentId: row.agent_id,
    toolId: row.tool_id,
    scope: row.scope as GrantScope,
    status: row.status as GrantStatus,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    revokedAt: row.revoked_at,
  };
}

export function getGrant(db: DatabaseSync, id: string): GrantRecord | undefined {
  const row = db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as
    | GrantRow
    | undefined;
  return row ? mapGrant(row) : undefined;
}

export function findOpenGrant(
  db: DatabaseSync,
  secretName: string,
  agentId: string,
  toolId: string,
): GrantRecord | undefined {
  const row = db
    .prepare(
      `SELECT * FROM grants
       WHERE secret_name = ? AND agent_id = ? AND tool_id = ?
         AND status IN ('pending', 'active')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(secretName, agentId, toolId) as GrantRow | undefined;
  return row ? mapGrant(row) : undefined;
}

export function listGrants(db: DatabaseSync): GrantRecord[] {
  const rows = db
    .prepare("SELECT * FROM grants ORDER BY created_at DESC")
    .all() as GrantRow[];
  return rows.map(mapGrant);
}

export function insertAudit(
  db: DatabaseSync,
  row: {
    id: string;
    action: AuditAction;
    actor: string;
    secretName: string | null;
    agentId: string | null;
    toolId: string | null;
    at: string;
  },
): void {
  db.prepare(
    `INSERT INTO audit (id, action, actor, secret_name, agent_id, tool_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.action, row.actor, row.secretName, row.agentId, row.toolId, row.at);
}

export function listAudit(db: DatabaseSync, limit = 200): AuditRecord[] {
  const rows = db
    .prepare("SELECT * FROM audit ORDER BY created_at DESC LIMIT ?")
    .all(limit) as AuditRow[];
  return rows.map((r) => ({
    id: r.id,
    action: r.action as AuditAction,
    actor: r.actor,
    secretName: r.secret_name,
    agentId: r.agent_id,
    toolId: r.tool_id,
    createdAt: r.created_at,
  }));
}
