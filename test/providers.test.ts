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
import { clientSecretItemNames, itemWithAccessToken, readMintedAccessToken, refreshAccessToken, refreshItemName } from "../src/hosted/providers/oauth.ts";
import type { ConnectorItem } from "../src/hosted/connector.ts";
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
  assert.equal(chooseRedirect(spotify, "https://staging.botpasses.com"), "https://staging.botpasses.com/integrations/spotify/callback");
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

test("Google and Slack authorize URLs carry the scopes their endpoints require", () => {
  const google = providerById("google");
  const slack = providerById("slack");
  const github = providerById("github");
  assert.ok(google && slack && github);
  const base = { clientId: "cid", redirectUri: "https://x/cb", state: "s", codeVerifier: "v".repeat(43) };

  const g = new URL(authorizeUrl(google, base));
  const googleScopes = (g.searchParams.get("scope") ?? "").split(" ");
  assert.ok(googleScopes.includes("openid") && googleScopes.includes("email"), googleScopes.join(" "));
  assert.ok(googleScopes.includes("https://www.googleapis.com/auth/gmail.readonly"), "Gmail read scope for gmail.googleapis.com");
  assert.ok(googleScopes.includes("https://www.googleapis.com/auth/spreadsheets.readonly"), "Sheets read scope for sheets.googleapis.com");
  assert.ok(googleScopes.includes("https://www.googleapis.com/auth/drive.file"), "per-file Drive scope for www.googleapis.com");
  assert.equal(g.searchParams.get("access_type"), "offline", "Google issues a refresh token only for offline access");
  assert.equal(g.searchParams.get("prompt"), "consent", "a re-connect must get a refresh token again");

  const s = new URL(authorizeUrl(slack, base));
  assert.equal(s.searchParams.get("scope"), null, "scope would ask Slack for a bot token");
  assert.equal(s.searchParams.get("user_scope"), "users:read,channels:read,chat:write", "user token scopes, comma-joined");

  // An empty scope list is refused for a provider whose endpoint rejects it, with a 400 the route can pass on.
  for (const p of [google, slack]) {
    assert.throws(
      () => authorizeUrl(p, { ...base, scopes: [] }),
      (err: unknown) => isHttpError(err) && err.status === 400 && /scope/.test(err.message) && err.extra.provider === p.id,
      `${p.id} refuses an authorize URL with no scopes`,
    );
  }
  // GitHub's endpoint accepts no scope at all; nothing changes for it.
  assert.equal(new URL(authorizeUrl(github, { ...base, scopes: [] })).searchParams.get("scope"), null);
});

test("a Slack user-scope token exchange is read from authed_user", () => {
  const nested = readMintedAccessToken(
    JSON.stringify({ ok: true, token_type: "user", authed_user: { id: "U1", access_token: "xoxp-user-token-1234", refresh_token: "xoxe-1-refresh", expires_in: 43200 } }),
  );
  assert.equal(nested.accessToken, "xoxp-user-token-1234");
  assert.equal(nested.refreshToken, "xoxe-1-refresh");
  assert.equal(nested.last4, "1234");
  const top = readMintedAccessToken(JSON.stringify({ access_token: "xoxb-bot-token-9999", authed_user: { id: "U1" } }));
  assert.equal(top.accessToken, "xoxb-bot-token-9999", "a top-level token still wins");
  // A Slack refresh (token rotation) answer carries the rotated user token at the top level and no authed_user.
  const refreshed = readMintedAccessToken(
    JSON.stringify({ ok: true, access_token: "xoxe-2-rotated-user-token-5678", refresh_token: "xoxe-2-rotated-refresh-token", token_type: "user", expires_in: 43200 }),
  );
  assert.equal(refreshed.accessToken, "xoxe-2-rotated-user-token-5678");
  assert.equal(refreshed.refreshToken, "xoxe-2-rotated-refresh-token");
  assert.equal(refreshed.last4, "5678");
  assert.throws(() => readMintedAccessToken(JSON.stringify({ ok: true, authed_user: { id: "U1" } })), /did not return access_token/);
});

test("token_last4 never shows a whole short token: under four characters reads as **** (R3-9)", () => {
  assert.equal(readMintedAccessToken(JSON.stringify({ access_token: "abc" })).last4, "****");
  assert.equal(readMintedAccessToken(JSON.stringify({ access_token: "abcd" })).last4, "abcd");
  assert.equal(readMintedAccessToken(JSON.stringify({ access_token: ACCESS })).last4, ACCESS.slice(-4));
  const base: ConnectorItem = { secret: "s", username: "u", last4: "****", inject: "client_credentials", allowedHosts: ["api.spotify.com"], name: "X", kind: "client_secret" };
  assert.equal(itemWithAccessToken(base, "abc").last4, "****");
  assert.equal(itemWithAccessToken(base, ACCESS).last4, ACCESS.slice(-4));
});

/**
 * R3-3: a refresh_token exchange authenticates the app like the code exchange did. `basic`
 * providers get the client id and secret as HTTP Basic; `post_body` providers get `client_id`
 * and `client_secret` form fields. The refresh token rides in the form, and none of the three
 * values (client secret, refresh token, minted access token) reaches the returned body or headers.
 */
