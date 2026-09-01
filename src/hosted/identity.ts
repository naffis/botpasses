import type { IncomingMessage } from "node:http";
import { importJWK, jwtVerify, type JWTPayload } from "jose";
import type { HostedKernel } from "./kernel.ts";
import { HttpError } from "./errors.ts";
import { readBearer, resolveMachineToken, type AuthResolver, type Principal } from "./auth.ts";
import { hashToken, OperatorIdentity, totpEnabled } from "./operator-identity.ts";
import type { OidcPrivateJwk } from "./boot.ts";
import { logVaultEvent } from "./observe.ts";

export type IdentityResolverOpts = {
  identity: OperatorIdentity;
  kernel: HostedKernel;
  secureCookies: boolean;
  oidcJwk?: OidcPrivateJwk;
  issuer?: string;
};

function requestSecure(req: IncomingMessage): boolean {
  const xf = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(xf) ? xf[0] : xf;
  if (proto === "https") return true;
  return false;
}

export function identityAuthResolver(opts: IdentityResolverOpts): AuthResolver {
  return async (req, kernel) => {
    const machine = await resolveMachineToken(req, kernel);
    if (machine) {
      if (machine.channel === "model" || machine.channel === "trusted") {
        const client = await kernel.store.getClient(machine.clientId);
        if (client?.revokedAt) throw new HttpError(401, "Authentication required");
      }
      return machine;
    }
    const bearer = readBearer(req);
    if (bearer && opts.oidcJwk && opts.issuer) {
      return principalFromAccessJwt(kernel, bearer, opts.oidcJwk, opts.issuer);
    }
    const secure = opts.secureCookies || requestSecure(req);
    const loaded = await opts.identity.loadSession(req.headers.cookie, secure);
    if (!loaded) return undefined;
    const ready = totpEnabled(loaded.user);
    if (!ready) {
      return {
        channel: "operator",
        userId: loaded.user.id,
        orgId: "",
        role: "owner",
        ready: false,
        sessionHash: loaded.session.idHash,
      };
    }
    const membership = await kernel.ensureVaultOrgForUser(loaded.user.id);
    const prior = await kernel.store.getAccessEventByJti(loaded.session.idHash);
    if (!prior) {
      await kernel.recordAccessEvent({
        orgId: membership.orgId,
        clientId: null,
        actorUserId: loaded.user.id,
        kind: "session",
        jtiHash: loaded.session.idHash,
        issuedAt: loaded.session.createdAt,
        expiresAt: loaded.session.expiresAt,
      });
      await kernel.writeAudit(membership.orgId, "session_created", loaded.user.id, null, null);
    }
    return {
      channel: "operator",
      userId: loaded.user.id,
      orgId: membership.orgId,
      role: membership.role,
      ready: true,
      sessionHash: loaded.session.idHash,
    };
  };
}

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
