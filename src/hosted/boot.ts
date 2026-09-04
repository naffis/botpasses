/** Hosted boot invariants, shutdown, and background sweeps. Exit 78 = EX_CONFIG. */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hostedDeployPlane, originForPlane, publicOriginError } from "../brand.ts";
import type { SweepCounts } from "../store/types.ts";

export const HOSTED_CONFIG_EXIT = 78;

/** Fly `kill_timeout` is 30 s; give open SSE streams 25 s, then cut them. */
export const SHUTDOWN_DRAIN_MS = 25_000;
/** After the drain deadline the server should close within this margin, or we exit anyway. */
export const SHUTDOWN_FORCE_MARGIN_MS = 3_000;
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type ShutdownHttp = {
  close(): Promise<void>;
  /** `node:http` Server#closeAllConnections; optional so a fake server can omit it. */
  server?: { closeAllConnections?: () => void };
};

export type ShutdownDeps = {
  http: ShutdownHttp;
  store: { close(): Promise<void> };
  /** Runs after the store is closed (zero the KEK, clear timers). */
  onDone?: () => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
  exit?: (code: number) => void;
  drainMs?: number;
  forceMarginMs?: number;
};

export type Shutdown = {
  /** Idempotent. The first call starts the drain; later calls are logged and ignored. */
  stop: (signal: string) => void;
  /** Resolves once the drain finished (or was forced). Never rejects. */
  done: Promise<void>;
};

/**
 * Drain order: stop accepting, wait up to `drainMs` for in-flight requests and SSE streams,
 * `closeAllConnections()`, then end the pool, then `onDone` (zero the KEK), then exit 0.
 * A second SIGTERM does not start a second drain or double-close the pool.
 */
export function createShutdown(deps: ShutdownDeps): Shutdown {
  const log = deps.log ?? (() => undefined);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const drainMs = deps.drainMs ?? SHUTDOWN_DRAIN_MS;
  const forceMarginMs = deps.forceMarginMs ?? SHUTDOWN_FORCE_MARGIN_MS;
  let started = false;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolveFn) => {
    resolveDone = resolveFn;
  });

  async function drain(signal: string): Promise<void> {
    const startedAt = Date.now();
    log("shutdown_begin", { signal, drain_ms: drainMs });
    let forced = false;
    // Not unref'd on purpose: during a drain these timers are what guarantee the process
    // reaches `exit` with a logged outcome even if every socket has already gone away.
    const cut = setTimeout(() => {
      forced = true;
      log("shutdown_cut_connections", { after_ms: Date.now() - startedAt });
      deps.http.server?.closeAllConnections?.();
    }, drainMs);
    const force = setTimeout(() => {
      log("shutdown_forced", { after_ms: Date.now() - startedAt });
      resolveDone();
      exit(1);
    }, drainMs + forceMarginMs);
    let code = 0;
    try {
      await deps.http.close();
    } catch (err) {
      code = 1;
      log("shutdown_http_close_failed", { message: err instanceof Error ? err.message : String(err) });
    }
    clearTimeout(cut);
    try {
      await deps.store.close();
    } catch (err) {
      code = 1;
      log("shutdown_store_close_failed", { message: err instanceof Error ? err.message : String(err) });
    }
    clearTimeout(force);
    try {
      deps.onDone?.();
    } catch {
      code = 1;
    }
    log("shutdown_done", { ms: Date.now() - startedAt, forced, code });
    resolveDone();
    exit(code);
  }

  return {
    done,
    stop(signal: string): void {
      if (started) {
        log("shutdown_repeat_signal", { signal });
        return;
      }
      started = true;
      void drain(signal);
    },
  };
}

export type SweepStore = { sweepExpired(nowIso: string): Promise<SweepCounts> };

export type SweepSchedule = {
  /** One sweep now. Errors are logged, never thrown. */
  runOnce(): Promise<SweepCounts | undefined>;
  stop(): void;
};

/**
 * Run `store.sweepExpired` now and every `intervalMs` (default hourly). The timer is
 * unref'd so it never keeps the process alive.
 */
