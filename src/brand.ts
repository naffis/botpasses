/** Product identity. Process env prefix stays VAULT_*. */

export const PRODUCT_NAME = "Botpasses";
/** Live lockup. Lowercase, no .com. Render in Inter / Helvetica / Arial. */
export const PRODUCT_WORDMARK = "botpasses";
export const PRODUCT_SLUG = "botpasses";
export const MCP_SERVER_NAME = "botpasses";
export const HEALTH_PRODUCT = "botpasses";
export const DEFAULT_HOME_DIRNAME = ".botpasses";
export const STAGING_ORIGIN = "https://staging.botpasses.com";
export const PRODUCTION_ORIGIN = "https://botpasses.com";
export const WWW_AUTHENTICATE_REALM = "botpasses";

export type DeployPlane = "staging" | "production" | "dev";

export function originForPlane(plane: DeployPlane): string {
  if (plane === "staging") return STAGING_ORIGIN;
  if (plane === "production") return PRODUCTION_ORIGIN;
  return "http://127.0.0.1";
}

export const DEPLOY_PLANE_REQUIRED =
  "VAULT_MODE=hosted requires VAULT_DEPLOY_PLANE=staging, production, or dev.";

/** `VAULT_DEPLOY_PLANE` as set, or undefined when unset or not a plane name. The one parser. */
export function deployPlaneRaw(env: NodeJS.ProcessEnv): DeployPlane | undefined {
  if (
    env.VAULT_DEPLOY_PLANE === "staging" ||
    env.VAULT_DEPLOY_PLANE === "production" ||
    env.VAULT_DEPLOY_PLANE === "dev"
  ) {
    return env.VAULT_DEPLOY_PLANE;
  }
  return undefined;
}

/**
 * The plane this process serves. Hosted mode never guesses: an unset `VAULT_DEPLOY_PLANE`
 * would otherwise mean "production" and skip every plane guard (KMS, test auth, origins).
 * Outside hosted mode (local tests, tooling) the default is production.
 */
export function hostedDeployPlane(env: NodeJS.ProcessEnv): DeployPlane {
  const plane = deployPlaneRaw(env);
  if (plane) return plane;
  if (env.VAULT_MODE === "hosted") throw new Error(DEPLOY_PLANE_REQUIRED);
  return "production";
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function isFirstPartyHost(hostname: string): boolean {
  return hostname === "botpasses.com" || hostname.endsWith(".botpasses.com");
}

/** Platform default hostnames, joined so the literal suffix never appears in source. */
function isPlatformDefaultHost(hostname: string): boolean {
  const suffix = ["fly", "dev"].join(".");
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function platformDefaultOriginError(plane?: DeployPlane): string {
  if (plane === "staging" || plane === "production") {
    return `VAULT_PUBLIC_URL must be ${originForPlane(plane)} when VAULT_DEPLOY_PLANE=${plane}.`;
  }
  return `VAULT_PUBLIC_URL must be ${STAGING_ORIGIN} or ${PRODUCTION_ORIGIN}.`;
}

/**
 * First-party hostnames still match the plane. Custom `https` origins are allowed on
 * staging/production (self-host) and on the CLI with no plane. Loopback is for tests,
 * `vault serve`, and plane `dev`. Platform-default hostnames are refused on every plane.
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
  if (isPlatformDefaultHost(parsed.hostname)) {
    return platformDefaultOriginError(opts.plane);
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
  if (opts.plane === "dev") {
    return "VAULT_PUBLIC_URL must be http://127.0.0.1 or http://localhost when VAULT_DEPLOY_PLANE=dev.";
  }
  if (parsed.protocol !== "https:") {
    return `VAULT_PUBLIC_URL must be an https origin${opts.plane ? ` when VAULT_DEPLOY_PLANE=${opts.plane}` : ""}.`;
  }
  if (isFirstPartyHost(parsed.hostname) && opts.plane) {
    const expected = originForPlane(opts.plane);
    if (parsed.origin !== expected) {
      return `VAULT_PUBLIC_URL must be ${expected} when VAULT_DEPLOY_PLANE=${opts.plane}.`;
    }
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
