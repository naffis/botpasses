import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { hostedBootError, HOSTED_CONFIG_EXIT } from "../src/hosted/boot.ts";
import { createDevMailer } from "../src/hosted/dev-mailer.ts";
import { openHostedStore } from "../src/hosted/hosted-store.ts";
import { OperatorIdentity } from "../src/hosted/operator-identity.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { applyHostedDevProcessEnv, buildHostedDevEnv, runHostedDev, secretsPath } from "../scripts/hosted-dev.ts";
import { cleanup, tempHome, TEST_SESSION_SECRET } from "./helpers.ts";

test("AC-06 dev mailer prints OTP; structured events do not contain the code", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "otp.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  const chunks: string[] = [];
  const mailer = createDevMailer(
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }),
  );
  const events: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    events.push(args.map(String).join(" "));
  };
  try {
    const identity = new OperatorIdentity({
      store,
      sessionSecret: TEST_SESSION_SECRET,
      kek,
      sendEmail: mailer,
    });
    await identity.sendOtp("op@example.com", "127.0.0.1");
    const stream = chunks.join("");
    const code = /(\d{8})/.exec(stream)?.[1];
    assert.ok(code, "dev mailer stream must contain an 8-digit code");
    assert.match(stream, /op@example.com/);
    const issued = await identity.verifyOtp("op@example.com", code, { secure: false }, "127.0.0.1");
    assert.ok(issued.sessionToken);
    const joined = events.join("\n");
    assert.doesNotMatch(joined, new RegExp(code));
  } finally {
    console.error = origError;
    await store.close();
    cleanup(home);
  }
});

test("AC-08 openHostedStore uses VAULT_HOSTED_SQLITE when DATABASE_URL is unset", async () => {
  const home = tempHome();
  const sqlitePath = join(home, "plane.sqlite");
  const store = await openHostedStore({
    VAULT_DEPLOY_PLANE: "dev",
    VAULT_HOSTED_SQLITE: sqlitePath,
  });
  try {
    assert.equal(existsSync(sqlitePath), true);
    await store.ping();
  } finally {
    await store.close();
  }
  if (!process.env.DATABASE_URL?.trim()) {
    cleanup(home);
    return;
  }
  const pg = await openHostedStore({
    VAULT_DEPLOY_PLANE: "dev",
    DATABASE_URL: process.env.DATABASE_URL,
  });
  try {
    assert.ok(pg instanceof PostgresStore);
    await pg.ping();
  } finally {
    await pg.close();
    cleanup(home);
  }
});

