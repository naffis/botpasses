export type MemberRole = "owner" | "operator";
export type VaultEnvName = "staging" | "production";
export type ItemKind = "secret" | "login" | "client_secret";
export type InjectMode = "bearer" | "basic" | `header:${string}`;
export type ClientKind = "model" | "trusted";
export type GrantPolicy = "prompt" | "session" | "item_standing" | "folder_standing";
export type HostedGrantStatus = "pending" | "active" | "revoked" | "consumed" | "expired";
export type PolicyKind = "item_standing" | "folder_standing";

export type OrgRecord = {
  id: string;
  name: string;
  wrappedDekIv: string;
  wrappedDekCiphertext: string;
  wrappedDekTag: string;
  createdAt: string;
};

export type MemberRecord = {
  orgId: string;
  userId: string;
  role: MemberRole;
};

export type VaultRecord = {
  id: string;
  orgId: string;
  name: string;
};

export type EnvironmentRecord = {
  id: string;
  vaultId: string;
  name: VaultEnvName;
};

export type FolderRecord = {
  id: string;
  environmentId: string;
  name: string;
};

export type ItemRecord = {
  id: string;
  environmentId: string;
  folderId: string | null;
  kind: ItemKind;
  name: string;
  last4: string;
  username: string | null;
  allowedHostsJson: string;
  inject: string;
  iv: string;
  ciphertext: string;
  tag: string;
  createdAt: string;
  updatedAt: string;
};

export type ItemPublic = {
  id: string;
  name: string;
  kind: ItemKind;
  last4: string;
  username: string | null;
  environment: VaultEnvName;
  inject: string;
  allowedHosts: string[];
  folderId: string | null;
};

export type ClientRecord = {
  id: string;
  orgId: string;
  kind: ClientKind;
  name: string;
  hashedSecret: string | null;
  clerkOauthUserId: string | null;
  oauthClientId: string | null;
  environment: VaultEnvName;
  revokedAt: string | null;
  lastTokenAt: string | null;
  lastSeenAt: string | null;
  last4: string | null;
  consentedByUserId: string | null;
};

export function emptyClientFields(): Pick<
  ClientRecord,
  "oauthClientId" | "revokedAt" | "lastTokenAt" | "lastSeenAt" | "last4" | "consentedByUserId"
> {
  return {
    oauthClientId: null,
    revokedAt: null,
    lastTokenAt: null,
    lastSeenAt: null,
    last4: null,
    consentedByUserId: null,
  };
}

export type UserRecord = {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  totpWrappedIv: string | null;
  totpWrappedCiphertext: string | null;
  totpWrappedTag: string | null;
  totpLastStep: number | null;
  createdAt: string;
};

export type EmailOtpRecord = {
  id: string;
  email: string;
  codeScrypt: string;
  expiresAt: string;
  attempts: number;
  sentAt: string;
};

export type OperatorSessionRecord = {
  idHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export type AccessEventRecord = {
  id: string;
  orgId: string;
  clientId: string | null;
  actorUserId: string | null;
  kind: "oauth_access" | "oauth_refresh" | "machine" | "session";
  jtiHash: string;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type PolicyRecord = {
  id: string;
  orgId: string;
  clientId: string;
  itemId: string | null;
  folderId: string | null;
  environmentId: string;
  kind: PolicyKind;
  createdAt: string;
};

export type HostedGrantRecord = {
  id: string;
  orgId: string;
  clientId: string;
  itemId: string | null;
  folderId: string | null;
  environmentId: string;
  policy: GrantPolicy;
  status: HostedGrantStatus;
  expiresAt: string | null;
  createdAt: string;
  approvedAt: string | null;
  consumedAt: string | null;
  taskId: string | null;
  taskDescription: string | null;
};

export type ApprovalChallengeRecord = {
  id: string;
  grantId: string;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  kind: "code" | "magic";
};

export type HostedAuditRecord = {
  id: string;
  orgId: string;
  action: string;
  actor: string;
  itemName: string | null;
  clientId: string | null;
  at: string;
};

export type NeedItemStatus = "pending" | "fulfilled" | "cancelled";

export type NeedItemRecord = {
  id: string;
  orgId: string;
  clientId: string;
  environmentId: string;
  suggestedName: string;
  host: string;
  taskDescription: string | null;
  status: NeedItemStatus;
  itemId: string | null;
  grantId: string | null;
  expiresAt: string;
  createdAt: string;
  fulfilledAt: string | null;
};

export type PersistFulfillInput = {
  item: ItemRecord;
  grant: HostedGrantRecord;
  audit: HostedAuditRecord;
  needId: string;
  fulfilledAt: string;
};

export type NeedPublic = {
  id: string;
  suggested_name: string;
  host: string;
  client_id: string;
  client_name: string;
  task_description: string | null;
  collect_path: string;
  expires_at: string;
  status: NeedItemStatus;
};

export type FindItemsStatus = "found" | "ambiguous" | "need_item" | "host_mismatch";

export type FindItemSummary = {
  name: string;
  kind: ItemKind;
  last4: string;
  allowed_hosts: string[];
  inject: string;
  environment: VaultEnvName;
};

export type FindItemsResult =
  | { status: "found"; item: FindItemSummary }
  | { status: "ambiguous"; items: FindItemSummary[]; truncated: boolean }
  | { status: "host_mismatch"; item: FindItemSummary }
  | {
      status: "need_item";
      collect_url: string;
      suggested_name: string;
      host: string;
      client_name: string;
      need_id: string;
      message: string;
    };
