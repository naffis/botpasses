import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ClientKind, MemberRole, VaultEnvName } from "../hosted-types.ts";
import type { HostedKernel } from "./kernel.ts";
import { HttpError } from "./errors.ts";

export type OperatorPrincipal = {
  channel: "operator";
  userId: string;
  orgId: string;
  role: MemberRole;
};

export type ModelPrincipal = {
  channel: "model";
  orgId: string;
  clientId: string;
  environment: VaultEnvName;
};

export type TrustedPrincipal = {
  channel: "trusted";
  orgId: string;
  clientId: string;
  environment: VaultEnvName;
};

export type Principal = OperatorPrincipal | ModelPrincipal | TrustedPrincipal;

export type AuthResolver = (
  req: IncomingMessage,
  kernel: HostedKernel,
) => Promise<Principal | undefined>;

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function bearer(req: IncomingMessage): string | undefined {
  const auth = header(req, "authorization");
  if (!auth?.startsWith("Bearer ")) return undefined;
  return auth.slice("Bearer ".length).trim();
}

export async function testAuthResolver(
  req: IncomingMessage,
  kernel: HostedKernel,
): Promise<Principal | undefined> {
  const token = bearer(req);
  if (token?.startsWith("avt_")) {
    const client = await kernel.lookupTrustedToken(token);
    if (!client || client.kind !== "trusted") return undefined;
    return {
      channel: "trusted",
      orgId: client.orgId,
      clientId: client.id,
      environment: client.environment,
    };
  }
  const channel = header(req, "x-test-channel");
  if (!channel) return undefined;
  if (channel === "operator") {
    const userId = header(req, "x-test-user");
    const orgId = header(req, "x-test-org");
    if (!userId) return undefined;
    if (!orgId) throw new HttpError(403, "Organization required");
    const role = await kernel.requireMember(orgId, userId);
    return { channel: "operator", userId, orgId, role };
  }
  if (channel === "model") {
    const clientId = header(req, "x-test-client");
    if (!clientId) return undefined;
    const client = await kernel.store.getClient(clientId);
    if (!client || client.kind !== "model") return undefined;
    return {
      channel: "model",
      orgId: client.orgId,
      clientId: client.id,
      environment: client.environment,
    };
  }
  return undefined;
}

export function requireOperator(p: Principal | undefined): OperatorPrincipal {
  if (!p) throw new HttpError(401, "Authentication required");
  if (p.channel !== "operator") throw new HttpError(403, "Operator session required");
  if (!p.orgId) throw new HttpError(403, "Organization required");
  return p;
}

export function requireModelOrOperator(p: Principal | undefined): ModelPrincipal | OperatorPrincipal {
  if (!p) throw new HttpError(401, "Authentication required");
  if (p.channel === "trusted") throw new HttpError(403, "Trusted tokens cannot use the model channel");
  return p;
}

export function requireTrusted(p: Principal | undefined): TrustedPrincipal {
  if (!p) throw new HttpError(401, "Authentication required");
  if (p.channel !== "trusted") throw new HttpError(403, "Trusted client required");
  return p;
}

export function isModelChannel(p: Principal): p is ModelPrincipal {
  return p.channel === "model";
}

export function clerkAudienceHint(publicUrl: string): { resource: string } {
  return { resource: publicUrl };
}

export function hashBearer(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type { ClientKind };