test("refreshAccessToken places the client secret per provider.tokenAuth for every provider and redacts every secret", async () => {
  const CS = "provider_client_secret_CANARY_77aa";
  const RT = "provider_refresh_token_CANARY_88bb";
  for (const provider of PROVIDERS) {
    const hosts = [...provider.apiHosts, provider.tokenHost];
    const clientSecret: ConnectorItem = { secret: CS, username: CLIENT_ID, last4: CS.slice(-4), inject: "client_credentials", allowedHosts: hosts, name: "APP_SECRET", kind: "client_secret" };
    const refresh: ConnectorItem = { secret: RT, username: CLIENT_ID, last4: RT.slice(-4), inject: "refresh", allowedHosts: hosts, name: "APP_REFRESH", kind: "secret" };
    let sent: { url: string; auth: string; form: URLSearchParams } | undefined;
    const { minted, origin } = await refreshAccessToken(provider, refresh, clientSecret, CLIENT_ID, {
      resolveAddresses: async () => ["8.8.8.8"],
      fetchImpl: async (url, init) => {
        const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        sent = { url: String(url), auth: new Headers(init?.headers).get("authorization") ?? "", form };
        // An origin that echoes the request back in its body and a header, like a debug endpoint would.
        return new Response(JSON.stringify({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600, echo: { form: form.toString(), auth: sent.auth } }), {
          status: 200,
          headers: { "content-type": "application/json", "x-request-id": `${RT}:${CS}` },
        });
      },
    });
    assert.ok(sent, provider.id);
    assert.equal(sent.url, `https://${provider.tokenHost}${provider.tokenPath}`, provider.id);
    assert.equal(sent.form.get("grant_type"), "refresh_token", provider.id);
    assert.equal(sent.form.get("refresh_token"), RT, provider.id);
    switch (provider.tokenAuth) {
      case "basic":
        assert.equal(sent.auth, `Basic ${Buffer.from(`${CLIENT_ID}:${CS}`).toString("base64")}`, `${provider.id}: id and secret as HTTP Basic`);
        assert.equal(sent.form.get("client_secret"), null, `${provider.id}: the secret is not also in the form`);
        break;
      case "post_body":
        assert.equal(sent.auth, "", `${provider.id}: no Authorization header`);
        assert.equal(sent.form.get("client_id"), CLIENT_ID, provider.id);
        assert.equal(sent.form.get("client_secret"), CS, `${provider.id}: the secret is a form field`);
        break;
      default: {
        const _exhaustive: never = provider.tokenAuth;
        throw new Error(String(_exhaustive));
      }
    }
    assert.equal(minted.accessToken, ACCESS, provider.id);
    const visible = JSON.stringify(origin);
    const hidden: [string, string][] = [["client secret", CS], ["refresh token", RT], ["access token", ACCESS], ["Basic pair", Buffer.from(`${CLIENT_ID}:${CS}`).toString("base64")]];
    for (const [what, value] of hidden) {
      assert.doesNotMatch(visible, new RegExp(value), `${provider.id}: the ${what} does not reach the result`);
    }
    assert.equal(origin.headers["x-request-id"], "[redacted]:[redacted]", provider.id);
  }
  // Both items must allow the token host; the refresh item alone is not enough.
  const spotify = providerById("spotify");
  assert.ok(spotify);
  const apiOnly: ConnectorItem = { secret: CS, username: CLIENT_ID, last4: "77aa", inject: "client_credentials", allowedHosts: ["api.spotify.com"], name: "APP_SECRET", kind: "client_secret" };
  const refreshOk: ConnectorItem = { ...apiOnly, secret: RT, inject: "refresh", allowedHosts: ["api.spotify.com", "accounts.spotify.com"], name: "APP_REFRESH", kind: "secret" };
  await assert.rejects(
    () => refreshAccessToken(spotify, refreshOk, apiOnly, CLIENT_ID, { resolveAddresses: async () => ["8.8.8.8"], fetchImpl: async () => tokenJson() }),
    (err: unknown) => isHttpError(err) && err.status === 400 && err.extra.status === "inject_denied" && /accounts\.spotify\.com/.test(String(err.extra.hint)),
  );
  await assert.rejects(
    () => refreshAccessToken(spotify, { ...refreshOk, allowedHosts: ["api.spotify.com"] }, { ...apiOnly, allowedHosts: refreshOk.allowedHosts }, CLIENT_ID, { resolveAddresses: async () => ["8.8.8.8"], fetchImpl: async () => tokenJson() }),
    (err: unknown) => isHttpError(err) && err.status === 400 && err.extra.status === "inject_denied",
  );
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
    assert.equal(done.location, `/console#vault?connected=github&agent=${ctx.model.id}`, "the landing flash can say the agent may retry");
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

async function inboxOf(ctx: Ctx) {
  const res = await fetch(`${ctx.base}/api/inbox`, { headers: ctx.op });
  return (await res.json()) as { grants: { item_name: string }[]; needs: Record<string, unknown>[] };
}

test("INF-49: a user-only path with only the app credential is refused before dialing: user_connect_required, no send, approval handed back, one inbox need", async () => {
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
    const secret = (await ctx.kernel.listItems(ctx.orgId, "staging")).find((i) => i.name === "SPOTIFY_SECRET");
    assert.ok(secret);
    const grantId = await approve(ctx);
    const me = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me", client_id: CLIENT_ID, task_description: "Show my profile" });
    assert.equal(me.payload.status, "user_connect_required", JSON.stringify(me.payload));
    assert.equal(me.payload.origin_status, undefined, "no origin answer: the doomed app-token call was not sent");
    assert.equal(ctx.hits.length, 0, "fetchImpl was never called: neither the token mint nor /v1/me");
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "active", "the one-call approval comes back: nothing left the process");
    assert.equal(me.payload.provider, "spotify");
    assert.equal(me.payload.item_name, "SPOTIFY_SECRET");
    assert.equal(me.payload.refresh_item_name, "SPOTIFY_REFRESH");
    const needId = String(me.payload.need_id);
    assert.match(needId, /^nid_/);
    assert.equal(
      me.payload.connect_url,
      `http://127.0.0.1:8788/console#credentials/item/${secret.id}?connect=spotify&agent=${ctx.model.id}&need=${needId}`,
      "a console deep link on the plane's public origin, carrying the agent and the need",
    );
    assert.match(String(me.payload.hint), /connect_url/);
    assert.match(String(me.payload.hint), /retry the same call once/);
    const next = me.payload.next as { for_model: string; tool: string; arguments: Record<string, string> };
    assert.equal(next.tool, "http_request");
    assert.match(next.for_model, /connect_url/);
    assert.match(next.for_model, /Do not retry until/);
    assert.deepEqual(next.arguments, { method: "GET", path: "/v1/me", host: "api.spotify.com", item_name: "SPOTIFY_SECRET", client_id: CLIENT_ID });
    assert.doesNotMatch(JSON.stringify(me.payload), new RegExp(CLIENT_SECRET));

    // Repeats reuse the pending row: the same need id and link, one inbox card, one audit row.
    const again = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me", client_id: CLIENT_ID });
    assert.equal(again.payload.status, "user_connect_required");
    assert.equal(again.payload.need_id, needId, "the same need id");
    assert.equal(again.payload.connect_url, me.payload.connect_url);
    assert.equal(ctx.hits.length, 0);
    const audit = await ctx.kernel.store.listAudit(ctx.orgId, 100);
    assert.equal(audit.filter((a) => a.action === "connect_requested").length, 1, "connect_requested is audited once per row");
    assert.ok(audit.some((a) => a.action === "connect_requested" && a.itemName === "SPOTIFY_REFRESH" && a.clientId === ctx.model.id));
    assert.equal(audit.filter((a) => a.action === "inject_denied" && a.itemName === "SPOTIFY_SECRET").length, 2, "each refusal is audited inject_denied, never inject");

    // Dry run reports the same reason and creates nothing.
    const cancelled = await ctx.kernel.store.denyNeed(needId);
    assert.equal(cancelled, true);
    const dry = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me", dry_run: true });
    assert.equal(dry.payload.dry_run, true);
    assert.equal(dry.payload.would_send, false);
    assert.equal(dry.payload.reason, "user_connect_required");
    assert.equal(dry.payload.provider, "spotify");
    assert.equal(dry.payload.grant_status, "active");
    assert.deepEqual((await inboxOf(ctx)).needs, [], "a dry run creates no inbox need");
    assert.equal((await ctx.kernel.store.getNeed(needId))?.status, "denied");

    // The inbox lists the connect need with what the card needs.
    const fresh = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" });
    assert.equal(fresh.payload.status, "user_connect_required");
    assert.notEqual(fresh.payload.need_id, needId, "a denied need is not reused");
    const inbox = await inboxOf(ctx);
    assert.equal(inbox.needs.length, 1);
    const card = inbox.needs[0];
    assert.ok(card);
    assert.equal(card.id, fresh.payload.need_id);
    assert.equal(card.kind, "connect");
    assert.equal(card.provider, "spotify");
    assert.equal(card.source_item_id, secret.id);
    assert.equal(card.source_item_name, "SPOTIFY_SECRET");
    assert.equal(card.suggested_name, "SPOTIFY_REFRESH");
    assert.equal(card.client_id, ctx.model.id);
    assert.equal(card.client_name, "grok");
    assert.equal(card.host, "api.spotify.com");
    assert.equal(card.collect_path, null, "nothing is typed in for a connect");
    assert.equal(typeof card.expires_at, "string");
    assert.equal(typeof card.created_at, "string");

    // The collect page refuses a connect need: the HTML route sends the operator to the inbox and fulfil is 409.
    const page = await fetch(`${ctx.base}/collect/${String(card.id)}`, { headers: ctx.op, redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/console#inbox");
    const needApi = await (await fetch(`${ctx.base}/api/need-items/${String(card.id)}`, { headers: ctx.op })).json() as Record<string, unknown>;
    assert.equal(needApi.kind, "connect");
    assert.equal(needApi.provider, "spotify");
    const typed = await fetch(`${ctx.base}/api/need-items/${String(card.id)}/fulfill`, {
      method: "POST",
      headers: ctx.op,
      body: JSON.stringify({ value: "typed_token_CANARY", allowed_hosts: ["api.spotify.com"] }),
    });
    assert.equal(typed.status, 409);
    assert.match(((await typed.json()) as { error: string }).error, /connect/i);
    assert.equal((await ctx.kernel.listItems(ctx.orgId, "staging")).length, 1, "nothing was stored");

    // A public path still works with the app token.
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

test("INF-49: a plain user token stored for the API host is still sent as before (the refusal is for app credentials only)", async () => {
  const ctx = await setup(async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("/v1/me")) return new Response(JSON.stringify({ id: auth === `Bearer ${ACCESS}` ? "user1" : "no" }), { status: 200 });
    return new Response("nope", { status: 404 });
  });
  try {
    await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "secret",
      name: "SPOTIFY_USER_TOKEN",
      value: ACCESS,
      allowedHosts: ["api.spotify.com"],
      inject: "bearer",
    });
    await approve(ctx, "SPOTIFY_USER_TOKEN");
    const me = await call(ctx, { item_name: "SPOTIFY_USER_TOKEN", method: "GET", path: "https://api.spotify.com/v1/me" });
    assert.equal(me.payload.origin_status, 200, JSON.stringify(me.payload));
    assert.equal(ctx.hits.length, 1);
    assert.deepEqual((await inboxOf(ctx)).needs, []);
  } finally {
    await teardown(ctx);
  }
});

test("INF-49: connecting from the inbox card fulfils the need and grants the agent, whose retry then succeeds with a user token and no new card", async () => {
  const ctx = await setup(async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("accounts.spotify.com/api/token")) {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (form.get("grant_type") === "authorization_code") return tokenJson({ refresh_token: REFRESH, scope: "user-read-email" });
      if (form.get("grant_type") === "refresh_token") return tokenJson();
      return new Response("", { status: 400 });
    }
    if (url.includes("/v1/me")) {
      return auth === `Bearer ${ACCESS}` ? new Response(JSON.stringify({ id: "user1" }), { status: 200 }) : new Response("", { status: 401 });
    }
    return new Response("nope", { status: 404 });
  });
  try {
    const me = { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" };
    await approve(ctx, "SPOTIFY_SECRET", "item_standing");
    const refused = await call(ctx, me);
    assert.equal(refused.payload.status, "user_connect_required", JSON.stringify(refused.payload));
    const needId = String(refused.payload.need_id);
    const link = new URL(String(refused.payload.connect_url));
    const q = new URLSearchParams(link.hash.split("?")[1] ?? "");
    assert.equal(q.get("need"), needId);
    assert.equal(q.get("agent"), ctx.model.id);

    // The console posts what the dialog carries: the item, the agent (checkbox on), and the need.
    const started = await startConnect(ctx, "spotify", {
      item_name: "SPOTIFY_SECRET",
      environment: "staging",
      agent_client_id: q.get("agent"),
      need_id: needId,
    });
    assert.equal(started.res.status, 200, JSON.stringify(started.json));
    // A need id that is not this org's pending connect need for this item is refused.
    const wrong = await startConnect(ctx, "spotify", { item_name: "SPOTIFY_SECRET", environment: "staging", need_id: "nid_nope" });
    assert.equal(wrong.res.status, 404);

    const done = await callback(ctx, "spotify", { code: "c0de", state: started.state });
    assert.equal(done.location, `/console#vault?connected=spotify&agent=${ctx.model.id}`);
    const need = await ctx.kernel.store.getNeed(needId);
    assert.equal(need?.status, "fulfilled");
    const refresh = (await ctx.kernel.listItems(ctx.orgId, "staging")).find((i) => i.name === "SPOTIFY_REFRESH");
    assert.ok(refresh);
    assert.equal(need?.itemId, refresh.id, "the need points at the stored refresh item");
    assert.equal((await ctx.kernel.store.findItemPolicy(ctx.orgId, ctx.model.id, refresh.id))?.kind, "item_standing");
    assert.deepEqual((await inboxOf(ctx)).needs, [], "the card is gone");
    const audit = await ctx.kernel.store.listAudit(ctx.orgId, 100);
    assert.ok(audit.some((a) => a.action === "need_fulfilled" && a.itemName === "SPOTIFY_REFRESH" && a.clientId === ctx.model.id));

    // The agent's retry goes through the user-token path: exchange, then the call, no inbox card.
    const retry = await call(ctx, me);
    assert.equal(retry.payload.origin_status, 200, JSON.stringify(retry.payload));
    assert.equal(retry.payload.user_token, true);
    assert.equal(retry.payload.status, 200);
    assert.deepEqual((await inboxOf(ctx)).needs, []);
    assert.equal((await inboxOf(ctx)).grants.filter((g) => g.item_name === "SPOTIFY_REFRESH").length, 0, "no pending refresh approval");
    const again = await call(ctx, me);
    assert.equal(again.payload.user_token, true, "the cached user token serves the next call");
    assert.equal(ctx.hits.filter((h) => h.url.includes("/api/token")).length, 2, "one code exchange and one refresh");
    const bodies = JSON.stringify([refused.payload, retry.payload, again.payload]);
    assert.doesNotMatch(bodies, new RegExp(CLIENT_SECRET));
    assert.doesNotMatch(bodies, new RegExp(REFRESH));
    assert.doesNotMatch(bodies, new RegExp(ACCESS));
  } finally {
    await teardown(ctx);
  }
});

