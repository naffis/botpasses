/**
 * Provider abstraction (3.2): the registry is data, the engines are generic, and the Spotify
 * behaviour the product shipped with (Basic + form mint, /v1/me hint, grant reuse) still holds.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { testAuthResolver } from "../src/hosted/auth.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { assertRedirectUri } from "../src/hosted/oauth-as.ts";
import { isTokenPath, pathMatchesPrefix, PROVIDERS, providerById, providerForHost, userPathHint } from "../src/hosted/providers/registry.ts";
import { cachedMint, clearMintCache, storeMint } from "../src/hosted/providers/token-cache.ts";
import { authorizeUrl, chooseRedirect, openOauthState, sealOauthState } from "../src/hosted/providers/user-oauth.ts";
import { isHttpError } from "../src/hosted/errors.ts";
import { redactOauthJson } from "../src/redact.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import { CANARY, cleanup, tempHome } from "./helpers.ts";

const CLIENT_ID = "97540628b46c43059710d66714d75870";
const CLIENT_SECRET = "spotify_client_secret_CANARY_b91c";
const ACCESS = "BQC_fake_access_token_do_not_leak_zzzz";
const REFRESH = "AQD_fake_refresh_token_do_not_leak_rrrr";

function mcpText(rpc: unknown): Record<string, unknown> {
  const rec = rpc as { result?: { content?: { text?: string }[] } };
  return JSON.parse(rec.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

async function setup(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  clearMintCache();
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
    name: "SPOTIFY_SECRET",
    value: CLIENT_SECRET,
    username: CLIENT_ID,
    allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
    inject: "client_credentials",
  });
  const { client: model } = await kernel.createModelClient({
    orgId,
    name: "grok",
    environment: "staging",
  });
  const hits: { url: string; auth: string; contentType: string; body: string }[] = [];
  const http = createHostedServer({
    authResolver: testAuthResolver,
    kernel,
    host: "127.0.0.1",
    port: 0,
    fetchImpl: async (url, init) => {
      const headers = new Headers(init?.headers);
      hits.push({
        url: String(url),
        auth: headers.get("authorization") ?? "",
        contentType: headers.get("content-type") ?? "",
        body: typeof init?.body === "string" ? init.body : "",
      });
      return handler(String(url), init);
    },
    resolveAddresses: async () => ["8.8.8.8"],
  });
  const addr = await http.listen();
  return {
    home,
    store,
    kernel,
    orgId,
    model,
    http,
    hits,
    base: `http://${addr.host}:${addr.port}`,
    op: {
      "x-test-channel": "operator",
      "x-test-user": "user_owner",
      "x-test-org": orgId,
      "content-type": "application/json",
    },
    modelH: {
      "x-test-channel": "model",
      "x-test-client": model.id,
      "content-type": "application/json",
    },
  };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function approve(ctx: Ctx, itemName = "SPOTIFY_SECRET", policy: "prompt" | "item_standing" = "prompt") {
  const asked = await ctx.kernel.requestGrant({
    orgId: ctx.orgId,
    clientId: ctx.model.id,
    itemName,
    environment: "staging",
  });
  await ctx.kernel.approveGrant({
    orgId: ctx.orgId,
    grantId: asked.grant.id,
    policy,
    role: "owner",
    actor: "user_owner",
  });
  return asked.grant.id;
}

async function call(ctx: Ctx, args: Record<string, unknown>) {
  const res = await fetch(`${ctx.base}/mcp`, {
    method: "POST",
    headers: ctx.modelH,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "http_request", arguments: args },
    }),
  });
  const rpc = await res.json();
  return { res, rpc, payload: mcpText(rpc) };
}

async function teardown(ctx: Ctx) {
  await ctx.http.close();
  await ctx.store.close();
  cleanup(ctx.home);
}

const tokenJson = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600, ...extra }), { status: 200 });

test("registry: five providers, looked up by API host or token host, with grant types that match the vendor", () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["spotify", "github", "google", "slack", "stripe"]);
  assert.equal(providerForHost("api.github.com")?.id, "github");
  assert.equal(providerForHost("GitHub.com")?.id, "github");
  assert.equal(providerForHost("gmail.googleapis.com")?.id, "google");
  assert.equal(providerForHost("oauth2.googleapis.com")?.id, "google");
  assert.equal(providerForHost("connect.stripe.com")?.id, "stripe");
  assert.equal(providerForHost("slack.com")?.id, "slack");
  assert.equal(providerForHost("api.example.com"), undefined);
  assert.equal(providerById("nope"), undefined);
  const github = providerById("github");
  assert.ok(github);
  assert.equal(github.grantTypes.includes("client_credentials"), false, "GitHub Apps have no client_credentials grant");
  assert.equal(github.tokenAuth, "post_body");
  assert.equal(providerById("spotify")?.tokenAuth, "basic");
  assert.equal(providerById("google")?.pkce, true);
  for (const p of PROVIDERS) {
    assert.ok(p.grantTypes.length > 0, `${p.id} grant types`);
    assert.ok(p.redactKeys.includes("access_token"), `${p.id} redacts access_token`);
    assert.ok(p.authorizeUrl?.startsWith("https://"), `${p.id} authorize url`);
    assert.doesNotMatch(p.displayName, /—/);
  }
});

test("registry: token paths and user-path hints are answered from data", () => {
  const spotify = providerById("spotify");
  assert.ok(spotify);
  assert.equal(isTokenPath(spotify, "accounts.spotify.com", "/api/token?x=1"), true);
  assert.equal(isTokenPath(spotify, "api.spotify.com", "/api/token"), false);
  assert.ok(userPathHint(spotify, "api.spotify.com", "/v1/me"));
  assert.ok(userPathHint(spotify, "api.spotify.com", "/v1/me/playlists?limit=5"));
  assert.ok(userPathHint(spotify, "api.spotify.com", "/v1/users/abc/playlists"));
  assert.equal(userPathHint(spotify, "api.spotify.com", "/v1/users/abc"), undefined, "public profile works with an app token");
  assert.equal(userPathHint(spotify, "api.spotify.com", "/v1/search?q=x"), undefined);
  assert.equal(userPathHint(spotify, "accounts.spotify.com", "/v1/me"), undefined, "hints apply to API hosts only");
  assert.equal(pathMatchesPrefix("/v1/users/abc/playlists/1", "/v1/users/*/playlists"), true);
  assert.equal(pathMatchesPrefix("/v1/users", "/v1/users/*/playlists"), false);
  assert.match(userPathHint(spotify, "api.spotify.com", "/v1/me")?.message ?? "", /Connect a Spotify user/);
});

