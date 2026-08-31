import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { PostgresStore } from "../src/store/postgres.ts";
import { CANARY } from "./helpers.ts";

const dbUrl = process.env.DATABASE_URL;

test("AC-10 two processes: exactly one prompt consume on Postgres", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const store = await PostgresStore.open(dbUrl);
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
  });
  const { orgId } = await kernel.createOrg(`org_${randomUUID()}`, "user_owner");
  await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "CAS_KEY",
    value: CANARY,
    allowedHosts: ["api.stripe.com"],
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({
    orgId,
    name: "m",
    environment: "staging",
  });
  const asked = await kernel.requestGrant({
    orgId,
    clientId: model.id,
    itemName: "CAS_KEY",
    environment: "staging",
  });
  await kernel.approveGrant({
    orgId,
    grantId: asked.grant.id,
    policy: "prompt",
    role: "owner",
    actor: "user_owner",
  });
  const worker = fileURLToPath(new URL("./helpers/cas-worker.ts", import.meta.url));
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          worker,
          asked.grant.id,
        ],
        { env: { ...process.env, DATABASE_URL: dbUrl } },
      );
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`worker exit ${code}`));
        else resolve(out);
      });
    });
  const [a, b] = await Promise.all([run(), run()]);
  const wins = [a, b].filter((x) => x === "1").length;
  assert.equal(wins, 1);
  await store.close();
});

test("AC-11 GET /ready is 200 against Postgres", async (t) => {
  if (!dbUrl) {
    t.skip("DATABASE_URL not set");
    return;
  }
  const store = await PostgresStore.open(dbUrl);
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
  });
  const http = createHostedServer({ kernel, host: "127.0.0.1", port: 0 });
  const addr = await http.listen();
  try {
    const res = await fetch(`http://${addr.host}:${addr.port}/ready`);
    assert.equal(res.status, 200);
  } finally {
    await http.close();
    await store.close();
  }
});
