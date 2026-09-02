import { request as httpsRequest } from "node:https";
import { HttpError } from "./errors.ts";
import {
  ALLOWED_METHODS,
  assertAllowedHostname,
  assertSafePath,
  isBlockedIp,
  resolvePublicAddresses,
} from "./ssrf.ts";
import { redactOauthJson } from "../redact.ts";

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

export function redactConnectorBody(body: string, item: ConnectorItem): string {
  let out = redactOauthJson(body);
  if (item.secret.length > 0) out = out.split(item.secret).join("[redacted]");
  if (item.last4.length >= 4 && item.secret.length >= 8) {
    out = out.split(item.last4).join("••••");
  }
  return out;
}

export async function executeConnector(
  item: ConnectorItem,
  req: ConnectorRequest,
  opts: {
    fetchImpl?: ConnectorFetch;
    resolveAddresses?: (hostname: string) => Promise<string[]>;
    /** Internal mint only. Caller must redact before any MCP/API result. */
    redact?: boolean;
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
        });
    const buf = Buffer.from(await res.arrayBuffer());
    const sliced = buf.subarray(0, RESPONSE_CAP).toString("utf8");
    const body = opts.redact === false ? sliced : redactConnectorBody(sliced, item);
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "Origin request failed");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPinned(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    addresses: string[];
  },
): Promise<Response> {
  const parsed = new URL(url);
  const ip = init.addresses[0];
  if (!ip) throw new HttpError(400, "Host resolves to a private or blocked address");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: ip,
        port: 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method,
        servername: parsed.hostname,
        headers: { ...init.headers, host: parsed.hostname },
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
      reject(new HttpError(502, "Origin request failed"));
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