test("user connect helpers are provider-generic", () => {
  const spotify = providerById("spotify");
  const google = providerById("google");
  const stripe = providerById("stripe");
  assert.ok(spotify && google && stripe);
  const url = new URL(authorizeUrl(spotify, { clientId: "cid", redirectUri: "https://x/cb", state: "s", codeVerifier: "v".repeat(43) }));
  assert.equal(url.origin + url.pathname, "https://accounts.spotify.com/authorize");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope") ?? "", /playlist-read-private/);
  const stripeUrl = new URL(authorizeUrl(stripe, { clientId: "ca_x", redirectUri: "https://x/cb", state: "s", codeVerifier: "v" }));
  assert.equal(stripeUrl.searchParams.get("code_challenge"), null, "no PKCE for providers that do not support it");
  assert.equal(stripeUrl.searchParams.get("scope"), "read_write");
  assert.equal(chooseRedirect(google, "https://botpasses.com"), "https://botpasses.com/integrations/google/callback");
  assert.equal(chooseRedirect(spotify, "http://127.0.0.1:8788"), "http://127.0.0.1:8888/callback");
  assert.equal(chooseRedirect(spotify, "https://botpasses.com"), "https://botpasses.com/integrations/spotify/callback");
  assert.throws(() => chooseRedirect(spotify, "https://botpasses.com", "https://evil.example/cb"), /redirect_uri/);
  assert.throws(() => chooseRedirect(spotify, "https://botpasses.com", "http://127.0.0.1:8888/callback"), /redirect_uri/, "the dev loopback callback is not a landing place for a hosted deployment");
  assert.equal(chooseRedirect(spotify, "http://127.0.0.1:8788", "http://127.0.0.1:8888/callback"), "http://127.0.0.1:8888/callback");
  const kek = parseMasterKey(generateMasterKey());
  const state = sealOauthState(
    { providerId: "google", orgId: "org", userId: "u", itemId: "i", itemName: "GOOGLE_SECRET", environment: "staging", clientId: "cid", redirectUri: "https://x/cb", codeVerifier: "v", exp: Date.now() + 60_000 },
    kek,
  );
  assert.equal(openOauthState(state, kek).providerId, "google");
  assert.throws(() => openOauthState(state, parseMasterKey(generateMasterKey())), /Invalid OAuth state/);
});

