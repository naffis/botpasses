/** Hosted item envelopes are bound to orgId|itemId|allowedHostsJson|inject (S11), with migrate-on-read. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { encrypt, generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { itemAad } from "../src/hosted/item-aad.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

async function setup() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "aad.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), deployPlane: "staging" });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const mk = (name: string, value: string, hosts: string[]) =>
    kernel.createItem({
      orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name,
      value,
      allowedHosts: hosts,
      inject: "bearer",
    });
  return { home, store, kernel, orgId, mk };
}

test("swapping two items' ciphertexts fails to decrypt (S11)", async () => {
  const ctx = await setup();
  try {
    const low = await ctx.mk("LOW_VALUE", "public-ish-token", ["api.low.example"]);
    const high = await ctx.mk("HIGH_VALUE", CANARY, ["api.high.example"]);
    const lowRow = await ctx.store.getItem(low.id);
    const highRow = await ctx.store.getItem(high.id);
    assert.ok(lowRow && highRow);
    await ctx.store.updateItemEnvelope(low.id, {
      iv: highRow.iv,
      ciphertext: highRow.ciphertext,
      tag: highRow.tag,
      last4: highRow.last4,
      updatedAt: highRow.updatedAt,
    });
    await assert.rejects(() => ctx.kernel.decryptItem(ctx.orgId, low.id));
    const stillHigh = await ctx.kernel.decryptItem(ctx.orgId, high.id);
    assert.equal(stillHigh.secret, CANARY);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("editing allowed_hosts_json or inject in the database breaks the envelope (S11)", async () => {
  const ctx = await setup();
  try {
    const item = await ctx.mk("BOUND", CANARY, ["api.good.example"]);
    const row = await ctx.store.getItem(item.id);
    assert.ok(row);
    await ctx.store.updateItemMeta(item.id, {
      name: row.name,
      kind: row.kind,
      environmentId: row.environmentId,
      username: row.username,
      inject: row.inject,
      allowedHostsJson: JSON.stringify(["attacker.example"]),
      updatedAt: row.updatedAt,
    });
    await assert.rejects(() => ctx.kernel.decryptItem(ctx.orgId, item.id));
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("updateItem re-encrypts when hosts or inject change, so the connector still decrypts", async () => {
  const ctx = await setup();
  try {
    const item = await ctx.mk("ROTATING", CANARY, ["api.one.example"]);
    const before = await ctx.store.getItem(item.id);
    await ctx.kernel.updateItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      itemId: item.id,
      allowedHosts: ["api.one.example", "api.two.example"],
      inject: "header:X-Api-Key",
    });
    const after = await ctx.store.getItem(item.id);
    assert.notEqual(after?.ciphertext, before?.ciphertext);
    const decrypted = await ctx.kernel.decryptItem(ctx.orgId, item.id);
    assert.equal(decrypted.secret, CANARY);
    assert.deepEqual(decrypted.allowedHosts, ["api.one.example", "api.two.example"]);
    assert.equal(decrypted.inject, "header:X-Api-Key");
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("rows bound to orgId alone decrypt once and are rebound on read (migrate-on-read)", async () => {
  const ctx = await setup();
  try {
    const item = await ctx.mk("LEGACY", "placeholder", ["api.legacy.example"]);
    const row = await ctx.store.getItem(item.id);
    assert.ok(row);
    const dek = await ctx.kernel.dekForOrg(ctx.orgId);
    const legacy = encrypt(CANARY, dek, ctx.orgId);
    await ctx.store.updateItemEnvelope(item.id, { ...legacy, last4: "10b", updatedAt: row.updatedAt });
    const first = await ctx.kernel.decryptItem(ctx.orgId, item.id);
    assert.equal(first.secret, CANARY);
    const rebound = await ctx.store.getItem(item.id);
    assert.ok(rebound);
    assert.notEqual(rebound.ciphertext, legacy.ciphertext);
    assert.equal(rebound.updatedAt, row.updatedAt, "migration is not an edit");
    const aad = itemAad({ orgId: ctx.orgId, itemId: item.id, allowedHostsJson: rebound.allowedHostsJson, inject: rebound.inject });
    assert.equal(aad, `${ctx.orgId}|${item.id}|["api.legacy.example"]|bearer`);
    const second = await ctx.kernel.decryptItem(ctx.orgId, item.id);
    assert.equal(second.secret, CANARY);
    assert.ok(!JSON.stringify(rebound).includes(CANARY));
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
