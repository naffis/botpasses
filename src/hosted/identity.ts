import type { IncomingMessage } from "node:http";
import type { HostedKernel } from "./kernel.ts";
import { HttpError } from "./errors.ts";
import { readBearer, resolveMachineToken, type AuthResolver, type OperatorPrincipal, type Principal } from "./auth.ts";
import { OperatorIdentity, totpEnabled } from "./operator-identity.ts";
import type { OidcPrivateJwk } from "./boot.ts";
import { principalFromAccessJwt } from "./access-jwt.ts";

export { principalFromAccessJwt };

export type IdentityResolverOpts = {
  identity: OperatorIdentity;
  kernel: HostedKernel;
  secureCookies: boolean;
  oidcJwk?: OidcPrivateJwk;
  /** Key being rotated out: still verifies access tokens it signed. See docs/ops/oidc-key-rotation.md. */
  oidcPreviousJwk?: OidcPrivateJwk;
  issuer?: string;
};

/**
 * An operator session that has not passed the authenticator step yet.
 * `needs_totp` is true when the user is enrolled (route to `/verify-totp`), false when the
 * user still has to enroll (route to `/enroll-totp`).
 */
export type PendingOperatorPrincipal = OperatorPrincipal & { ready: false; needs_totp: boolean };

/** True for a pre-MFA session whose user is already enrolled and must verify, not enroll. */
export function needsTotpVerify(p: Principal | undefined): boolean {
  if (!p || p.channel !== "operator" || p.ready !== false) return false;
  return "needs_totp" in p && p.needs_totp === true;
}

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
      return principalFromAccessJwt(kernel, bearer, opts.oidcJwk, opts.issuer, opts.oidcPreviousJwk);
    }
    // Secure cookies are `__Host-` names only and are honoured only on a TLS request: a plain
    // `bp_session` cookie tossed onto an HTTPS origin, or a session replayed over HTTP, is ignored.
    if (opts.secureCookies && !requestSecure(req)) return undefined;
    const loaded = await opts.identity.loadSession(req.headers.cookie, opts.secureCookies);
    if (!loaded) return undefined;
    const enrolled = totpEnabled(loaded.user);
    // Ready means this session passed the authenticator step, not merely that the user has one.
    const ready = enrolled && loaded.session.mfaAt !== null;
    if (!ready) {
      const pending: PendingOperatorPrincipal = {
        channel: "operator",
        userId: loaded.user.id,
        orgId: "",
        role: "owner",
        ready: false,
        sessionHash: loaded.session.idHash,
        needs_totp: enrolled,
      };
      return pending;
    }
    const membership = await kernel.ensureVaultOrgForUser(loaded.user.id, loaded.session.activeOrgId ?? null);
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
