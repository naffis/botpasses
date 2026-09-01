import type { IncomingMessage, ServerResponse } from "node:http";
import { consentHtml, deviceHtml, enrollTotpHtml, signInHtml, signUpHtml } from "./auth-pages.ts";
import type { OperatorIdentity } from "./operator-identity.ts";
import { totpEnabled } from "./operator-identity.ts";
import { HttpError } from "./errors.ts";
import type { Principal } from "./auth.ts";

export type AuthRouteOpts = {
  identity: OperatorIdentity;
  secure: boolean;
  htmlHeaders: Record<string, string>;
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  setCookies: (res: ServerResponse, cookies: string[], status: number, body: unknown) => void;
  clientIp: (req: IncomingMessage) => string;
};

export function sendHtml(res: ServerResponse, html: string, extra: Record<string, string>, noStore = true): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": noStore ? "no-store" : "no-cache",
    ...extra,
  });
  res.end(html);
}

export function tryAuthPage(
  method: string,
  path: string,
  res: ServerResponse,
  extra: Record<string, string>,
  principal?: Principal,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const op = principal?.channel === "operator" ? principal : undefined;
  if (path === "/sign-in" || path === "/sign-up") {
    if (op?.ready) {
      res.writeHead(302, { location: "/console" });
      res.end();
      return true;
    }
    if (op && op.ready === false) {
      res.writeHead(302, { location: "/enroll-totp" });
      res.end();
      return true;
    }
    sendHtml(res, path === "/sign-up" ? signUpHtml() : signInHtml(), extra);
    return true;
  }
  if (path === "/enroll-totp") {
    if (op?.ready) {
      res.writeHead(302, { location: "/console" });
      res.end();
      return true;
    }
    if (!op) {
      res.writeHead(302, { location: "/sign-in" });
      res.end();
      return true;
    }
    sendHtml(res, enrollTotpHtml(), extra);
    return true;
  }
  if (path === "/consent") {
    sendHtml(res, consentHtml("MCP client", ""), extra);
    return true;
  }
  if (path === "/device") {
    sendHtml(res, deviceHtml(), extra);
    return true;
  }
  return false;
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
  if (method === "POST" && path === "/api/auth/otp/send") {
    const body = await opts.readJson(req);
    const result = await opts.identity.sendOtp(String(body.email ?? ""), opts.clientIp(req));
    opts.json(res, 200, result);
    return true;
  }
  if (method === "POST" && path === "/api/auth/otp/verify") {
    const body = await opts.readJson(req);
    const result = await opts.identity.verifyOtp(String(body.email ?? ""), String(body.otp ?? ""), cookies);
    opts.setCookies(res, result.cookies, 200, {
      ok: true,
      enroll: !totpEnabled(result.user),
    });
    return true;
  }
  if (method === "POST" && path === "/api/auth/totp/start") {
    if (!principal || principal.channel !== "operator") throw new HttpError(401, "Authentication required");
    const result = await opts.identity.startTotp(principal.userId);
    opts.json(res, 200, result);
    return true;
  }
  if (method === "POST" && path === "/api/auth/totp/confirm") {
    if (!principal || principal.channel !== "operator") throw new HttpError(401, "Authentication required");
    const body = await opts.readJson(req);
    const result = await opts.identity.confirmTotp(principal.userId, String(body.code ?? ""), cookies);
    opts.setCookies(res, result.cookies, 200, {
      ok: true,
      backup_codes: result.backup_codes,
    });
    return true;
  }
  if (method === "POST" && path === "/api/auth/logout") {
    const hash = principal?.channel === "operator" ? principal.sessionHash : undefined;
    if (hash) await opts.identity.store.deleteSession(hash);
    opts.setCookies(res, opts.identity.logoutCookies(opts.secure), 200, { ok: true });
    return true;
  }
  return false;
}
