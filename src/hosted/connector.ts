import { request as httpsRequest } from "node:https";
import { HttpError } from "./errors.ts";
import {
  ALLOWED_METHODS,
  assertAllowedHostname,
  assertSafePath,
  isBlockedIp,
  resolvePublicAddresses,
} from "./ssrf.ts";
import { redactOauthJson, redactSecrets, secretEncodings } from "../redact.ts";
import { applyInject } from "./providers/inject.ts";
import { isTokenPath, providerForHost } from "./providers/registry.ts";

const RESPONSE_CAP = 256 * 1024;
export const ORIGIN_TIMEOUT_MS = 10_000;
export const ORIGIN_TIMEOUT_MIN_MS = 1_000;
export const ORIGIN_TIMEOUT_MAX_MS = 30_000;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/** Response headers a model may see. Pagination, rate limits, tracing; nothing that echoes auth. */
export const ORIGIN_HEADER_ALLOWLIST: readonly string[] = [
  "content-type",
  "link",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-request-id",
];

export type ConnectorFetch = typeof fetch;

export type ConnectorItem = {
  secret: string;
  username: string | null;
  last4: string;
  inject: string;
  allowedHosts: string[];
  name: string;
  kind: "secret" | "login" | "client_secret";
  grantId?: string;
  grantPolicy?: string;
  itemId?: string;
};

export type ConnectorRequest = {
  method: string;
  path: string;
  body?: unknown;
  host?: string;
  contentType?: string;
};

export type ConnectorResult = {
  status: number;
  body: string;
  /** Allowlisted origin response headers (`ORIGIN_HEADER_ALLOWLIST`), lowercase names. */
  headers: Record<string, string>;
};

/** Test-only overrides for the pinned TLS path: trust a local CA and dial a non-443 port. */
export type PinnedTlsOpts = {
  ca?: string | Buffer;
  port?: number;
};

export type ConnectorOpts = {
  fetchImpl?: ConnectorFetch;
  resolveAddresses?: (hostname: string) => Promise<string[]>;
  /** Internal mint only. Caller must redact before any MCP/API result. */
  redact?: boolean;
  tls?: PinnedTlsOpts;
  /** Origin deadline, clamped to [ORIGIN_TIMEOUT_MIN_MS, ORIGIN_TIMEOUT_MAX_MS]. */
  timeoutMs?: number;
  /** Clock for signed modes (hmac, sigv4). Tests pin it. */
  now?: () => Date;
};

export function selectConnectorHost(item: ConnectorItem, requested?: string): string {
  if (requested) {
    const host = requested.toLowerCase();
    if (!item.allowedHosts.includes(host)) {
      throw new HttpError(400, `host_mismatch: ${host} is not in allowed_hosts`, {
        status: "host_mismatch",
        host,
        allowed_hosts: item.allowedHosts,
      });
    }
    return host;
  }
  const host = item.allowedHosts[0];
  if (!host) throw new HttpError(400, "Item has no allowed_hosts");
  return host;
}

/** Clamp a requested origin deadline into the supported window; non-numbers are a 400. */
export function clampTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null) return ORIGIN_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new HttpError(400, `timeout_ms must be a number between ${ORIGIN_TIMEOUT_MIN_MS} and ${ORIGIN_TIMEOUT_MAX_MS}`);
  }
  return Math.min(ORIGIN_TIMEOUT_MAX_MS, Math.max(ORIGIN_TIMEOUT_MIN_MS, Math.round(raw)));
}

function encodeBody(body: unknown, contentType: string): string {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    if (typeof body === "string") return body;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
        if (value === undefined || value === null) continue;
        params.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      return params.toString();
    }
    throw new HttpError(400, "form-urlencoded body must be an object or string");
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

/**
 * Strip OAuth token fields (standard keys plus the host's provider keys), then every encoding of
 * the item secret and any extra values such as a minted access token. No body-wide last-4
 * masking: it rewrote dates and ids.
 */
export function redactConnectorBody(
  body: string,
  item: ConnectorItem,
  extra: readonly string[] = [],
  host?: string,
): string {
  const forms = secretEncodings(item.secret, item.username);
  for (const value of extra) forms.push(...secretEncodings(value));
  const providerKeys = host ? providerForHost(host)?.redactKeys ?? [] : [];
  return redactSecrets(redactOauthJson(body, providerKeys), forms);
}

/** Only the allowlisted names, lowercased, in allowlist order. */
export function pickOriginHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ORIGIN_HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null && value !== "") out[name] = value;
  }
  return out;
}

/**
 * Header values can echo the request (a `Link: <…?api_key=…>` after a `query:` inject, a
 * request id derived from the token). Redact every encoding of the secret, like the body.
 */
export function redactOriginHeaders(
  headers: Record<string, string>,
  item: Pick<ConnectorItem, "secret" | "username">,
  extraSecrets: string[] = [],
): Record<string, string> {
  const forms = [
    ...secretEncodings(item.secret, item.username),
    ...extraSecrets.flatMap((s) => secretEncodings(s, null)),
  ];
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = redactSecrets(value, forms);
  return out;
}

