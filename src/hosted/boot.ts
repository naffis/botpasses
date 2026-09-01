/** Hosted boot invariants. Exit 78 = EX_CONFIG. */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hostedDeployPlane, originForPlane, publicOriginError } from "../brand.ts";

export const HOSTED_CONFIG_EXIT = 78;

export type OidcPrivateJwk = {
  kty: "RSA";
  alg: "RS256";
  d: string;
  n: string;
  e: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
  kid?: string;
  use?: string;
};

export function parseOidcPrivateJwk(raw: string | undefined): OidcPrivateJwk | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const rec = parsed as Record<string, unknown>;
    if (rec.kty !== "RSA" || rec.alg !== "RS256") return undefined;
    if (typeof rec.d !== "string" || !rec.d) return undefined;
    if (typeof rec.n !== "string" || typeof rec.e !== "string") return undefined;
    const out: OidcPrivateJwk = {
      kty: "RSA",
      alg: "RS256",
      d: rec.d,
      n: rec.n,
      e: rec.e,
    };
    for (const key of ["p", "q", "dp", "dq", "qi", "kid", "use"] as const) {
      if (typeof rec[key] === "string" && rec[key]) out[key] = rec[key];
    }
    return out;
  } catch {
    return undefined;
  }
}

export function hostedBootError(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.VAULT_MODE !== "hosted") return undefined;
  if (!env.DATABASE_URL) {
    return "VAULT_MODE=hosted requires DATABASE_URL (Neon pooled).";
  }
  if (env.VAULT_HOME) {
    return "VAULT_MODE=hosted refuses VAULT_HOME; do not open sqlite on the Machine.";
  }
  const kekErr = hostedKekBootError(env);
  if (kekErr) return kekErr;
  if (env.RESEND_API_KEY && !env.VAULT_EMAIL_FROM?.trim()) {
    return "VAULT_MODE=hosted with RESEND_API_KEY requires VAULT_EMAIL_FROM.";
  }
  const bootstrap = env.VAULT_BOOTSTRAP_TOKEN?.trim() ?? "";
  if (bootstrap.length > 0 && bootstrap.length < 32) {
    return "VAULT_BOOTSTRAP_TOKEN must be at least 32 characters when set.";
  }
  const plane = hostedDeployPlane(env);
  const pub = env.VAULT_PUBLIC_URL?.trim() ?? "";
  if (!pub) {
    return `VAULT_MODE=hosted requires VAULT_PUBLIC_URL=${originForPlane(plane)}.`;
  }
  const originErr = publicOriginError(pub, { plane, allowLoopback: false });
  if (originErr) return originErr;
  const session = env.VAULT_SESSION_SECRET ?? "";
  if (Buffer.byteLength(session) < 32) {
    return "VAULT_MODE=hosted requires VAULT_SESSION_SECRET of at least 32 bytes.";
  }
  if (!parseOidcPrivateJwk(env.VAULT_OIDC_PRIVATE_JWK)) {
    return "VAULT_MODE=hosted requires VAULT_OIDC_PRIVATE_JWK as a private RS256 JWK.";
  }
  const siteRoot = env.VAULT_SITE_ROOT?.trim() || resolve(process.cwd(), "site/dist");
  if (!existsSync(resolve(siteRoot, "index.html"))) {
    return "VAULT_MODE=hosted requires site/dist/index.html (build the Astro site).";
  }
  return undefined;
}

export function deployPlaneRaw(env: NodeJS.ProcessEnv): "staging" | "production" | undefined {
  if (env.VAULT_DEPLOY_PLANE === "staging" || env.VAULT_DEPLOY_PLANE === "production") {
    return env.VAULT_DEPLOY_PLANE;
  }
  return undefined;
}

export function hostedKekBootError(env: NodeJS.ProcessEnv): string | undefined {
  const plane = deployPlaneRaw(env);
  if (env.VAULT_AUTH_MODE === "test" && plane) {
    return "VAULT_AUTH_MODE=test is refused when VAULT_DEPLOY_PLANE is staging or production.";
  }
  const wrapped = Boolean(env.VAULT_KEK_WRAPPED?.trim() && env.VAULT_KMS_KEY_ID?.trim());
  const raw = Boolean(env.VAULT_KEK?.trim());
  const requireKms = env.VAULT_KEK_REQUIRE_KMS === "1";
  if (plane) {
    if (wrapped && !env.FLY_APP_NAME?.trim()) {
      return "VAULT_MODE=hosted KMS unwrap requires FLY_APP_NAME.";
    }
    if (wrapped) return undefined;
    if (raw && !requireKms) return undefined;
    if (requireKms) {
      return "VAULT_KEK_REQUIRE_KMS=1 requires VAULT_KEK_WRAPPED and VAULT_KMS_KEY_ID.";
    }
    return "VAULT_MODE=hosted requires VAULT_KEK or VAULT_KEK_WRAPPED.";
  }
  if (!raw) return "VAULT_MODE=hosted requires VAULT_KEK.";
  return undefined;
}

export function assertHostedBoot(env: NodeJS.ProcessEnv = process.env): void {
  const err = hostedBootError(env);
  if (err) {
    const wrapped = new Error(err);
    (wrapped as Error & { exitCode: number }).exitCode = HOSTED_CONFIG_EXIT;
    throw wrapped;
  }
}
