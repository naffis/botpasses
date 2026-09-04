/** OAuth access-JWT verification for /mcp. Maps a token to a vault client principal. */
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import type { HostedKernel } from "./kernel.ts";
import { HttpError } from "./errors.ts";
import type { Principal } from "./auth.ts";
import { hashToken } from "./operator-identity.ts";
import type { OidcPrivateJwk } from "./boot.ts";
import { logVaultEvent } from "./observe.ts";

/** Skew allowed on `exp`, `nbf`, and `iat` (seconds). Access tokens live 600 s. */
export const ACCESS_JWT_CLOCK_TOLERANCE_S = 30;

/** Claim carrying the org the operator consented in. Set by `extraTokenClaims`. */
export const ORG_CLAIM = "org_id";

/** The signing key plus, during a rotation, the key it replaced (verify only). */
export type OidcKeySet = { current: OidcPrivateJwk; previous?: OidcPrivateJwk };

/** Key id published in JWKS and stamped on token headers. Stable for the life of a key. */
export function oidcKid(jwk: OidcPrivateJwk): string {
  return jwk.n.slice(0, 8);
}

/** Public halves of the key set, in JWKS order: current first. */
export function publicJwks(keys: OidcKeySet): JSONWebKeySet {
  const pub = (jwk: OidcPrivateJwk) => ({ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, use: "sig", kid: oidcKid(jwk) });
  return { keys: keys.previous ? [pub(keys.current), pub(keys.previous)] : [pub(keys.current)] };
}

function unauthenticated(): HttpError {
  return new HttpError(401, "Authentication required");
}

/**
 * Verifies signature (any key in the set, matched by `kid`), issuer, audience, and time.
 * Returns undefined for anything that does not verify; callers decide what that means.
 */
export async function verifyAccessJwt(
  token: string,
  keys: OidcKeySet,
  issuer: string,
): Promise<JWTPayload | undefined> {
  const origin = issuer.replace(/\/$/, "");
  try {
    const verified = await jwtVerify(token, createLocalJWKSet(publicJwks(keys)), {
      issuer: origin,
      audience: `${origin}/mcp`,
      algorithms: ["RS256"],
      clockTolerance: ACCESS_JWT_CLOCK_TOLERANCE_S,
    });
    return verified.payload;
  } catch {
    return undefined;
  }
}

/**
 * The DCR client id is shared by every operator who connects the same MCP host, so it
 * never identifies a tenant on its own. The org bound at consent (`org_id`) picks the
 * tenant; `sub` (the operator account) must still be a member of it; the vault client
 * is then the `(org, oauth_client_id)` pair. Verification never provisions an org.
 */
export async function principalFromAccessJwt(
  kernel: HostedKernel,
  token: string,
  jwk: OidcPrivateJwk,
  issuer: string,
  previousJwk?: OidcPrivateJwk,
): Promise<Principal> {
  const payload = await verifyAccessJwt(token, { current: jwk, previous: previousJwk }, issuer);
  if (!payload) throw unauthenticated();
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
  const orgId = typeof payload[ORG_CLAIM] === "string" ? payload[ORG_CLAIM] : undefined;
  if (!orgId) throw unauthenticated();
  if (!(await kernel.store.getMember(orgId, sub))) throw unauthenticated();
  const client = await kernel.store.findClientByOrgAndOauthId(orgId, oauthId);
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
