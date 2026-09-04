export type LocalGrantScope = "once" | "session";
export type GrantStatus = "pending" | "active" | "revoked" | "consumed" | "expired";

export type AuditAction =
  | "store"
  | "request_grant"
  | "grant"
  | "revoke"
  | "inject"
  | "inject_denied";

export type SecretMeta = {
  name: string;
  last4: string;
  createdAt: string;
  updatedAt: string;
};

export type GrantRecord = {
  id: string;
  secretName: string;
  agentId: string;
  toolId: string;
  scope: LocalGrantScope;
  status: GrantStatus;
  expiresAt: string | null;
  createdAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
};

export type AuditRecord = {
  id: string;
  action: AuditAction;
  actor: string;
  secretName: string | null;
  agentId: string | null;
  toolId: string | null;
  createdAt: string;
};

export type SecretBinding = {
  secretName: string;
  envName?: string;
};

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};
