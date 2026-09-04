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
  MemberRole,
  NeedItemRecord,
  OperatorSessionRecord,
  OrgRecord,
  PersistFulfillInput,
  PolicyRecord,
  RequestedScope,
  UserRecord,
  VaultEnvName,
  VaultRecord,
} from "../hosted-types.ts";

export type AuditListFilter = {
  clientId?: string;
  itemName?: string;
  action?: string;
};

/** Rows deleted per table by `sweepExpired`. */
export type SweepCounts = {
  emailOtpChallenges: number;
  operatorSessions: number;
  approvalChallenges: number;
  needItems: number;
  rateHits: number;
  oidcPayloads: number;
  /** Unaccepted invites more than seven days past `expires_at`. */
  orgInvites: number;
  /** Revoked, consumed, or expired grants settled more than 30 days ago. */
  grants: number;
};

/** An item still bound to the legacy `orgId` AAD (or unrecorded), with the org that owns it. */
export type LegacyAadItem = { item: ItemRecord; orgId: string };

/** Rate limit buckets: `grant` and `need` share the hourly org budget; `approve_code` has its own. */
export type RateHitKind = "grant" | "need" | "approve_code";

/**
 * Identity columns added after `UserRecord` froze (see `HOSTED_SCHEMA_IDENTITY_ALTER2_*`).
 * The TOTP failure counter and lockout, plus the in-flight enrollment secret, wrapped under
 * the identity DEK like the confirmed secret so enrollment survives a restart or second machine.
 */
export type UserSecurityState = {
  totpFailures: number;
  totpLockedUntil: string | null;
  totpPendingWrappedIv: string | null;
  totpPendingWrappedCiphertext: string | null;
  totpPendingWrappedTag: string | null;
  totpPendingAt: string | null;
};

/** A `users` row as read from the store: the frozen record plus the security columns. */
export type UserRow = UserRecord & UserSecurityState;

/**
 * `operator_sessions` row. `mfaAt` is null until the session passed the authenticator step.
 * `activeOrgId` is the org chosen in the switcher (null: the user's first membership); optional
 * on insert so identity code that predates the column keeps compiling.
 */
export type OperatorSessionRow = OperatorSessionRecord & { mfaAt: string | null; activeOrgId?: string | null };

/** `org_members` row as read: `joinedAt` is null for rows written before the column existed. */
export type MemberRow = MemberRecord & { joinedAt: string | null };

/** `org_invites` row. The accept token is never stored, only its sha256. */
export type InviteRecord = {
  id: string;
  orgId: string;
  email: string;
  role: MemberRole;
  tokenHash: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
};

/** Single-row table holding the identity DEK wrapped under the KEK (AAD = id). */
export type IdentityKeyRecord = {
  id: string;
  wrappedIv: string;
  wrappedCiphertext: string;
  wrappedTag: string;
  createdAt: string;
};

