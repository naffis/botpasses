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
  type ShutdownHttp,
  type SweepStore,
} from "./boot.ts";
import type { RebindOptions, RebindResult } from "./kernel-items.ts";
import { selectKekProvider, selectPreviousKekProvider, usedRawKekFallback } from "./kms.ts";
import { logVaultEvent, packageVersion } from "./observe.ts";
import { PostgresStore } from "../store/postgres.ts";
import { hostedAuthResolver } from "./auth.ts";
import { OperatorIdentity } from "./operator-identity.ts";
import { identityAuthResolver } from "./identity.ts";
import { createOauthProvider } from "./oauth-as.ts";
import { rebindLegacyEmails } from "./email-directory.ts";

export async function startHosted(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Refuses an unset VAULT_MODE first: every other guard below is keyed on hosted mode.
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
  const host = env.VAULT_BIND_HOST ?? "0.0.0.0";
  const sessionSecret = env.VAULT_SESSION_SECRET ?? "";
  const identity = new OperatorIdentity({ store, sessionSecret, kek, previousKek, sendEmail });
  // Both shapes were checked by hostedBootError before the KEK was unwrapped.
  const jwk = parseOidcPrivateJwk(env.VAULT_OIDC_PRIVATE_JWK);
  const previousJwk = parseOidcPrivateJwk(env.VAULT_OIDC_PREVIOUS_JWK);
  const oidcProvider = jwk
    ? createOauthProvider({
        issuer: publicUrl.replace(/\/$/, ""),
        kernel,
        sessionSecret,
        jwk,
        previousJwk,
        secureCookies: true,
        oidcDirectory: kernel.oidc,
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
  await serveHosted({
    http,
    store,
    rebind: (opts) => kernel.rebindLegacyItems(opts),
    emailRebind: (shouldStop) => rebindLegacyEmails(store, kernel.emails, shouldStop),
    oidcRebind: (shouldStop) => kernel.oidc.rebind(shouldStop),
    log: logVaultEvent,
    onListening: (addr) => {
      logVaultEvent("hosted_listening", {
        host: addr.host,
        port: addr.port,
        plane: deployPlane,
        version: packageVersion(),
      });
      console.error(`${PRODUCT_NAME} hosted on ${addr.host}:${addr.port} plane=${deployPlane}`);
    },
    onDone: () => {
      zeroKey(kek);
      if (previousKek) zeroKey(previousKek);
    },
  });
}

export type ServeHostedDeps = {
  http: ShutdownHttp & { listen(): Promise<{ host: string; port: number }> };
  store: { close(): Promise<void> } & SweepStore;
  /** `HostedKernel.rebindLegacyItems`: the batched legacy AAD rebind. */
  rebind: (opts: RebindOptions) => Promise<RebindResult>;
  /** After listen: wrap leftover plaintext inboxes. Failures do not gate `/ready`. */
  emailRebind?: (shouldStop: () => boolean) => Promise<{ users: number; invites: number }>;
  /** After listen: HMAC bearer ids and wrap leftover plaintext oidc rows. */
  oidcRebind?: (shouldStop: () => boolean) => Promise<{ rebound: number }>;
  log: (event: string, fields: Record<string, unknown>) => void;
  onListening: (addr: { host: string; port: number }) => void;
  /** Runs after the store is closed (zero the KEK). */
  onDone?: () => void;
  /** Where the signal handlers go; the process by default. */
  proc?: Pick<NodeJS.Process, "on">;
  exit?: (code: number) => void;
  drainMs?: number;
  forceMarginMs?: number;
};

/**
 * Everything after the kernel and server exist, in this order: listen (so `/health` and
 * `/ready` answer inside the health-check grace period), install the signal handlers, run the
 * legacy AAD rebind one batch at a time, run the first sweep, then wait for a signal.
 *
 * The rebind is a one-shot data migration over every item written before migration 010, so on
 * a large table it can outlast the check's grace period; it must never gate readiness. A SIGTERM
 * during it sets the stop flag, the run ends at the next batch boundary, and the drain waits for
 * that before closing the store, so no batch is cut mid-statement. A rebind that throws is
 * logged as `aad_rebind_failed` and the process keeps serving: rows still at `aad_version` 0
 * fail closed on inject (no legacy fallback) and the next boot picks the run up again.
 */
export async function serveHosted(deps: ServeHostedDeps): Promise<void> {
  const proc = deps.proc ?? process;
  const addr = await deps.http.listen();
  deps.onListening(addr);

  let stopping = false;
  let rebindDone: Promise<void> = Promise.resolve();
  const sweeps = scheduleSweeps(deps.store, { log: deps.log });
  const shutdown = createShutdown({
    http: deps.http,
    store: {
      close: async () => {
        // The rebind checks `stopping` between batches; wait for the batch in flight.
        await rebindDone;
        await deps.store.close();
      },
    },
    log: deps.log,
    exit: deps.exit,
    drainMs: deps.drainMs,
    forceMarginMs: deps.forceMarginMs,
    onDone: () => {
      sweeps.stop();
      deps.onDone?.();
    },
  });
  // Signal handlers go in before the rebind and the first sweep: a SIGTERM during either must
  // drain and zero the KEK, not kill the process with the default handler.
  const onSignal = (signal: string): void => {
    stopping = true;
    shutdown.stop(signal);
  };
  proc.on("SIGINT", () => onSignal("SIGINT"));
  proc.on("SIGTERM", () => onSignal("SIGTERM"));

  rebindDone = (async () => {
    await runBootRebind(deps.rebind, deps.log, () => stopping);
    if (deps.emailRebind) {
      await runCountRebind("email_rebind", deps.emailRebind, deps.log, () => stopping);
    }
    if (deps.oidcRebind) {
      await runCountRebind("oidc_rebind", deps.oidcRebind, deps.log, () => stopping);
    }
  })();
  await rebindDone;
  if (!stopping) await sweeps.runOnce();
  await shutdown.done;
}

/** One-shot: item envelopes written before AAD binding are rebound, so the read path never needs the legacy `orgId` AAD again. */
async function runBootRebind(
  rebind: ServeHostedDeps["rebind"],
  log: ServeHostedDeps["log"],
  shouldStop: () => boolean,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await rebind({
      shouldStop,
      onBatch: (progress) => log("aad_rebind_progress", { ...progress, ms: Date.now() - startedAt }),
    });
    log("aad_rebind", { ...result, ms: Date.now() - startedAt });
  } catch (err) {
    log("aad_rebind_failed", { message: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt });
  }
}

async function runCountRebind(
  event: "email_rebind" | "oidc_rebind",
  run: (shouldStop: () => boolean) => Promise<Record<string, number>>,
  log: ServeHostedDeps["log"],
  shouldStop: () => boolean,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await run(shouldStop);
    log(event, { ...result, ms: Date.now() - startedAt });
  } catch (err) {
    log(`${event}_failed`, { message: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt });
  }
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