test("INF-49: Deny on the connect card settles the need, audits need_denied, and a second deny is 409", async () => {
  const ctx = await setup(async () => new Response("nope", { status: 404 }));
  try {
    await approve(ctx);
    const refused = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" });
    assert.equal(refused.payload.status, "user_connect_required");
    const needId = String(refused.payload.need_id);
    const other = await ctx.kernel.createOrg("other", "user_other");
    const foreign = await fetch(`${ctx.base}/api/need-items/${needId}/deny`, {
      method: "POST",
      headers: { ...ctx.op, "x-test-user": "user_other", "x-test-org": other.orgId },
      body: "{}",
    });
    assert.equal(foreign.status, 404, "another org's need reads as unknown");
    const denied = await fetch(`${ctx.base}/api/need-items/${needId}/deny`, { method: "POST", headers: ctx.op, body: "{}" });
    assert.equal(denied.status, 200);
    assert.equal((await ctx.kernel.store.getNeed(needId))?.status, "denied");
    assert.deepEqual((await inboxOf(ctx)).needs, []);
    const audit = await ctx.kernel.store.listAudit(ctx.orgId, 100);
    assert.ok(audit.some((a) => a.action === "need_denied" && a.actor === "user_owner" && a.itemName === "SPOTIFY_REFRESH" && a.clientId === ctx.model.id));
    const twice = await fetch(`${ctx.base}/api/need-items/${needId}/deny`, { method: "POST", headers: ctx.op, body: "{}" });
    assert.equal(twice.status, 409);
    assert.equal(ctx.hits.length, 0);
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

test("a stored <ITEM>_REFRESH token is exchanged with the client secret's credentials (Basic for Spotify) and the user path succeeds", async () => {
  const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
  const ctx = await setup(async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("accounts.spotify.com/api/token")) {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      // A confidential client: Spotify answers invalid_client to a refresh without the app's credentials.
      if (auth !== basic) return new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 });
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === REFRESH) {
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
    const audit = await ctx.kernel.store.listAudit(ctx.orgId, 50);
    const blob = JSON.stringify({ payload: me.payload, audit });
    for (const secret of [REFRESH, ACCESS, CLIENT_SECRET, Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")]) {
      assert.doesNotMatch(blob, new RegExp(secret), "neither secret reaches the result or the audit");
    }
    assert.ok(audit.some((a) => a.action === "inject" && a.itemName === "SPOTIFY_REFRESH"), "the refresh item's use is audited");
    assert.ok(audit.some((a) => a.action === "inject" && a.itemName === "SPOTIFY_SECRET"), "and so is the client secret's");
    const mint = ctx.hits.find((h) => h.url.includes("/api/token"));
    assert.ok(mint);
    assert.equal(mint.auth, basic, "the refresh_token grant authenticates the app as the code exchange did");
    assert.match(mint.body, /grant_type=refresh_token/);
    assert.doesNotMatch(mint.body, /client_secret=/, "a basic provider does not also get the secret in the form");
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

test("a token endpoint that answers 2xx with an unusable body is audited inject, not inject_failed: the credential was sent (R3-6)", async () => {
  const ctx = await setup(async (url) => {
    if (url.includes("/api/token")) return new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } });
    return new Response(JSON.stringify({ tracks: [] }), { status: 200 });
  });
  try {
    const grantId = await approve(ctx);
    const search = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/search?q=x&type=track" });
    assert.match(String(search.payload.error), /non-JSON body/, JSON.stringify(search.payload));
    assert.equal(ctx.hits.filter((h) => h.url.includes("/api/token")).length, 1, "the mint was sent");
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "consumed", "the one-call approval stays spent");
    let audit = await ctx.kernel.store.listAudit(ctx.orgId, 50);
    assert.equal(audit.filter((a) => a.action === "inject_failed").length, 0, "the origin was reached");
    assert.equal(audit.filter((a) => a.action === "inject" && a.itemName === "SPOTIFY_SECRET").length, 1);

    // The same on the refresh path: the refresh item was sent to the token endpoint.
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
    const refreshGrant = await approve(ctx, "SPOTIFY_REFRESH");
    const me = await call(ctx, { item_name: "SPOTIFY_SECRET", method: "GET", path: "https://api.spotify.com/v1/me" });
    assert.match(String(me.payload.error), /non-JSON body/);
    assert.equal((await ctx.kernel.store.getGrant(refreshGrant))?.status, "consumed");
    audit = await ctx.kernel.store.listAudit(ctx.orgId, 50);
    assert.equal(audit.filter((a) => a.action === "inject_failed").length, 0);
    assert.equal(audit.filter((a) => a.action === "inject" && a.itemName === "SPOTIFY_REFRESH").length, 1);
    assert.doesNotMatch(JSON.stringify({ search, me, audit }), new RegExp(CLIENT_SECRET));
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

/* ---- R4a: the direct refresh path (an agent posts <ITEM>_REFRESH to the token endpoint itself) ---- */

const ROTATED_REFRESH = "1//rotated_refresh_token_do_not_leak_9f9f";

type RefreshPair = {
  providerId: "google" | "slack" | "github" | "stripe" | "spotify";
  secretName: string;
  refreshName: string;
  clientId: string;
  secret: string;
  refresh: string;
};

/**
 * The two rows the connect flow leaves behind: the client secret item and its `<ITEM>_REFRESH`,
 * both allowed on the provider's API and token hosts. Only the refresh item is approved for the
 * agent; the sibling gets no grant and no policy, which is the point of the direct path.
 */
async function storeRefreshPair(ctx: Ctx, pair: RefreshPair, opts: { sibling?: boolean; policy?: "prompt" | "item_standing" } = {}) {
  const provider = providerById(pair.providerId);
  assert.ok(provider);
  const hosts = [...new Set([...provider.apiHosts, provider.tokenHost])];
  let siblingId: string | undefined;
  if (opts.sibling !== false) {
    const sibling = await ctx.kernel.createItem({
      orgId: ctx.orgId,
      actor: "user_owner",
      environment: "staging",
      kind: "client_secret",
      name: pair.secretName,
      value: pair.secret,
      username: pair.clientId,
      allowedHosts: hosts,
      inject: "client_credentials",
    });
    siblingId = sibling.id;
  }
  const refresh = await ctx.kernel.createItem({
    orgId: ctx.orgId,
    actor: "user_owner",
    environment: "staging",
    kind: "secret",
    name: pair.refreshName,
    value: pair.refresh,
    username: pair.clientId,
    allowedHosts: hosts,
    inject: "refresh",
  });
  const grantId = await approve(ctx, pair.refreshName, opts.policy ?? "item_standing");
  return { provider, refreshId: refresh.id, siblingId, grantId, tokenUrl: `https://${provider.tokenHost}${provider.tokenPath}` };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The result and every audit row must be free of both stored values, the Basic form, and the tokens the endpoint minted. */
async function assertNothingLeaked(ctx: Ctx, payload: unknown, pair: RefreshPair) {
  const audit = await ctx.kernel.store.listAudit(ctx.orgId, 100);
  const blob = JSON.stringify({ payload, audit });
  const basic = Buffer.from(`${pair.clientId}:${pair.secret}`).toString("base64");
  for (const secret of [pair.secret, pair.refresh, basic, ACCESS, ROTATED_REFRESH]) {
    assert.doesNotMatch(blob, new RegExp(escapeRe(secret)), `${secret.slice(0, 8)}... reached the result or the audit`);
  }
  return audit;
}

type AuditRow = { action: string; itemName: string | null; actor: string; clientId: string | null };

/** Both items are audited `inject` under the calling agent, as `tryUserToken` records them. */
function assertInjectRows(ctx: Ctx, audit: AuditRow[], pair: RefreshPair) {
  for (const name of [pair.refreshName, pair.secretName]) {
    const rows = audit.filter((a) => a.action === "inject" && a.itemName === name);
    assert.equal(rows.length, 1, `${name} is audited inject exactly once`);
    assert.equal(rows[0]?.actor, ctx.model.id);
    assert.equal(rows[0]?.clientId, ctx.model.id);
  }
  assert.equal(audit.filter((a) => a.action === "inject_denied" || a.action === "inject_failed").length, 0);
}

function refreshCall(pair: RefreshPair, tokenUrl: string, body: Record<string, unknown> = { grant_type: "refresh_token" }) {
  return { item_name: pair.refreshName, method: "POST", path: tokenUrl, body };
}

test("direct refresh, Google (post_body): client_id and client_secret ride in the form from the sibling item, the rotated refresh token is persisted", async () => {
  const pair: RefreshPair = {
    providerId: "google",
    secretName: "GOOGLE_SECRET",
    refreshName: "GOOGLE_REFRESH",
    clientId: "1234.apps.googleusercontent.com",
    secret: "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77aa",
    refresh: "1//google_refresh_token_do_not_leak_11bb",
  };
  const ctx = await setup(async (url, init) => {
    if (!url.includes("oauth2.googleapis.com/token")) return new Response("nope", { status: 404 });
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (form.get("client_id") !== pair.clientId || form.get("client_secret") !== pair.secret) {
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 });
    }
    if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== pair.refresh) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return tokenJson({ refresh_token: ROTATED_REFRESH, scope: "openid email" });
  });
  try {
    const { refreshId, siblingId, tokenUrl } = await storeRefreshPair(ctx, pair);
    assert.ok(siblingId);
    assert.ok((await ctx.kernel.store.listGrants(ctx.orgId)).every((g) => g.itemId !== siblingId), "the agent holds no grant on the client secret item");
    const { payload } = await call(ctx, refreshCall(pair, tokenUrl));
    assert.equal(payload.origin_status, 200, JSON.stringify(payload));
    assert.equal(payload.refreshed, true);
    assert.equal(payload.token_last4, ACCESS.slice(-4));
    assert.match(String(payload.body), /"access_token":"\[redacted\]"/);
    assert.match(String(payload.body), /"refresh_token":"\[redacted\]"/);
    const hit = ctx.hits.find((h) => h.url === tokenUrl);
    assert.ok(hit);
    assert.equal(hit.auth, "", "a post_body provider gets no Authorization header");
    assert.match(hit.contentType, /x-www-form-urlencoded/);
    const form = new URLSearchParams(hit.body);
    assert.equal(form.get("client_id"), pair.clientId);
    assert.equal(form.get("client_secret"), pair.secret);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), pair.refresh);
    assert.equal((await ctx.kernel.decryptItem(ctx.orgId, refreshId)).secret, ROTATED_REFRESH, "the rotated refresh token replaced the stored value");
    const audit = await assertNothingLeaked(ctx, payload, pair);
    assertInjectRows(ctx, audit, pair);
    const rotated = audit.find((a) => a.action === "refresh_rotated");
    assert.equal(rotated?.itemName, pair.refreshName);
    assert.equal(rotated?.actor, "provider");
    // The minted user token is cached under the refresh item, as the user-token path caches it.
    assert.equal(cachedMint(ctx.orgId, refreshId, pair.clientId, "refresh_token")?.last4, ACCESS.slice(-4));
  } finally {
    await teardown(ctx);
  }
});

