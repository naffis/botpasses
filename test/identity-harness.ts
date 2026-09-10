/** Shared harness for the identity test files: a hosted server with first-party auth and an injectable clock. */
import assert from "node:assert/strict";
import { join } from "node:path";
import * as OTPAuth from "otpauth";
import { generateMasterKey, parseMasterKey } from "../src/crypto.ts";
import { createHostedServer } from "../src/hosted/http.ts";
import { HostedKernel } from "../src/hosted/kernel.ts";
import { identityAuthResolver } from "../src/hosted/identity.ts";
import { OperatorIdentity } from "../src/hosted/operator-identity.ts";
import { createOauthProvider } from "../src/hosted/oauth-as.ts";
import { parseOidcPrivateJwk } from "../src/hosted/boot.ts";
import { openHostedSqlite } from "../src/store/sqlite-hosted.ts";
import type { VaultStore } from "../src/store/types.ts";
import { TEST_SESSION_SECRET, cleanup, tempHome, testOidcPrivateJwk } from "./helpers.ts";

export type Clock = { now: number };

export type Jar = { cookie: string; csrf: string; token: string };

export type IdentityCtx = {
  home: string;
  store: VaultStore;
  kernel: HostedKernel;
  identity: OperatorIdentity;
  emails: { to: string; html: string }[];
  base: string;
  clock: Clock;
  kek: Buffer;
  close(): Promise<void>;
  /** Close the HTTP server and reopen one on the same store, optionally under a different KEK. */
  reopen(kek?: Buffer): Promise<IdentityCtx>;
};

export function codeFromEmail(html: string): string {
  const m = />(\d{8})</.exec(html);
  assert.ok(m?.[1], "otp missing from email");
  return m[1];
}

export function cookieJar(res: Response): Jar {
  const parts = res.headers.getSetCookie();
  const cookie = parts.map((p) => p.split(";")[0]).join("; ");
  const csrfPart = parts.find((p) => p.startsWith("bp_csrf=") || p.startsWith("__Host-bp_csrf="));
  const csrf = csrfPart ? decodeURIComponent((csrfPart.split(";")[0] ?? "").split("=").slice(1).join("=")) : "";
  const sessPart = parts.find((p) => p.startsWith("bp_session=") || p.startsWith("__Host-bp_session="));
  const token = sessPart ? decodeURIComponent((sessPart.split(";")[0] ?? "").split("=").slice(1).join("=")) : "";
  return { cookie, csrf, token };
}

export function totpCode(secretBase32: string, atMs: number): string {
  return new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate({ timestamp: atMs });
}

