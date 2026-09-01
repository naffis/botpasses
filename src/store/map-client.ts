import type { ClientRecord } from "../hosted-types.ts";

export function mapClientRow(r: Record<string, unknown>): ClientRecord {
  const oauth =
    r.oauth_client_id == null
      ? r.clerk_oauth_user_id == null
        ? null
        : String(r.clerk_oauth_user_id)
      : String(r.oauth_client_id);
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    kind: r.kind as ClientRecord["kind"],
    name: String(r.name),
    hashedSecret: r.hashed_secret == null ? null : String(r.hashed_secret),
    clerkOauthUserId: r.clerk_oauth_user_id == null ? null : String(r.clerk_oauth_user_id),
    oauthClientId: oauth,
    environment: r.environment as ClientRecord["environment"],
    revokedAt: r.revoked_at == null ? null : String(r.revoked_at),
    lastTokenAt: r.last_token_at == null ? null : String(r.last_token_at),
    lastSeenAt: r.last_seen_at == null ? null : String(r.last_seen_at),
    consentedByUserId: r.consented_by_user_id == null ? null : String(r.consented_by_user_id),
  };
}
