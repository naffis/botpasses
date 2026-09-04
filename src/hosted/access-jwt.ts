/** OAuth access-JWT verification for /mcp. Maps a token to a vault client principal. */
import { importJWK, jwtVerify, type JWTPayload } from "jose";
import type { HostedKernel } from "./kernel.ts";
import { HttpError } from "./errors.ts";
import type { Principal } from "./auth.ts";
import { hashToken } from "./operator-identity.ts";
import type { OidcPrivateJwk } from "./boot.ts";
import { logVaultEvent } from "./observe.ts";

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
    throw new HttpError(401, "Authentication required");
  }
  const jti = typeof payload.jti === "string" ? payload.jti : undefined;
  if (!jti) throw new HttpError(401, "Authentication required");
  const event = await kernel.store.getAccessEventByJti(hashToken(jti));
  if (event?.revokedAt) throw new HttpError(401, "Authentication required");
  const oauthId = typeof payload.client_id === "string" ? payload.client_id : undefined;
  if (!oauthId) throw new HttpError(401, "Authentication required");
  const client = await kernel.store.findClientByOauthId(oauthId);
  if (!client || client.revokedAt) throw new HttpError(401, "Authentication required");
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