test("direct refresh, Slack (basic): the sibling secret goes out as HTTP Basic, never in the form; the user token is read from authed_user", async () => {
  const pair: RefreshPair = {
    providerId: "slack",
    secretName: "SLACK_APP_SECRET",
    refreshName: "SLACK_APP_REFRESH",
    clientId: "1234567890.0987654321",
    secret: "slack_client_secret_CANARY_3c3c",
    refresh: "xoxe-1-slack_refresh_token_do_not_leak_4d4d",
  };
  const basic = `Basic ${Buffer.from(`${pair.clientId}:${pair.secret}`).toString("base64")}`;
  const ctx = await setup(async (url, init) => {
    if (!url.includes("slack.com/api/oauth.v2.access")) return new Response("nope", { status: 404 });
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (auth !== basic) return new Response(JSON.stringify({ ok: false, error: "invalid_client" }), { status: 200 });
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== pair.refresh) {
      return new Response(JSON.stringify({ ok: false, error: "invalid_refresh_token" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ ok: true, authed_user: { id: "U1", access_token: ACCESS, refresh_token: pair.refresh, token_type: "user", expires_in: 43200 } }),
      { status: 200 },
    );
  });
  try {
    const { refreshId, tokenUrl } = await storeRefreshPair(ctx, pair);
    const { payload } = await call(ctx, refreshCall(pair, tokenUrl));
    assert.equal(payload.origin_status, 200, JSON.stringify(payload));
    assert.equal(payload.refreshed, true);
    const hit = ctx.hits.find((h) => h.url === tokenUrl);
    assert.ok(hit);
    assert.equal(hit.auth, basic, "a basic provider authenticates the app in the Authorization header");
    const form = new URLSearchParams(hit.body);
    assert.equal(form.get("client_secret"), null, "and never in the form");
    assert.equal(form.get("client_id"), null);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), pair.refresh);
    assert.equal((await ctx.kernel.decryptItem(ctx.orgId, refreshId)).secret, pair.refresh, "an unchanged refresh token is left alone");
    const audit = await assertNothingLeaked(ctx, payload, pair);
    assertInjectRows(ctx, audit, pair);
    assert.equal(audit.some((a) => a.action === "refresh_rotated"), false);
  } finally {
    await teardown(ctx);
  }
});