/** A 6-digit code that is not valid for `secret` at `atMs` in the one-step window either side. */
export function wrongTotpCode(secretBase32: string, atMs: number): string {
  const valid = new Set([-1, 0, 1].map((d) => totpCode(secretBase32, atMs + d * 30_000)));
  for (let n = 0; n < 1_000_000; n += 1) {
    const candidate = String(n).padStart(6, "0");
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

/** Toggle to make the harness mailer fail, as Resend would on an outage. */
export type Mailer = { fail: boolean };

type ServerParts = {
  home: string;
  store: VaultStore;
  emails: { to: string; html: string }[];
  clock: Clock;
  kek: Buffer;
  /** `true` issues `__Host-` Secure cookies and honours them only on `x-forwarded-proto: https`. */
  secure: boolean;
  mailer: Mailer;
};

async function startServer(parts: ServerParts): Promise<IdentityCtx> {
  const now = (): Date => new Date(parts.clock.now);
  const sendEmail = async (to: string, _s: string, html: string): Promise<void> => {
    if (parts.mailer.fail) throw new Error("mailer down");
    parts.emails.push({ to, html });
  };
  const kernel = new HostedKernel({
    store: parts.store,
    kek: parts.kek,
    now,
    sendEmail,
    publicUrl: "http://127.0.0.1:8788",
  });
  const identity = new OperatorIdentity({
    store: parts.store,
    sessionSecret: TEST_SESSION_SECRET,
    kek: parts.kek,
    sendEmail,
    now,
  });
  const jwk = parseOidcPrivateJwk(testOidcPrivateJwk());
  assert.ok(jwk);
  const oidcProvider = createOauthProvider({
    issuer: "http://127.0.0.1:8788",
    kernel,
    sessionSecret: TEST_SESSION_SECRET,
    jwk,
    secureCookies: parts.secure,
    oidcDirectory: kernel.oidc,
  });
  const http = createHostedServer({
    kernel,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    identity,
    oidcProvider,
    secureCookies: parts.secure,
    authResolver: identityAuthResolver({
      identity,
      kernel,
      secureCookies: parts.secure,
      oidcJwk: jwk,
      issuer: "http://127.0.0.1:8788",
    }),
  });
  const addr = await http.listen();
  return {
    home: parts.home,
    store: parts.store,
    kernel,
    identity,
    emails: parts.emails,
    base: `http://${addr.host}:${addr.port}`,
    clock: parts.clock,
    kek: parts.kek,
    async close() {
      await http.close();
      await parts.store.close();
      cleanup(parts.home);
    },
    async reopen(kek?: Buffer) {
      await http.close();
      return startServer({ ...parts, kek: kek ?? parts.kek });
    },
  };
}

export async function identityServer(
  opts: { clock?: Clock; kek?: Buffer; secure?: boolean; mailer?: Mailer } = {},
): Promise<IdentityCtx> {
  const home = tempHome();
  return startServer({
    home,
    store: openHostedSqlite(join(home, "id.sqlite")),
    emails: [],
    clock: opts.clock ?? { now: Date.now() },
    kek: opts.kek ?? parseMasterKey(generateMasterKey()),
    secure: opts.secure ?? false,
    mailer: opts.mailer ?? { fail: false },
  });
}

export type ApiInit = {
  method?: string;
  jar?: Jar;
  csrf?: boolean;
  body?: unknown;
  headers?: Record<string, string>;
};

export async function api(ctx: IdentityCtx, path: string, init: ApiInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.jar) headers.cookie = init.jar.cookie;
  if (init.csrf && init.jar) headers["x-csrf-token"] = init.jar.csrf;
  return fetch(`${ctx.base}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
  });
}

export async function readJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Status assertion that reads the body only on mismatch, so callers can still consume it. */
export async function expectStatus(res: Response, status: number, label = ""): Promise<void> {
  if (res.status === status) return;
  const text = await res.text().catch(() => "");
  assert.fail(`${label ? `${label}: ` : ""}expected ${status}, got ${res.status}: ${text}`);
}

/** Email step only: returns the pre-MFA session and the routing flags the client script reads. */
export async function otpSignIn(
  ctx: IdentityCtx,
  email: string,
): Promise<{ jar: Jar; body: { ok: boolean; enroll: boolean; verify: boolean } }> {
  const sent = await api(ctx, "/api/auth/otp/send", { body: { email } });
  assert.equal(sent.status, 200);
  const mail = ctx.emails.filter((e) => e.to === email).at(-1);
  assert.ok(mail, `no email for ${email}`);
  const otp = codeFromEmail(mail.html);
  const verified = await api(ctx, "/api/auth/otp/verify", { body: { email, otp } });
  await expectStatus(verified, 200, "otp/verify");
  const body = await readJson<{ ok: boolean; enroll: boolean; verify: boolean }>(verified);
  return { jar: cookieJar(verified), body };
}

/** Start and confirm authenticator enrollment for the session in `jar`. */
export async function enrollTotp(
  ctx: IdentityCtx,
  jar: Jar,
  currentCode?: string,
): Promise<{ secret: string; backupCodes: string[]; jar: Jar }> {
  const start = await api(ctx, "/api/auth/totp/start", {
    jar,
    csrf: true,
    body: currentCode ? { current_code: currentCode } : {},
  });
  await expectStatus(start, 200, "totp/start");
  const started = await readJson<{ otpauth_url: string }>(start);
  const secret = new URL(started.otpauth_url).searchParams.get("secret");
  assert.ok(secret);
  const confirm = await api(ctx, "/api/auth/totp/confirm", {
    jar,
    csrf: true,
    body: { code: totpCode(secret, ctx.clock.now) },
  });
  await expectStatus(confirm, 200, "totp/confirm");
  const confirmed = await readJson<{ backup_codes: string[] }>(confirm);
  return { secret, backupCodes: confirmed.backup_codes, jar: cookieJar(confirm) };
}

/** Full sign-up: email step, enrollment, and the resulting MFA-passed session. */
export async function signUpAndEnroll(
  ctx: IdentityCtx,
  email: string,
): Promise<{ secret: string; backupCodes: string[]; jar: Jar; pendingJar: Jar }> {
  const { jar: pendingJar, body } = await otpSignIn(ctx, email);
  assert.equal(body.enroll, true);
  const enrolled = await enrollTotp(ctx, pendingJar);
  return { ...enrolled, pendingJar };
}

export async function logout(ctx: IdentityCtx, jar: Jar): Promise<void> {
  const res = await api(ctx, "/api/auth/logout", { jar, csrf: true, body: {} });
  assert.equal(res.status, 200);
}
