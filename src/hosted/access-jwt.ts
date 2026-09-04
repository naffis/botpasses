/** OAuth access-JWT verification for /mcp. Maps a token to a vault client principal. */
import { importJWK, jwtVerify, type JWTPayload } from "jose";
import type { HostedKernel } from "./kernel.ts";
import { HttpError } from "./errors.ts";
import type { Principal } from "./auth.ts";
import { hashToken } from "./operator-identity.ts";
import type { OidcPrivateJwk } from "./boot.ts";
import { logVaultEvent } from "./observe.ts";

function unauthenticated(): HttpError {
  return new HttpError(401, "Authentication required");
}

/**
 * The DCR client id is shared by every operator who connects the same MCP host, so it
 * never identifies a tenant on its own. `sub` (the operator account) picks the org
 * first; the vault client is then the `(org, oauth_client_id)` pair.
 */
export async function principalFromAccessJwt(
  kernel: HostedKernel,
  token: string,
  jwk: OidcPrivateJwk,
  issuer: string,
): Promise<Principal> {
  const origin = issuer.replace(/\/$/, "");
  const aud = `${origin}/mcp`;
  const { n, e, kty, alg } = jwk;
  const key = await importJWK({ kty, n, e, alg }, "RS256");
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, key, { issuer: origin, audience: aud });
    payload = verified.payload;
  } catch {
    throw unauthenticated();
  }
  const jti = typeof payload.jti === "string" ? payload.jti : undefined;
  if (!jti) throw unauthenticated();
  const event = await kernel.store.getAccessEventByJti(hashToken(jti));
  if (event?.revokedAt) throw unauthenticated();
  const oauthId = typeof payload.client_id === "string" ? payload.client_id : undefined;
  if (!oauthId) throw unauthenticated();
  // oidc-provider emits `sub: accountId || clientId`; a sub equal to the client id
  // means no end-user account, which never maps to a vault.
  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!sub || sub === oauthId) throw unauthenticated();
  const membership = await kernel.ensureVaultOrgForUser(sub);
  const client = await kernel.store.findClientByOrgAndOauthId(membership.orgId, oauthId);
  if (!client || client.revokedAt) throw unauthenticated();
  void kernel.store.touchClientLastSeen(client.id, new Date().toISOString()).catch((err: unknown) => {
    logVaultEvent("client_last_seen_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return {
    channel: "model",
    orgId: client.orgId,
    clientId: client.id,
    environment: client.environment,
  };
}