test("AC-12 hosted-dev --check writes 0o600 secrets and does not listen", async () => {
  const cwd = tempHome();
  mkdirSync(join(cwd, ".botpasses-hosted"), { recursive: true });
  const stderr: string[] = [];
  let started = false;
  const env = await runHostedDev(["--check"], {
    cwd,
    parent: { PORT: "8791" },
    error: (message) => stderr.push(message),
    start: async () => {
      started = true;
    },
  });
  assert.equal(hostedBootError(env), undefined);
  const path = secretsPath(cwd);
  assert.equal(existsSync(path), true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const secrets = JSON.parse(readFileSync(path, "utf8")) as { kek: string };
  assert.doesNotMatch(stderr.join("\n"), new RegExp(secrets.kek));
  assert.equal(started, false);
  assert.match(stderr.join("\n"), /hosted-dev --check ok/);
  cleanup(cwd);
});

test("AC-16 buildHostedDevEnv aligns VAULT_PUBLIC_URL with PORT", () => {
  const cwd = tempHome();
  const env = buildHostedDevEnv({ cwd, parent: { PORT: "9999" } });
  assert.equal(env.VAULT_PUBLIC_URL, "http://127.0.0.1:9999");
  assert.equal(env.PORT, "9999");
  cleanup(cwd);
});

test("AC-18 buildHostedDevEnv does not copy a leftover parent DATABASE_URL", () => {
  const cwd = tempHome();
  const leftover = buildHostedDevEnv({
    cwd,
    parent: {
      DATABASE_URL: "postgres://example/db",
      VAULT_HOME: "/tmp/vault",
      FLY_APP_NAME: "botpasses-staging",
    },
  });
  assert.equal(leftover.DATABASE_URL, undefined);
  assert.equal(leftover.VAULT_HOME, undefined);
  assert.equal(leftover.FLY_APP_NAME, undefined);
  const opted = buildHostedDevEnv({
    cwd,
    parent: {
      DATABASE_URL: "postgres://example/db",
      VAULT_HOSTED_DEV_DATABASE_URL: "postgres://local/vault",
    },
    postgres: true,
  });
  assert.equal(opted.DATABASE_URL, "postgres://local/vault");
  cleanup(cwd);
});

test("hosted-dev --reset replaces secrets and warns without printing key material", async () => {
  const cwd = tempHome();
  const first = buildHostedDevEnv({ cwd, parent: {} });
  const firstKek = first.VAULT_KEK;
  assert.ok(firstKek);
  const stderr: string[] = [];
  const second = await runHostedDev(["--check", "--reset"], {
    cwd,
    parent: {},
    error: (message) => stderr.push(message),
    start: async () => {
      throw new Error("must not listen");
    },
  });
  assert.notEqual(second.VAULT_KEK, firstKek);
  assert.match(stderr.join("\n"), /will not unwrap/);
  assert.doesNotMatch(stderr.join("\n"), new RegExp(firstKek));
  assert.doesNotMatch(stderr.join("\n"), new RegExp(second.VAULT_KEK ?? "missing"));
  writeFileSync(secretsPath(cwd), "{not-json", { encoding: "utf8" });
  assert.throws(() => buildHostedDevEnv({ cwd, parent: {} }), (err: unknown) => {
    assert.match(err instanceof Error ? err.message : "", /--reset/);
    assert.equal((err as { exitCode?: number }).exitCode, HOSTED_CONFIG_EXIT);
    return true;
  });
  cleanup(cwd);
});

test("openHostedStore refuses sqlite unless the plane is dev", async () => {
  await assert.rejects(openHostedStore({ VAULT_DEPLOY_PLANE: "staging" }), /DATABASE_URL|Postgres/);
  await assert.rejects(openHostedStore({ VAULT_DEPLOY_PLANE: "production" }), /DATABASE_URL|Postgres/);
});

test("applyHostedDevProcessEnv strips leftover wrap and test-auth flags", () => {
  const cwd = tempHome();
  const env = buildHostedDevEnv({ cwd, parent: {} });
  const target: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    VAULT_KEK_WRAPPED: "d3JhcA==",
    VAULT_KMS_KEY_ID: "arn:aws:kms:us-east-1:1:key/x",
    VAULT_KEK_REQUIRE_KMS: "1",
    VAULT_KEK_PREVIOUS: "not-a-key",
    VAULT_OIDC_PREVIOUS_JWK: "not-a-jwk",
    VAULT_BOOTSTRAP_TOKEN: "short",
    VAULT_AUTH_MODE: "test",
    VAULT_HOME: "/tmp/x",
    FLY_APP_NAME: "botpasses-staging",
    DATABASE_URL: "postgres://example/db",
    RESEND_API_KEY: "re_leftover",
  };
  applyHostedDevProcessEnv(target, env);
  assert.equal(target.PATH, "/usr/bin");
  assert.equal(target.VAULT_KEK_WRAPPED, undefined);
  assert.equal(target.VAULT_KEK_REQUIRE_KMS, undefined);
  assert.equal(target.VAULT_KEK_PREVIOUS, undefined);
  assert.equal(target.VAULT_OIDC_PREVIOUS_JWK, undefined);
  assert.equal(target.VAULT_BOOTSTRAP_TOKEN, undefined);
  assert.equal(target.VAULT_AUTH_MODE, undefined);
  assert.equal(target.VAULT_HOME, undefined);
  assert.equal(target.FLY_APP_NAME, undefined);
  assert.equal(target.DATABASE_URL, undefined);
  assert.equal(target.RESEND_API_KEY, undefined);
  assert.equal(hostedBootError(target), undefined);
  cleanup(cwd);
});
