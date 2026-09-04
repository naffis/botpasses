import type { IncomingMessage } from "node:http";
import type { HostedKernel } from "./kernel.ts";
import { HttpError } from "./errors.ts";
import { readBearer, resolveMachineToken, type AuthResolver } from "./auth.ts";
import { OperatorIdentity, totpEnabled } from "./operator-identity.ts";
import type { OidcPrivateJwk } from "./boot.ts";
import { logVaultEvent } from "./observe.ts";
import { principalFromAccessJwt } from "./access-jwt.ts";

export { principalFromAccessJwt };

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
