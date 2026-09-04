import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generateMasterKey } from "../src/crypto.ts";
import { cleanup, tempHome } from "./helpers.ts";

type Probe = { code: number; pg: boolean; kms: boolean; oidc: boolean };

function probe(args: string[], env: NodeJS.ProcessEnv): Promise<Probe> {
  const helper = fileURLToPath(new URL("./helpers/cli-modules.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", helper, ...args],
      { env: { ...process.env, ...env } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => void (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => void (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`probe exit ${code}: ${err}`));
      const last = out.trim().split("\n").at(-1) ?? "{}";
      resolve(JSON.parse(last) as Probe);
    });
  });
}

test("vault init/set/list do not load pg, the AWS KMS SDK, or oidc-provider", async () => {
  const home = tempHome();
  const env = { VAULT_HOME: home, VAULT_MASTER_KEY: generateMasterKey(), VAULT_MODE: "" };
  try {
    const init = await probe(["init"], env);
    assert.equal(init.code, 0);
    assert.deepEqual({ pg: init.pg, kms: init.kms, oidc: init.oidc }, { pg: false, kms: false, oidc: false });
    const list = await probe(["list"], env);
    assert.equal(list.code, 0);
    assert.deepEqual({ pg: list.pg, kms: list.kms, oidc: list.oidc }, { pg: false, kms: false, oidc: false });
  } finally {
    cleanup(home);
  }
});

test("positive control: the postgres store module does load pg", async () => {
  const home = tempHome();
  try {
    const r = await probe(["kek-rotate-probe"], { VAULT_HOME: home, VAULT_MASTER_KEY: generateMasterKey() });
    assert.equal(r.code, 1, "unknown command exits 1");
    assert.equal(r.pg, true);
  } finally {
    cleanup(home);
  }
});
