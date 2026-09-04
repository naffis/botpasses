/**
 * Item write guards: the deploy plane check on rotate, update, and delete and the 64 KiB cap on
 * rotate (G11); envelope and metadata written in one store call (G7).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { MAX_ITEM_BYTES } from "../src/hosted/kernel-items.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import type { VaultStore } from "../src/store/types.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

async function expectStatus(fn: () => Promise<unknown>, status: number, message: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!isHttpError(err)) throw err;
    assert.equal(err.status, status);
    assert.match(err.message, message);
    return;
  }
  assert.fail(`expected ${status}`);
}

test("the staging deploy cannot rotate, update, or delete a production item by id (G11)", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "plane.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  const production = new HostedKernel({ store, kek, deployPlane: "production" });
  const staging = new HostedKernel({ store, kek, deployPlane: "staging" });
  try {
    const { orgId } = await production.createOrg("acme", "user_owner");
    const item = await production.createItem({
      orgId,
      actor: "user_owner",
      environment: "production",
      kind: "secret",
      name: "PROD_KEY",
      value: CANARY,
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    });
    const notHere = /Production items are not available on the staging deploy/;
    await expectStatus(() => staging.rotateItem({ orgId, actor: "user_owner", itemId: item.id, value: "new-value" }), 404, notHere);
    await expectStatus(() => staging.updateItem({ orgId, actor: "user_owner", itemId: item.id, name: "RENAMED" }), 404, notHere);
    await expectStatus(() => staging.deleteItem(orgId, "user_owner", item.id), 404, notHere);
    const row = await store.getItem(item.id);
    assert.equal(row?.name, "PROD_KEY");
    assert.equal(row?.last4, CANARY.slice(-4));
    assert.equal((await production.decryptItem(orgId, item.id)).secret, CANARY);
    assert.equal((await store.listAudit(orgId, 10)).filter((a) => a.action !== "store").length, 0, "nothing was audited on staging");
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("rotateItem refuses a value over 64 KiB like createItem and updateItem (G11)", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "cap.sqlite"));
  const kernel = new HostedKernel({ store, kek: parseMasterKey(generateMasterKey()), deployPlane: "staging" });
  try {
    const { orgId } = await kernel.createOrg("acme", "user_owner");
    const item = await kernel.createItem({
      orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "KEY",
      value: CANARY,
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    });
    const huge = "x".repeat(MAX_ITEM_BYTES + 1);
    await expectStatus(() => kernel.rotateItem({ orgId, actor: "user_owner", itemId: item.id, value: huge }), 400, /64KiB/);
    assert.equal((await kernel.decryptItem(orgId, item.id)).secret, CANARY);
    const exact = await kernel.rotateItem({ orgId, actor: "user_owner", itemId: item.id, value: "y".repeat(MAX_ITEM_BYTES) });
    assert.equal(exact.last4, "yyyy");
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("updateItem writes a re-encrypted envelope and its metadata in one store call (G7)", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "atomic.sqlite"));
  const calls: string[] = [];
  const watched = new Set(["updateItemEnvelope", "updateItemMeta", "updateItemEnvelopeAndMeta"]);
  const spy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      const method = value as (...a: unknown[]) => unknown;
      if (typeof prop === "string" && watched.has(prop)) {
        return (...args: unknown[]) => {
          calls.push(prop);
          return method.apply(target, args);
        };
      }
      return method.bind(target);
    },
  }) as VaultStore;
  const kernel = new HostedKernel({ store: spy, kek: parseMasterKey(generateMasterKey()), deployPlane: "staging" });
  try {
    const { orgId } = await kernel.createOrg("acme", "user_owner");
    const item = await kernel.createItem({
      orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "KEY",
      value: CANARY,
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    });
    calls.length = 0;
    await kernel.updateItem({ orgId, actor: "user_owner", itemId: item.id, allowedHosts: ["api.other.example"], inject: "header:X-Key" });
    assert.deepEqual(calls, ["updateItemEnvelopeAndMeta"], "AAD-bound columns and the envelope land together");
    const decrypted = await kernel.decryptItem(orgId, item.id);
    assert.equal(decrypted.secret, CANARY);
    assert.deepEqual(decrypted.allowedHosts, ["api.other.example"]);
    assert.equal(decrypted.inject, "header:X-Key");

    calls.length = 0;
    await kernel.updateItem({ orgId, actor: "user_owner", itemId: item.id, value: "rotated-value" });
    assert.deepEqual(calls, ["updateItemEnvelopeAndMeta"]);
    assert.equal((await kernel.decryptItem(orgId, item.id)).secret, "rotated-value");

    calls.length = 0;
    await kernel.updateItem({ orgId, actor: "user_owner", itemId: item.id, name: "RENAMED" });
    assert.deepEqual(calls, ["updateItemMeta"], "a metadata-only edit does not touch the envelope");
    assert.equal((await store.getItem(item.id))?.name, "RENAMED");
  } finally {
    await store.close();
    cleanup(home);
  }
});
