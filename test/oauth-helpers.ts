/** Shared fixtures for the OAuth authorization-server tests. Not a test file itself. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import * as OTPAuth from "otpauth";
import type Provider from "oidc-provider";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { parseOidcPrivateJwk } from "../src/hosted/boot.ts";
import type { PinnedFetch } from "../src/hosted/cimd-fetch.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { identityAuthResolver } from "../src/hosted/identity.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { createOauthProvider } from "../src/hosted/oauth-as.ts";
import { OperatorIdentity } from "../src/hosted/operator-identity.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import type { VaultEnvName } from "../src/hosted-types.ts";
import { TEST_SESSION_SECRET, cleanup, tempHome, testOidcPrivateJwk } from "./helpers.ts";

export const ISSUER = "http://127.0.0.1:8788";
export const AUDIENCE = `${ISSUER}/mcp`;

/** Minimal cookie jar: keeps the last value per name, ignores Path and attributes. */
export class Jar {
  readonly #cookies = new Map<string, string>();

  absorb(res: Response): this {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /expires=Thu, 01 Jan 1970/i.test(line)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return this;
  }

  header(filter: (name: string) => boolean = () => true): string {
    return [...this.#cookies.entries()]
      .filter(([k]) => filter(k))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  csrf(): string {
    const raw = this.#cookies.get("__Host-bp_csrf") ?? this.#cookies.get("bp_csrf") ?? "";
    return decodeURIComponent(raw);
  }
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function codeFromEmail(html: string): string {
  const m = />(\d{8})</.exec(html);
  assert.ok(m?.[1], "otp missing from email");
  return m[1];
}

export type OauthServer = Awaited<ReturnType<typeof startOauthServer>>;

/**
 * Hosted server with first-party identity and the OAuth AS mounted. `secure: true`
 * mirrors Fly: Secure cookies, provider.proxy, and every request must carry
 * `x-forwarded-proto: https` (see `secureHeaders`).
 */
export async function startOauthServer(opts: {
  secure: boolean;
  deployPlane?: VaultEnvName;
  fetchImpl?: PinnedFetch;
}) {
  const home = tempHome();
  const store = openHostedSqlite(join(home, "oauth.sqlite"));
  const kek = parseMasterKey(generateMasterKey());
  const emails: { to: string; html: string }[] = [];
  const sendEmail = async (to: string, _s: string, html: string) => {
    emails.push({ to, html });
  };
  const deployPlane = opts.deployPlane ?? "staging";
  const kernel = new HostedKernel({ store, kek, sendEmail, publicUrl: ISSUER, deployPlane });
  const identity = new OperatorIdentity({ store, sessionSecret: TEST_SESSION_SECRET, kek, sendEmail });
  const jwk = parseOidcPrivateJwk(testOidcPrivateJwk());
  assert.ok(jwk);
  const oidcProvider: Provider = createOauthProvider({
    issuer: ISSUER,
    kernel,
    sessionSecret: TEST_SESSION_SECRET,
    jwk,
    secureCookies: opts.secure,
    deployPlane,
    fetchImpl: opts.fetchImpl,
  });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    publicUrl: ISSUER,
    identity,
    oidcProvider,
    secureCookies: opts.secure,
    deployPlane,
    authResolver: identityAuthResolver({
      identity,
      kernel,
      secureCookies: opts.secure,
      oidcJwk: jwk,
      issuer: ISSUER,
    }),
  });
  const addr = await http.listen();
  const base = `http://${addr.host}:${addr.port}`;
  const forwarded: Record<string, string> = opts.secure ? { "x-forwarded-proto": "https" } : {};

  /** fetch that never follows redirects, adds the forwarded-proto header, and feeds the jar. */
  async function go(path: string, init: RequestInit & { jar?: Jar } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [k, v] of Object.entries(forwarded)) headers.set(k, v);
    if (init.jar) {
      const cookie = init.jar.header();
      if (cookie) headers.set("cookie", cookie);
      const method = (init.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD" && !headers.has("x-csrf-token") && init.jar.csrf()) {
        headers.set("x-csrf-token", init.jar.csrf());
      }
    }
    const url = path.startsWith("http") ? path : `${base}${path}`;
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    init.jar?.absorb(res);
    return res;
  }