export type VaultStore = {
  ping(): Promise<void>;
  close(): Promise<void>;
  /**
   * Delete rows nothing can read again: expired OTP challenges, sessions, approval
   * challenges, and oidc payloads; cancelled/expired needs older than 24 h; rate_hits
   * windows older than 2 h; revoked, consumed, or expired grants settled more than 30 days
   * ago (the audit rows they produced stay). Runs at boot and hourly.
   */
  sweepExpired(nowIso: string): Promise<SweepCounts>;

  insertOrg(row: OrgRecord): Promise<void>;
  getOrg(id: string): Promise<OrgRecord | undefined>;
  listOrgs(): Promise<OrgRecord[]>;
  /** Orgs whose `created_by` is this user, oldest first. */
  listOrgsCreatedBy(userId: string): Promise<OrgRecord[]>;
  updateOrgWrappedDek(
    id: string,
    patch: Pick<OrgRecord, "wrappedDekIv" | "wrappedDekCiphertext" | "wrappedDekTag">,
  ): Promise<void>;
  deleteOrg(orgId: string): Promise<void>;

  /** `joinedAt` is recorded when given; older callers leave it null. */
  insertMember(row: MemberRecord & { joinedAt?: string }): Promise<void>;
  getMember(orgId: string, userId: string): Promise<MemberRecord | undefined>;
  listMembers(orgId: string): Promise<MemberRow[]>;
  listMembershipsForUser(userId: string): Promise<MemberRecord[]>;
  /** Verified member emails for approval notifications. Members without a user row are skipped. */
  listMemberEmails(orgId: string): Promise<string[]>;
  upsertOidcPayload(row: { id: string; kind: string; payload: string; expiresAt: string | null }): Promise<void>;
  getOidcPayload(id: string, kind: string): Promise<{ payload: string; expiresAt: string | null } | undefined>;
  deleteOidcPayload(id: string, kind: string): Promise<void>;
  listOidcPayloads(kind: string): Promise<{ id: string; payload: string }[]>;

  insertVault(row: VaultRecord): Promise<void>;
  listVaults(orgId: string): Promise<VaultRecord[]>;

  insertEnvironment(row: EnvironmentRecord): Promise<void>;
  getEnvironment(id: string): Promise<EnvironmentRecord | undefined>;
  getEnvironmentByName(vaultId: string, name: string): Promise<EnvironmentRecord | undefined>;
  listEnvironments(vaultId: string): Promise<EnvironmentRecord[]>;

  insertFolder(row: FolderRecord): Promise<void>;
  getFolder(id: string): Promise<FolderRecord | undefined>;
  getFolderByName(environmentId: string, name: string): Promise<FolderRecord | undefined>;

  insertItem(row: ItemRecord): Promise<void>;
  /** Writes a bound envelope (`aad_version` becomes current). */
  updateItemEnvelope(
    id: string,
    patch: Pick<ItemRecord, "iv" | "ciphertext" | "tag" | "last4" | "updatedAt">,
  ): Promise<void>;
  updateItemMeta(
    id: string,
    patch: Pick<
      ItemRecord,
      "name" | "kind" | "environmentId" | "username" | "inject" | "allowedHostsJson" | "updatedAt"
    >,
  ): Promise<void>;
  /**
   * Envelope and metadata in one statement, so a re-encryption under new `allowed_hosts_json`
   * or `inject` never lands without the columns it is bound to (or the other way round).
   */
  updateItemEnvelopeAndMeta(
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
  ): Promise<void>;
  /** Items whose `aad_version` is below the current binding, with their org. Boot rebind input. */
  listItemsWithLegacyAad(): Promise<LegacyAadItem[]>;
  /** Marks an envelope verified under the current binding without rewriting it. */
  setItemAadVersion(id: string, version: number): Promise<void>;
  deleteItem(id: string): Promise<void>;
  getItem(id: string): Promise<ItemRecord | undefined>;
  getItemByName(environmentId: string, name: string): Promise<ItemRecord | undefined>;
  listItems(environmentId: string): Promise<ItemRecord[]>;
  countProductionItems(orgId: string): Promise<number>;

  insertClient(row: ClientRecord): Promise<void>;
  getClient(id: string): Promise<ClientRecord | undefined>;
  findClientByHashedSecret(hashedSecret: string): Promise<ClientRecord | undefined>;
  listClients(orgId: string): Promise<ClientRecord[]>;
  findClientByOauthId(oauthClientId: string): Promise<ClientRecord | undefined>;
  updateClientHashedSecret(id: string, hashedSecret: string, tokenLast4: string): Promise<void>;
  updateClientEnvironment(id: string, environment: VaultEnvName): Promise<void>;
  incrementRateHit(orgId: string, kind: RateHitKind, windowStart: string): Promise<number>;
  countRateHits(orgId: string, kind: RateHitKind, windowStart: string): Promise<number>;

  insertPolicy(row: PolicyRecord): Promise<void>;
  deletePolicy(id: string): Promise<void>;
  findItemPolicy(orgId: string, clientId: string, itemId: string): Promise<PolicyRecord | undefined>;
  findFolderPolicy(
    orgId: string,
    clientId: string,
    folderId: string | null,
    environmentId: string,
  ): Promise<PolicyRecord | undefined>;
  listPoliciesForClient(orgId: string, clientId: string): Promise<PolicyRecord[]>;

  insertGrant(row: HostedGrantRecord): Promise<void>;
  getGrant(id: string): Promise<HostedGrantRecord | undefined>;
  listGrants(orgId: string): Promise<HostedGrantRecord[]>;
  listPendingGrants(orgId: string): Promise<HostedGrantRecord[]>;
  /** Every grant for one (client, item) pair, newest first; uses `grants_client_item_status`. */
  listGrantsForPair(orgId: string, clientId: string, itemId: string): Promise<HostedGrantRecord[]>;
  /** Writes every grant column except `calls_used`, which only `recordGrantCall` moves. */
  updateGrant(row: HostedGrantRecord): Promise<void>;
  consumeGrant(id: string, consumedAt: string): Promise<boolean>;
  /** Prompt grants only. Restores an unused inject after a failed origin call. */
  reactivateGrant(id: string): Promise<boolean>;
  /**
   * Counts one call against an active grant's `max_calls` in a single UPDATE; the row becomes
   * `consumed` (with `consumed_at`) when the quota is reached. False when the grant is not
   * active or the quota was already spent, so two racing callers cannot both pass the last call.
   */
  recordGrantCall(id: string, at: string): Promise<boolean>;
  /** Counts one call against a standing policy's `max_calls`. False when spent. */
  recordPolicyCall(id: string): Promise<boolean>;

  insertChallenge(row: ApprovalChallengeRecord): Promise<void>;
  getChallenge(id: string): Promise<ApprovalChallengeRecord | undefined>;
  getChallengeByGrant(grantId: string): Promise<ApprovalChallengeRecord | undefined>;
  getChallengeByGrantKind(
    grantId: string,
    kind: ApprovalChallengeRecord["kind"],
  ): Promise<ApprovalChallengeRecord | undefined>;
  updateChallenge(row: ApprovalChallengeRecord): Promise<void>;
  deleteChallenge(id: string): Promise<void>;

  insertAudit(row: HostedAuditRecord): Promise<void>;
  listAudit(orgId: string, limit?: number, filter?: AuditListFilter): Promise<HostedAuditRecord[]>;

  insertPendingNeed(row: NeedItemRecord): Promise<NeedItemRecord>;
  getNeed(id: string): Promise<NeedItemRecord | undefined>;
  getPendingNeed(input: {
    orgId: string;
    clientId: string;
    environmentId: string;
    suggestedName: string;
    host: string;
  }): Promise<NeedItemRecord | undefined>;
  listPendingNeeds(orgId: string): Promise<NeedItemRecord[]>;
  cancelNeed(id: string): Promise<void>;
  refreshNeedExpires(id: string, expiresAt: string): Promise<void>;
  persistFulfill(input: PersistFulfillInput): Promise<void>;

  insertUser(row: UserRecord): Promise<void>;
  getUser(id: string): Promise<UserRow | undefined>;
  getUserByEmail(email: string): Promise<UserRow | undefined>;
  /** Writes the frozen `UserRecord` columns only; security columns go through `updateUserSecurity`. */
  updateUser(row: UserRecord): Promise<void>;
  insertEmailOtp(row: EmailOtpRecord): Promise<void>;
  latestEmailOtp(email: string): Promise<EmailOtpRecord | undefined>;
  updateEmailOtp(row: EmailOtpRecord): Promise<void>;
  /**
   * Atomically spends one verify attempt on a challenge that is still live (not expired and
   * under `maxAttempts`). Returns the attempt count after the claim, or undefined when the
   * challenge is missing, expired, or exhausted, so concurrent guesses cannot share a slot.
   */
  claimOtpAttempt(id: string, nowIso: string, maxAttempts: number): Promise<number | undefined>;
  countEmailOtpSince(email: string, sinceIso: string): Promise<number>;
  insertBackupCode(userId: string, codeScrypt: string): Promise<void>;
  listBackupCodes(userId: string): Promise<{ codeScrypt: string; usedAt: string | null }[]>;
  /** True when this call consumed the code; false when it was already used (single use under concurrency). */
  markBackupUsed(userId: string, codeScrypt: string, usedAt: string): Promise<boolean>;
  insertSession(row: OperatorSessionRow): Promise<void>;
  getSession(idHash: string): Promise<OperatorSessionRow | undefined>;
  deleteSession(idHash: string): Promise<void>;
  deleteOtherSessions(userId: string, keepHash: string): Promise<void>;
  /**
   * Sessions acting in `orgId`: the session's `active_org_id` when the user is still a member
   * of it, otherwise the user's first membership (the `listMembershipsForUser` order).
   */
  listOperatorSessions(orgId: string): Promise<OperatorSessionRow[]>;
  touchSession(idHash: string, lastSeenAt: string, expiresAt: string): Promise<void>;
  updateUserSecurity(userId: string, patch: UserSecurityState): Promise<void>;
  /**
   * Atomically charges one authenticator attempt: increments `totp_failures` (restarting at 1
   * when a lock has expired, which also clears it). Returns the count after the charge, or
   * undefined while the user is locked or unknown.
   */
  claimTotpAttempt(userId: string, nowIso: string): Promise<number | undefined>;
  /** Replay guard: records `step` only when it is newer than the last accepted one. True when accepted. */
  consumeTotpStep(userId: string, step: number): Promise<boolean>;
  lockTotp(userId: string, untilIso: string): Promise<void>;
  resetTotpFailures(userId: string): Promise<void>;
  /** Users with a confirmed or pending authenticator secret (for KEK rotation re-wraps). */
  listUsersWithTotp(): Promise<UserRow[]>;
  deleteUnusedBackupCodes(userId: string): Promise<void>;
  /** Deletes the user's sessions that never passed the authenticator step, except `keepHash`. */
  deletePendingSessions(userId: string, keepHash: string): Promise<void>;
  getIdentityKey(id: string): Promise<IdentityKeyRecord | undefined>;
  /** Idempotent: a concurrent insert of the same id is ignored, callers re-read. */
  insertIdentityKey(row: IdentityKeyRecord): Promise<void>;
  updateIdentityKey(
    id: string,
    patch: Pick<IdentityKeyRecord, "wrappedIv" | "wrappedCiphertext" | "wrappedTag">,
  ): Promise<void>;
  insertAccessEvent(row: AccessEventRecord): Promise<void>;
  listAccessEvents(orgId: string, limit?: number): Promise<AccessEventRecord[]>;
  getAccessEventByJti(jtiHash: string): Promise<AccessEventRecord | undefined>;
  revokeAccessEventsForClient(clientId: string, at: string): Promise<void>;
  revokeAccessEvent(jtiHash: string, at: string): Promise<void>;
  /**
   * Marks every unrevoked ledger row issued under an OAuth grant. Returns the rows it changed
   * so the caller can audit each one.
   */
  revokeAccessEventsForGrant(grantId: string, at: string): Promise<AccessEventRecord[]>;
  /** `at` null clears the revocation (re-consent through OAuth reactivates the same row). */
  setClientRevoked(id: string, at: string | null): Promise<void>;
  touchClientLastSeen(id: string, at: string): Promise<void>;
  setClientLastTokenAt(id: string, at: string): Promise<void>;

  /** Tenant-scoped OAuth client lookup: the DCR id is shared across orgs, the pair is unique. */
  findClientByOrgAndOauthId(orgId: string, oauthClientId: string): Promise<ClientRecord | undefined>;
  /** Records which operator account first consented for this vault client. No-op when already set. */
  setClientConsentedBy(id: string, userId: string): Promise<void>;
  findOidcPayloadByUid(kind: string, uid: string): Promise<OidcPayloadRow | undefined>;
  findOidcPayloadByUserCode(kind: string, userCode: string): Promise<OidcPayloadRow | undefined>;
  deleteOidcPayloadsByGrantId(kind: string, grantId: string): Promise<void>;
  /**
   * Deletes rows of `kind` whose payload clientId is one of `clientIds` and whose
   * accountId is `accountId` (or absent). Rows bound to another account survive.
   */
  deleteOidcPayloadsForClient(kind: string, clientIds: string[], accountId: string | null): Promise<void>;
  /** Rows of `kind` whose payload clientId is one of `clientIds` (used to find an org's grants at revoke). */
  listOidcPayloadsForClient(kind: string, clientIds: string[]): Promise<{ id: string; payload: string }[]>;
  /**
   * Atomically stamps `consumed` (epoch seconds) into the payload JSON of a row that has not been
   * consumed yet. Returns false when the row is missing or already consumed, so two concurrent
   * exchanges of one code cannot both succeed.
   */
  consumeOidcPayload(id: string, kind: string, consumedAt: number): Promise<boolean>;
  /** Removes rows whose expires_at is at or before `nowIso`. Returns the count. */
  purgeExpiredOidcPayloads(nowIso: string): Promise<number>;

  /* ---- team (3.7) and plan limits (3.9) ---- */

  removeMember(orgId: string, userId: string): Promise<void>;
  updateMemberRole(orgId: string, userId: string, role: MemberRole): Promise<void>;
  insertInvite(row: InviteRecord): Promise<void>;
  getInvite(id: string): Promise<InviteRecord | undefined>;
  getInviteByTokenHash(tokenHash: string): Promise<InviteRecord | undefined>;
  /** Invites for the org that have not been accepted, newest first. Expired rows are included. */
  listInvites(orgId: string): Promise<InviteRecord[]>;
  acceptInvite(id: string, acceptedAt: string): Promise<void>;
  deleteInvite(id: string): Promise<void>;
  /** Org chosen in the switcher for this session; null clears it. */
  setSessionActiveOrg(idHash: string, orgId: string | null): Promise<void>;
  /** Audit rows for `action` in the org at or after `sinceIso` (monthly call budget). */
  countAuditSince(orgId: string, action: string, sinceIso: string): Promise<number>;
  /** Items across every environment of the org (credentials plan limit). */
  countItemsForOrg(orgId: string): Promise<number>;
};