/** The provider's authorize URL from `POST /api/integrations/:provider/start`, with its sealed state. */
async function startConnect(ctx: Ctx, providerId: string, body: Record<string, unknown>) {
  const res = await fetch(`${ctx.base}/api/integrations/${providerId}/start`, {
    method: "POST",
    headers: ctx.op,
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { authorize_url?: string; redirect_uri?: string; provider?: string; error?: string };
  const url = json.authorize_url ? new URL(json.authorize_url) : undefined;
  return { res, json, url, state: url?.searchParams.get("state") ?? "" };
}

async function callback(ctx: Ctx, providerId: string, query: Record<string, string>) {
  const res = await fetch(`${ctx.base}/integrations/${providerId}/callback?${new URLSearchParams(query)}`, {
    headers: ctx.op,
    redirect: "manual",
  });
  return { status: res.status, location: res.headers.get("location") ?? "" };
}

/** Token endpoint that accepts the code exchange for one provider and hands back a refresh token. */
function codeExchangeHandler(tokenUrl: string, wantVerifier: boolean) {
  return async (url: string, init?: RequestInit) => {
    if (!url.includes(tokenUrl)) return new Response("nope", { status: 404 });
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const ok =
      form.get("grant_type") === "authorization_code" &&
      form.get("code") === "c0de" &&
      Boolean(form.get("redirect_uri")) &&
      (wantVerifier ? Boolean(form.get("code_verifier")) : true);
    if (!ok) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    return tokenJson({ refresh_token: REFRESH, scope: "user-read-email" });
  };
}

test("user connect over HTTP: start returns the provider authorize URL; the callback stores <ITEM>_REFRESH with inject refresh", async () => {
  const ctx = await setup(codeExchangeHandler("accounts.spotify.com/api/token", true));
  try {
    const started = await startConnect(ctx, "spotify", { item_name: "SPOTIFY_SECRET", environment: "staging" });
    assert.equal(started.res.status, 200, JSON.stringify(started.json));
    assert.ok(started.url);
    assert.equal(started.url.origin + started.url.pathname, "https://accounts.spotify.com/authorize");
    assert.equal(started.url.searchParams.get("client_id"), CLIENT_ID, "client id falls back to the item username");
    assert.equal(started.url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(started.json.redirect_uri, "http://127.0.0.1:8888/callback");
    assert.equal(started.json.provider, "spotify");
    assert.doesNotMatch(JSON.stringify(started.json), new RegExp(CLIENT_SECRET));

    const done = await callback(ctx, "spotify", { code: "c0de", state: started.state });
    assert.equal(done.status, 302);
    assert.equal(done.location, "/console#vault?connected=spotify");
    const items = await ctx.kernel.listItems(ctx.orgId, "staging");
    const refresh = items.find((i) => i.name === "SPOTIFY_REFRESH");
    assert.ok(refresh, "refresh item stored");
    assert.equal(refresh.inject, "refresh");
    assert.equal(refresh.kind, "secret");
    assert.equal(refresh.username, CLIENT_ID);
    assert.equal(refresh.last4, REFRESH.slice(-4));
    assert.deepEqual(refresh.allowedHosts, ["api.spotify.com", "accounts.spotify.com"], "provider API hosts plus the token host");
    assert.equal(await ctx.kernel.store.findItemPolicy(ctx.orgId, ctx.model.id, refresh.id), undefined, "no policy without agent_client_id");
    const decrypted = await ctx.kernel.decryptItem(ctx.orgId, refresh.id);
    assert.equal(decrypted.secret, REFRESH);

    // A second connect rotates the stored refresh token in place and resets how it may be sent:
    // hosts and inject mode someone set on the row earlier do not survive a fresh connect.
    await ctx.kernel.updateItem({
      orgId: ctx.orgId,
      actor: "user_other",
      itemId: refresh.id,
      allowedHosts: ["mallory.example"],
      inject: "query:t",
    });
    const again = await startConnect(ctx, "spotify", { item_name: "SPOTIFY_SECRET", environment: "staging" });
    const rotated = await callback(ctx, "spotify", { code: "c0de", state: again.state });
    assert.equal(rotated.location, "/console#vault?connected=spotify");
    const after = (await ctx.kernel.listItems(ctx.orgId, "staging")).filter((i) => i.name === "SPOTIFY_REFRESH");
    assert.equal(after.length, 1);
    assert.equal(after[0]?.inject, "refresh");
    assert.deepEqual(after[0]?.allowedHosts, ["api.spotify.com", "accounts.spotify.com"]);
    const audit = await ctx.kernel.store.listAudit(ctx.orgId, 50);
    assert.equal(audit.filter((a) => a.action === "provider_connected" && a.itemName === "SPOTIFY_REFRESH").length, 2);

    // The account that started the connect must finish it.
    const other = await startConnect(ctx, "spotify", { item_name: "SPOTIFY_SECRET", environment: "staging" });
    await assert.rejects(
      () => ctx.kernel.finishProviderUserOauth({ providerId: "spotify", orgId: ctx.orgId, userId: "user_someone_else", state: other.state, code: "c0de" }),
      (err: unknown) => isHttpError(err) && err.status === 403 && /account/.test(err.message),
    );

    // Unknown provider is 404; a callback denied at the vendor lands on the console with a reason code.
    const nope = await startConnect(ctx, "nope", { item_name: "SPOTIFY_SECRET", environment: "staging" });
    assert.equal(nope.res.status, 404);
    const denied = await callback(ctx, "spotify", { error: "access_denied", state: "x" });
    assert.equal(denied.location, "/console#vault?connect_error=spotify&reason=provider_denied");
    const noCode = await callback(ctx, "spotify", { state: "x" });
    assert.equal(noCode.location, "/console#vault", "a bare visit without code or state is not an error");
  } finally {
    await teardown(ctx);
  }
});

test("user connect for a second provider (GitHub, no PKCE) and the narrowed auto-policy for one named agent", async () => {
  const GH_SECRET = "gh_app_client_secret_CANARY_2c3d";
  const ctx = await setup(codeExchangeHandler("github.com/login/oauth/access_token", false));
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "client_secret",
      name: "GITHUB_APP_SECRET",
      value: GH_SECRET,
      username: "Iv1.abc123",
      allowedHosts: ["api.github.com", "github.com"],
      inject: "client_credentials",
    });
    const { client: other } = await ctx.kernel.createModelClient({ orgId: ctx.orgId, name: "other", environment: "staging" });
    const started = await startConnect(ctx, "github", {
      item_name: "GITHUB_APP_SECRET",
      environment: "staging",
      agent_client_id: ctx.model.id,
    });
    assert.equal(started.res.status, 200, JSON.stringify(started.json));
    assert.ok(started.url);
    assert.equal(started.url.origin + started.url.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(started.url.searchParams.get("code_challenge"), null);
    assert.equal(started.json.redirect_uri, "http://127.0.0.1:8888/callback");

    const done = await callback(ctx, "github", { code: "c0de", state: started.state });
    assert.equal(done.location, "/console#vault?connected=github");
    const refresh = (await ctx.kernel.listItems(ctx.orgId, "staging")).find((i) => i.name === "GITHUB_APP_REFRESH");
    assert.ok(refresh);
    assert.deepEqual(refresh.allowedHosts, ["api.github.com", "github.com"]);
    const mine = await ctx.kernel.store.findItemPolicy(ctx.orgId, ctx.model.id, refresh.id);
    assert.equal(mine?.kind, "item_standing", "the named agent gets a standing policy");
    assert.equal(await ctx.kernel.store.findItemPolicy(ctx.orgId, other.id, refresh.id), undefined, "other agents do not");
    assert.ok((await ctx.kernel.store.listAudit(ctx.orgId, 50)).some((a) => a.action === "grant" && a.clientId === ctx.model.id), "the standing policy is audited");
    const exchange = ctx.hits.find((h) => h.url.includes("/login/oauth/access_token"));
    assert.ok(exchange);
    assert.equal(exchange.auth, "", "post_body providers carry the client secret in the form");
    assert.equal(new URLSearchParams(exchange.body).get("client_secret"), GH_SECRET);
    assert.doesNotMatch(JSON.stringify(ctx.hits.map((h) => h.url)), new RegExp(GH_SECRET));

    const bad = await startConnect(ctx, "github", { item_name: "GITHUB_APP_SECRET", environment: "staging", agent_client_id: "cli_nope" });
    assert.equal(bad.res.status, 404, "agent_client_id must be a client in this org");
  } finally {
    await teardown(ctx);
  }
});

test("user connect rejects a state minted for another provider, another org, or another KEK", async () => {
  const ctx = await setup(codeExchangeHandler("accounts.spotify.com/api/token", true));
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "client_secret",
      name: "GOOGLE_SECRET",
      value: "google_client_secret_CANARY_9e8f",
      username: "123.apps.googleusercontent.com",
      allowedHosts: ["www.googleapis.com", "oauth2.googleapis.com"],
      inject: "client_credentials",
    });
    const google = await startConnect(ctx, "google", { item_name: "GOOGLE_SECRET", environment: "staging" });
    assert.equal(google.res.status, 200, JSON.stringify(google.json));
    // The Google state arrives on the Spotify callback: refused before any token request leaves.
    const crossed = await callback(ctx, "spotify", { code: "c0de", state: google.state });
    assert.equal(crossed.location, "/console#vault?connect_error=spotify&reason=state_expired");
    assert.equal(ctx.hits.length, 0, "no code exchange was attempted");
    const garbage = await callback(ctx, "google", { code: "c0de", state: "not-a-state" });
    assert.equal(garbage.location, "/console#vault?connect_error=google&reason=state_expired");
    await assert.rejects(
      () => ctx.kernel.finishProviderUserOauth({ providerId: "spotify", orgId: ctx.orgId, userId: "user_owner", state: google.state, code: "c0de" }),
      (err: unknown) => isHttpError(err) && err.status === 400 && /another provider/.test(err.message),
    );
    await assert.rejects(
      () => ctx.kernel.finishProviderUserOauth({ providerId: "google", orgId: "org_other", userId: "user_owner", state: google.state, code: "c0de" }),
      (err: unknown) => isHttpError(err) && err.status === 403,
    );
    const foreignKek = new HostedKernel({ store: ctx.store, kek: parseMasterKey(generateMasterKey()), publicUrl: "http://127.0.0.1:8788" });
    await assert.rejects(
      () => foreignKek.finishProviderUserOauth({ orgId: ctx.orgId, userId: "user_owner", state: google.state, code: "c0de" }),
      (err: unknown) => isHttpError(err) && err.status === 400,
    );
    assert.equal((await ctx.kernel.listItems(ctx.orgId, "staging")).some((i) => i.name.endsWith("_REFRESH")), false);
  } finally {
    await teardown(ctx);
  }
});

