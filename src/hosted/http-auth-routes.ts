import type { IncomingMessage, ServerResponse } from "node:http";
import * as OTPAuth from "otpauth";
import { authEntryHtml, enrollTotpHtml, verifyTotpHtml } from "./auth-pages.ts";
import type { OperatorIdentity } from "./operator-identity.ts";
import { totpEnabled } from "./operator-identity.ts";
import { otpauthUrl, pendingEnvelope } from "./identity-totp.ts";
import { otpauthQrSvg } from "./totp-qr.ts";
import { requestClientIp } from "./identity-limiter.ts";
import { logAuthEvent } from "./observe.ts";
import { needsTotpVerify } from "./identity.ts";
import { HttpError } from "./errors.ts";
import type Provider from "oidc-provider";
import { endOidcSession } from "./oauth-as.ts";
import { requireOperator, type OperatorPrincipal, type Principal } from "./auth.ts";

export type AuthRouteOpts = {
  identity: OperatorIdentity;
  secure: boolean;
  htmlHeaders: Record<string, string>;
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  setCookies: (res: ServerResponse, cookies: string[], status: number, body: unknown) => void;
  /**
   * Superseded by `requestClientIp(req)`, which also reads `Fly-Client-IP`. Still accepted so
   * `http.ts` keeps compiling; drop it there and here together.
   */
  clientIp?: (req: IncomingMessage) => string;
  /** When set, logout also ends the OAuth server's own session (S12). */
  oidcProvider?: Provider;
};

export function sendHtml(res: ServerResponse, html: string, extra: Record<string, string>, noStore = true): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": noStore ? "no-store" : "no-cache",
    ...extra,
  });
  res.end(html);
}

function redirect(res: ServerResponse, location: string): true {
  res.writeHead(302, { location });
  res.end();
  return true;
}

/** Where a signed-in-but-not-ready operator has to go next. */
function pendingStep(op: OperatorPrincipal): "/verify-totp" | "/enroll-totp" {
  return needsTotpVerify(op) ? "/verify-totp" : "/enroll-totp";
}

/** True while the user has a live (unexpired) in-flight enrollment secret. */
export async function hasPendingTotp(identity: OperatorIdentity, userId: string): Promise<boolean> {
  const user = await identity.store.getUser(userId);
  return Boolean(user && pendingEnvelope(user, identity.now().getTime()));
}

/**
 * The live in-flight enrollment as `totp/start` first returned it, so a reload of `/enroll-totp`
 * or the re-enroll page (which cannot call `start` again without a current code) shows the same
 * QR that the pending secret will be confirmed against. Undefined when none is in flight.
 */
export async function pendingTotpEnrollment(
  identity: OperatorIdentity,
  userId: string,
): Promise<{ otpauth_url: string; qr_svg: string } | undefined> {
  const user = await identity.store.getUser(userId);
  if (!user) return undefined;
  const envelope = pendingEnvelope(user, identity.now().getTime());
  if (!envelope) return undefined;
  const { secret } = await identity.keys.unwrap(user.id, "totp_pending", envelope);
  const otpauth_url = otpauthUrl(OTPAuth.Secret.fromBase32(secret), user.email);
  return { otpauth_url, qr_svg: otpauthQrSvg(otpauth_url) };
}

/**
 * First-party auth pages. `/consent` and `/device` are not here: the OAuth provider owns them
 * (`handleConsentGet`, `handleOauth`) and without a provider they are simply not mounted.
 */
export async function tryAuthPage(
  method: string,
  path: string,
  res: ServerResponse,
  extra: Record<string, string>,
  principal?: Principal,
  pendingTotp?: (userId: string) => Promise<boolean>,
): Promise<boolean> {
  if (method !== "GET" && method !== "HEAD") return false;
  const op = principal?.channel === "operator" ? principal : undefined;
  if (path === "/sign-in" || path === "/sign-up") {
    if (op?.ready) return redirect(res, "/console");
    if (op && op.ready === false) return redirect(res, pendingStep(op));
    sendHtml(res, authEntryHtml(path === "/sign-up" ? "sign-up" : "sign-in"), extra);
    return true;
  }
  if (path === "/enroll-totp") {
    if (!op) return redirect(res, "/sign-in");
    // A ready operator lands here only while re-enrolling (a pending secret started with a
    // current code); otherwise the page has nothing to show and the console is the place to be.
    if (op.ready && !(pendingTotp && (await pendingTotp(op.userId)))) return redirect(res, "/console");
    if (needsTotpVerify(op)) return redirect(res, "/verify-totp");
    sendHtml(res, enrollTotpHtml(), extra);
    return true;
  }
  if (path === "/verify-totp") {
    if (op?.ready) return redirect(res, "/console");
    if (!op) return redirect(res, "/sign-in");
    if (!needsTotpVerify(op)) return redirect(res, "/enroll-totp");
    sendHtml(res, verifyTotpHtml(), extra);
    return true;
  }
  return false;
}