test("direct refresh, GitHub (post_body): the sibling is found as <ITEM>_SECRET and the exchange carries its secret in the form", async () => {
  const pair: RefreshPair = {
    providerId: "github",
    secretName: "GITHUB_APP_SECRET",
    refreshName: "GITHUB_APP_REFRESH",
    clientId: "Iv1.abc123",
    secret: "gh_app_client_secret_CANARY_5e5e",
    refresh: "ghr_github_refresh_token_do_not_leak_6f6f",
  };
  const ctx = await setup(async (url, init) => {
    if (!url.includes("github.com/login/oauth/access_token")) return new Response("nope", { status: 404 });
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (form.get("client_id") !== pair.clientId || form.get("client_secret") !== pair.secret) {
      return new Response(JSON.stringify({ error: "incorrect_client_credentials" }), { status: 200 });
    }
    if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== pair.refresh) {
      return new Response(JSON.stringify({ error: "bad_refresh_token" }), { status: 200 });
    }
    return new Response(JSON.stringify({ access_token: ACCESS, expires_in: 28800, refresh_token: ROTATED_REFRESH, token_type: "bearer" }), { status: 200 });
  });
  try {
    const { refreshId, tokenUrl } = await storeRefreshPair(ctx, pair);
    const { payload } = await call(ctx, refreshCall(pair, tokenUrl));
    assert.equal(payload.origin_status, 200, JSON.stringify(payload));
    assert.equal(payload.refreshed, true);
    const hit = ctx.hits.find((h) => h.url === tokenUrl);
    assert.ok(hit);
    assert.equal(hit.auth, "");
    const form = new URLSearchParams(hit.body);
    assert.equal(form.get("client_secret"), pair.secret);
    assert.equal(form.get("client_id"), pair.clientId);
    assert.equal(form.get("refresh_token"), pair.refresh);
    assert.equal((await ctx.kernel.decryptItem(ctx.orgId, refreshId)).secret, ROTATED_REFRESH, "GitHub Apps rotate the refresh token on every exchange");
    const audit = await assertNothingLeaked(ctx, payload, pair);
    assertInjectRows(ctx, audit, pair);
  } finally {
    await teardown(ctx);
  }
});

