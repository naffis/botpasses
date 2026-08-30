import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { dbPath } from "../src/db.ts";
import { Vault } from "../src/vault.ts";
import { CANARY, cleanup, makeVault } from "./helpers.ts";

test("store returns last-4 only and database has no plaintext", () => {
  const { vault, home } = makeVault();
  try {
    const meta = vault.setSecret("stripe_key", CANARY);
    assert.equal(meta.name, "STRIPE_KEY");
    assert.equal(meta.last4, CANARY.slice(-4));
    assert.ok(!JSON.stringify(meta).includes(CANARY));
    const raw = readFileSync(dbPath(home));
    assert.ok(!raw.includes(CANARY));
    assert.ok(!raw.toString("utf8").includes(CANARY));
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("one vault, many agents — grant is scoped", async () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    vault.approveGrant({
      secretName: "STRIPE_KEY",
      agentId: "invoicer",
      toolId: "stripe",
      scope: "once",
    });
    await assert.rejects(
      () =>
        vault.runWithSecrets({
          bindings: [{ secretName: "STRIPE_KEY" }],
          agentId: "researcher",
          toolId: "stripe",
          command: [process.execPath, "-e", "process.exit(0)"],
        }),
      /No active grant/,
    );
    const denied = vault.listAudit().filter((a) => a.action === "inject_denied");
    assert.equal(denied.length, 1);
    assert.equal(denied[0]?.agentId, "researcher");
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("once grant is consumed after a single inject", async () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    vault.approveGrant({
      secretName: "STRIPE_KEY",
      agentId: "invoicer",
      toolId: "stripe",
      scope: "once",
    });
    const first = await vault.runWithSecrets({
      bindings: [{ secretName: "STRIPE_KEY" }],
      agentId: "invoicer",
      toolId: "stripe",
      command: [process.execPath, "-e", "process.exit(0)"],
    });
    assert.equal(first.code, 0);
    await assert.rejects(
      () =>
        vault.runWithSecrets({
          bindings: [{ secretName: "STRIPE_KEY" }],
          agentId: "invoicer",
          toolId: "stripe",
          command: [process.execPath, "-e", "process.exit(0)"],
        }),
      /No active grant/,
    );
    const grants = vault.listGrants();
    assert.equal(grants[0]?.status, "consumed");
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("revoke blocks later inject", async () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    const grant = vault.approveGrant({
      secretName: "STRIPE_KEY",
      agentId: "invoicer",
      toolId: "stripe",
      scope: "session",
    });
    vault.revokeGrant({ grantId: grant.id });
    await assert.rejects(
      () =>
        vault.runWithSecrets({
          bindings: [{ secretName: "STRIPE_KEY" }],
          agentId: "invoicer",
          toolId: "stripe",
          command: [process.execPath, "-e", "process.exit(0)"],
        }),
      /No active grant/,
    );
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("audit log has actor, secret name, tool, agent, action — never the value", () => {
  const { vault, home } = makeVault();
  try {
    vault.setSecret("STRIPE_KEY", CANARY);
    vault.approveGrant({
      secretName: "STRIPE_KEY",
      agentId: "invoicer",
      toolId: "stripe",
    });
    vault.revokeGrant({
      secretName: "STRIPE_KEY",
      agentId: "invoicer",
      toolId: "stripe",
    });
    const audit = vault.listAudit();
    const actions = audit.map((a) => a.action).sort();
    assert.deepEqual(actions, ["grant", "revoke", "store"]);
    const blob = JSON.stringify(audit);
    assert.ok(!blob.includes(CANARY));
    assert.ok(!blob.includes("value"));
    assert.match(blob, /STRIPE_KEY/);
    assert.match(blob, /invoicer/);
    assert.match(blob, /stripe/);
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("wrong master key refuses to open the vault", () => {
  const { vault, home } = makeVault();
  vault.setSecret("STRIPE_KEY", CANARY);
  vault.close();
  assert.throws(() => {
    const other = new Vault({
      home,
      masterKey: parseMasterKey(generateMasterKey()),
    });
    other.close();
  }, /fingerprint/);
  cleanup(home);
});
