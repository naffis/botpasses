/**
 * SSRF-pinned `fetch` for oidc-provider's outbound requests: client_id metadata
 * documents (CIMD), `jwks_uri`, and `sector_identifier_uri`.
 *
 * The hostname is resolved first, every address is checked against the private
 * and special-use blocklist, and the TLS connection is opened to the pinned IP
 * with `servername` (SNI) and `Host` set to the original hostname. Redirects are
 * never followed; a 3xx comes back as-is and the caller treats it as a failure.
 * The connector's outbound path in connector.ts uses the same shape.
 */
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { HttpError } from "./errors.ts";
import { isBlockedIp, resolvePublicAddresses } from "./ssrf.ts";

/** Hard ceiling on bytes buffered from a remote document, above oidc-provider's own per-purpose caps. */
const BODY_CAP = 1024 * 1024;
/** Socket inactivity ceiling. oidc-provider also aborts a metadata fetch after 2.5 s. */
const DEFAULT_TIMEOUT_MS = 3000;
/** Statuses for which the Fetch Response constructor forbids a body. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export type PinnedRequest = (options: RequestOptions, onResponse: (res: IncomingMessage) => void) => ClientRequest;

export type PinnedFetchOpts = {
  /** DNS resolver. Defaults to the SSRF-checked resolver in ssrf.ts. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Transport. Defaults to node:https `request`; tests inject node:http against a fixture. */
  request?: PinnedRequest;
  timeoutMs?: number;
};

export type PinnedFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

function headerBag(headers: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  new Headers(headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function responseHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }
  return headers;
}

export function createPinnedFetch(opts: PinnedFetchOpts = {}): PinnedFetch {
  const resolve = opts.resolve ?? resolvePublicAddresses;
  const request = opts.request ?? httpsRequest;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function pinnedFetch(input, init = {}): Promise<Response> {
    const url = typeof input === "string" ? new URL(input) : input;
    if (url.protocol !== "https:") throw new HttpError(400, "Outbound metadata fetch must be https");
    if (url.username || url.password) throw new HttpError(400, "Credentials in URL are not allowed");
    const addrs = await resolve(url.hostname);
    const ip = addrs[0];
    if (!ip || addrs.some((a) => isBlockedIp(a))) {
      throw new HttpError(400, "Host resolves to a private or blocked address");
    }
    const headers = headerBag(init.headers);
    headers.host = url.host;
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : undefined;

    return new Promise<Response>((resolveResponse, reject) => {
      const req = request(
        {
          hostname: ip,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method,
          servername: url.hostname,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > BODY_CAP) {
              req.destroy(new HttpError(400, "Remote document too large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const status = res.statusCode ?? 502;
            resolveResponse(
              new Response(NULL_BODY_STATUS.has(status) ? null : Buffer.concat(chunks), {
                status,
                headers: responseHeaders(res),
              }),
            );
          });
          res.on("error", reject);
        },
      );
      const onAbort = () => req.destroy(new HttpError(504, "Remote document fetch aborted"));
      init.signal?.addEventListener("abort", onAbort, { once: true });
      req.on("timeout", () => req.destroy(new HttpError(504, "Remote document fetch timed out")));
      req.on("error", (err) => {
        init.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      req.on("close", () => init.signal?.removeEventListener("abort", onAbort));
      if (body) req.write(body);
      req.end();
    });
  };
}