export function scheduleSweeps(
  store: SweepStore,
  opts: {
    intervalMs?: number;
    log?: (event: string, fields: Record<string, unknown>) => void;
    now?: () => Date;
  } = {},
): SweepSchedule {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (() => new Date());
  let running = false;
  async function runOnce(): Promise<SweepCounts | undefined> {
    if (running) return undefined;
    running = true;
    const startedAt = Date.now();
    try {
      const counts = await store.sweepExpired(now().toISOString());
      log("sweep_expired", { ...counts, ms: Date.now() - startedAt });
      return counts;
    } catch (err) {
      log("sweep_failed", { message: err instanceof Error ? err.message : String(err) });
      return undefined;
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => {
    void runOnce();
  }, opts.intervalMs ?? SWEEP_INTERVAL_MS);
  timer.unref();
  return {
    runOnce,
    stop: () => clearInterval(timer),
  };
}

/**
 * Last-resort handlers. A hosted process with an unknown broken invariant must not keep
 * serving; log one line and exit 1 so Fly restarts it.
 */
export function installProcessGuards(
  proc: Pick<NodeJS.Process, "on" | "exit"> = process,
  log: (event: string, fields: Record<string, unknown>) => void = (event, fields) =>
    console.error(JSON.stringify({ event, ...fields, at: new Date().toISOString() })),
): void {
  proc.on("unhandledRejection", (reason: unknown) => {
    log("unhandled_rejection", { message: reason instanceof Error ? reason.message : String(reason) });
    proc.exit(1);
  });
  proc.on("uncaughtException", (err: Error) => {
    log("uncaught_exception", { message: err.message, name: err.name });
    proc.exit(1);
  });
}

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

/**
 * `VAULT_KEK_PREVIOUS` / `VAULT_KEK_PREVIOUS_WRAPPED` (the KEK a rotation is leaving) follow the
 * same rules as the current KEK: one form at a time, raw refused under `VAULT_KEK_REQUIRE_KMS=1`,
 * the wrapped form only on a plane with `VAULT_KMS_KEY_ID`, and a raw value must parse.
 */
export function previousKekBootError(env: NodeJS.ProcessEnv): string | undefined {
  const plane = deployPlaneRaw(env);
  const raw = env.VAULT_KEK_PREVIOUS?.trim() ?? "";
  const wrapped = env.VAULT_KEK_PREVIOUS_WRAPPED?.trim() ?? "";
  if (!raw && !wrapped) return undefined;
  if (raw && wrapped) return "Set VAULT_KEK_PREVIOUS or VAULT_KEK_PREVIOUS_WRAPPED, not both.";
  if (wrapped) {
    if (!plane || !env.VAULT_KMS_KEY_ID?.trim()) {
      return "VAULT_KEK_PREVIOUS_WRAPPED requires VAULT_DEPLOY_PLANE and VAULT_KMS_KEY_ID.";
    }
    if (!env.FLY_APP_NAME?.trim()) return "VAULT_KEK_PREVIOUS_WRAPPED requires FLY_APP_NAME.";
    return undefined;
  }
  if (plane && env.VAULT_KEK_REQUIRE_KMS === "1") {
    return "VAULT_KEK_REQUIRE_KMS=1 refuses raw VAULT_KEK_PREVIOUS; use VAULT_KEK_PREVIOUS_WRAPPED.";
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw) && Buffer.from(raw, "base64").length !== 32) {
    return "VAULT_KEK_PREVIOUS must be a 32-byte key (64 hex chars or base64).";
  }
  return undefined;
}

export function hostedKekBootError(env: NodeJS.ProcessEnv): string | undefined {
  const plane = deployPlaneRaw(env);
  if (env.VAULT_AUTH_MODE === "test" && plane) {
    return "VAULT_AUTH_MODE=test is refused when VAULT_DEPLOY_PLANE is staging or production.";
  }
  const previousErr = previousKekBootError(env);
  if (previousErr) return previousErr;
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