  /** Email OTP then TOTP enrolment: a ready operator session in `jar`. Returns the user id. */
  async function signInReady(email: string): Promise<{ jar: Jar; userId: string; orgId: string }> {
    const jar = new Jar();
    await go("/api/auth/otp/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const otp = codeFromEmail(emails.at(-1)?.html ?? "");
    const verified = await go("/api/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, otp }),
      jar,
    });
    assert.equal(verified.status, 200);
    const start = await go("/api/auth/totp/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      jar,
    });
    const started = (await start.json()) as { otpauth_url: string };
    const secret = new URL(started.otpauth_url).searchParams.get("secret");
    assert.ok(secret);
    const totp = new OTPAuth.TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
    const confirm = await go("/api/auth/totp/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: totp.generate() }),
      jar,
    });
    assert.equal(confirm.status, 200);
    // First ready request provisions the org.
    const items = await go("/api/items", { jar });
    assert.equal(items.status, 200);
    const user = await store.getUserByEmail(email);
    assert.ok(user);
    const membership = await kernel.ensureVaultOrgForUser(user.id);
    return { jar, userId: user.id, orgId: membership.orgId };
  }

  async function registerClient(body: Record<string, unknown>): Promise<{ client_id: string }> {
    const res = await go("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
        response_types: ["code"],
        ...body,
      }),
    });
    const text = await res.text();
    assert.ok(res.status === 200 || res.status === 201, text);
    return JSON.parse(text) as { client_id: string };
  }

  /**
   * Browser leg of the authorization-code flow for an already signed-in operator:
   * authorize, consent page, consent POST, resume, redirect back with a code.
   */
  async function authorizeWithConsent(input: {
    jar: Jar;
    clientId: string;
    redirectUri: string;
    challenge: string;
    state?: string;
  }): Promise<{ code: string; consentHtml: string; location: URL }> {
    const params = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: "openid mcp",
      code_challenge: input.challenge,
      code_challenge_method: "S256",
      resource: AUDIENCE,
      state: input.state ?? "st",
    });
    const authorize = await go(`/oauth/authorize?${params}`, { jar: input.jar });
    assert.equal(authorize.status, 303, await authorize.text());
    const consentPath = authorize.headers.get("location") ?? "";
    assert.match(consentPath, /^\/consent\?uid=/);
    const uid = new URL(consentPath, base).searchParams.get("uid") ?? "";
    const consent = await go(consentPath, { jar: input.jar });
    const consentHtml = await consent.text();
    assert.equal(consent.status, 200, consentHtml);
    const decided = await go("/consent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": input.jar.csrf() },
      body: JSON.stringify({ uid, decision: "allow" }),
      jar: input.jar,
    });
    assert.equal(decided.status, 303, await decided.text());
    const resume = new URL(decided.headers.get("location") ?? "", base);
    const resumed = await go(resume.pathname, { jar: input.jar });
    assert.equal(resumed.status, 303, await resumed.text());
    const location = new URL(resumed.headers.get("location") ?? "");
    const code = location.searchParams.get("code") ?? "";
    assert.ok(code, resumed.headers.get("location") ?? "");
    return { code, consentHtml, location };
  }

  async function token(form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await go("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
  }

  async function mcp(bearer: string, method: string, params?: unknown): Promise<Response> {
    return go("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  }

  async function close(): Promise<void> {
    await http.close();
    await store.close();
    cleanup(home);
  }

  return {
    base,
    store,
    kernel,
    identity,
    oidcProvider,
    emails,
    deployPlane,
    go,
    signInReady,
    registerClient,
    authorizeWithConsent,
    token,
    mcp,
    close,
  };
}

/** Names listed by `list_items` in an MCP tool result. */
export function itemNames(rpc: unknown): string[] {
  const rec = rpc as { result?: { content?: { text?: string }[] } };
  const text = rec.result?.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as { items?: { name: string }[] };
  return (parsed.items ?? []).map((i) => i.name).sort();
}