test("token cache is keyed by org, item, client, and grant type and drops entries near expiry", () => {
  clearMintCache();
  const token = { accessToken: ACCESS, expiresAt: Date.now() + 120_000, last4: "zzzz", tokenType: "Bearer" };
  storeMint("org", "itm", "cid", "client_credentials", token);
  assert.equal(cachedMint("org", "itm", "cid", "client_credentials")?.accessToken, ACCESS);
  assert.equal(cachedMint("org", "itm", "cid", "refresh_token"), undefined);
  assert.equal(cachedMint("org", "other", "cid", "client_credentials"), undefined);
  assert.equal(cachedMint("org", "itm", "cid", "client_credentials", Date.now() + 61_000), undefined, "one minute of skew");
  assert.equal(cachedMint("org", "itm", "cid", "client_credentials"), undefined, "the expired entry was evicted");
});

test("assertRedirectUri accepts Grok/Cursor desktop schemes", () => {
  assert.doesNotThrow(() => assertRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback"));
  assert.doesNotThrow(() => assertRedirectUri("grok://oauth/callback"));
  assert.doesNotThrow(() => assertRedirectUri("http://127.0.0.1:8888/callback"));
  assert.throws(() => assertRedirectUri("javascript:alert(1)"));
});

test("redactOauthJson never emits access_token values", () => {
  const out = redactOauthJson(JSON.stringify({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600 }));
  assert.doesNotMatch(out, new RegExp(ACCESS));
  assert.match(out, /\[redacted\]/);
});

test("Spotify token mint uses Basic + form body and redacts the access token", async () => {
  const ctx = await setup(async (url) => {
    if (url.includes("accounts.spotify.com/api/token")) {
      const res = tokenJson();
      res.headers.set("link", `<https://accounts.spotify.com/next?t=${CLIENT_SECRET}&a=${ACCESS}>; rel="next"`);
      return res;
    }
    return new Response("nope", { status: 404 });
  });
  try {
    await approve(ctx);
    const { res, payload } = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "POST",
      path: "https://accounts.spotify.com/api/token",
      client_id: CLIENT_ID,
    });
    assert.equal(res.status, 200);
    assert.equal(payload.origin_status, 200);
    assert.equal(payload.status, 200, "deprecated duplicate kept for one release");
    const blob = JSON.stringify(payload);
    assert.doesNotMatch(blob, new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(blob, new RegExp(ACCESS));
    assert.match(String(payload.body), /\[redacted\]/);
    assert.equal(payload.minted, true);
    const headers = payload.origin_headers as Record<string, string>;
    assert.equal(headers.link, "<https://accounts.spotify.com/next?t=[redacted]&a=[redacted]>; rel=\"next\"", "origin headers on the token path are redacted for the secret and the minted token");
    const hit = ctx.hits.find((h) => h.url.includes("/api/token"));
    assert.ok(hit);
    assert.match(hit.auth, /^Basic /);
    assert.doesNotMatch(hit.auth, /Bearer /);
    assert.match(hit.contentType, /application\/x-www-form-urlencoded/);
    assert.match(hit.body, /grant_type=client_credentials/);
    const expected = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    assert.equal(hit.auth, `Basic ${expected}`);
  } finally {
    await teardown(ctx);
  }
});

