import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { main, normalizeMcpArgs, parsePort } from "../src/cli.ts";
import { generateMasterKey } from "../src/crypto.ts";
import { CANARY, captureIo, cleanup, tempHome } from "./helpers.ts";

/** Sets (or, for undefined, unsets) process env for the call and restores it afterwards. */
async function withEnvVars<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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
  io.readStdin = async () => CANARY;
  try {
    await withEnv(home, keyHex, async () => {
      assert.equal(await main(["init"], io), 0);
      assert.equal(await main(["set", "STRIPE_KEY"], io), 0);
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
  io.readStdin = async () => CANARY;
    assert.equal(await main(["init"], io), 0);
    assert.equal(await main(["set", "STRIPE_KEY"], io), 0);
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

test("vault init creates the home directory before writing master.key (fresh machine, no VAULT_MASTER_KEY)", async () => {
  const root = tempHome();
  const home = join(root, "nested", "botpasses-home");
  const io = captureIo();
  try {
    await withEnvVars({ VAULT_HOME: home, VAULT_MASTER_KEY: undefined }, async () => {
      assert.equal(await main(["init"], io), 0, io.stderr.join("\n"));
    });
    const { statSync } = await import("node:fs");
    const mode = statSync(join(home, "master.key")).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.match(io.stdout.join("\n"), /Key source: generated/);
  } finally {
    cleanup(root);
  }
});

test("vault mcp --user-jwt=TOKEN is hosted mode: it never falls back to the local vault", async () => {
  const home = tempHome();
  const io = captureIo();
  try {
    // No master key in this home: falling through to the local vault would fail differently.
    await withEnvVars({ VAULT_HOME: home, VAULT_MASTER_KEY: undefined, VAULT_PUBLIC_URL: undefined, VAULT_USER_JWT: undefined }, async () => {
      assert.equal(await main(["mcp", "--user-jwt=eyJplaceholder"], io), 1);
    });
    assert.match(io.stderr.join("\n"), /VAULT_PUBLIC_URL/);
    assert.deepEqual(normalizeMcpArgs(["--user-jwt"]), ["--user-jwt="]);
    assert.deepEqual(normalizeMcpArgs(["--user-jwt", "--remote"]), ["--user-jwt=", "--remote"]);
    assert.deepEqual(normalizeMcpArgs(["--user-jwt", "tok"]), ["--user-jwt", "tok"]);
    assert.deepEqual(normalizeMcpArgs(["--remote=http://127.0.0.1:9000"]), ["--remote", "http://127.0.0.1:9000"]);
  } finally {
    cleanup(home);
  }
});

test("vault mcp refuses --remote with --user-jwt, unknown options, and stray arguments", async () => {
  const io = captureIo();
  assert.equal(await main(["mcp", "--remote", "--user-jwt", "x"], io), 1);
  assert.match(io.stderr.join("\n"), /not both/);
  const unknown = captureIo();
  assert.equal(await main(["mcp", "--bogus"], unknown), 1);
  assert.match(unknown.stderr.join("\n"), /Unknown option/);
  const stray = captureIo();
  assert.equal(await main(["mcp", "extra"], stray), 1);
  assert.match(stray.stderr.join("\n"), /Unexpected argument: extra/);
});

test("per-command --help prints usage and exits 0 instead of parsing options or serving", async () => {
  for (const args of [["grant", "--help"], ["mcp", "--help"], ["serve", "-h"], ["set", "NAME", "--help"], ["run", "--help", "--", "cmd"]]) {
    const io = captureIo();
    assert.equal(await main(args, io), 0, args.join(" "));
    assert.match(io.stdout.join("\n"), /Usage:/, args.join(" "));
  }
});

test("vault grant refuses --once with --session and --ttl without --session", async () => {
  const home = tempHome();
  const keyHex = generateMasterKey();
  try {
    await withEnv(home, keyHex, async () => {
      const both = captureIo();
      assert.equal(await main(["grant", "--secret", "K", "--agent", "a", "--tool", "t", "--once", "--session"], both), 1);
      assert.match(both.stderr.join("\n"), /--once or --session, not both/);
      const ttl = captureIo();
      assert.equal(await main(["grant", "--secret", "K", "--agent", "a", "--tool", "t", "--once", "--ttl", "8h"], ttl), 1);
      assert.match(ttl.stderr.join("\n"), /--ttl applies to --session/);
      const bare = captureIo();
      assert.equal(await main(["grant", "--secret", "K", "--agent", "a", "--tool", "t", "--ttl", "8h"], bare), 1);
      assert.match(bare.stderr.join("\n"), /--ttl applies to --session/);
    });
  } finally {
    cleanup(home);
  }
});

test("vault serve validates --port before opening the vault", async () => {
  const home = tempHome();
  const keyHex = generateMasterKey();
  try {
    await withEnv(home, keyHex, async () => {
      for (const port of ["abc", "0", "70000", "80.5", ""]) {
        const io = captureIo();
        assert.equal(await main(["serve", "--port", port], io), 1, port);
        assert.match(io.stderr.join("\n"), /--port must be a whole number from 1 to 65535/, port);
      }
    });
    assert.equal(parsePort("8788"), 8788);
    assert.equal(parsePort(" 443 "), 443);
    assert.equal(parsePort("65536"), undefined);
  } finally {
    cleanup(home);
  }
});

test("help mentions the loopback bearer for vault serve and the five MCP tools", async () => {
  const io = captureIo();
  assert.equal(await main(["--help"], io), 0);
  const out = io.stdout.join("\n");
  assert.match(out, /loopback bearer/);
  assert.match(out, /Authorization/);
  assert.match(out, /--host api\.example\.com/);
  assert.match(out, /--inject bearer\|basic\|header:Name/);
  assert.match(out, /list_items, find_items, request_grant, list_grants, setup, http_request/);
  assert.match(out, /--tool http_request/);
  assert.doesNotMatch(out, /—/);
});

test("CLI set --host --inject stores connector metadata and list shows it, never the value", async () => {
  const home = tempHome();
  const keyHex = generateMasterKey();
  const io = captureIo();
  io.readStdin = async () => CANARY;
  try {
    await withEnv(home, keyHex, async () => {
      assert.equal(await main(["init"], io), 0);
      assert.equal(
        await main(["set", "STRIPE_KEY", "--host", "api.stripe.com", "--host", "files.stripe.com", "--inject", "basic"], io),
        0,
      );
      assert.equal(await main(["set", "PLAIN_KEY"], io), 0);
      assert.equal(await main(["set", "SIGNED_KEY", "--host", "api.example.com", "--inject", "hmac:stripe_sig", "--username", "acct_1"], io), 0);
      assert.equal(await main(["list"], io), 0);
      assert.equal(await main(["set", "BAD", "--inject", "cookie"], io).catch(() => 1), 1);
    });
    const out = [...io.stdout, ...io.stderr].join("\n");
    assert.ok(!out.includes(CANARY));
    assert.match(out, /Stored STRIPE_KEY ••••c10b hosts=api.stripe.com,files.stripe.com inject=basic/);
    assert.match(out, /Stored SIGNED_KEY ••••c10b hosts=api.example.com inject=hmac:stripe_sig username=acct_1/);
    assert.match(out, /STRIPE_KEY\t••••c10b\tapi.stripe.com,files.stripe.com\tbasic\tupdated/);
    assert.match(out, /PLAIN_KEY\t••••c10b\t-\tbearer\tupdated/);
  } finally {
    cleanup(home);
  }
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
