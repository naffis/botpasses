#!/usr/bin/env node
/**
 * Laptop hosted kernel: sqlite-hosted (or opt-in Postgres), loopback, printed OTP.
 * Does not inherit DATABASE_URL, VAULT_HOME, or FLY_APP_NAME from the parent env.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostedBootError, HOSTED_CONFIG_EXIT } from "../src/hosted/boot.ts";
import { startHosted } from "../src/hosted/main.ts";

export const HOSTED_DEV_DIRNAME = ".botpasses-hosted";
export const HOSTED_DEV_SECRETS = "secrets.json";

export type HostedDevJwk = {
  kty: "RSA";
  alg: "RS256";
  d: string;
  n: string;
  e: string;
  kid?: string;
  use?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
};

export type HostedDevSecrets = {
  kek: string;
  sessionSecret: string;
  approvalHmac: string;
  oidcJwk: HostedDevJwk;
};

export type BuildHostedDevEnvOpts = {
  cwd?: string;
  parent?: NodeJS.ProcessEnv;
  postgres?: boolean;
  reset?: boolean;
  port?: string;
};

export type RunHostedDevOpts = {
  cwd?: string;
  parent?: NodeJS.ProcessEnv;
  start?: (env: NodeJS.ProcessEnv) => Promise<void>;
  error?: (message: string) => void;
};

function configError(message: string): Error & { exitCode: number } {
  const err = new Error(message) as Error & { exitCode: number };
  err.exitCode = HOSTED_CONFIG_EXIT;
  return err;
}

/** Parent keys that `hostedBootError` / dest boot read. A leftover can fail listen after `--check` passed. */
function isHostedDevParentPoison(key: string): boolean {
  return (
    key.startsWith("VAULT_") ||
    key === "DATABASE_URL" ||
    key === "DATABASE_URL_DIRECT" ||
    key === "FLY_APP_NAME" ||
    key === "FLY_ALLOC_ID" ||
    key === "RESEND_API_KEY"
  );
}

export function applyHostedDevProcessEnv(target: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(target)) {
    if (isHostedDevParentPoison(key) && env[key] === undefined) delete target[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) target[key] = value;
  }
}

function parseArgs(argv: string[]): { check: boolean; reset: boolean; postgres: boolean } {
  return {
    check: argv.includes("--check"),
    reset: argv.includes("--reset"),
    postgres: argv.includes("--postgres"),
  };
}

function generateOidcJwk(): HostedDevJwk {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as HostedDevJwk;
  return { ...jwk, kty: "RSA", alg: "RS256", kid: "hosted-dev", use: "sig" };
}

export function generateHostedDevSecrets(): HostedDevSecrets {
  return {
    kek: randomBytes(32).toString("hex"),
    sessionSecret: randomBytes(32).toString("base64url"),
    approvalHmac: randomBytes(32).toString("hex"),
    oidcJwk: generateOidcJwk(),
  };
}

function parseSecrets(raw: string): HostedDevSecrets {
  const parsed = JSON.parse(raw) as Partial<HostedDevSecrets>;
  if (
    typeof parsed.kek !== "string" ||
    typeof parsed.sessionSecret !== "string" ||
    typeof parsed.approvalHmac !== "string" ||
    !parsed.oidcJwk ||
    typeof parsed.oidcJwk !== "object"
  ) {
    throw new Error("corrupt secrets.json");
  }
  return {
    kek: parsed.kek,
    sessionSecret: parsed.sessionSecret,
    approvalHmac: parsed.approvalHmac,
    oidcJwk: parsed.oidcJwk,
  };
}

export function secretsPath(cwd: string): string {
  return resolve(cwd, HOSTED_DEV_DIRNAME, HOSTED_DEV_SECRETS);
}

export function loadOrCreateSecrets(cwd: string, reset: boolean): { secrets: HostedDevSecrets; created: boolean } {
  const dir = resolve(cwd, HOSTED_DEV_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const path = secretsPath(cwd);
  if (reset || !existsSync(path)) {
    const secrets = generateHostedDevSecrets();
    writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    return { secrets, created: true };
  }
  try {
    const secrets = parseSecrets(readFileSync(path, "utf8"));
    chmodSync(path, 0o600);
    return { secrets, created: false };
  } catch {
    throw configError(
      `${path} is unreadable or corrupt. Re-run with --reset (the existing hosted.sqlite will not unwrap under new secrets).`,
    );
  }
}

export function buildHostedDevEnv(opts: BuildHostedDevEnvOpts = {}): NodeJS.ProcessEnv {
  const cwd = opts.cwd ?? process.cwd();
  const parent = opts.parent ?? {};
  const port = opts.port ?? (parent.PORT?.trim() || parent.VAULT_PORT?.trim() || "8788");
  const { secrets } = loadOrCreateSecrets(cwd, Boolean(opts.reset));
  const env: NodeJS.ProcessEnv = {
    VAULT_MODE: "hosted",
    VAULT_DEPLOY_PLANE: "dev",
    VAULT_PUBLIC_URL: `http://127.0.0.1:${port}`,
    VAULT_BIND_HOST: "127.0.0.1",
    PORT: port,
    VAULT_KEK: secrets.kek,
    VAULT_SESSION_SECRET: secrets.sessionSecret,
    VAULT_APPROVAL_HMAC: secrets.approvalHmac,
    VAULT_OIDC_PRIVATE_JWK: JSON.stringify(secrets.oidcJwk),
    VAULT_HOSTED_SQLITE: parent.VAULT_HOSTED_SQLITE?.trim() || resolve(cwd, HOSTED_DEV_DIRNAME, "hosted.sqlite"),
  };
  const hostedDevUrl = parent.VAULT_HOSTED_DEV_DATABASE_URL?.trim();
  if (opts.postgres || hostedDevUrl) {
    const url = hostedDevUrl || parent.DATABASE_URL?.trim();
    if (!url) {
      throw configError("hosted:dev --postgres requires VAULT_HOSTED_DEV_DATABASE_URL or DATABASE_URL.");
    }
    env.DATABASE_URL = url;
  }
  if (parent.RESEND_API_KEY?.trim()) {
    env.RESEND_API_KEY = parent.RESEND_API_KEY;
    if (parent.VAULT_EMAIL_FROM?.trim()) env.VAULT_EMAIL_FROM = parent.VAULT_EMAIL_FROM;
  }
  return env;
}

export async function runHostedDev(
  argv: string[] = process.argv.slice(2),
  opts: RunHostedDevOpts = {},
): Promise<NodeJS.ProcessEnv> {
  const flags = parseArgs(argv);
  const cwd = opts.cwd ?? process.cwd();
  const parent = opts.parent ?? process.env;
  const error = opts.error ?? ((message: string) => console.error(message));
  if (flags.reset) {
    error("Replacing .botpasses-hosted/secrets.json. Existing hosted.sqlite ciphertext will not unwrap.");
  }
  const env = buildHostedDevEnv({
    cwd,
    parent,
    postgres: flags.postgres,
    reset: flags.reset,
  });
  const bootErr = hostedBootError(env);
  if (bootErr) {
    error(bootErr);
    throw configError(bootErr);
  }
  if (flags.check) {
    error("hosted-dev --check ok");
    return env;
  }
  if (opts.start) {
    await opts.start(env);
    return env;
  }
  applyHostedDevProcessEnv(process.env, env);
  await startHosted(process.env);
  return env;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false;
if (invoked) {
  void runHostedDev().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    const code = err instanceof Error && "exitCode" in err && typeof err.exitCode === "number" ? err.exitCode : 1;
    process.exit(code);
  });
}