export type OidcPayloadRow = { id: string; payload: string; expiresAt: string | null };

/** A JSON-array TEXT scope column. Null, empty, or malformed reads as unrestricted. */
export function parseScopeList(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const list = parsed.filter((v): v is string => typeof v === "string");
  return list.length > 0 ? list : null;
}

export function scopeListJson(list: string[] | null): string | null {
  return list && list.length > 0 ? JSON.stringify(list) : null;
}

/** `requested_scope_json` column. Missing keys read as null; malformed JSON as no request. */
export function parseRequestedScope(value: unknown): RequestedScope | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const str = (key: string): string | null => (typeof rec[key] === "string" && rec[key] ? rec[key] : null);
  return { host: str("host"), method: str("method"), path: str("path") };
}

export function requestedScopeJson(scope: RequestedScope | null): string | null {
  return scope ? JSON.stringify(scope) : null;
}

/** Integer column that may be NULL (`max_calls`); anything else reads as unrestricted. */
export function parseNullableInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** `calls_used` column: NOT NULL DEFAULT 0, but rows from a half-applied ALTER read as 0. */
export function parseCallsUsed(value: unknown): number {
  return parseNullableInt(value) ?? 0;
}

export type OidcPayloadIndex = {
  uid: string | null;
  userCode: string | null;
  grantId: string | null;
  clientId: string | null;
  accountId: string | null;
};

/** Pulls the indexed fields out of an oidc-provider payload. Malformed JSON yields all nulls. */
export function oidcPayloadIndex(payload: string): OidcPayloadIndex {
  const empty: OidcPayloadIndex = { uid: null, userCode: null, grantId: null, clientId: null, accountId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const rec = parsed as Record<string, unknown>;
  const str = (key: string): string | null => (typeof rec[key] === "string" && rec[key] ? rec[key] : null);
  return {
    uid: str("uid"),
    userCode: str("userCode"),
    grantId: str("grantId"),
    clientId: str("clientId"),
    accountId: str("accountId"),
  };
}
