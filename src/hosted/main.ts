import { resolve } from "node:path";
import { hostedDeployPlane, PRODUCT_NAME, resolvePublicOrigin } from "../brand.ts";
import { zeroKey } from "../crypto.ts";
import { HostedKernel } from "./kernel.ts";
import { createHostedServer } from "./http.ts";
import { createResendSender } from "./email.ts";
import {
  assertHostedBoot,
  createShutdown,
  HOSTED_CONFIG_EXIT,
  installProcessGuards,
  parseOidcPrivateJwk,
  scheduleSweeps,
} from "./boot.ts";
import { selectKekProvider, selectPreviousKekProvider, usedRawKekFallback } from "./kms.ts";
import { logVaultEvent, packageVersion } from "./observe.ts";
import { PostgresStore } from "../store/postgres.ts";
import { hostedAuthResolver } from "./auth.ts";
import { OperatorIdentity } from "./operator-identity.ts";
import { identityAuthResolver } from "./identity.ts";
import { createOauthProvider } from "./oauth-as.ts";

export async function startHosted(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    assertHostedBoot(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(HOSTED_CONFIG_EXIT);
  }
  let kek: Buffer;
  try {
    kek = await selectKekProvider(env).unwrap();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`KMS unwrap failed: ${message}`);
    process.exit(HOSTED_CONFIG_EXIT);
  }
  if (usedRawKekFallback(env)) {
    logVaultEvent("kek_raw_fallback", { plane: env.VAULT_DEPLOY_PLANE ?? "" });
  }
  let previousKek: Buffer | undefined;
  try {
    previousKek = await selectPreviousKekProvider(env)?.unwrap();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Previous KEK unwrap failed: ${message}`);
    zeroKey(kek);
    process.exit(HOSTED_CONFIG_EXIT);
  }
  if (previousKek && previousKek.equals(kek)) {
    console.error("VAULT_KEK_PREVIOUS is the current KEK; remove it once the rotation is done.");
    zeroKey(kek);
    zeroKey(previousKek);
    process.exit(HOSTED_CONFIG_EXIT);
  }
  if (previousKek) logVaultEvent("kek_previous_loaded", { plane: env.VAULT_DEPLOY_PLANE ?? "" });
  const deployPlane = hostedDeployPlane(env);
  if (!env.SENTRY_DSN?.trim()) {
    // Not fatal: the plane still serves. Loud, because a plane without error reporting is blind.
    logVaultEvent("sentry_dsn_missing", { plane: deployPlane });
  }
  let store: PostgresStore;
  try {
    store = await PostgresStore.open(env.DATABASE_URL ?? "", { plane: deployPlane });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `Postgres open failed: ${message}. Check DATABASE_URL (Neon pooled host, sslmode=require) and that the release_command migrated the schema.`,
    );
    zeroKey(kek);
    if (previousKek) zeroKey(previousKek);
    process.exit(HOSTED_CONFIG_EXIT);
  }
  const sendEmail = env.RESEND_API_KEY
    ? createResendSender(env.RESEND_API_KEY, env.VAULT_EMAIL_FROM ?? "")
    : undefined;
  const publicUrl = resolvePublicOrigin(env.VAULT_PUBLIC_URL ?? "", {
    plane: deployPlane,
    allowLoopback: false,
  });
  const kernel = new HostedKernel({
    store,
    kek,
    previousKek,
    sendEmail,
    publicUrl,
    // Shape checked by hostedBootError (64 hex chars); the kernel refuses anything under 32 bytes.
    approvalHmac: env.VAULT_APPROVAL_HMAC?.trim() ? Buffer.from(env.VAULT_APPROVAL_HMAC.trim(), "hex") : undefined,
    deployPlane,
  });
  // One-shot: item envelopes written before AAD binding are rebound now, so the read path
  // never needs the legacy `orgId` AAD again.
  const rebind = await kernel.rebindLegacyItems();
  if (rebind.rebound + rebind.verified + rebind.unreadable > 0) logVaultEvent("aad_rebind", { ...rebind });
  const host = env.VAULT_BIND_HOST ?? "0.0.0.0";
  const sessionSecret = env.VAULT_SESSION_SECRET ?? "";
  const identity = new OperatorIdentity({ store, sessionSecret, kek, previousKek, sendEmail });
  const jwk = parseOidcPrivateJwk(env.VAULT_OIDC_PRIVATE_JWK);
  const previousJwk = parseOidcPrivateJwk(env.VAULT_OIDC_PREVIOUS_JWK);
  if (env.VAULT_OIDC_PREVIOUS_JWK?.trim() && !previousJwk) {
    throw new Error("VAULT_OIDC_PREVIOUS_JWK is set but is not a private RS256 JWK");
  }
  const oidcProvider = jwk
    ? createOauthProvider({
        issuer: publicUrl.replace(/\/$/, ""),
        kernel,
        sessionSecret,
        jwk,
        previousJwk,
        secureCookies: true,
      })
    : undefined;
  // Only real identity here: `VAULT_AUTH_MODE=test` is refused by hostedBootError, and the
  // hosted process never installs header principals.
  const inner = identityAuthResolver({
    identity,
    kernel,
    secureCookies: true,
    oidcJwk: jwk,
    oidcPreviousJwk: previousJwk,
    issuer: publicUrl.replace(/\/$/, ""),
  });
  const authResolver = hostedAuthResolver(env, inner);
  const http = createHostedServer({
    kernel,
    host,
    port: Number(env.PORT ?? env.VAULT_PORT ?? 8788),
    publicUrl: kernel.publicUrl,
    authResolver,
    identity,
    oidcProvider,
    secureCookies: true,
    siteRoot: env.VAULT_SITE_ROOT?.trim() || resolve(process.cwd(), "site/dist"),
    deployPlane,
  });
  const addr = await http.listen();
  logVaultEvent("hosted_listening", {
    host: addr.host,
    port: addr.port,
    plane: deployPlane,
    version: packageVersion(),
  });
  console.error(`${PRODUCT_NAME} hosted on ${addr.host}:${addr.port} plane=${deployPlane}`);

  // Signal handlers go in before the first sweep: a SIGTERM during a slow boot-time sweep
  // must drain and zero the KEK, not kill the process with the default handler.
  const sweeps = scheduleSweeps(store, { log: logVaultEvent });
  const shutdown = createShutdown({
    http,
    store,
    log: logVaultEvent,
    onDone: () => {
      sweeps.stop();
      zeroKey(kek);
      if (previousKek) zeroKey(previousKek);
    },
  });
  process.on("SIGINT", () => shutdown.stop("SIGINT"));
  process.on("SIGTERM", () => shutdown.stop("SIGTERM"));
  await sweeps.runOnce();
  await shutdown.done;
}

const isMain = process.argv[1]?.includes("hosted/main");
if (isMain) {
  installProcessGuards();
  startHosted().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logVaultEvent("hosted_boot_failed", { message });
    process.exit(1);
  });
}
