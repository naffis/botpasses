/** Hosted item envelopes are bound to orgId|itemId|allowedHostsJson|inject (S11); legacy rows are rebound once at boot (G5). */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { encrypt, generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { itemAad } from "../src/hosted/item-aad.ts";
import { ITEM_AAD_VERSION } from "../src/store/rows.ts";
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

test("the inject path never opens a row bound to orgId alone; the boot rebind moves it to the item binding once (G5)", async () => {
  const ctx = await setup();
  try {
    const item = await ctx.mk("LEGACY", "placeholder", ["api.legacy.example"]);
    const row = await ctx.store.getItem(item.id);
    assert.ok(row);
    const dek = await ctx.kernel.dekForOrg(ctx.orgId);
    const legacy = encrypt(CANARY, dek, ctx.orgId);
    await ctx.store.updateItemEnvelope(item.id, { ...legacy, last4: "10b", updatedAt: row.updatedAt });
    await ctx.store.setItemAadVersion(item.id, 0);
    // A row already under the item binding whose version was never recorded (written before the column).
    const bound = await ctx.mk("BOUND_UNRECORDED", CANARY, ["api.bound.example"]);
    await ctx.store.setItemAadVersion(bound.id, 0);
    // A row that opens under neither binding.
    const broken = await ctx.mk("BROKEN", "placeholder", ["api.broken.example"]);
    const brokenRow = await ctx.store.getItem(broken.id);
    assert.ok(brokenRow);
    await ctx.store.updateItemEnvelope(broken.id, { ...brokenRow, ciphertext: "00".repeat(8), tag: "00".repeat(16) });
    await ctx.store.setItemAadVersion(broken.id, 0);
    // A fresh row is written at the current version and is not a rebind candidate.
    await ctx.mk("FRESH", CANARY, ["api.fresh.example"]);
    assert.deepEqual(
      (await ctx.store.listItemsWithLegacyAad()).map((x) => x.item.name).sort(),
      ["BOUND_UNRECORDED", "BROKEN", "LEGACY"],
    );

    await assert.rejects(() => ctx.kernel.decryptItem(ctx.orgId, item.id), "no runtime fallback to the legacy AAD");

    const first = await ctx.kernel.rebindLegacyItems();
    assert.deepEqual(first, { rebound: 1, verified: 1, unreadable: 1 });
    const rebound = await ctx.store.getItem(item.id);
    assert.ok(rebound);
    assert.notEqual(rebound.ciphertext, legacy.ciphertext);
    assert.equal(rebound.updatedAt, row.updatedAt, "a rebind is not an edit");
    const aad = itemAad({ orgId: ctx.orgId, itemId: item.id, allowedHostsJson: rebound.allowedHostsJson, inject: rebound.inject });
    assert.equal(aad, `${ctx.orgId}|${item.id}|["api.legacy.example"]|bearer`);
    assert.equal((await ctx.kernel.decryptItem(ctx.orgId, item.id)).secret, CANARY);
    assert.equal((await ctx.kernel.decryptItem(ctx.orgId, bound.id)).secret, CANARY);
    assert.deepEqual(
      (await ctx.store.listItemsWithLegacyAad()).map((x) => x.item.name),
      ["BROKEN"],
      "unreadable rows stay at version 0 and are reported, never deleted",
    );
    assert.ok(await ctx.store.getItem(broken.id));
    const second = await ctx.kernel.rebindLegacyItems();
    assert.deepEqual(second, { rebound: 0, verified: 0, unreadable: 1 }, "a second run has nothing left to move");
    assert.ok(!JSON.stringify(rebound).includes(CANARY));
    assert.equal(ITEM_AAD_VERSION, 1);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
