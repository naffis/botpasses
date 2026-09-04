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

const RESPONSE_CAP = 256 * 1024;
const ORIGIN_TIMEOUT_MS = 10_000;
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
};

/** Test-only overrides for the pinned TLS path: trust a local CA and dial a non-443 port. */
export type PinnedTlsOpts = {
  ca?: string | Buffer;
  port?: number;
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

function injectHeaders(item: ConnectorItem, host: string): Record<string, string> {
  const accounts = host === "accounts.spotify.com";
  const useBasic =
    item.kind === "login" ||
    item.inject === "basic" ||
    item.inject === "client_credentials" ||
    (accounts && item.inject !== "header:Authorization");
  if (useBasic) {
    const user = item.username ?? "";
    const token = Buffer.from(`${user}:${item.secret}`).toString("base64");
    return { authorization: `Basic ${token}` };
  }
  if (item.inject.startsWith("header:")) {
    const name = item.inject.slice("header:".length);
    if (!name) throw new HttpError(400, "Invalid inject header");
    return { [name.toLowerCase()]: item.secret };
  }
  return { authorization: `Bearer ${item.secret}` };
}

/**
 * Strip OAuth token fields, then every encoding of the item secret (and any extra values such as
 * a minted access token). No body-wide last-4 masking: it rewrote dates and ids.
 */
export function redactConnectorBody(body: string, item: ConnectorItem, extra: readonly string[] = []): string {
  const forms = secretEncodings(item.secret, item.username);
  for (const value of extra) forms.push(...secretEncodings(value));
  return redactSecrets(redactOauthJson(body), forms);
}

/** Human-readable transport failure without the request (which carries the credential). */
export function describeOriginFailure(err: unknown, host: string, aborted: boolean): string {
  if (aborted) return `Origin request failed: ${host} did not respond within ${ORIGIN_TIMEOUT_MS / 1000}s`;
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
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

export async function executeConnector(
  item: ConnectorItem,
  req: ConnectorRequest,
  opts: {
    fetchImpl?: ConnectorFetch;
    resolveAddresses?: (hostname: string) => Promise<string[]>;
    /** Internal mint only. Caller must redact before any MCP/API result. */
    redact?: boolean;
    tls?: PinnedTlsOpts;
  } = {},
): Promise<ConnectorResult> {
  const method = req.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new HttpError(400, "Unsupported method");
  }
  assertSafePath(req.path);
  const host = selectConnectorHost(item, req.host);
  assertAllowedHostname(host, item.allowedHosts);
  const resolve = opts.resolveAddresses ?? resolvePublicAddresses;
  const addrs = await resolve(host);
  if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a))) {
    throw new HttpError(400, "Host resolves to a private or blocked address");
  }

  const url = `https://${host}${req.path}`;
  const contentType =
    req.contentType ??
    (req.body !== undefined ? "application/json" : undefined);
  const encoded = req.body === undefined ? undefined : encodeBody(req.body, contentType ?? "application/json");
  const headers: Record<string, string> = {
    ...injectHeaders(item, host),
    accept: "application/json, text/plain, */*",
  };
  if (encoded !== undefined && contentType) {
    headers["content-type"] = contentType;
  }
  for (const hop of HOP_BY_HOP) {
    delete headers[hop];
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ORIGIN_TIMEOUT_MS);
  const fetchImpl = opts.fetchImpl;
  try {
    const res = fetchImpl
      ? await fetchImpl(url, {
          method,
          headers,
          body: encoded,
          redirect: "manual",
          signal: ac.signal,
        })
      : await fetchPinned(url, {
          method,
          headers,
          body: encoded,
          signal: ac.signal,
          addresses: addrs,
          ...opts.tls,
        });
    const full = Buffer.from(await res.arrayBuffer()).toString("utf8");
    const redacted = opts.redact === false ? full : redactConnectorBody(full, item);
    const body = redacted.length > RESPONSE_CAP ? redacted.slice(0, RESPONSE_CAP) : redacted;
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, describeOriginFailure(err, host, ac.signal.aborted));
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
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 502,
              headers: { "content-type": res.headers["content-type"] ?? "text/plain" },
            }),
          );
        });
      },
    );
    const onAbort = () => {
      req.destroy();
      reject(new HttpError(502, describeOriginFailure(undefined, parsed.hostname, true)));
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
