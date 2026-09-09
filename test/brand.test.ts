import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_HOME_DIRNAME,
  HEALTH_PRODUCT,
  MCP_SERVER_NAME,
  PRODUCT_NAME,
  PRODUCT_WORDMARK,
  PRODUCTION_ORIGIN,
  publicOriginError,
  resolvePublicOrigin,
  STAGING_ORIGIN,
  WWW_AUTHENTICATE_REALM,
} from "../src/brand.ts";
import { defaultHome } from "../src/vault.ts";
import { createResendSender } from "../src/hosted/email.ts";

test("brand constants are Botpasses", () => {
  assert.equal(PRODUCT_NAME, "Botpasses");
  assert.equal(PRODUCT_WORDMARK, "botpasses");
  assert.equal(MCP_SERVER_NAME, "botpasses");
  assert.equal(HEALTH_PRODUCT, "botpasses");
  assert.equal(DEFAULT_HOME_DIRNAME, ".botpasses");
  assert.equal(STAGING_ORIGIN, "https://staging.botpasses.com");
  assert.equal(PRODUCTION_ORIGIN, "https://botpasses.com");
  assert.equal(WWW_AUTHENTICATE_REALM, "botpasses");
});

test("default home ends with /.botpasses when VAULT_HOME is unset", () => {
  const prev = process.env.VAULT_HOME;
  delete process.env.VAULT_HOME;
  try {
    assert.match(defaultHome(), /\/\.botpasses$/);
  } finally {
    if (prev === undefined) delete process.env.VAULT_HOME;
    else process.env.VAULT_HOME = prev;
  }
});

test("package.json name and dual bin", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    name: string;
    bin: Record<string, string>;
    keywords: string[];
    homepage: string;
  };
  assert.equal(pkg.name, "botpasses");
  assert.equal(pkg.bin.botpasses, "./bin/vault.js");
  assert.equal(pkg.bin.vault, "./bin/vault.js");
  assert.ok(pkg.keywords.includes("botpasses"));
  assert.equal(pkg.homepage, PRODUCTION_ORIGIN);
});

test("fly tomls use botpasses app names", () => {
  const staging = readFileSync(join(process.cwd(), "fly.staging.toml"), "utf8");
  const prod = readFileSync(join(process.cwd(), "fly.prod.toml"), "utf8");
  assert.match(staging, /^app = "botpasses-staging"$/m);
  assert.match(prod, /^app = "botpasses-prod"$/m);
  assert.match(staging, /^ {2}VAULT_PUBLIC_URL = "https:\/\/staging\.botpasses\.com"$/m);
  assert.match(prod, /^ {2}VAULT_PUBLIC_URL = "https:\/\/botpasses\.com"$/m);
});

const FORBIDDEN_BRAND = /Agent Grant Vault|AgentVault|agent-grant-vault|staging\.vault\.example\.com|mail\.agent-vault\.invalid|Agent grant vault|Agent Vault/;

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

test("src scripts README AGENTS env package have no leftover Agent Grant Vault copy", () => {
  const cwd = process.cwd();
  const files = [
    ...walkFiles(join(cwd, "src")),
    ...walkFiles(join(cwd, "scripts")),
    join(cwd, "README.md"),
    join(cwd, "AGENTS.md"),
    join(cwd, ".env.example"),
    join(cwd, "package.json"),
  ];
  const hits: string[] = [];
  for (const file of files) {
    if (FORBIDDEN_BRAND.test(readFileSync(file, "utf8"))) hits.push(file);
  }
  assert.deepEqual(hits, []);
});

test("live product surfaces do not use botpasses.ai", () => {
  const cwd = process.cwd();
  const files = [
    ...walkFiles(join(cwd, "src")),
    ...walkFiles(join(cwd, "scripts")),
    ...walkFiles(join(cwd, "docs/ops")),
    ...walkFiles(join(cwd, "test")).filter((f) => !f.endsWith("brand.test.ts")),
    join(cwd, "README.md"),
    join(cwd, "AGENTS.md"),
    join(cwd, ".env.example"),
    join(cwd, "package.json"),
  ];
  const hits: string[] = [];
  for (const file of files) {
    if (readFileSync(file, "utf8").includes("botpasses.ai")) hits.push(file);
  }
  assert.deepEqual(hits, []);
  assert.ok(readFileSync(join(cwd, "README.md"), "utf8").includes(STAGING_ORIGIN));
  assert.ok(readFileSync(join(cwd, "AGENTS.md"), "utf8").includes(PRODUCTION_ORIGIN));
});

test("public origin allowlist is botpasses.com or loopback", () => {
  assert.equal(publicOriginError(STAGING_ORIGIN), undefined);
  assert.equal(publicOriginError(PRODUCTION_ORIGIN), undefined);
  assert.equal(publicOriginError("http://127.0.0.1:8788"), undefined);
  assert.equal(resolvePublicOrigin(STAGING_ORIGIN, { plane: "staging" }), STAGING_ORIGIN);
  assert.match(publicOriginError("https://example.com") ?? "", /botpasses\.com/);
  const platformDefault = `https://botpasses-staging.${["fly", "dev"].join(".")}`;
  assert.match(publicOriginError(platformDefault) ?? "", /botpasses\.com/);
  assert.match(
    publicOriginError(platformDefault, { plane: "staging", allowLoopback: false }) ?? "",
    /staging\.botpasses\.com/,
  );
  assert.match(
    publicOriginError("http://127.0.0.1:8788", { plane: "staging", allowLoopback: false }) ?? "",
    /staging\.botpasses\.com/,
  );
  assert.match(publicOriginError(PRODUCTION_ORIGIN, { plane: "staging" }) ?? "", /staging\.botpasses\.com/);
});

test("live product surfaces do not name a platform default hostname", () => {
  const cwd = process.cwd();
  const needle = ["fly", "dev"].join(".");
  const files = [
    ...walkFiles(join(cwd, "src")),
    ...walkFiles(join(cwd, "scripts")),
    ...walkFiles(join(cwd, "docs/ops")),
    join(cwd, "README.md"),
    join(cwd, "AGENTS.md"),
    join(cwd, ".env.example"),
    join(cwd, "package.json"),
    join(cwd, "fly.staging.toml"),
    join(cwd, "fly.prod.toml"),
  ];
  const hits: string[] = [];
  for (const file of files) {
    if (readFileSync(file, "utf8").includes(needle)) hits.push(file);
  }
  assert.deepEqual(hits, []);
});

test("createResendSender empty from throws before fetch", async () => {
  const orig = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("ok", { status: 200 });
  };
  try {
    const send = createResendSender("re_test", "  ");
    await assert.rejects(() => send("op@example.com", "subj", "<p>x</p>"), /VAULT_EMAIL_FROM/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test("createResendSender uses VAULT_EMAIL_FROM in JSON", async () => {
  const orig = globalThis.fetch;
  const from = "Botpasses <noreply@staging.botpasses.com>";
  let parsed: { from?: string; text?: string } = {};
  globalThis.fetch = async (_url, init) => {
    parsed = JSON.parse(String(init?.body)) as { from?: string; text?: string };
    return new Response("{}", { status: 200 });
  };
  try {
    const send = createResendSender("re_test", from);
    await send("op@example.com", "subj", "<p>x</p>", "plain");
    assert.equal(parsed.from, from);
    assert.equal(parsed.text, "plain");
  } finally {
    globalThis.fetch = orig;
  }
});