test("direct refresh, Stripe Connect (post_body): the exchange carries the platform secret in the form and the answer is redacted", async () => {
  const pair: RefreshPair = {
    providerId: "stripe",
    secretName: "STRIPE_CONNECT_SECRET",
    refreshName: "STRIPE_CONNECT_REFRESH",
    clientId: "ca_platform_client_id",
    secret: "sk_live_stripe_platform_secret_CANARY_7a7a",
    refresh: "rt_stripe_refresh_token_do_not_leak_8b8b",
  };
  const ctx = await setup(async (url, init) => {
    if (!url.includes("connect.stripe.com/oauth/token")) return new Response("nope", { status: 404 });
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (form.get("client_secret") !== pair.secret) {
      return new Response(JSON.stringify({ error: "invalid_client", error_description: "No such client secret" }), { status: 401 });
    }
    if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== pair.refresh) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return new Response(
      JSON.stringify({ access_token: ACCESS, refresh_token: pair.refresh, token_type: "bearer", stripe_user_id: "acct_1", scope: "read_write" }),
      { status: 200 },
    );
  });
  try {
    const { tokenUrl } = await storeRefreshPair(ctx, pair);
    const { payload } = await call(ctx, refreshCall(pair, tokenUrl));
    assert.equal(payload.origin_status, 200, JSON.stringify(payload));
    assert.equal(payload.refreshed, true);
    assert.match(String(payload.body), /"stripe_user_id":"acct_1"/, "non-secret fields still reach the model");
    const hit = ctx.hits.find((h) => h.url === tokenUrl);
    assert.ok(hit);
    assert.equal(hit.auth, "");
    const form = new URLSearchParams(hit.body);
    assert.equal(form.get("client_id"), pair.clientId);
    assert.equal(form.get("client_secret"), pair.secret);
    assert.equal(form.get("refresh_token"), pair.refresh);
    const audit = await assertNothingLeaked(ctx, payload, pair);
    assertInjectRows(ctx, audit, pair);
  } finally {
    await teardown(ctx);
  }
});