function headerString(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return typeof raw === "string" ? raw : undefined;
}

/** A cookie-backed operator session (bootstrap-token operators have no session hash). */
function requireSession(principal: Principal | undefined): OperatorPrincipal & { sessionHash: string } {
  if (!principal || principal.channel !== "operator") throw new HttpError(401, "Authentication required");
  const hash = principal.sessionHash;
  if (!hash) throw new HttpError(401, "Session required");
  return { ...principal, sessionHash: hash };
}

export async function handleAuthApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  principal: Principal | undefined,
  opts: AuthRouteOpts,
): Promise<boolean> {
  const cookies = { secure: opts.secure };
  // `/api/auth/*` is exempt from the global CSRF check in http.ts, so the routes that act on a
  // session verify the double-submit token here.
  const assertCsrf = (): void =>
    opts.identity.assertCsrf(req.headers.cookie, headerString(req, "x-csrf-token"), opts.secure);
  if (method === "POST" && path === "/api/auth/otp/send") {
    const body = await opts.readJson(req);
    const result = await opts.identity.sendOtp(String(body.email ?? ""), requestClientIp(req));
    opts.json(res, 200, result);
    return true;
  }
  if (method === "POST" && path === "/api/auth/otp/verify") {
    const body = await opts.readJson(req);
    const result = await opts.identity.verifyOtp(
      String(body.email ?? ""),
      String(body.otp ?? ""),
      cookies,
      requestClientIp(req),
    );
    const enrolled = totpEnabled(result.user);
    opts.setCookies(res, result.cookies, 200, { ok: true, enroll: !enrolled, verify: enrolled });
    return true;
  }
  if (method === "POST" && path === "/api/auth/totp/start") {
    const op = requireSession(principal);
    assertCsrf();
    const body = await opts.readJson(req);
    const currentCode = typeof body.current_code === "string" ? body.current_code : undefined;
    const result = await opts.identity.startTotp(op.userId, { currentCode, sessionReady: op.ready !== false });
    opts.json(res, 200, result);
    return true;
  }
  if (method === "GET" && path === "/api/auth/totp/pending") {
    const op = requireSession(principal);
    // Same gate as a re-enroll `start`: an enrolled account only from a session that passed the step.
    if (op.ready === false && needsTotpVerify(op)) throw new HttpError(403, "mfa_required", { verify_url: "/verify-totp" });
    const pending = await pendingTotpEnrollment(opts.identity, op.userId);
    if (!pending) throw new HttpError(404, "no_pending_enrollment");
    opts.json(res, 200, pending);
    return true;
  }
  if (method === "POST" && path === "/api/auth/totp/confirm") {
    const op = requireSession(principal);
    assertCsrf();
    const body = await opts.readJson(req);
    const result = await opts.identity.confirmTotp(op.userId, op.sessionHash, String(body.code ?? ""), cookies);
    opts.setCookies(res, result.cookies, 200, { ok: true, backup_codes: result.backup_codes });
    return true;
  }
  if (method === "POST" && path === "/api/auth/totp/verify") {
    const op = requireSession(principal);
    assertCsrf();
    const body = await opts.readJson(req);
    const result = await opts.identity.verifyTotp(op.userId, op.sessionHash, String(body.code ?? ""), cookies);
    opts.setCookies(res, result.cookies, 200, { ok: true });
    return true;
  }
  if (method === "GET" && path === "/api/auth/me") {
    const op = requireOperator(principal);
    opts.json(res, 200, await opts.identity.accountSummary(op.userId));
    return true;
  }
  if (method === "POST" && path === "/api/auth/backup-codes/regenerate") {
    const op = requireOperator(principal);
    if (op.sessionHash) assertCsrf();
    const body = await opts.readJson(req);
    const result = await opts.identity.regenerateBackupCodes(op.userId, String(body.code ?? ""));
    opts.json(res, 200, result);
    return true;
  }
  if (method === "POST" && path === "/api/auth/logout") {
    const hash = principal?.channel === "operator" ? principal.sessionHash : undefined;
    if (hash) {
      assertCsrf();
      await opts.identity.store.deleteSession(hash);
      logAuthEvent("signed_out", { user_id: principal?.channel === "operator" ? principal.userId : undefined });
    }
    const opCookies = opts.oidcProvider ? await endOidcSession(opts.oidcProvider, req, res) : [];
    opts.setCookies(res, [...opts.identity.logoutCookies(opts.secure), ...opCookies], 200, { ok: true });
    return true;
  }
  return false;
}
