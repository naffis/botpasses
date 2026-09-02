import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

const HMAC = Buffer.from("aa".repeat(32), "hex");
const APP_CANARY = "spotify_client_secret_CANARY_edit_7f3a";

async function setup() {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
    approvalHmac: HMAC,
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
  });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const op = {
    "x-test-channel": "operator",
    "x-test-user": "user_owner",
    "x-test-org": orgId,
    "content-type": "application/json",
  };
  return { home, store, kernel, orgId, http, base, op };
}

function assertNoCanary(body: unknown, canary = CANARY): void {
  assert.doesNotMatch(JSON.stringify(body), new RegExp(canary));
}

test("POST /api/items persists client_secret instead of collapsing to secret", async () => {
  const ctx = await setup();
  try {
    const res = await fetch(`${ctx.base}/api/items`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({
        name: "SPOTIFY_SECRET",
        kind: "client_secret",
        environment: "staging",
        value: APP_CANARY,
        username: "spotify-client-id-example",
        allowed_hosts: ["api.spotify.com", "accounts.spotify.com"],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { item: { kind: string; inject: string; username: string } };
    assert.equal(body.item.kind, "client_secret");
    assert.equal(body.item.inject, "client_credentials");
    assert.equal(body.item.username, "spotify-client-id-example");
    assertNoCanary(body, APP_CANARY);

    const listed = await fetch(`${ctx.base}/api/items`, { headers: ctx.op });
    const listBody = (await listed.json()) as { items: { name: string; kind: string }[] };
    const row = listBody.items.find((i) => i.name === "SPOTIFY_SECRET");
    assert.ok(row);
    assert.equal(row.kind, "client_secret");
    assertNoCanary(listBody, APP_CANARY);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("POST /api/items/:id blank value keeps the current secret", async () => {
  const ctx = await setup();
  try {
    const created = await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "client_secret",
      name: "SPOTIFY_APP",
      value: APP_CANARY,
      username: "old-client-id",
      allowedHosts: ["api.spotify.com"],
      inject: "client_credentials",
    });
    const res = await fetch(`${ctx.base}/api/items/${created.id}`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({
        name: "SPOTIFY_APP",
        kind: "client_secret",
        environment: "staging",
        username: "new-client-id",
        allowed_hosts: ["api.spotify.com", "accounts.spotify.com"],
        inject: "client_credentials",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      item: { kind: string; username: string; last4: string; allowedHosts: string[] };
    };
    assert.equal(body.item.kind, "client_secret");
    assert.equal(body.item.username, "new-client-id");
    assert.equal(body.item.last4, APP_CANARY.slice(-4));
    assert.deepEqual(body.item.allowedHosts, ["api.spotify.com", "accounts.spotify.com"]);
    assertNoCanary(body, APP_CANARY);

    const decrypted = await ctx.kernel.decryptItem(ctx.orgId, created.id);
    assert.equal(decrypted.secret, APP_CANARY);
    assert.equal(decrypted.kind, "client_secret");
    assert.equal(decrypted.username, "new-client-id");
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("edit can change kind from a collapsed secret to client_secret without rotating", async () => {
  const ctx = await setup();
  try {
    const created = await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "LEGACY_SPOTIFY",
      value: APP_CANARY,
      username: "legacy-client-id",
      allowedHosts: ["api.spotify.com"],
      inject: "client_credentials",
    });
    assert.equal(created.kind, "secret");
    const res = await fetch(`${ctx.base}/api/items/${created.id}`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({
        kind: "client_secret",
        username: "legacy-client-id",
        inject: "client_credentials",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { item: { kind: string } };
    assert.equal(body.item.kind, "client_secret");
    const decrypted = await ctx.kernel.decryptItem(ctx.orgId, created.id);
    assert.equal(decrypted.secret, APP_CANARY);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("edit with a new value rotates the envelope", async () => {
  const ctx = await setup();
  try {
    const created = await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_KEY",
      value: CANARY,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const next = "sk_live_CANARY_rotated_edit_aa11";
    const res = await fetch(`${ctx.base}/api/items/${created.id}`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({
        name: "STRIPE_KEY",
        kind: "secret",
        value: next,
        allowed_hosts: ["api.stripe.com"],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { item: { last4: string } };
    assert.equal(body.item.last4, next.slice(-4));
    assertNoCanary(body);
    assertNoCanary(body, next);
    const decrypted = await ctx.kernel.decryptItem(ctx.orgId, created.id);
    assert.equal(decrypted.secret, next);
  } finally {
    await ctx.http.close();
    await ctx.store.close();
    cleanup(ctx.home);
  }
});