test("direct refresh, Spotify PKCE without a sibling: the public-client exchange goes out with client_id alone", async () => {
  const pair: RefreshPair = {
    providerId: "spotify",
    secretName: "SPOTIFY_PUBLIC_SECRET",
    refreshName: "SPOTIFY_PUBLIC_REFRESH",
    clientId: "public_pkce_client_id_0000",
    secret: "never_stored_CANARY",
    refresh: "AQD_public_refresh_token_do_not_leak_9c9c",
  };
  const ctx = await setup(async (url, init) => {
    if (!url.includes("accounts.spotify.com/api/token")) return new Response("nope", { status: 404 });
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    // A PKCE public client has no secret: Spotify accepts client_id in the form and no Basic header.
    if (auth !== "") return new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 });
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    if (form.get("client_id") !== pair.clientId || form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== pair.refresh) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }
    return tokenJson({ refresh_token: ROTATED_REFRESH, scope: "user-read-email" });
  });
  try {
    const { refreshId, siblingId, tokenUrl } = await storeRefreshPair(ctx, pair, { sibling: false });
    assert.equal(siblingId, undefined);
    const { payload } = await call(ctx, refreshCall(pair, tokenUrl));
    assert.equal(payload.origin_status, 200, JSON.stringify(payload));
    assert.equal(payload.refreshed, true);
    const hit = ctx.hits.find((h) => h.url === tokenUrl);
    assert.ok(hit);
    assert.equal(hit.auth, "");
    const form = new URLSearchParams(hit.body);
    assert.equal(form.get("client_id"), pair.clientId);
    assert.equal(form.get("client_secret"), null);
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.get("refresh_token"), pair.refresh);
    assert.equal((await ctx.kernel.decryptItem(ctx.orgId, refreshId)).secret, ROTATED_REFRESH);
    const audit = await assertNothingLeaked(ctx, payload, pair);
    assert.equal(audit.filter((a) => a.action === "inject" && a.itemName === pair.refreshName).length, 1);
    assert.equal(audit.some((a) => a.itemName === pair.secretName), false, "no sibling, no sibling row");
  } finally {
    await teardown(ctx);
  }
});