/** Human-readable transport failure without the request (which carries the credential). */
export function describeOriginFailure(err: unknown, host: string, aborted: boolean, timeoutMs = ORIGIN_TIMEOUT_MS): string {
  if (aborted) return `Origin request failed: ${host} did not respond within ${Math.round(timeoutMs / 1000)}s`;
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA") {
    return `Origin request failed: DNS lookup for ${host} failed (${code})`;
  }
  if (code.startsWith("ERR_TLS") || code === "CERT_HAS_EXPIRED" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "ERR_OSSL_EVP_UNSUPPORTED" ||
      code === "ERR_SSL_WRONG_VERSION_NUMBER" || code.startsWith("ERR_SSL")) {
    return `Origin request failed: TLS handshake with ${host} failed (${code})`;
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ETIMEDOUT" || code === "EPIPE") {
    return `Origin request failed: could not connect to ${host} (${code})`;
  }
  return code ? `Origin request failed: ${host} (${code})` : `Origin request failed: ${host}`;
}

/** Is this request the token endpoint of a known provider? Decides client-credential placement. */
function tokenEndpointFor(host: string, path: string): { auth: "basic" | "post_body" } | undefined {
  const provider = providerForHost(host);
  if (!provider || !isTokenPath(provider, host, path)) return undefined;
  return { auth: provider.tokenAuth };
}

export async function executeConnector(
  item: ConnectorItem,
  req: ConnectorRequest,
  opts: ConnectorOpts = {},
): Promise<ConnectorResult> {
  const method = req.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new HttpError(400, "Unsupported method");
  }
  assertSafePath(req.path);
  const host = selectConnectorHost(item, req.host);
  assertAllowedHostname(host, item.allowedHosts);
  const timeoutMs = clampTimeoutMs(opts.timeoutMs);
  const resolve = opts.resolveAddresses ?? resolvePublicAddresses;
  const addrs = await resolve(host);
  if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a))) {
    throw new HttpError(400, "Host resolves to a private or blocked address");
  }

  const tokenEndpoint = tokenEndpointFor(host, req.path);
  const contentType =
    req.contentType ??
    (tokenEndpoint ? "application/x-www-form-urlencoded" : req.body !== undefined ? "application/json" : undefined);
  const encoded = req.body === undefined ? undefined : encodeBody(req.body, contentType ?? "application/json");
  const injected = applyInject(item, {
    host,
    method,
    path: req.path,
    body: encoded,
    contentType,
    tokenEndpoint,
    now: opts.now?.() ?? new Date(),
  });
  const headers: Record<string, string> = {
    ...injected.headers,
    accept: "application/json, text/plain, */*",
  };
  const sendType = contentType ?? (injected.body !== undefined ? "application/x-www-form-urlencoded" : undefined);
  if (injected.body !== undefined && sendType) {
    headers["content-type"] = sendType;
  }
  for (const hop of HOP_BY_HOP) {
    delete headers[hop];
  }
  const url = `https://${host}${injected.path}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const fetchImpl = opts.fetchImpl;
  try {
    const res = fetchImpl
      ? await fetchImpl(url, {
          method,
          headers,
          body: injected.body,
          redirect: "manual",
          signal: ac.signal,
        })
      : await fetchPinned(url, {
          method,
          headers,
          body: injected.body,
          signal: ac.signal,
          addresses: addrs,
          timeoutMs,
          ...opts.tls,
        });
    const full = Buffer.from(await res.arrayBuffer()).toString("utf8");
    const redacted = opts.redact === false ? full : redactConnectorBody(full, item, [], host);
    const body = redacted.length > RESPONSE_CAP ? redacted.slice(0, RESPONSE_CAP) : redacted;
    const originHeaders = pickOriginHeaders(res.headers);
    return {
      status: res.status,
      body,
      // Headers are never the payload a caller needs verbatim: redact them for the item even
      // when the caller hand-redacts the body (token endpoints add the minted tokens too).
      headers: redactOriginHeaders(originHeaders, item),
    };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, describeOriginFailure(err, host, ac.signal.aborted, timeoutMs));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dial the resolved (public) IP directly so DNS cannot rebind between resolve and connect, while
 * presenting the hostname for SNI, certificate verification, and the Host header. Redirects are
 * returned as-is, never followed.
 */
export async function fetchPinned(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    addresses: string[];
    timeoutMs?: number;
  } & PinnedTlsOpts,
): Promise<Response> {
  const parsed = new URL(url);
  const ip = init.addresses[0];
  if (!ip) throw new HttpError(400, "Host resolves to a private or blocked address");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: ip,
        port: init.port ?? 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method,
        servername: parsed.hostname,
        headers: { ...init.headers, host: parsed.hostname },
        ...(init.ca ? { ca: init.ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(name, value);
            else if (Array.isArray(value)) headers.set(name, value.join(", "));
          }
          if (!headers.has("content-type")) headers.set("content-type", "text/plain");
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers }));
        });
      },
    );
    const onAbort = () => {
      req.destroy();
      reject(new HttpError(502, describeOriginFailure(undefined, parsed.hostname, true, init.timeoutMs)));
    };
    init.signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", (err) => {
      init.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    req.on("close", () => {
      init.signal.removeEventListener("abort", onAbort);
    });
    if (init.body) req.write(init.body);
    req.end();
  });
}
