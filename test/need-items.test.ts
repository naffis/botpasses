import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import { StoreConflictError } from "../src/store/conflict.ts";
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

test("insertPendingNeed reuses the unique pending row (AC-17)", async () => {
  const ctx = await setup();
  try {
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    const row = {
      id: "nid_a",
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environmentId: env.id,
      suggestedName: "API_EXAMPLE_COM",
      host: "api.example.com",
      taskDescription: null,
      status: "pending" as const,
      itemId: null,
      grantId: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      fulfilledAt: null,
    };
    const first = await ctx.store.insertPendingNeed(row);
    const second = await ctx.store.insertPendingNeed({ ...row, id: "nid_b" });
    assert.equal(second.id, first.id);
    const pending = await ctx.store.listPendingNeeds(ctx.orgId);
    assert.equal(pending.length, 1);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("deleteOrg removes need_items", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.example.com",
    });
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 1);
    await ctx.kernel.deleteOrg(ctx.orgId, "user_owner", "owner", "acme");
    assert.equal(await ctx.store.getOrg(ctx.orgId), undefined);
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("find_items miss returns path-only collect_url (AC-01, AC-12)", async () => {
  const ctx = await setup();
  try {
    const result = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.spotify.com",
    });
    assert.equal(result.status, "need_item");
    if (result.status !== "need_item") return;
    const url = new URL(result.collect_url);
    assert.equal(url.search, "");
    assert.ok(result.collect_url.startsWith(`${STAGING_ORIGIN}/collect/`));
    assert.equal(result.client_name, "grok");
    assert.ok(!JSON.stringify(result).includes(CANARY));
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("repeated find reuses need_id (AC-05)", async () => {
  const ctx = await setup();
  try {
    const a = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.spotify.com",
    });
    const b = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.spotify.com",
    });
    assert.equal(a.status, "need_item");
    assert.equal(b.status, "need_item");
    if (a.status !== "need_item" || b.status !== "need_item") return;
    assert.equal(a.need_id, b.need_id);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("fulfill then find is found without canary (AC-02)", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.spotify.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    await ctx.kernel.fulfillNeed({
      orgId: ctx.orgId,
      actor: "user_owner",
      needId: miss.need_id,
      value: CANARY,
      name: "SPOTIFY_TOKEN",
      allowedHosts: ["api.spotify.com"],
      inject: "bearer",
    });
    const found = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.spotify.com",
    });
    assert.equal(found.status, "found");
    if (found.status !== "found") return;
    assert.equal(found.item.name, "SPOTIFY_TOKEN");
    assert.ok(!JSON.stringify(found).includes(CANARY));
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("two items on one host are ambiguous (AC-03)", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "ONE",
      value: "aaaa",
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    });
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "TWO",
      value: "bbbb",
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    });
    const result = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.example.com",
    });
    assert.equal(result.status, "ambiguous");
    if (result.status !== "ambiguous") return;
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every((i) => i.allowed_hosts.includes("api.example.com")));
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("find_items with neither name nor host is 400 (AC-04)", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(
      () =>
        ctx.kernel.findItems({
          orgId: ctx.orgId,
          clientId: ctx.client.id,
          environment: "staging",
        }),
      (err: unknown) => isHttpError(err) && err.status === 400,
    );
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("name plus unmatched host is host_mismatch with no need (AC-11)", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "FOO",
      value: "zzzz",
      allowedHosts: ["api.foo.com"],
      inject: "bearer",
    });
    const result = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      itemName: "FOO",
      host: "api.bar.com",
    });
    assert.equal(result.status, "host_mismatch");
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("second fulfill of one need is 409 (AC-13)", async () => {
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
    await ctx.kernel.fulfillNeed({
      orgId: ctx.orgId,
      actor: "user_owner",
      needId: miss.need_id,
      value: "first",
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    });
    await assert.rejects(
      () =>
        ctx.kernel.fulfillNeed({
          orgId: ctx.orgId,
          actor: "user_owner",
          needId: miss.need_id,
          value: "second",
          allowedHosts: ["api.example.com"],
          inject: "bearer",
        }),
      (err: unknown) => isHttpError(err) && err.status === 409,
    );
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    const items = await ctx.store.listItems(env.id);
    assert.equal(items.filter((i) => i.name === "NEW_KEY").length, 1);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("concurrent fulfill POSTs: one succeeds and the other is 409 (AC-13)", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      itemName: "RACE_KEY",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const body = {
      orgId: ctx.orgId,
      actor: "user_owner",
      needId: miss.need_id,
      allowedHosts: ["api.example.com"],
      inject: "bearer",
    };
    const settled = await Promise.allSettled([
      ctx.kernel.fulfillNeed({ ...body, value: "first" }),
      ctx.kernel.fulfillNeed({ ...body, value: "second" }),
    ]);
    const ok = settled.filter((s) => s.status === "fulfilled");
    const denied = settled.filter(
      (s) =>
        s.status === "rejected" &&
        isHttpError(s.reason) &&
        s.reason.status === 409,
    );
    assert.equal(ok.length, 1);
    assert.equal(denied.length, 1);
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    const items = await ctx.store.listItems(env.id);
    assert.equal(items.filter((i) => i.name === "RACE_KEY").length, 1);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("persistFulfill rolls back item when grant insert fails", async () => {
  const ctx = await setup();
  try {
    const miss = await ctx.kernel.findItems({
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      environment: "staging",
      host: "api.rollback.com",
    });
    assert.equal(miss.status, "need_item");
    if (miss.status !== "need_item") return;
    const need = await ctx.store.getNeed(miss.need_id);
    assert.ok(need);
    const env = await ctx.kernel.envFor(ctx.orgId, "staging");
    const grantId = "grt_collision";
    await ctx.store.insertGrant({
      id: grantId,
      orgId: ctx.orgId,
      clientId: ctx.client.id,
      itemId: null,
      folderId: null,
      environmentId: env.id,
      policy: "prompt",
      status: "pending",
      expiresAt: null,
      createdAt: new Date().toISOString(),
      approvedAt: null,
      consumedAt: null,
      taskId: null,
      taskDescription: null,
    });
    await assert.rejects(
      () =>
        ctx.store.persistFulfill({
          item: {
            id: "itm_x",
            environmentId: env.id,
            folderId: null,
            kind: "secret",
            name: "ROLLBACK_KEY",
            last4: "xxxx",
            username: null,
            allowedHostsJson: '["api.rollback.com"]',
            inject: "bearer",
            iv: "aa",
            ciphertext: "bb",
            tag: "cc",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          grant: {
            id: grantId,
            orgId: ctx.orgId,
            clientId: ctx.client.id,
            itemId: "itm_x",
            folderId: null,
            environmentId: env.id,
            policy: "prompt",
            status: "active",
            expiresAt: null,
            createdAt: new Date().toISOString(),
            approvedAt: new Date().toISOString(),
            consumedAt: null,
            taskId: null,
            taskDescription: null,
          },
          needId: need.id,
          fulfilledAt: new Date().toISOString(),
          audit: {
            id: "aud_x",
            orgId: ctx.orgId,
            action: "need_fulfilled",
            actor: "user_owner",
            itemName: "ROLLBACK_KEY",
            clientId: ctx.client.id,
            at: new Date().toISOString(),
          },
        }),
      (err: unknown) => err instanceof StoreConflictError,
    );
    assert.equal(await ctx.store.getItem("itm_x"), undefined);
    const still = await ctx.store.getNeed(need.id);
    assert.equal(still?.status, "pending");
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
