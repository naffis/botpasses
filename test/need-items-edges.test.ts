import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { PRODUCTION_ORIGIN, STAGING_ORIGIN } from "../src/brand.ts";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

async function setup() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: STAGING_ORIGIN,
    deployPlane: "staging",
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const { client } = await kernel.createModelClient({
    orgId,
    name: "grok",
    environment: "staging",
  });
  return { home, store, kernel, orgId, client };
}

test("production client cannot find_items in staging (env isolation)", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: PRODUCTION_ORIGIN,
    deployPlane: "production",
  });
  try {
    const { orgId } = await kernel.createOrg("acme", "user_owner");
    const { client: prod } = await kernel.createModelClient({
      orgId,
      name: "prod-bot",
      environment: "production",
    });
    await kernel.createItem({
      orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "STAGING_ONLY",
      value: "aaaa",
      allowedHosts: ["api.staging.example"],
      inject: "bearer",
    });
    await assert.rejects(
      () =>
        kernel.findItems({
          orgId,
          clientId: prod.id,
          environment: "staging",
          itemName: "STAGING_ONLY",
        }),
      (err: unknown) => isHttpError(err) && err.status === 403,
    );
    assert.equal((await store.listPendingNeeds(orgId)).length, 0);
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("exactly one host match is found and does not insert a need (R-04 inverse)", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "ONLY_ONE",
      value: "aaaa",
      allowedHosts: ["api.only.com"],
      inject: "bearer",
    });
    const result = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.only.com",
    });
    assert.equal(result.status, "found");
    if (result.status !== "found") return;
    assert.equal(result.item.name, "ONLY_ONE");
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("name-only find of an existing item is found with hosts (R-05)", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "SPOTIFY_TOKEN",
      value: "aaaa",
      allowedHosts: ["api.spotify.com"],
      inject: "bearer",
    });
    const result = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      itemName: "SPOTIFY_TOKEN",
    });
    assert.equal(result.status, "found");
    if (result.status !== "found") return;
    assert.deepEqual(result.item.allowed_hosts, ["api.spotify.com"]);
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("more than five host matches are truncated (R-04)", async () => {
  const ctx = await setup();
  try {
    for (const name of ["A_ONE", "B_TWO", "C_THREE", "D_FOUR", "E_FIVE", "F_SIX"]) {
      await ctx.kernel.createItem({
        orgId: ctx.orgId,
        actor: "user_owner",
        environment: "staging",
        kind: "secret",
        name,
        value: "xxxx",
        allowedHosts: ["api.example.com"],
        inject: "bearer",
      });
    }
    const result = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.example.com",
    });
    assert.equal(result.status, "ambiguous");
    if (result.status !== "ambiguous") return;
    assert.equal(result.items.length, 5);
    assert.equal(result.truncated, true);
    assert.equal(result.items[0]?.name, "A_ONE");
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("repeated find refreshes expires_at on the pending row (N-03)", async () => {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: STAGING_ORIGIN,
    deployPlane: "staging",
    now: () => new Date(nowMs),
  });
  try {
    const { orgId } = await kernel.createOrg("acme", "user_owner");
    const { client } = await kernel.createModelClient({
      orgId,
      name: "grok",
      environment: "staging",
    });
    const first = await kernel.findItems({
      orgId,
      clientId: client.id,
      environment: "staging",
      host: "api.refresh.com",
    });
    assert.equal(first.status, "need_item");
    if (first.status !== "need_item") return;
    const before = await store.getNeed(first.need_id);
    nowMs += 60_000;
    const second = await kernel.findItems({
      orgId,
      clientId: client.id,
      environment: "staging",
      host: "api.refresh.com",
    });
    assert.equal(second.status, "need_item");
    if (second.status !== "need_item") return;
    assert.equal(second.need_id, first.need_id);
    const after = await store.getNeed(first.need_id);
    assert.ok(before && after);
    assert.ok(after.expiresAt > before.expiresAt);
  } finally {
    await store.close();
    cleanup(home);
  }
});

