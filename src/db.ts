import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function dbPath(home: string): string {
  return join(home, "vault.sqlite");
}

export function openDb(home: string): DatabaseSync {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath(home));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
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
  created_at: string;
  updated_at: string;
};

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

export function upsertSecret(
  db: DatabaseSync,
  row: {
    name: string;
    iv: string;
    ciphertext: string;
    tag: string;
    last4: string;
    at: string;
  },
): SecretMeta {
  const existing = db
    .prepare("SELECT created_at FROM secrets WHERE name = ?")
    .get(row.name) as { created_at: string } | undefined;
  const createdAt = existing?.created_at ?? row.at;
  db.prepare(
    `INSERT INTO secrets (name, iv, ciphertext, tag, last4, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       iv = excluded.iv,
       ciphertext = excluded.ciphertext,
       tag = excluded.tag,
       last4 = excluded.last4,
       updated_at = excluded.updated_at`,
  ).run(row.name, row.iv, row.ciphertext, row.tag, row.last4, createdAt, row.at);
  return {
    name: row.name,
    last4: row.last4,
    createdAt,
    updatedAt: row.at,
  };
}

export function listSecretMeta(db: DatabaseSync): SecretMeta[] {
  const rows = db
    .prepare(
      "SELECT name, last4, created_at, updated_at FROM secrets ORDER BY name",
    )
    .all() as Pick<SecretRow, "name" | "last4" | "created_at" | "updated_at">[];
  return rows.map((r) => ({
    name: r.name,
    last4: r.last4,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getSecretEnvelope(
  db: DatabaseSync,
  name: string,
): { iv: string; ciphertext: string; tag: string; last4: string } | undefined {
  const row = db
    .prepare("SELECT iv, ciphertext, tag, last4 FROM secrets WHERE name = ?")
    .get(name) as Pick<SecretRow, "iv" | "ciphertext" | "tag" | "last4"> | undefined;
  return row;
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

export function dirnameOf(path: string): string {
  return dirname(path);
}
