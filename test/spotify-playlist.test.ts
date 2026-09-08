/**
 * BOTP-9: Spotify playlist `/tracks` is rewritten to `/items` (Feb 2026 rename) before
 * the origin call. Other `/tracks` paths are untouched. Canary secrets never appear.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { testAuthResolver } from "../src/hosted/auth.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { nextForPayload } from "../src/hosted/mcp-steer.ts";
import { rewriteSpotifyPlaylistTracks } from "../src/hosted/providers/spotify-playlist.ts";
import { callMcpTool, newMcpSession } from "../src/mcp.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, makeVault, tempHome } from "./helpers.ts";

const PLAYLIST = "37i9dQZF1DXcBWIGoYBM5M";
const TRACK_URI = "spotify:track:4iV5W9uYEdYUVa79Axb7Rh";

function mcpText(rpc: unknown): Record<string, unknown> {
  const rec = rpc as { result?: { content?: { text?: string }[] } };
  return JSON.parse(rec.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

function parsed(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function assertNoCanary(value: unknown): void {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(CANARY));
}

test("rewriteSpotifyPlaylistTracks: playlist id /tracks becomes /items; query kept", () => {
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    const out = rewriteSpotifyPlaylistTracks({
      host: "api.spotify.com",
      method,
      path: `/v1/playlists/${PLAYLIST}/tracks?market=US`,
    });
    assert.ok(out, method);
    assert.equal(out.path, `/v1/playlists/${PLAYLIST}/items?market=US`);
    assert.equal(out.requested_path, `/v1/playlists/${PLAYLIST}/tracks?market=US`);
    assert.equal(out.rewritten_path, `/v1/playlists/${PLAYLIST}/items?market=US`);
    assert.equal(out.body_key_mapped, false);
  }
});

test("rewriteSpotifyPlaylistTracks: host case does not matter; trailing slash is accepted", () => {
  const out = rewriteSpotifyPlaylistTracks({
    host: "API.SPOTIFY.COM",
    method: "post",
    path: `/v1/playlists/${PLAYLIST}/tracks/`,
  });
  assert.equal(out?.rewritten_path, `/v1/playlists/${PLAYLIST}/items`);
});

test("rewriteSpotifyPlaylistTracks: DELETE maps tracks to items only when items is absent", () => {
  const mapped = rewriteSpotifyPlaylistTracks({
    host: "api.spotify.com",
    method: "DELETE",
    path: `/v1/playlists/${PLAYLIST}/tracks`,
    body: { tracks: [{ uri: TRACK_URI }], snapshot_id: "snap" },
  });
  assert.deepEqual(mapped?.body, { snapshot_id: "snap", items: [{ uri: TRACK_URI }] });
  assert.equal(mapped?.body_key_mapped, true);

  const fromJson = rewriteSpotifyPlaylistTracks({
    host: "api.spotify.com",
    method: "DELETE",
    path: `/v1/playlists/${PLAYLIST}/tracks`,
    body: JSON.stringify({ tracks: [{ uri: TRACK_URI }] }),
  });
  assert.deepEqual(fromJson?.body, { items: [{ uri: TRACK_URI }] });
  assert.equal(fromJson?.body_key_mapped, true);

  const already = rewriteSpotifyPlaylistTracks({
    host: "api.spotify.com",
    method: "DELETE",
    path: `/v1/playlists/${PLAYLIST}/tracks`,
    body: { items: [{ uri: TRACK_URI }], tracks: [{ uri: "other" }] },
  });
  assert.deepEqual(already?.body, { items: [{ uri: TRACK_URI }], tracks: [{ uri: "other" }] });
  assert.equal(already?.body_key_mapped, false);
});

test("rewriteSpotifyPlaylistTracks: non-playlist /tracks and other hosts are untouched", () => {
  const skip = [
    { host: "api.spotify.com", method: "GET", path: "/v1/tracks" },
    { host: "api.spotify.com", method: "GET", path: "/v1/tracks/4iV5W9uYEdYUVa79Axb7Rh" },
    { host: "api.spotify.com", method: "GET", path: "/v1/me/tracks" },
    { host: "api.spotify.com", method: "PUT", path: "/v1/me/tracks" },
    { host: "api.spotify.com", method: "GET", path: "/v1/albums/abc/tracks" },
    { host: "api.spotify.com", method: "GET", path: `/v1/playlists/${PLAYLIST}` },
    { host: "api.spotify.com", method: "GET", path: `/v1/playlists/${PLAYLIST}/items` },
    { host: "api.spotify.com", method: "GET", path: `/v1/playlists/${PLAYLIST}/followers` },
    { host: "api.spotify.com", method: "GET", path: `/v1/playlists/${PLAYLIST}/tracks/extra` },
    { host: "api.spotify.com", method: "PATCH", path: `/v1/playlists/${PLAYLIST}/tracks` },
    { host: "api.example.com", method: "GET", path: `/v1/playlists/${PLAYLIST}/tracks` },
    { host: "accounts.spotify.com", method: "GET", path: `/v1/playlists/${PLAYLIST}/tracks` },
  ];
  for (const input of skip) {
    assert.equal(rewriteSpotifyPlaylistTracks(input), undefined, JSON.stringify(input));
  }
});

test("next.for_model names the rewritten path and does not name a vendor", () => {
  const next = nextForPayload({
    origin_status: 200,
    body: "{}",
    path_rewritten: true,
    requested_path: `/v1/playlists/${PLAYLIST}/tracks`,
    rewritten_path: `/v1/playlists/${PLAYLIST}/items`,
    body_key_mapped: "tracks->items",
  });
  assert.match(next?.for_model ?? "", /rewritten from .*\/tracks to .*\/items/);
  assert.match(next?.for_model ?? "", /DELETE body key tracks was mapped to items/);
  assert.doesNotMatch(next?.for_model ?? "", /spotify|grok|—/i);
});

async function hostedSetup(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "hosted.sqlite"));
  const kernel = new HostedKernel({
    store,
    kek: parseMasterKey(generateMasterKey()),
    publicUrl: "http://127.0.0.1:8788",
  });
  const { orgId } = await kernel.createOrg("acme", "user_owner");
  await kernel.createItem({
    orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: "SPOTIFY_TOKEN",
    value: CANARY,
    allowedHosts: ["api.spotify.com"],
    inject: "bearer",
  });
  const { client: model } = await kernel.createModelClient({ orgId, name: "cursor", environment: "staging" });
  const hits: { url: string; method: string; body: string }[] = [];
  const http = createHostedServer({
    authResolver: testAuthResolver,
    kernel,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async (url, init) => {
      hits.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return handler(String(url), init);
    },
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  const asked = await kernel.requestGrant({ orgId, clientId: model.id, itemName: "SPOTIFY_TOKEN", environment: "staging" });
  await kernel.approveGrant({
    orgId,
    grantId: asked.grant.id,
    policy: "session",
    role: "owner",
    actor: "user_owner",
  });
  const call = async (args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${addr.port}/mcp`, {
      method: "POST",
      headers: {
        "x-test-channel": "model",
        "x-test-client": model.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "http_request", arguments: args },
      }),
    });
    const rpc: unknown = await res.json();
    return { rpc, payload: mcpText(rpc) };
  };
  return {
    hits,
    call,
    close: async () => {
      await http.close();
      await store.close();
      cleanup(home);
    },
  };
}

test("hosted http_request: playlist /tracks is sent as /items and the result names the rewrite (BOTP-9)", async () => {
  const ctx = await hostedSetup(async (url) => {
    if (url.includes(`/v1/playlists/${PLAYLIST}/items`)) {
      return new Response(JSON.stringify({ snapshot_id: "ok", echo: CANARY }), { status: 201 });
    }
    if (url.includes("/tracks")) return new Response("legacy tracks must not be called", { status: 403 });
    return new Response("nope", { status: 404 });
  });
  try {
    const added = await ctx.call({
      item_name: "SPOTIFY_TOKEN",
      host: "api.spotify.com",
      method: "POST",
      path: `/v1/playlists/${PLAYLIST}/tracks`,
      body: { uris: [TRACK_URI] },
    });
    assert.equal(added.payload.origin_status, 201, JSON.stringify(added.payload));
    assert.equal(added.payload.path_rewritten, true);
    assert.equal(added.payload.requested_path, `/v1/playlists/${PLAYLIST}/tracks`);
    assert.equal(added.payload.rewritten_path, `/v1/playlists/${PLAYLIST}/items`);
    const next = added.payload.next as { for_model?: string } | undefined;
    assert.match(next?.for_model ?? "", /rewritten from .*\/tracks to .*\/items/);
    assert.doesNotMatch(next?.for_model ?? "", /spotify/i);
    assert.equal(ctx.hits.length, 1);
    assert.equal(ctx.hits[0]?.url, `https://api.spotify.com/v1/playlists/${PLAYLIST}/items`);
    assert.equal(ctx.hits[0]?.method, "POST");
    assert.match(ctx.hits[0]?.body ?? "", new RegExp(TRACK_URI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assertNoCanary(added.payload);
    assert.doesNotMatch(String(added.payload.body), new RegExp(CANARY));

    const listed = await ctx.call({
      item_name: "SPOTIFY_TOKEN",
      host: "api.spotify.com",
      method: "GET",
      path: `/v1/playlists/${PLAYLIST}/tracks?limit=20`,
    });
    assert.equal(listed.payload.origin_status, 201);
    assert.equal(listed.payload.rewritten_path, `/v1/playlists/${PLAYLIST}/items?limit=20`);
    assert.equal(ctx.hits.at(-1)?.url, `https://api.spotify.com/v1/playlists/${PLAYLIST}/items?limit=20`);
    assertNoCanary(listed.payload);

    const removed = await ctx.call({
      item_name: "SPOTIFY_TOKEN",
      host: "api.spotify.com",
      method: "DELETE",
      path: `/v1/playlists/${PLAYLIST}/tracks`,
      body: { tracks: [{ uri: TRACK_URI }] },
    });
    assert.equal(removed.payload.origin_status, 201);
    assert.equal(removed.payload.body_key_mapped, "tracks->items");
    assert.match(String(ctx.hits.at(-1)?.body), /"items":/);
    assert.doesNotMatch(String(ctx.hits.at(-1)?.body), /"tracks":/);
    assert.match((removed.payload.next as { for_model?: string }).for_model ?? "", /DELETE body key tracks/);
    assertNoCanary(removed.payload);
  } finally {
    await ctx.close();
  }
});

test("hosted http_request: catalog, saved, and album /tracks paths are not rewritten", async () => {
  const ctx = await hostedSetup(async (url) => {
    return new Response(JSON.stringify({ url, echo: CANARY }), { status: 200 });
  });
  try {
    const cases = [
      { path: "/v1/tracks/4iV5W9uYEdYUVa79Axb7Rh", want: "https://api.spotify.com/v1/tracks/4iV5W9uYEdYUVa79Axb7Rh" },
      { path: "/v1/me/tracks", want: "https://api.spotify.com/v1/me/tracks" },
      { path: "/v1/albums/abc/tracks", want: "https://api.spotify.com/v1/albums/abc/tracks" },
      { path: `/v1/playlists/${PLAYLIST}/items`, want: `https://api.spotify.com/v1/playlists/${PLAYLIST}/items` },
    ];
    for (const c of cases) {
      ctx.hits.length = 0;
      const out = await ctx.call({
        item_name: "SPOTIFY_TOKEN",
        host: "api.spotify.com",
        method: "GET",
        path: c.path,
      });
      assert.equal(out.payload.origin_status, 200, c.path);
      assert.equal(out.payload.path_rewritten, undefined, c.path);
      assert.equal(ctx.hits[0]?.url, c.want, c.path);
      assertNoCanary(out.payload);
    }
  } finally {
    await ctx.close();
  }
});

test("local http_request: playlist /tracks is rewritten; other /tracks paths are not", async () => {
  const { vault, home } = makeVault();
  const hits: { url: string; body: string }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    hits.push({ url: String(url), body: typeof init?.body === "string" ? init.body : "" });
    return new Response(JSON.stringify({ ok: true, echo: CANARY }), { status: 200 });
  };
  const session = newMcpSession();
  session.agentId = "cursor";
  const ctx = { session, fetchImpl, resolveAddresses: async () => ["8.8.8.8"] };
  try {
    vault.setSecret("SPOTIFY_TOKEN", CANARY, { allowedHosts: ["api.spotify.com"] });
    vault.approveGrant({ secretName: "SPOTIFY_TOKEN", agentId: "cursor", toolId: "http_request", scope: "session" });

    const added = parsed(
      await callMcpTool(
        vault,
        "http_request",
        {
          item_name: "SPOTIFY_TOKEN",
          host: "api.spotify.com",
          method: "POST",
          path: `/v1/playlists/${PLAYLIST}/tracks`,
          body: { uris: [TRACK_URI] },
        },
        ctx,
      ),
    );
    assert.equal(added.origin_status, 200);
    assert.equal(added.path_rewritten, true);
    assert.equal(added.rewritten_path, `/v1/playlists/${PLAYLIST}/items`);
    assert.equal(hits[0]?.url, `https://api.spotify.com/v1/playlists/${PLAYLIST}/items`);
    assertNoCanary(added);

    const catalog = parsed(
      await callMcpTool(
        vault,
        "http_request",
        { item_name: "SPOTIFY_TOKEN", host: "api.spotify.com", method: "GET", path: "/v1/tracks/abc" },
        ctx,
      ),
    );
    assert.equal(catalog.origin_status, 200);
    assert.equal(catalog.path_rewritten, undefined);
    assert.equal(hits.at(-1)?.url, "https://api.spotify.com/v1/tracks/abc");
    assertNoCanary(catalog);
  } finally {
    vault.close();
    cleanup(home);
  }
});