test("minted app token calls /v1/search; /v1/me explains user OAuth", async () => {
  const ctx = await setup(async (url) => {
    if (url.includes("accounts.spotify.com/api/token")) return tokenJson();
    if (url.includes("/v1/search")) {
      return new Response(JSON.stringify({ tracks: { items: [{ name: "test" }] } }), { status: 200 });
    }
    if (url.includes("/v1/me")) {
      return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    const grantId = await approve(ctx);
    const me = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "GET",
      path: "https://api.spotify.com/v1/me",
      client_id: CLIENT_ID,
    });
    assert.equal(me.payload.origin_status, 401);
    assert.match(String(me.payload.hint ?? ""), /user OAuth|\/v1\/me|Client credentials|Connect a Spotify user/i);
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "consumed", "the origin answered, so the one-call approval is spent");
    await approve(ctx);

    const search = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "GET",
      path: "https://api.spotify.com/v1/search?q=test&type=track",
      client_id: CLIENT_ID,
    });
    assert.equal(search.payload.origin_status, 200);
    assert.doesNotMatch(JSON.stringify(search.payload), new RegExp(ACCESS));
    assert.doesNotMatch(JSON.stringify(search.payload), new RegExp(CLIENT_SECRET));
    const searchAuth = ctx.hits.find((h) => h.url.includes("/v1/search"))?.auth ?? "";
    assert.equal(searchAuth, `Bearer ${ACCESS}`);
  } finally {
    await teardown(ctx);
  }
});

