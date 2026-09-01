/** Product identity. Process env prefix stays VAULT_*. */

export const PRODUCT_NAME = "Botpasses";
export const PRODUCT_SLUG = "botpasses";
export const MCP_SERVER_NAME = "botpasses";
export const HEALTH_PRODUCT = "botpasses";
export const DEFAULT_HOME_DIRNAME = ".botpasses";
export const STAGING_ORIGIN = "https://staging.botpasses.com";
export const PRODUCTION_ORIGIN = "https://botpasses.com";
export const WWW_AUTHENTICATE_REALM = "botpasses";

export type DeployPlane = "staging" | "production";

export function originForPlane(plane: DeployPlane): string {
  return plane === "staging" ? STAGING_ORIGIN : PRODUCTION_ORIGIN;
}

export function hostedDeployPlane(env: NodeJS.ProcessEnv): DeployPlane {
  return env.VAULT_DEPLOY_PLANE === "staging" ? "staging" : "production";
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/**
 * Public URLs users/MCP/CLI see must be a botpasses.com origin.
 * Loopback is only for local tests and `vault serve`.
 */
export function publicOriginError(
  raw: string,
  opts: { plane?: DeployPlane; allowLoopback?: boolean } = {},
): string | undefined {
  const allowLoopback = opts.allowLoopback ?? true;
  const trimmed = raw.trim();
  if (!trimmed) return "VAULT_PUBLIC_URL is required.";
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "VAULT_PUBLIC_URL must be a URL.";
  }
  if (parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    return "VAULT_PUBLIC_URL must be an origin with no path or query.";
  }
  if (isLoopbackHost(parsed.hostname)) {
    if (!allowLoopback) {
      return `VAULT_PUBLIC_URL must be ${originForPlane(opts.plane ?? "production")}.`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "VAULT_PUBLIC_URL loopback must be http or https.";
    }
    return undefined;
  }
  const expected = opts.plane ? originForPlane(opts.plane) : undefined;
  if (expected) {
    if (parsed.origin !== expected) {
      return `VAULT_PUBLIC_URL must be ${expected} when VAULT_DEPLOY_PLANE=${opts.plane}.`;
    }
    return undefined;
  }
  if (parsed.origin !== STAGING_ORIGIN && parsed.origin !== PRODUCTION_ORIGIN) {
    return `VAULT_PUBLIC_URL must be ${STAGING_ORIGIN} or ${PRODUCTION_ORIGIN}.`;
  }
  return undefined;
}

export function resolvePublicOrigin(
  raw: string,
  opts: { plane?: DeployPlane; allowLoopback?: boolean } = {},
): string {
  const err = publicOriginError(raw, opts);
  if (err) throw new Error(err);
  return new URL(raw.trim()).origin;
}

export {
  MCP_INSTRUCTIONS_HOSTED,
  MCP_INSTRUCTIONS_LOCAL,
} from "./prompts/mcp-hosted.ts";
