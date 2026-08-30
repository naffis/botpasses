import { request as httpsRequest } from "node:https";
import { HttpError } from "./errors.ts";
import {
  ALLOWED_METHODS,
  assertAllowedHostname,
  assertSafePath,
  isBlockedIp,
  resolvePublicAddresses,
} from "./ssrf.ts";

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
  kind: "secret" | "login";
};

export type ConnectorRequest = {
  method: string;
  path: string;
  body?: unknown;
};

export type ConnectorResult = {
  status: number;
  body: string;
};

function injectHeaders(item: ConnectorItem): Record<string, string> {
  if (item.kind === "login" || item.inject === "basic") {
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
  let out = body;
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
  } = {},
): Promise<ConnectorResult> {
  const method = req.method.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new HttpError(400, "Unsupported method");
  }
  assertSafePath(req.path);
  const host = item.allowedHosts[0];
  if (!host) throw new HttpError(400, "Item has no allowed_hosts");
  assertAllowedHostname(host, item.allowedHosts);
  const resolve = opts.resolveAddresses ?? resolvePublicAddresses;
  const addrs = await resolve(host);
  if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a))) {
    throw new HttpError(400, "Host resolves to a private or blocked address");
  }

  const url = `https://${host}${req.path}`;
  const headers: Record<string, string> = {
    ...injectHeaders(item),
    accept: "application/json, text/plain, */*",
  };
  if (req.body !== undefined) {
    headers["content-type"] = "application/json";
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
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          redirect: "manual",
          signal: ac.signal,
        })
      : await fetchPinned(url, {
          method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: ac.signal,
          addresses: addrs,
        });
    const buf = Buffer.from(await res.arrayBuffer());
    const sliced = buf.subarray(0, RESPONSE_CAP).toString("utf8");
    return { status: res.status, body: redactConnectorBody(sliced, item) };
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
