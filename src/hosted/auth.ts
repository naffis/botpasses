import type { IncomingMessage } from "node:http";
import { deployPlaneRaw } from "../brand.ts";
import { tokensEqual } from "../crypto.ts";
import type { ClientKind, MemberRole, VaultEnvName } from "../hosted-types.ts";
import { sha256Hex } from "../ids.ts";
import type { HostedKernel } from "./kernel.ts";
import { HttpError } from "./errors.ts";
import { requestClientIp } from "./identity-limiter.ts";
import { logAuthEvent, logVaultEvent } from "./observe.ts";

/** Short, stable fingerprint of the bootstrap token for log correlation; never the token. */
function hashBootstrap(token: string): string {
  return sha256Hex(token).slice(0, 12);
}

export type OperatorPrincipal = {
  channel: "operator";
  userId: string;
  orgId: string;
  role: MemberRole;
  ready?: boolean;
  sessionHash?: string;
  /** Enrolled, but this session has not passed the authenticator step yet. */
  needs_totp?: boolean;
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

export function readBearer(req: IncomingMessage): string | undefined {
  const auth = header(req, "authorization");
  if (!auth?.startsWith("Bearer ")) return undefined;
  return auth.slice("Bearer ".length).trim();
}

export async function resolveMachineToken(
  req: IncomingMessage,
  kernel: HostedKernel,
): Promise<Principal | undefined> {
  const token = readBearer(req);
  if (!token) return undefined;
  if (token.startsWith("avt_")) {
    const client = await kernel.lookupTrustedToken(token);
    if (!client || client.kind !== "trusted" || client.revokedAt) return undefined;
    return {
      channel: "trusted",
      orgId: client.orgId,
      clientId: client.id,
      environment: client.environment,
    };
  }
  if (token.startsWith("avm_")) {
    const client = await kernel.lookupTrustedToken(token);
    if (!client || client.kind !== "model" || client.revokedAt) return undefined;
    return {
      channel: "model",
      orgId: client.orgId,
      clientId: client.id,
      environment: client.environment,
    };
  }
  return undefined;
}

/** True when `VAULT_BOOTSTRAP_TOKEN` is honoured: 32+ chars, and on a plane only with `VAULT_BOOTSTRAP_ALLOW_PLANE=1`. */
export function bootstrapTokenEnabled(env: NodeJS.ProcessEnv): boolean {
  const bootstrap = env.VAULT_BOOTSTRAP_TOKEN?.trim() ?? "";
  if (bootstrap.length < 32) return false;
  const plane = deployPlaneRaw(env) !== undefined;
  return !plane || env.VAULT_BOOTSTRAP_ALLOW_PLANE === "1";
}

export function hostedAuthResolver(
  env: NodeJS.ProcessEnv,
  fallback: AuthResolver,
): AuthResolver {
  const bootstrap = env.VAULT_BOOTSTRAP_TOKEN?.trim() ?? "";
  const enabled = bootstrapTokenEnabled(env);
  if (enabled) {
    // Boot-time warning: a static break-glass credential is live. Every use is logged below.
    logVaultEvent("bootstrap_token_enabled", {
      token_hash: hashBootstrap(bootstrap),
      plane: env.VAULT_DEPLOY_PLANE ?? "local",
    });
  }
  return async (req, kernel) => {
    const token = readBearer(req);
    if (enabled && token && tokensEqual(token, bootstrap)) {
      const op = await kernel.ensureBootstrapOperator();
      logAuthEvent("bootstrap_used", {
        token_hash: hashBootstrap(bootstrap),
        ip: requestClientIp(req),
        method: req.method ?? "GET",
        path: (req.url ?? "/").split("?")[0] ?? "/",
      });
      return { channel: "operator", userId: op.userId, orgId: op.orgId, role: op.role };
    }
    const machine = await resolveMachineToken(req, kernel);
    if (machine) return machine;
    return fallback(req, kernel);
  };
}

export async function testAuthResolver(
  req: IncomingMessage,
  kernel: HostedKernel,
): Promise<Principal | undefined> {
  const machine = await resolveMachineToken(req, kernel);
  if (machine) return machine;
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
  if (channel === "trusted") {
    const clientId = header(req, "x-test-client");
    if (!clientId) return undefined;
    const client = await kernel.store.getClient(clientId);
    if (!client || client.kind !== "trusted" || client.revokedAt) return undefined;
    return {
      channel: "trusted",
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
  if (p.ready === false) {
    throw new HttpError(
      403,
      "mfa_required",
      p.needs_totp ? { verify_url: "/verify-totp" } : { enroll_url: "/enroll-totp" },
    );
  }
  if (!p.orgId) throw new HttpError(403, "Organization required");
  return p;
}

export function requireModelOrOperator(p: Principal | undefined): ModelPrincipal | OperatorPrincipal {
  if (!p) throw new HttpError(401, "Authentication required");
  if (p.channel === "trusted") throw new HttpError(403, "Trusted tokens cannot use the model channel");
  if (p.channel === "operator" && p.ready === false) {
    throw new HttpError(
      403,
      "mfa_required",
      p.needs_totp ? { verify_url: "/verify-totp" } : { enroll_url: "/enroll-totp" },
    );
  }
  return p;
}

export function requireTrusted(p: Principal | undefined): TrustedPrincipal {
  if (!p) throw new HttpError(401, "Authentication required");
  if (p.channel !== "trusted") throw new HttpError(403, "Trusted client required");
  return p;
}

export type { ClientKind };
