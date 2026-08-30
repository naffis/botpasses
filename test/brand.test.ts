import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_HOME_DIRNAME,
  HEALTH_PRODUCT,
  MCP_SERVER_NAME,
  PRODUCT_NAME,
  PRODUCTION_ORIGIN,
  STAGING_ORIGIN,
  WWW_AUTHENTICATE_REALM,
} from "../src/brand.ts";
import { defaultHome } from "../src/vault.ts";
import { createResendSender } from "../src/hosted/email.ts";

test("brand constants are Botpasses", () => {
  assert.equal(PRODUCT_NAME, "Botpasses");
  assert.equal(MCP_SERVER_NAME, "botpasses");
  assert.equal(HEALTH_PRODUCT, "botpasses");
  assert.equal(DEFAULT_HOME_DIRNAME, ".botpasses");
  assert.equal(STAGING_ORIGIN, "https://staging.botpasses.ai");
  assert.equal(PRODUCTION_ORIGIN, "https://botpasses.ai");
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
  };
  assert.equal(pkg.name, "botpasses");
  assert.equal(pkg.bin.botpasses, "./bin/vault.js");
  assert.equal(pkg.bin.vault, "./bin/vault.js");
  assert.ok(pkg.keywords.includes("botpasses"));
});

test("fly tomls use botpasses app names", () => {
  const staging = readFileSync(join(process.cwd(), "fly.staging.toml"), "utf8");
  const prod = readFileSync(join(process.cwd(), "fly.prod.toml"), "utf8");
  assert.match(staging, /^app = "botpasses-staging"$/m);
  assert.match(prod, /^app = "botpasses-prod"$/m);
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
  const from = "Botpasses <noreply@mail.botpasses.ai>";
  let parsed: { from?: string } = {};
  globalThis.fetch = async (_url, init) => {
    parsed = JSON.parse(String(init?.body)) as { from?: string };
    return new Response("{}", { status: 200 });
  };
  try {
    const send = createResendSender("re_test", from);
    await send("op@example.com", "subj", "<p>x</p>");
    assert.equal(parsed.from, from);
  } finally {
    globalThis.fetch = orig;
  }
});
