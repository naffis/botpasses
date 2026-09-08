import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { STAGING_ORIGIN } from "../src/brand.ts";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { handleHostedMcpRpc } from "../src/hosted/mcp.ts";
import { callMcpTool } from "../src/mcp.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, makeVault, tempHome } from "./helpers.ts";

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
  const { client: model } = await kernel.createModelClient({
    orgId,
    name: "grok",
    environment: "staging",
  });
  const principal = {
    channel: "model" as const,
    orgId,
    clientId: model.id,
    environment: "staging" as const,
  };
  return { home, store, kernel, orgId, model, principal };
}

function parseTool(rpc: unknown): { isError?: boolean; body: Record<string, unknown> } {
  const rec = rpc as { result?: { isError?: boolean; content?: { text?: string }[] } };
  const text = rec.result?.content?.[0]?.text ?? "{}";
  return { isError: rec.result?.isError, body: JSON.parse(text) as Record<string, unknown> };
}

async function callSetup(ctx: Awaited<ReturnType<typeof setup>>, args: Record<string, unknown>) {
  const rpc = await handleHostedMcpRpc(
    { kernel: ctx.kernel, principal: ctx.principal },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "setup", arguments: args } },
  );
  return parseTool(rpc);
}

test("hosted setup spotify on empty vault is need_item with recipe (AC-01)", async () => {
  const ctx = await setup();
  try {
    const parsed = await callSetup(ctx, { provider: "spotify" });
    assert.equal(parsed.isError, undefined);
    assert.equal(parsed.body.status, "need_item");
    assert.equal(parsed.body.suggested_name, "SPOTIFY_SECRET");
    assert.equal(parsed.body.host, "api.spotify.com");
    assert.match(String(parsed.body.collect_url), /^https:\/\/staging\.botpasses\.com\/collect\/nid_/);
    assert.doesNotMatch(String(parsed.body.collect_url), /[?&](hmac|sig|token)=/i);
    const recipe = parsed.body.recipe as { allowed_hosts?: string[]; kind?: string } | undefined;
    assert.ok(recipe?.allowed_hosts?.includes("accounts.spotify.com"));
    assert.equal(recipe?.kind, "client_secret");
    assert.ok(!JSON.stringify(parsed.body).includes(CANARY));
    const next = parsed.body.next as { tool?: string; for_model?: string } | undefined;
    assert.equal(next?.tool, "setup");
    assert.match(next?.for_model ?? "", /collect_url/);
    assert.match(next?.for_model ?? "", /Client ID and Client Secret/);
    const steps = parsed.body.steps as { id?: string; state?: string; url?: string }[] | undefined;
    assert.ok(Array.isArray(steps));
    assert.deepEqual(
      steps.map((s) => ({ id: s.id, state: s.state })),
      [
        { id: "store", state: "current" },
        { id: "connect", state: "todo" },
        { id: "allow", state: "todo" },
        { id: "ready", state: "todo" },
      ],
    );
    assert.equal(steps[0]?.url, parsed.body.collect_url);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("setup {} or both provider and host is 400 and writes no need (AC-06)", async () => {
  const ctx = await setup();
  try {
    const empty = await callSetup(ctx, {});
    assert.equal(empty.isError, true);
    const both = await callSetup(ctx, { provider: "spotify", host: "api.stripe.com" });
    assert.equal(both.isError, true);
    const agree = await callSetup(ctx, { provider: "spotify", host: "api.spotify.com" });
    assert.equal(agree.isError, true);
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("setup host with shell metacharacters is 400 and writes no vault set command", async () => {
  const ctx = await setup();
  try {
    const hosted = await callSetup(ctx, { host: "api.example.com;curl evil.test" });
    assert.equal(hosted.isError, true);
    assert.doesNotMatch(JSON.stringify(hosted.body), /curl evil/);
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
  const { vault, home } = makeVault();
  try {
    const parsed = JSON.parse(
      (await callMcpTool(vault, "setup", { host: "api.example.com;curl evil.test" })).content[0]?.text ?? "{}",
    ) as Record<string, unknown>;
    assert.ok(parsed.error);
    assert.doesNotMatch(JSON.stringify(parsed), /curl evil/);
    assert.doesNotMatch(JSON.stringify(parsed), /vault set/);
  } finally {
    vault.close();
    cleanup(home);
  }
});

test("setup host api.example.com is a generic Collect need (AC-07)", async () => {
  const ctx = await setup();
  try {
    const parsed = await callSetup(ctx, { host: "api.example.com" });
    assert.equal(parsed.body.status, "need_item");
    assert.equal(parsed.body.suggested_name, "API_EXAMPLE_COM");
    assert.equal(parsed.body.host, "api.example.com");
    assert.equal(parsed.body.recipe, undefined);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("setup host accounts.spotify.com reuses the Spotify primaryHost need (AC-11)", async () => {
  const ctx = await setup();
  try {
    const first = await callSetup(ctx, { host: "accounts.spotify.com" });
    assert.equal(first.body.status, "need_item");
    assert.equal(first.body.host, "api.spotify.com");
    assert.equal(first.body.suggested_name, "SPOTIFY_SECRET");
    const second = await callSetup(ctx, { provider: "spotify" });
    assert.equal(second.body.need_id, first.body.need_id);
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 1);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("dry_run setup reports need_item without inserting a row", async () => {
  const ctx = await setup();
  try {
    const parsed = await callSetup(ctx, { provider: "stripe", dry_run: true });
    assert.equal(parsed.body.status, "need_item");
    assert.equal(parsed.body.collect_url, undefined);
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("Spotify fulfill always_allow then setup is user_connect_required; Stripe is ready (AC-03, AC-04)", async () => {
  const ctx = await setup();
  try {
    const miss = await callSetup(ctx, { provider: "spotify" });
    assert.equal(miss.body.status, "need_item");
    await ctx.kernel.fulfillNeed({
      orgId: ctx.orgId,
      actor: "user_owner",
      needId: String(miss.body.need_id),
      value: CANARY,
      name: "SPOTIFY_SECRET",
      allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
      inject: "client_credentials",
      kind: "client_secret",
      username: "spotify_client",
      alwaysAllow: true,
    });
    const again = await callSetup(ctx, { provider: "spotify" });
    assert.equal(again.body.status, "user_connect_required");
    assert.ok(!JSON.stringify(again.body).includes(CANARY));
    assert.match(String(again.body.connect_url), /\/console#credentials\/item\//);
    assert.doesNotMatch(String(again.body.connect_url), /hmac/i);
    const grants = await ctx.kernel.listClientGrants(ctx.orgId, ctx.model.id);
    assert.ok(grants.some((g) => g.policy === "item_standing" && g.status === "active"));
    const listed = await handleHostedMcpRpc(
      { kernel: ctx.kernel, principal: ctx.principal },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_grants", arguments: {} } },
    );
    const listedBody = parseTool(listed).body;
    const publicGrants = listedBody.grants as { grant_id?: string; policy?: string; status?: string }[] | undefined;
    const standing = publicGrants?.find((g) => g.policy === "item_standing" && g.status === "active");
    assert.ok(standing?.grant_id);
    const standingRow = grants.find((g) => g.id === standing.grant_id);
    const items = await ctx.kernel.listItems(ctx.orgId, "staging");
    assert.equal(items.find((i) => i.id === standingRow?.itemId)?.name, "SPOTIFY_SECRET");
    const connectNeed = await ctx.store.getNeed(String(again.body.need_id));
    assert.equal(connectNeed?.kind, "connect");

    const stripeMiss = await callSetup(ctx, { provider: "stripe" });
    assert.equal(stripeMiss.body.status, "need_item");
    await ctx.kernel.fulfillNeed({
      orgId: ctx.orgId,
      actor: "user_owner",
      needId: String(stripeMiss.body.need_id),
      value: CANARY,
      name: "STRIPE_SECRET_KEY",
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
      kind: "secret",
      alwaysAllow: true,
    });
    const stripeReady = await callSetup(ctx, { provider: "stripe" });
    assert.equal(stripeReady.body.status, "ready");
    assert.ok(!JSON.stringify(stripeReady.body).includes(CANARY));
    const next = stripeReady.body.next as { tool?: string; arguments?: Record<string, string> } | undefined;
    assert.equal(next?.tool, "http_request");
    assert.equal(next?.arguments?.path, "/v1/balance");
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("setup after store without always_allow is ready_prompt", async () => {
  const ctx = await setup();
  try {
    const miss = await callSetup(ctx, { provider: "github" });
    await ctx.kernel.fulfillNeed({
      orgId: ctx.orgId,
      actor: "user_owner",
      needId: String(miss.body.need_id),
      value: CANARY,
      allowedHosts: ["api.github.com"],
      inject: "bearer",
    });
    const again = await callSetup(ctx, { provider: "github" });
    assert.equal(again.body.status, "ready_prompt");
    const next = again.body.next as { for_model?: string } | undefined;
    assert.match(next?.for_model ?? "", /Always-allow/);
    assert.doesNotMatch(next?.for_model ?? "", /collect_url/);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("unknown or empty provider is 400 and writes no need", async () => {
  const ctx = await setup();
  try {
    const unknown = await callSetup(ctx, { provider: "nope" });
    assert.equal(unknown.isError, true);
    assert.match(JSON.stringify(unknown.body), /Unknown provider|spotify/);
    const empty = await callSetup(ctx, { provider: "" });
    assert.equal(empty.isError, true);
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("two items on the same recipe host is ambiguous and writes no need", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_SECRET_KEY",
      value: CANARY,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_OTHER",
      value: `${CANARY}-b`,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const parsed = await callSetup(ctx, { provider: "stripe" });
    assert.equal(parsed.isError, undefined);
    assert.equal(parsed.body.status, "ambiguous");
    const items = parsed.body.items as { name?: string }[] | undefined;
    assert.equal(items?.length, 2);
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
    assert.ok(!JSON.stringify(parsed.body).includes(CANARY));
    const next = parsed.body.next as { tool?: string; arguments?: Record<string, string>; for_model?: string } | undefined;
    assert.equal(next?.tool, "http_request");
    assert.equal(next?.arguments?.provider, undefined);
    assert.equal(next?.arguments?.host, undefined);
    assert.match(next?.for_model ?? "", /item_name/);
    assert.equal(parsed.body.retry, undefined);
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("existing API_SPOTIFY_COM bearer is ready_prompt and does not create SPOTIFY_SECRET", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "API_SPOTIFY_COM",
      value: CANARY,
      allowedHosts: ["api.spotify.com"],
      inject: "bearer",
    });
    const parsed = await callSetup(ctx, { provider: "spotify" });
    assert.equal(parsed.body.status, "ready_prompt");
    const item = parsed.body.item as { name?: string } | undefined;
    assert.equal(item?.name, "API_SPOTIFY_COM");
    const names = (await ctx.kernel.listItems(ctx.orgId, "staging")).map((i) => i.name);
    assert.ok(names.includes("API_SPOTIFY_COM"));
    assert.ok(!names.includes("SPOTIFY_SECRET"));
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
    assert.ok(!JSON.stringify(parsed.body).includes(CANARY));
    const steps = parsed.body.steps as { id?: string; state?: string }[] | undefined;
    assert.ok(!steps?.some((s) => s.id === "connect"));
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("dry_run after a stored item reports state without inserting a need (R-09)", async () => {
  const ctx = await setup();
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "client_secret",
      name: "SPOTIFY_SECRET",
      value: CANARY,
      allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
      inject: "client_credentials",
      username: "spotify_client",
    });
    const spotify = await callSetup(ctx, { provider: "spotify", dry_run: true });
    assert.equal(spotify.body.status, "user_connect_required");
    assert.equal(spotify.body.connect_url, undefined);
    assert.equal(spotify.body.need_id, undefined);
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);

    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "STRIPE_SECRET_KEY",
      value: `${CANARY}-stripe`,
      allowedHosts: ["api.stripe.com"],
      inject: "bearer",
    });
    const stripe = await callSetup(ctx, { provider: "stripe", dry_run: true });
    assert.equal(stripe.body.status, "ready_prompt");
    assert.equal((await ctx.store.listPendingNeeds(ctx.orgId)).length, 0);
    assert.ok(!JSON.stringify(spotify.body).includes(CANARY));
    assert.ok(!JSON.stringify(stripe.body).includes(CANARY));
  } finally {
    await ctx.store.close();
    cleanup(ctx.home);
  }
});

test("local setup spotify returns the vault set command and no collect_url (AC-08)", async () => {
  const { vault, home } = makeVault();
  try {
    const result = await callMcpTool(vault, "setup", { provider: "spotify" });
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
    assert.equal(parsed.status, "need_item");
    assert.equal(parsed.collect_url, undefined);
    assert.match(
      String(parsed.message),
      /vault set SPOTIFY_SECRET --host api\.spotify\.com --host accounts\.spotify\.com --inject client_credentials --username/,
    );
    assert.doesNotMatch(String(parsed.message), /--kind/);
    assert.ok(!JSON.stringify(parsed).includes(CANARY));
    const next = parsed.next as { tool?: string; for_model?: string } | undefined;
    assert.equal(next?.tool, "setup");
    assert.match(next?.for_model ?? "", /vault set|secret/);
  } finally {
    vault.close();
    cleanup(home);
  }
});