test("an origin 401 or 410 spends a one-call approval (the secret left the process); a standing approval covers the retry", async () => {
  let tokenStatus = 401;
  const ctx = await setup(async (url) => {
    if (url.includes("/api/token")) {
      if (tokenStatus === 410) return new Response("", { status: 410 });
      if (tokenStatus === 401) return new Response("invalid", { status: 401 });
      return tokenJson();
    }
    return new Response("nope", { status: 404 });
  });
  const tokenCall = { item_name: "SPOTIFY_SECRET", method: "POST", path: "https://accounts.spotify.com/api/token", client_id: CLIENT_ID };
  try {
    const grantId = await approve(ctx);
    const first = await call(ctx, tokenCall);
    assert.equal(first.payload.origin_status, 401);
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "consumed", "any origin status spends a prompt grant");
    const again = await call(ctx, tokenCall);
    assert.equal(again.payload.status, "pending", "the retry asks for a new approval");
    assert.equal(ctx.hits.filter((h) => h.url.includes("/api/token")).length, 1, "nothing was sent without an approval");

    const standingId = await approve(ctx, "SPOTIFY_SECRET", "item_standing");
    tokenStatus = 410;
    const gone = await call(ctx, tokenCall);
    assert.equal(gone.payload.origin_status, 410);
    assert.equal(gone.payload.body, "");
    assert.match(String(gone.payload.hint), /410/);
    assert.match(String(gone.payload.hint), /one-call approval is spent/);
    assert.equal((await ctx.kernel.store.getGrant(standingId))?.status, "active", "a standing approval covers retries");

    tokenStatus = 200;
    const ok = await call(ctx, tokenCall);
    assert.equal(ok.payload.origin_status, 200);
    assert.equal((await ctx.kernel.store.getGrant(standingId))?.status, "active");
    assert.doesNotMatch(JSON.stringify(ok.payload), new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(JSON.stringify(ok.payload), new RegExp(ACCESS));
  } finally {
    await teardown(ctx);
  }
});

