import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { main } from "../src/cli.ts";
import { generateMasterKey } from "../src/crypto.ts";
import { CANARY, captureIo, cleanup, tempHome } from "./helpers.ts";

const vaultBin = fileURLToPath(new URL("../bin/vault.js", import.meta.url));

function envFor(home: string, keyHex: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    VAULT_HOME: home,
    VAULT_MASTER_KEY: keyHex,
    VAULT_ACTOR: "operator",
  };
}

async function withEnv<T>(home: string, keyHex: string, fn: () => Promise<T>): Promise<T> {
  const prev = {
    VAULT_HOME: process.env.VAULT_HOME,
    VAULT_MASTER_KEY: process.env.VAULT_MASTER_KEY,
    VAULT_ACTOR: process.env.VAULT_ACTOR,
  };
  process.env.VAULT_HOME = home;
  process.env.VAULT_MASTER_KEY = keyHex;
  process.env.VAULT_ACTOR = "operator";
  try {
    return await fn();
  } finally {
    if (prev.VAULT_HOME === undefined) delete process.env.VAULT_HOME;
    else process.env.VAULT_HOME = prev.VAULT_HOME;
    if (prev.VAULT_MASTER_KEY === undefined) delete process.env.VAULT_MASTER_KEY;
    else process.env.VAULT_MASTER_KEY = prev.VAULT_MASTER_KEY;
    if (prev.VAULT_ACTOR === undefined) delete process.env.VAULT_ACTOR;
    else process.env.VAULT_ACTOR = prev.VAULT_ACTOR;
  }
}

test("CLI init / set / list / grant / audit never print the value", async () => {
  const home = tempHome();
  const keyHex = generateMasterKey();
  const io = captureIo();
  try {
    await withEnv(home, keyHex, async () => {
      assert.equal(await main(["init"], io), 0);
      assert.equal(await main(["set", "STRIPE_KEY", "--value", CANARY], io), 0);
      assert.equal(await main(["list"], io), 0);
      assert.equal(
        await main(
          ["grant", "--secret", "STRIPE_KEY", "--agent", "invoicer", "--tool", "stripe", "--once"],
          io,
        ),
        0,
      );
      assert.equal(await main(["audit"], io), 0);
    });
    const out = [...io.stdout, ...io.stderr].join("\n");
    assert.ok(!out.includes(CANARY));
    assert.match(out, /STRIPE_KEY/);
    assert.match(out, /••••c10b/);
    assert.match(out, /Granted STRIPE_KEY/);
  } finally {
    cleanup(home);
  }
});

test("CLI run injects into the child without printing the secret", async () => {
  const home = tempHome();
  const keyHex = generateMasterKey();
  mkdirSync(home, { recursive: true });
  const probe = join(home, "probe.txt");
  const child = join(home, "child.mjs");
  writeFileSync(
    child,
    `
      import { writeFileSync } from "node:fs";
      const v = process.env.STRIPE_KEY || "";
      writeFileSync(${JSON.stringify(probe)}, v === ${JSON.stringify(CANARY)} ? "match" : "miss");
      console.log("child-ok");
    `,
  );

  await withEnv(home, keyHex, async () => {
    const io = captureIo();
    assert.equal(await main(["init"], io), 0);
    assert.equal(await main(["set", "STRIPE_KEY", "--value", CANARY], io), 0);
    assert.equal(
      await main(
        ["grant", "--secret", "STRIPE_KEY", "--agent", "invoicer", "--tool", "stripe", "--session"],
        io,
      ),
      0,
    );
  });

  const result = await spawnCapture(
    process.execPath,
    [
      vaultBin,
      "run",
      "--with",
      "STRIPE_KEY",
      "--agent",
      "invoicer",
      "--tool",
      "stripe",
      "--",
      process.execPath,
      child,
    ],
    envFor(home, keyHex),
  );

  try {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /child-ok/);
    assert.ok(!result.stdout.includes(CANARY));
    assert.ok(!result.stderr.includes(CANARY));
    assert.equal(await import("node:fs").then((fs) => fs.readFileSync(probe, "utf8")), "match");
  } finally {
    cleanup(home);
  }
});

test("vault login prints hosted stdio steps and never a canary", async () => {
  const io = captureIo();
  const prevUrl = process.env.VAULT_PUBLIC_URL;
  delete process.env.VAULT_PUBLIC_URL;
  try {
    assert.equal(await main(["login"], io), 0);
    const out = [...io.stdout, ...io.stderr].join("\n");
    assert.match(out, /\/sign-in/);
    assert.match(out, /\/console/);
    assert.match(out, /\/device/);
    assert.match(out, /vault mcp --user-jwt/);
    assert.doesNotMatch(out, /Clerk/);
    assert.ok(out.includes(STAGING_ORIGIN));
    assert.ok(!out.includes(CANARY));
    assert.ok(!out.includes("sk_live"));
  } finally {
    if (prevUrl === undefined) delete process.env.VAULT_PUBLIC_URL;
    else process.env.VAULT_PUBLIC_URL = prevUrl;
  }
});

test("vault login refuses a non-botpasses VAULT_PUBLIC_URL", async () => {
  const io = captureIo();
  const prevUrl = process.env.VAULT_PUBLIC_URL;
  const platformDefault = `https://botpasses-staging.${["fly", "dev"].join(".")}`;
  process.env.VAULT_PUBLIC_URL = platformDefault;
  try {
    assert.equal(await main(["login"], io), 1);
    const out = [...io.stdout, ...io.stderr].join("\n");
    assert.match(out, /botpasses\.com/);
    assert.ok(!out.includes(platformDefault));
  } finally {
    if (prevUrl === undefined) delete process.env.VAULT_PUBLIC_URL;
    else process.env.VAULT_PUBLIC_URL = prevUrl;
  }
});

test("vault mcp --user-jwt without VAULT_PUBLIC_URL exits 1", async () => {
  const io = captureIo();
  const prevUrl = process.env.VAULT_PUBLIC_URL;
  const prevJwt = process.env.VAULT_USER_JWT;
  delete process.env.VAULT_PUBLIC_URL;
  delete process.env.VAULT_USER_JWT;
  try {
    assert.equal(await main(["mcp", "--user-jwt", "eyJplaceholder"], io), 1);
    const err = io.stderr.join("\n");
    assert.match(err, /VAULT_PUBLIC_URL/);
    assert.ok(!err.includes(CANARY));
  } finally {
    if (prevUrl === undefined) delete process.env.VAULT_PUBLIC_URL;
    else process.env.VAULT_PUBLIC_URL = prevUrl;
    if (prevJwt === undefined) delete process.env.VAULT_USER_JWT;
    else process.env.VAULT_USER_JWT = prevJwt;
  }
});

test("help mentions the loopback bearer for vault serve", async () => {
  const io = captureIo();
  assert.equal(await main(["--help"], io), 0);
  const out = io.stdout.join("\n");
  assert.match(out, /loopback bearer/);
  assert.match(out, /Authorization/);
});

function spawnCapture(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
