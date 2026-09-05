/**
 * Row mappers and insert value lists shared by the SQLite and Postgres stores. Every column the
 * hosted schema stores is TEXT or INTEGER in both engines, so one mapper per record type reads
 * either driver's row. Each store keeps its own SQL (placeholder syntax differs) and its own
 * "row or undefined" handling; the mapping itself is written once here.
 */
import type {
  AccessEventRecord,
  ApprovalChallengeRecord,
  EmailOtpRecord,
  EnvironmentRecord,
  FolderRecord,
  HostedGrantRecord,
  ItemRecord,
  MemberRecord,
  NeedItemRecord,
  OrgRecord,
  PolicyRecord,
  VaultRecord,
} from "../hosted-types.ts";
import {
  parseCallsUsed,
  parseNullableInt,
  parseRequestedScope,
  parseScopeList,
  requestedScopeJson,
  scopeListJson,
  type IdentityKeyRecord,
  type InviteRecord,
  type MemberRow,
  type OidcPayloadRow,
  type OperatorSessionRow,
  type UserRow,
} from "./types.ts";

export type Row = Record<string, unknown>;

function text(v: unknown): string | null {
  return v == null ? null : String(v);
}

export function mapOrg(r: Row): OrgRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    wrappedDekIv: String(r.wrapped_dek_iv),
    wrappedDekCiphertext: String(r.wrapped_dek_ciphertext),
    wrappedDekTag: String(r.wrapped_dek_tag),
    createdAt: String(r.created_at),
    createdBy: text(r.created_by),
  };
}

export function mapVault(r: Row): VaultRecord {
  return { id: String(r.id), orgId: String(r.org_id), name: String(r.name) };
}

export function mapEnv(r: Row): EnvironmentRecord {
  return { id: String(r.id), vaultId: String(r.vault_id), name: r.name as EnvironmentRecord["name"] };
}

export function mapFolder(r: Row): FolderRecord {
  return { id: String(r.id), environmentId: String(r.environment_id), name: String(r.name) };
}

export function mapMemberRecord(r: Row): MemberRecord {
  return { orgId: String(r.org_id), userId: String(r.user_id), role: r.role as MemberRecord["role"] };
}

export function mapMember(r: Row): MemberRow {
  return { ...mapMemberRecord(r), joinedAt: text(r.joined_at) };
}

export function mapItem(r: Row): ItemRecord {
  return {
    id: String(r.id),
    environmentId: String(r.environment_id),
    folderId: text(r.folder_id),
    kind: r.kind as ItemRecord["kind"],
    name: String(r.name),
    last4: String(r.last4),
    username: text(r.username),
    allowedHostsJson: String(r.allowed_hosts_json),
    inject: String(r.inject),
    iv: String(r.iv),
    ciphertext: String(r.ciphertext),
    tag: String(r.tag),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function mapGrant(r: Row): HostedGrantRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    clientId: String(r.client_id),
    itemId: text(r.item_id),
    folderId: text(r.folder_id),
    environmentId: String(r.environment_id),
    policy: r.policy as HostedGrantRecord["policy"],
    status: r.status as HostedGrantRecord["status"],
    expiresAt: text(r.expires_at),
    createdAt: String(r.created_at),
    approvedAt: text(r.approved_at),
    consumedAt: text(r.consumed_at),
    taskId: text(r.task_id),
    taskDescription: text(r.task_description),
    methods: parseScopeList(r.methods),
    pathPrefixes: parseScopeList(r.path_prefixes),
    hosts: parseScopeList(r.hosts),
    maxCalls: parseNullableInt(r.max_calls),
    callsUsed: parseCallsUsed(r.calls_used),
    requestedScope: parseRequestedScope(r.requested_scope_json),
  };
}

export function mapPolicy(r: Row): PolicyRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    clientId: String(r.client_id),
    itemId: text(r.item_id),
    folderId: text(r.folder_id),
    environmentId: String(r.environment_id),
    kind: r.kind as PolicyRecord["kind"],
    createdAt: String(r.created_at),
    methods: parseScopeList(r.methods),
    pathPrefixes: parseScopeList(r.path_prefixes),
    hosts: parseScopeList(r.hosts),
    maxCalls: parseNullableInt(r.max_calls),
    callsUsed: parseCallsUsed(r.calls_used),
    expiresAt: text(r.expires_at),
  };
}

export function mapChallenge(r: Row): ApprovalChallengeRecord {
  return {
    id: String(r.id),
    grantId: String(r.grant_id),
    codeHash: String(r.code_hash),
    expiresAt: String(r.expires_at),
    attempts: Number(r.attempts),
    kind: r.kind as ApprovalChallengeRecord["kind"],
  };
}