test("a stored <ITEM>_REFRESH token is exchanged in the form body (no Basic) and the user path succeeds", async () => {
  const ctx = await setup(async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("accounts.spotify.com/api/token")) {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === REFRESH && form.get("client_id") === CLIENT_ID && !auth) {
        return tokenJson({ refresh_token: REFRESH, scope: "user-read-email" });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    if (url.includes("/v1/me")) {
      return auth === `Bearer ${ACCESS}`
        ? new Response(JSON.stringify({ id: "user1", email: "u@example.com" }), { status: 200 })
        : new Response("", { status: 401 });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "SPOTIFY_REFRESH",
      value: REFRESH,
      username: CLIENT_ID,
      allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
      inject: "refresh",
    });
    await approve(ctx, "SPOTIFY_SECRET", "item_standing");
    await approve(ctx, "SPOTIFY_REFRESH", "item_standing");
    const me = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" });
    assert.equal(me.payload.origin_status, 200, JSON.stringify(me.payload));
    assert.equal(me.payload.user_token, true);
    assert.equal(me.payload.token_last4, ACCESS.slice(-4));
    const blob = JSON.stringify(me.payload);
    for (const secret of [REFRESH, ACCESS, CLIENT_SECRET]) assert.doesNotMatch(blob, new RegExp(secret));
    const mint = ctx.hits.find((h) => h.url.includes("/api/token"));
    assert.ok(mint);
    assert.equal(mint.auth, "", "refresh_token grant carries client_id in the body, not a Basic header");
    assert.match(mint.body, /grant_type=refresh_token/);
    const second = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" });
    assert.equal(second.payload.origin_status, 200);
    assert.equal(ctx.hits.filter((h) => h.url.includes("/api/token")).length, 1, "the refreshed token is cached");
  } finally {
    await teardown(ctx);
  }
});

test("a rotated refresh token replaces the stored <ITEM>_REFRESH value in place and is audited refresh_rotated", async () => {
  const ROTATED = "AQD_rotated_refresh_token_do_not_leak_2222";
  let exchanges = 0;
  const ctx = await setup(async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("accounts.spotify.com/api/token")) {
      exchanges += 1;
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      const sent = form.get("refresh_token");
      // The provider rotates on every exchange: the first value works once, then only the new one.
      if (form.get("grant_type") === "refresh_token" && sent === (exchanges === 1 ? REFRESH : ROTATED)) {
        return tokenJson({ refresh_token: ROTATED, expires_in: 30 });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    if (url.includes("/v1/me")) {
      return auth === `Bearer ${ACCESS}` ? new Response(JSON.stringify({ id: "user1" }), { status: 200 }) : new Response("", { status: 401 });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    const stored = await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "SPOTIFY_REFRESH",
      value: REFRESH,
      username: CLIENT_ID,
      allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
      inject: "refresh",
    });
    await approve(ctx, "SPOTIFY_SECRET", "item_standing");
    await approve(ctx, "SPOTIFY_REFRESH", "item_standing");
    const first = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" });
    assert.equal(first.payload.origin_status, 200, JSON.stringify(first.payload));
    assert.equal((await ctx.kernel.decryptItem(ctx.orgId, stored.id)).secret, ROTATED, "the new refresh token is stored");
    const audit = await ctx.kernel.store.listAudit(ctx.orgId, 50);
    const rotated = audit.find((a) => a.action === "refresh_rotated");
    assert.equal(rotated?.itemName, "SPOTIFY_REFRESH");
    assert.equal(rotated?.actor, "provider");
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(ROTATED));
    assert.doesNotMatch(JSON.stringify(first.payload), new RegExp(ROTATED));
    // The 30 s token is inside the cache skew, so the next call refreshes again: only the rotated
    // value is accepted now, and the call succeeds because it was persisted.
    clearMintCache();
    const second = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" });
    assert.equal(second.payload.origin_status, 200, JSON.stringify(second.payload));
    assert.equal(exchanges, 2);
  } finally {
    await teardown(ctx);
  }
});

test("user-token path: a cached token needs no refresh approval; without one the result is the pending <ITEM>_REFRESH grant", async () => {
  const ctx = await setup(async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("accounts.spotify.com/api/token")) {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      return form.get("grant_type") === "refresh_token" ? tokenJson() : new Response("", { status: 400 });
    }
    if (url.includes("/v1/me")) {
      return auth === `Bearer ${ACCESS}` ? new Response(JSON.stringify({ id: "user1" }), { status: 200 }) : new Response("", { status: 401 });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "SPOTIFY_REFRESH",
      value: REFRESH,
      username: CLIENT_ID,
      allowedHosts: ["api.spotify.com", "accounts.spotify.com"],
      inject: "refresh",
    });
    const me = { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" };
    // No approval on the refresh item: the model is told to get one, not sent an app token that 401s.
    const secretGrant = await approve(ctx);
    const halted = await call(ctx, me);
    assert.equal(halted.payload.status, "pending", JSON.stringify(halted.payload));
    assert.equal(halted.payload.item_name, "SPOTIFY_REFRESH");
    assert.match(String(halted.payload.hint), /SPOTIFY_REFRESH/);
    assert.equal(typeof halted.payload.approval_code, "string");
    assert.equal(ctx.hits.length, 0, "nothing was sent");
    assert.equal((await ctx.kernel.store.getGrant(secretGrant))?.status, "active", "the client secret's one-call approval was not spent: nothing left the process");
    const inbox = await (await fetch(`${ctx.base}/api/inbox`, { headers: ctx.op })).json() as { grants: { item_name: string }[] };
    assert.ok(inbox.grants.some((g) => g.item_name === "SPOTIFY_REFRESH"), "the operator sees the refresh approval request");

    // Approve the refresh item once: the first call exchanges it, the second reuses the cached
    // access token and does not need (or spend) another refresh approval.
    const pendingRefresh = (await ctx.kernel.store.listGrants(ctx.orgId)).find((g) => g.status === "pending");
    assert.ok(pendingRefresh);
    await ctx.kernel.approveGrant({ orgId: ctx.orgId, grantId: pendingRefresh.id, policy: "prompt", role: "owner", actor: "user_owner" });
    const first = await call(ctx, me);
    assert.equal(first.payload.origin_status, 200, JSON.stringify(first.payload));
    assert.equal(first.payload.user_token, true);
    assert.equal((await ctx.kernel.store.getGrant(pendingRefresh.id))?.status, "consumed");
    await approve(ctx);
    const second = await call(ctx, me);
    assert.equal(second.payload.origin_status, 200, JSON.stringify(second.payload));
    assert.equal(second.payload.user_token, true, "the cached user token served the call without a refresh approval");
    assert.equal(ctx.hits.filter((h) => h.url.includes("/api/token")).length, 1, "one exchange");
  } finally {
    await teardown(ctx);
  }
});

