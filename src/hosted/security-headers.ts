import { randomBytes } from "node:crypto";
import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { DeployPlane } from "../brand.ts";

export type SecurityHeaderOpts = {
  nonce?: string;
  extraScriptSrc?: string[];
  extraConnectSrc?: string[];
  extraImgSrc?: string[];
  extraFontSrc?: string[];
  extraWorkerSrc?: string[];
  html: boolean;
  cache?: boolean;
};

export const MARKETING_CSP_EXTRAS: Pick<
  SecurityHeaderOpts,
  "extraScriptSrc" | "extraImgSrc" | "extraFontSrc" | "extraWorkerSrc"
> = {
  extraScriptSrc: ["'wasm-unsafe-eval'"],
  extraImgSrc: ["'self'"],
  extraFontSrc: ["'self'"],
  extraWorkerSrc: ["'self'", "blob:"],
};

export function newCspNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function httpsHostList(hostOrUrl: string | undefined): string[] {
  const host = hostOrUrl?.trim() ?? "";
  if (!host) return [];
  return [`https://${host.replace(/^https?:\/\//, "")}`];
}

export function securityHeaders(opts: SecurityHeaderOpts): Record<string, string> {
  const headers: Record<string, string> = {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "strict-transport-security": "max-age=63072000",
  };
  if (opts.cache !== false) headers["cache-control"] = "no-store";
  if (opts.html) {
    const script = ["'nonce-" + (opts.nonce ?? "") + "'", "'self'", ...(opts.extraScriptSrc ?? [])];
    const connect = ["'self'", ...(opts.extraConnectSrc ?? [])];
    const img = opts.extraImgSrc?.length ? opts.extraImgSrc.join(" ") : "'none'";
    const csp = [
      "default-src 'none'",
      `script-src ${script.join(" ")}`,
      "style-src 'unsafe-inline' 'self'",
      `img-src ${img}`,
      `connect-src ${connect.join(" ")}`,
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ];
    if (opts.extraFontSrc?.length) csp.push(`font-src ${opts.extraFontSrc.join(" ")}`);
    if (opts.extraWorkerSrc?.length) csp.push(`worker-src ${opts.extraWorkerSrc.join(" ")}`);
    headers["content-security-policy"] = csp.join("; ");
  }
  return headers;
}

export function hostedPageHeaders(
  plane: DeployPlane,
  opts: SecurityHeaderOpts,
): Record<string, string> {
  const headers = securityHeaders(opts);
  if (plane !== "production") headers["x-robots-tag"] = "noindex, nofollow";
  return headers;
}

function headerBag(incoming?: OutgoingHttpHeaders | OutgoingHttpHeaders[]): OutgoingHttpHeaders {
  if (!incoming) return {};
  if (Array.isArray(incoming)) return Object.assign({}, ...incoming);
  return { ...incoming };
}

export function bindSecurityHeaders(res: ServerResponse): void {
  const original = res.writeHead.bind(res);
  res.writeHead = ((
    statusCode: number,
    reasonOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeaders[],
    maybeHeaders?: OutgoingHttpHeaders | OutgoingHttpHeaders[],
  ) => {
    const hasReason = typeof reasonOrHeaders === "string";
    const raw = headerBag(hasReason ? maybeHeaders : reasonOrHeaders);
    const ctype = String(raw["content-type"] ?? raw["Content-Type"] ?? res.getHeader("content-type") ?? "");
    const html = ctype.includes("text/html");
    // First-party HTML loads /assets/console.css fonts and /favicon.svg. OAuth device HTML uses the same chrome without operatorAppHeaders.
    const sec = securityHeaders({
      html,
      nonce: html ? newCspNonce() : undefined,
      extraFontSrc: html ? ["'self'"] : undefined,
      extraImgSrc: html ? ["'self'"] : undefined,
    });
    for (const [k, v] of Object.entries(sec)) {
      if (raw[k] === undefined && raw[k.toLowerCase()] === undefined && res.getHeader(k) === undefined) {
        raw[k] = v;
      }
    }
    return hasReason ? original(statusCode, reasonOrHeaders, raw) : original(statusCode, raw);
  }) as ServerResponse["writeHead"];
}