test("expired pending need is cancelled and a new row inserted (R-15)", async () => {
  const ctx = await setup();
  try {
    const first = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.expired.com",
    });
    assert.equal(first.status, "need_item");
    if (first.status !== "need_item") return;
    await ctx.store.refreshNeedExpires(first.need_id, new Date(Date.now() - 1000).toISOString());
    const second = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.expired.com",
    });
    assert.equal(second.status, "need_item");
    if (second.status !== "need_item") return;
    assert.notEqual(second.need_id, first.need_id);
    const old = await ctx.store.getNeed(first.need_id);
    assert.equal(old?.status, "cancelled");
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("name-only pending need uses empty host (unique pending host '')", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      itemName: "NEW_KEY",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const row = await ctx.store.getNeed(miss.need_id);
    assert.equal(row?.host, "");
    const again = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      itemName: "NEW_KEY",
    });
    assert.equal(again.status, "need_item");
    if (again.status !== "need_item") return;
    assert.equal(again.need_id, miss.need_id);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("ensureNeedItem is 429 after the org limiter is exhausted (R-16)", async () => {
  const ctx = await setup();
  try {
    const t = Date.now();
    for (let i = 0; i < 30; i++) {
      assert.equal(await ctx.kernel.limiter.allow(ctx.orgId, t), true);
    }
    await assert.rejects(
      () =>
        ctx.kernel.findItems({
          orgId: ctx.orgId,
          clientId: ctx.client.id,
          environment: "staging",
          host: "api.limited.com",
        }),
      (err: unknown) => isHttpError(err) && err.status === 429,
    );
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("invalid item_name does not create a need", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      () =>
        ctx.kernel.findItems({
          orgId: ctx.orgId,
          clientId: ctx.client.id,
          environment: "staging",
          itemName: "not a name",
        }),
      (err: unknown) => isHttpError(err) && err.status === 400,
    );
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("invalid host does not create a need", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      () =>
        ctx.kernel.findItems({
          orgId: ctx.orgId,
          clientId: ctx.client.id,
          environment: "staging",
          host: "127.0.0.1",
        }),
      (err: unknown) => isHttpError(err) && err.status === 400,
    );
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("empty fulfill value is 400", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.empty.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    await assert.rejects(
      () =>
        ctx.kernel.fulfillNeed({
          orgId: ctx.orgId,
          actor: "user_owner",
          needId: miss.need_id,
          value: "",
          allowedHosts: ["api.empty.com"],
          inject: "bearer",
        }),
      (err: unknown) => isHttpError(err) && err.status === 400,
    );
    const still = await ctx.store.getNeed(miss.need_id);
    assert.equal(still?.status, "pending");
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("fulfill duplicate item name is 409 and need stays pending", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "TAKEN",
      value: "zzzz",
      allowedHosts: ["api.taken.com"],
      inject: "bearer",
    });
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.newhost.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    await assert.rejects(
      () =>
        ctx.kernel.fulfillNeed({
          orgId: ctx.orgId,
          actor: "user_owner",
          needId: miss.need_id,
          name: "TAKEN",
          value: CANARY,
          allowedHosts: ["api.newhost.com"],
          inject: "bearer",
        }),
      (err: unknown) => isHttpError(err) && err.status === 409,
    );
    const still = await ctx.store.getNeed(miss.need_id);
    assert.equal(still?.status, "pending");
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("task_description on a need is truncated to 500 characters (N-07)", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.task.com",
      taskDescription: "x".repeat(600),
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const row = await ctx.store.getNeed(miss.need_id);
    assert.equal(row?.taskDescription?.length, 500);
    const inbox = await ctx.kernel.listInboxNeeds(ctx.orgId);
    assert.equal(inbox[0]?.task_description?.length, 500);
    assert.equal(inbox[0]?.client_name, "grok");
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
