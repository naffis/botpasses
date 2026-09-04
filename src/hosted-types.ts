export type MemberRole = "owner" | "operator";
export type VaultEnvName = "staging" | "production";
export type ItemKind = "secret" | "login" | "client_secret";
/** Request-signing schemes for `hmac:<scheme>`. Algorithms: src/hosted/providers/hmac.ts. */
export type HmacScheme = "stripe_sig" | "slack_sig" | "github_sig";

/**
 * How the connector attaches a stored value to an origin request. Grammar and validation:
 * `injectModeOf` in src/hosted/store-form-fields.ts (shared with the browser); application:
 * src/hosted/providers/inject.ts. Unknown strings are rejected at store time (400) and at send
 * time (500 `inject_unsupported`); nothing falls through to Bearer.
 */
export type InjectMode =
  | "bearer"
  | "basic"
  | "client_credentials"
  | "refresh"
  | "sigv4"
  | `header:${string}`
  | `query:${string}`
  | `cookie:${string}`
  | `hmac:${HmacScheme}`;

/** OAuth 2.0 grant types a provider's token endpoint accepts (RFC 6749 sections 4.1, 4.4, 6). */
export type OauthGrantType = "client_credentials" | "authorization_code" | "refresh_token";

/** Where the token endpoint expects client credentials: HTTP Basic (RFC 6749 2.3.1) or form fields. */
export type TokenAuthStyle = "basic" | "post_body";
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
  /** User who provisioned the org; null for rows written before migration 010. */
  createdBy: string | null;
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
  createdAt: string;
  updatedAt: string;
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

/**
 * Optional limits on a grant or standing policy (3.1 scoped approvals). `null` in a dimension
 * means unrestricted in that dimension. `hosts` is always a subset of the item's allowed hosts.
 * `callsUsed` counts consumes against `maxCalls`; the row is spent when they meet.
 */
export type GrantScope = {
  methods: string[] | null;
  pathPrefixes: string[] | null;
  hosts: string[] | null;
  maxCalls: number | null;
  callsUsed: number;
};

/** What the agent said it would call when it asked (`request_grant` host, method, path). */
export type RequestedScope = {
  host: string | null;
  method: string | null;
  path: string | null;
};

/** Wire shape of a scope on MCP results, inbox cards, and the access snapshot. */
export type GrantScopePublic = {
  methods: string[] | null;
  path_prefixes: string[] | null;
  hosts: string[] | null;
  max_calls: number | null;
  calls_used: number;
  expires_at: string | null;
};

export type PolicyRecord = GrantScope & {
  id: string;
  orgId: string;
  clientId: string;
  itemId: string | null;
  folderId: string | null;
  environmentId: string;
  kind: PolicyKind;
  createdAt: string;
  /** Standing policies may expire; `null` means until revoked (the pre-3.1 behaviour). */
  expiresAt: string | null;
};

export type HostedGrantRecord = GrantScope & {
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
  requestedScope: RequestedScope | null;
};

/** No limits in any dimension: the shape every grant and policy had before scoped approvals. */
export function unscopedFields(): GrantScope {
  return { methods: null, pathPrefixes: null, hosts: null, maxCalls: null, callsUsed: 0 };
}

/**
 * The scope a grant inherits when a standing policy activates it: the policy's limits with a
 * fresh call counter, and the policy's expiry. Unrestricted when there is no policy.
 */
export function scopeFromPolicy(policy: PolicyRecord | undefined): GrantScope & { expiresAt: string | null } {
  if (!policy) return { ...unscopedFields(), expiresAt: null };
  return {
    methods: policy.methods,
    pathPrefixes: policy.pathPrefixes,
    hosts: policy.hosts,
    maxCalls: policy.maxCalls,
    callsUsed: 0,
    expiresAt: policy.expiresAt,
  };
}

/** Public scope, or `null` when the row is unrestricted in every dimension. */
export function publicGrantScope(row: GrantScope & { expiresAt: string | null }): GrantScopePublic | null {
  if (row.methods === null && row.pathPrefixes === null && row.hosts === null && row.maxCalls === null) {
    return null;
  }
  return {
    methods: row.methods,
    path_prefixes: row.pathPrefixes,
    hosts: row.hosts,
    max_calls: row.maxCalls,
    calls_used: row.callsUsed,
    expires_at: row.expiresAt,
  };
}

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