test("direct refresh without a sibling on a confidential provider is refused before dialing, naming the missing item; a one-call approval comes back", async () => {
  const pair: RefreshPair = {
    providerId: "github",
    secretName: "GH_ONLY_SECRET",
    refreshName: "GH_ONLY_REFRESH",
    clientId: "Iv1.lonely",
    secret: "never_stored_CANARY",
    refresh: "ghr_lonely_refresh_token_do_not_leak_0d0d",
  };
  const ctx = await setup(async () => new Response(JSON.stringify({ error: "incorrect_client_credentials" }), { status: 200 }));
  try {
    const { grantId, tokenUrl } = await storeRefreshPair(ctx, pair, { sibling: false, policy: "prompt" });
    const { rpc, payload } = await call(ctx, refreshCall(pair, tokenUrl));
    assert.equal((rpc as { result?: { isError?: boolean } }).result?.isError, undefined, "a structured refusal, not an MCP error");
    assert.equal(payload.status, "inject_denied", JSON.stringify(payload));
    assert.equal(payload.item_name, pair.refreshName);
    assert.equal(payload.missing_item, pair.secretName);
    assert.match(String(payload.hint), /GH_ONLY_SECRET or GH_ONLY/);
    assert.match(String(payload.hint), /github\.com/);
    assert.match(String(payload.hint), /invalid_client/);
    assert.equal(ctx.hits.length, 0, "nothing was sent: no silent invalid_client from the vendor");
    assert.equal((await ctx.kernel.store.getGrant(grantId))?.status, "active", "the one-call approval was handed back");
    const audit = await assertNothingLeaked(ctx, payload, pair);
    assert.equal(audit.filter((a) => a.action === "inject_denied" && a.itemName === pair.refreshName).length, 1);
    assert.equal(audit.filter((a) => a.action === "inject").length, 0);

    // A refresh item can only run the refresh_token grant.
    const wrong = await call(ctx, refreshCall(pair, tokenUrl, { grant_type: "authorization_code", code: "c0de" }));
    assert.match(String(wrong.payload.error), /only grant it can run is refresh_token/);
    assert.equal(ctx.hits.length, 0);
  } finally {
    await teardown(ctx);
  }
});

test("clientSecretItemNames inverts refreshItemName for both connect spellings", () => {
  assert.deepEqual(clientSecretItemNames(refreshItemName("FOO_SECRET")), ["FOO_SECRET", "FOO"]);
  assert.deepEqual(clientSecretItemNames(refreshItemName("FOO")), ["FOO_SECRET", "FOO"]);
  assert.deepEqual(clientSecretItemNames("FOO"), [], "no suffix, no sibling");
  assert.deepEqual(clientSecretItemNames("_REFRESH"), []);
});
