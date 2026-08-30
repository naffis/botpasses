export type MemberRole = "owner" | "operator";
export type VaultEnvName = "staging" | "production";
export type ItemKind = "secret" | "login";
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
  environment: VaultEnvName;
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
