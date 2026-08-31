import type { IncomingMessage } from "node:http";
import { verifyToken } from "@clerk/backend";
import type { HostedKernel } from "./kernel.ts";
import { HttpError } from "./errors.ts";
import { readBearer, resolveMachineToken, type Principal } from "./auth.ts";

export type ClerkClaims = {
  sub?: string;
  org_id?: string;
  azp?: string;
  sid?: string | null;
};

function stringField(payload: object, key: string): string | undefined {
  if (!(key in payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Map verified Clerk claims to a vault principal.
 * Session JWTs (`sid` present) are operators. OAuth access tokens (no `sid`)
 * bind to the model client registered for `azp` (or `sub`), creating one if needed.
 */
export async function principalFromClerkClaims(
  kernel: HostedKernel,
  claims: ClerkClaims,
): Promise<Principal> {
  const userId = claims.sub;
  const orgId = claims.org_id;
  if (!userId) throw new HttpError(401, "Authentication required");
  if (!orgId) throw new HttpError(403, "Organization required");
  const sid = claims.sid;
  if (typeof sid === "string" && sid.length > 0) {
    const role = await kernel.requireMember(orgId, userId);
    return { channel: "operator", userId, orgId, role };
  }
  const oauthId = claims.azp && claims.azp.length > 0 ? claims.azp : userId;
  const client = await kernel.ensureModelClient({
    orgId,
    name: `oauth:${oauthId.slice(0, 64)}`,
    environment: "staging",
    clerkOauthUserId: oauthId,
  });
  return {
    channel: "model",
    orgId,
    clientId: client.id,
    environment: client.environment,
  };
}

/**
 * Clerk session JWT (operator) or OAuth access token (model).
 * Tokens without org_id are 403. Trusted `avt_` keys are handled before this resolver.
 */
export async function clerkAuthResolver(
  req: IncomingMessage,
  kernel: HostedKernel,
): Promise<Principal | undefined> {
  const machine = await resolveMachineToken(req, kernel);
  if (machine) return machine;
  const token = readBearer(req);
  if (!token) return undefined;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) throw new HttpError(401, "Authentication required");
  const payload = await verifyToken(token, { secretKey });
  return principalFromClerkClaims(kernel, {
    sub: payload.sub,
    org_id: stringField(payload, "org_id"),
    azp: stringField(payload, "azp"),
    sid: stringField(payload, "sid") ?? null,
  });
}