export function mapNeed(r: Row): NeedItemRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    clientId: String(r.client_id),
    environmentId: String(r.environment_id),
    suggestedName: String(r.suggested_name),
    host: String(r.host),
    taskDescription: text(r.task_description),
    status: r.status as NeedItemRecord["status"],
    itemId: text(r.item_id),
    grantId: text(r.grant_id),
    expiresAt: String(r.expires_at),
    createdAt: String(r.created_at),
    fulfilledAt: text(r.fulfilled_at),
  };
}

export function mapInvite(r: Row): InviteRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    email: String(r.email),
    role: r.role as InviteRecord["role"],
    tokenHash: String(r.token_hash),
    invitedBy: String(r.invited_by),
    createdAt: String(r.created_at),
    expiresAt: String(r.expires_at),
    acceptedAt: text(r.accepted_at),
  };
}

export function mapOidcRow(r: Row): OidcPayloadRow {
  return { id: String(r.id), payload: String(r.payload), expiresAt: text(r.expires_at) };
}

export function mapUser(r: Row): UserRow {
  return {
    id: String(r.id),
    email: String(r.email),
    emailVerifiedAt: text(r.email_verified_at),
    totpWrappedIv: text(r.totp_wrapped_iv),
    totpWrappedCiphertext: text(r.totp_wrapped_ciphertext),
    totpWrappedTag: text(r.totp_wrapped_tag),
    totpLastStep: r.totp_last_step == null ? null : Number(r.totp_last_step),
    createdAt: String(r.created_at),
    totpFailures: r.totp_failures == null ? 0 : Number(r.totp_failures),
    totpLockedUntil: text(r.totp_locked_until),
    totpPendingWrappedIv: text(r.totp_pending_wrapped_iv),
    totpPendingWrappedCiphertext: text(r.totp_pending_wrapped_ciphertext),
    totpPendingWrappedTag: text(r.totp_pending_wrapped_tag),
    totpPendingAt: text(r.totp_pending_at),
  };
}

export function mapIdentityKey(r: Row): IdentityKeyRecord {
  return {
    id: String(r.id),
    wrappedIv: String(r.wrapped_iv),
    wrappedCiphertext: String(r.wrapped_ciphertext),
    wrappedTag: String(r.wrapped_tag),
    createdAt: String(r.created_at),
  };
}

export function mapOtp(r: Row): EmailOtpRecord {
  return {
    id: String(r.id),
    email: String(r.email),
    codeScrypt: String(r.code_scrypt),
    expiresAt: String(r.expires_at),
    attempts: Number(r.attempts),
    sentAt: String(r.sent_at),
  };
}

export function mapSess(r: Row): OperatorSessionRow {
  return {
    idHash: String(r.id_hash),
    userId: String(r.user_id),
    createdAt: String(r.created_at),
    lastSeenAt: String(r.last_seen_at),
    expiresAt: String(r.expires_at),
    mfaAt: text(r.mfa_at),
    activeOrgId: text(r.active_org_id),
  };
}

export function mapAccess(r: Row): AccessEventRecord {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    clientId: text(r.client_id),
    actorUserId: text(r.actor_user_id),
    kind: r.kind as AccessEventRecord["kind"],
    jtiHash: String(r.jti_hash),
    issuedAt: String(r.issued_at),
    expiresAt: text(r.expires_at),
    revokedAt: text(r.revoked_at),
    grantId: text(r.grant_id),
  };
}

/* ---- insert column lists and value tuples (same order in both stores) ---- */

/**
 * `items.aad_version` written by every kernel insert and envelope update: the envelope is bound
 * to orgId|itemId|allowed_hosts_json|inject. Rows at 0 predate the column and are rebound at boot.
 */
export const ITEM_AAD_VERSION = 1;

export const ITEM_INSERT_COLUMNS =
  "id, environment_id, folder_id, kind, name, last4, username, allowed_hosts_json, inject, iv, ciphertext, tag, created_at, updated_at, aad_version";

export function itemValues(row: ItemRecord): (string | number | null)[] {
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
    ITEM_AAD_VERSION,
  ];
}

export const NEED_INSERT_COLUMNS =
  "id, org_id, client_id, environment_id, suggested_name, host, task_description, status, item_id, grant_id, expires_at, created_at, fulfilled_at";

export function needValues(row: NeedItemRecord): (string | null)[] {
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

export const GRANT_INSERT_COLUMNS =
  "id, org_id, client_id, item_id, folder_id, environment_id, policy, status, expires_at, created_at, approved_at, consumed_at, task_id, task_description, methods, path_prefixes, hosts, max_calls, calls_used, requested_scope_json";

export function grantValues(row: HostedGrantRecord): (string | number | null)[] {
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

/** `n` positional placeholders: `?, ?, ?` for SQLite, `$1,$2,$3` for Postgres. */
export function placeholders(n: number, style: "sqlite" | "pg"): string {
  return Array.from({ length: n }, (_, i) => (style === "pg" ? `$${i + 1}` : "?")).join(", ");
}