test("a post_body provider (GitHub) gets client_id and client_secret in the form, never in a header", async () => {
  const GH_SECRET = "gh_app_client_secret_CANARY_0a1b";
  const ctx = await setup(async (url, init) => {
    if (url.includes("github.com/login/oauth/access_token")) {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (form.get("client_secret") !== GH_SECRET) return new Response(JSON.stringify({ error: "incorrect_client_credentials" }), { status: 401 });
      return new Response(JSON.stringify({ access_token: ACCESS, token_type: "bearer", scope: "repo" }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "client_secret",
      name: "GITHUB_APP_SECRET",
      value: GH_SECRET,
      username: "Iv1.abc123",
      allowedHosts: ["api.github.com", "github.com"],
      inject: "client_credentials",
    });
    await approve(ctx, "GITHUB_APP_SECRET");
    const { payload } = await call(ctx, {
      item_name: "GITHUB_APP_SECRET",
      method: "POST",
      path: "https://github.com/login/oauth/access_token",
      body: { grant_type: "authorization_code", code: "c0de", redirect_uri: "https://botpasses.com/integrations/github/callback" },
    });
    assert.equal(payload.origin_status, 200, JSON.stringify(payload));
    assert.equal(payload.minted, undefined, "an authorization_code exchange is not cached as an app token");
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(GH_SECRET));
    assert.doesNotMatch(JSON.stringify(payload), new RegExp(ACCESS));
    const hit = ctx.hits.find((h) => h.url.includes("/login/oauth/access_token"));
    assert.ok(hit);
    assert.equal(hit.auth, "");
    assert.match(hit.contentType, /x-www-form-urlencoded/);
    assert.equal(new URLSearchParams(hit.body).get("client_id"), "Iv1.abc123");
    assert.equal(new URLSearchParams(hit.body).get("code"), "c0de");
  } finally {
    await teardown(ctx);
  }
});

test("avm-style model principal can tools/list without leaking secrets", async () => {
  const ctx = await setup(async () => new Response("{}", { status: 200 }));
  try {
    const listed = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: ctx.modelH,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = await listed.text();
    assert.equal(listed.status, 200);
    assert.doesNotMatch(body, new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(body, /avm_/);
    assert.match(body, /http_request/);
  } finally {
    await teardown(ctx);
  }
});

test("isolation: canary secret never appears after store grant mint or search", async () => {
  const ctx = await setup(async (url) => {
    if (url.includes("/api/token")) return tokenJson();
    return new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 });
  });
  try {
    await approve(ctx);
    const search = await call(ctx, {
      item_name: "SPOTIFY_SECRET",
      method: "GET",
      path: "https://api.spotify.com/v1/search?q=test&type=track",
    });
    const inbox = await (await fetch(`${ctx.base}/api/inbox`, { headers: ctx.op })).json();
    const blob = JSON.stringify({ search, inbox, hits: ctx.hits.map((h) => ({ url: h.url, type: h.contentType })) });
    assert.doesNotMatch(blob, new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(blob, new RegExp(ACCESS));
    assert.doesNotMatch(blob, new RegExp(CANARY));
  } finally {
    await teardown(ctx);
  }
});
