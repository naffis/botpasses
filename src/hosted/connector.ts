import { request as httpsRequest } from "node:https";
import { HttpError } from "./errors.ts";
import {
  ALLOWED_METHODS,
  assertAllowedHostname,
  canonicalRequestPath,
  isBlockedIp,
  resolvePublicAddresses,
} from "./ssrf.ts";
import { redactOauthJson, redactSecrets, secretEncodings } from "../redact.ts";
import { applyInject } from "./providers/inject.ts";
import { isTokenPath, providerForHost } from "./providers/registry.ts";
import {
  playlistRewriteFields,
  rewriteSpotifyPlaylistTracks,
  type PlaylistRewritePublic,
} from "./providers/spotify-playlist.ts";

const RESPONSE_CAP = 256 * 1024;
/** Raw bytes the connector reads from an origin before it gives up on the response. */
export const RAW_RESPONSE_CAP = 1024 * 1024;
export const BODY_TOO_LARGE = "body_too_large";

/**
 * 502 for an origin that could not be reached. `credentialSent` is false only when the request
 * never left the process (DNS, connect, or TLS failure, or a deadline before the handshake);
 * callers use it to decide whether a one-call approval was spent.
 */
export class OriginUnreachableError extends HttpError {
  readonly credentialSent: boolean;
  constructor(message: string, credentialSent: boolean, extra: Record<string, unknown> = {}) {
    super(502, message, extra);
    this.name = "OriginUnreachableError";
    this.credentialSent = credentialSent;
  }
}

export function isOriginUnreachable(err: unknown): err is OriginUnreachableError {
  return err instanceof OriginUnreachableError;
}

const NEVER_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NODATA",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_OSSL_EVP_UNSUPPORTED",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

function errorCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const rec = err as { code?: unknown; cause?: unknown };
  if (typeof rec.code === "string") return rec.code;
  const cause = rec.cause as { code?: unknown } | undefined;
  return cause && typeof cause === "object" && typeof cause.code === "string" ? cause.code : "";
}

/**
 * Did the credential leave the process before this failure? `fetchPinned` says so exactly; for
 * another fetch the error code decides, and anything unrecognised counts as sent.
 */
function credentialSentBefore(err: unknown): boolean {
  if (err && typeof err === "object" && "credentialSent" in err && typeof err.credentialSent === "boolean") {
    return err.credentialSent;
  }
  const code = errorCode(err);
  if (!code) return true;
  if (NEVER_SENT_CODES.has(code)) return false;
  return !(code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL"));
}
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
} & Partial<PlaylistRewritePublic>;

/**
 * What both network paths hand back: the origin status, its headers (lowercase names, repeated
 * values joined), and the raw body. A plain record on purpose: the WHATWG `Response` refuses a
 * body on 204/205/304 and any status outside 200-599, and an origin decides both.
 */
export type OriginResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
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

/** Case-insensitive membership: hosts are stored lowercase now, but older rows may not be. */
export function hostAllowedBy(allowedHosts: readonly string[], host: string): boolean {
  const wanted = host.trim().toLowerCase();
  return allowedHosts.some((h) => h.trim().toLowerCase() === wanted);
}

export function selectConnectorHost(item: ConnectorItem, requested?: string): string {
  if (requested) {
    const host = requested.trim().toLowerCase();
    if (!hostAllowedBy(item.allowedHosts, host)) {
      throw new HttpError(400, `host_mismatch: ${host} is not in allowed_hosts`, {
        status: "host_mismatch",
        host,
        allowed_hosts: item.allowedHosts,
      });
    }
    return host;
  }
  const host = item.allowedHosts[0]?.trim().toLowerCase();
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
  sentAs?: string | null,
): string {
  const forms = credentialForms(item, extra, sentAs);
  const providerKeys = host ? providerForHost(host)?.redactKeys ?? [] : [];
  return redactSecrets(redactOauthJson(body, providerKeys), forms);
}

/**
 * Every encoding of the item secret, plus the Basic form under `sentAs` when the request went
 * out under a username other than the stored one (a `client_id` argument at a token endpoint).
 */
function credentialForms(
  item: Pick<ConnectorItem, "secret" | "username">,
  extra: readonly string[],
  sentAs?: string | null,
): string[] {
  const forms = secretEncodings(item.secret, item.username);
  if (sentAs !== undefined && sentAs !== item.username) forms.push(...secretEncodings(item.secret, sentAs));
  for (const value of extra) forms.push(...secretEncodings(value));
  return forms;
}

/** Only the allowlisted names, lowercased, in allowlist order. */
export function pickOriginHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ORIGIN_HEADER_ALLOWLIST) {
    const value = headers[name];
    if (value !== undefined && value !== "") out[name] = value;
  }
  return out;
}

/** `Headers` (a fetch mock's) as the plain lowercase record the pinned path produces. */
function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
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
  sentAs?: string | null,
): Record<string, string> {
  const forms = credentialForms(item, extraSecrets, sentAs);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name] = redactSecrets(value, forms);
  return out;
}

/** Human-readable transport failure without the request (which carries the credential). */
export function describeOriginFailure(err: unknown, host: string, aborted: boolean, timeoutMs = ORIGIN_TIMEOUT_MS): string {
  if (aborted) return `Origin request failed: ${host} did not respond within ${Math.round(timeoutMs / 1000)}s`;
  const code = errorCode(err);
  if (code === "ERR_STREAM_PREMATURE_CLOSE") {
    return `Origin request failed: ${host} closed the connection before the response completed`;
  }
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
  const pathIn = canonicalRequestPath(req.path);
  const host = selectConnectorHost(item, req.host);
  assertAllowedHostname(host, item.allowedHosts);
  const rewrite = rewriteSpotifyPlaylistTracks({ host, method, path: pathIn, body: req.body });
  const path = rewrite ? canonicalRequestPath(rewrite.path) : pathIn;
  const reqBody = rewrite ? rewrite.body : req.body;
  const rewriteFields = playlistRewriteFields(rewrite) ?? {};
  const timeoutMs = clampTimeoutMs(opts.timeoutMs);
  const resolve = opts.resolveAddresses ?? resolvePublicAddresses;
  const addrs = await resolve(host);
  if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a))) {
    throw new HttpError(400, "Host resolves to a private or blocked address");
  }

  const tokenEndpoint = tokenEndpointFor(host, path);
  const contentType =
    req.contentType ??
    (tokenEndpoint ? "application/x-www-form-urlencoded" : reqBody !== undefined ? "application/json" : undefined);
  const encoded = reqBody === undefined ? undefined : encodeBody(reqBody, contentType ?? "application/json");
  const injected = applyInject(item, {
    host,
    method,
    path,
    body: encoded,
    contentType,
    tokenEndpoint,
    now: opts.now?.() ?? new Date(),
  });
  const headers: Record<string, string> = {
    ...injected.headers,
    accept: "application/json, text/plain, */*",
    // The raw cap counts bytes on the wire; a compressed body could expand past it in memory.
    "accept-encoding": "identity",
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
      ? await readCapped(
          await fetchImpl(url, {
            method,
            headers,
            body: injected.body,
            redirect: "manual",
            signal: ac.signal,
          }),
        )
      : await fetchPinned(url, {
          method,
          headers,
          body: injected.body,
          signal: ac.signal,
          addresses: addrs,
          timeoutMs,
          ...opts.tls,
        });
    const full = res.body.toString("utf8");
    const redacted = opts.redact === false ? full : redactConnectorBody(full, item, [], host);
    const body = redacted.length > RESPONSE_CAP ? redacted.slice(0, RESPONSE_CAP) : redacted;
    return {
      status: res.status,
      body,
      // Headers are never the payload a caller needs verbatim: redact them for the item even
      // when the caller hand-redacts the body (token endpoints add the minted tokens too).
      headers: redactOriginHeaders(pickOriginHeaders(res.headers), item),
      ...rewriteFields,
    };
  } catch (err) {
    if (err instanceof OriginBodyTooLarge) return bodyTooLarge(err.headers, item, rewriteFields);
    if (err instanceof HttpError) throw err;
    const aborted = ac.signal.aborted;
    throw new OriginUnreachableError(describeOriginFailure(err, host, aborted, timeoutMs), credentialSentBefore(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Raised when the origin body passes `RAW_RESPONSE_CAP`; the socket (or stream) is destroyed. */
class OriginBodyTooLarge extends Error {
  readonly headers: Record<string, string>;
  constructor(headers: Record<string, string>) {
    super(BODY_TOO_LARGE);
    this.name = "OriginBodyTooLarge";
    this.headers = headers;
  }
}

/**
 * The result for an origin body past `RAW_RESPONSE_CAP`: a 502 the model can act on. The origin
 * answered, so the credential was sent and a one-call approval is spent like any other status.
 * Its headers are redacted like any other answer's: a `Link` after a `query:` inject echoes the key.
 */
function bodyTooLarge(
  headers: Record<string, string>,
  item: Pick<ConnectorItem, "secret" | "username">,
  rewriteFields: Partial<PlaylistRewritePublic> = {},
): ConnectorResult {
  return {
    status: 502,
    body: JSON.stringify({
      error: BODY_TOO_LARGE,
      hint: `The origin response exceeded ${RAW_RESPONSE_CAP} bytes and was discarded. Ask for a smaller page (limit, page size, or fields).`,
    }),
    headers: redactOriginHeaders(pickOriginHeaders(headers), item),
    ...rewriteFields,
  };
}

/**
 * Reads a fetch `Response` into the plain shape, at most `RAW_RESPONSE_CAP` bytes; past it the
 * stream is cancelled and `OriginBodyTooLarge` carries the headers. `fetchPinned` enforces the
 * same cap on the socket; this covers any other fetch.
 */
async function readCapped(res: Response): Promise<OriginResponse> {
  const headers = headerRecord(res.headers);
  const declared = Number(headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > RAW_RESPONSE_CAP) {
    await res.body?.cancel().catch(() => undefined);
    throw new OriginBodyTooLarge(headers);
  }
  if (!res.body) return { status: res.status, headers, body: Buffer.alloc(0) };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RAW_RESPONSE_CAP) {
      await reader.cancel().catch(() => undefined);
      throw new OriginBodyTooLarge(headers);
    }
    chunks.push(Buffer.from(value));
  }
  return { status: res.status, headers, body: Buffer.concat(chunks) };
}

/** The status codes an HTTP/1.1 parser may hand us that no HTTP client should pass on. */
function isValidOriginStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 100 && status <= 599;
}

/**
 * Dial the resolved (public) IP directly so DNS cannot rebind between resolve and connect, while
 * presenting the hostname for SNI, certificate verification, and the Host header. Redirects are
 * returned as-is, never followed. Every outcome settles the promise: nothing in the parser
 * callbacks may throw, because an exception there is uncaught and ends the process.
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
): Promise<OriginResponse> {
  const parsed = new URL(url);
  const ip = init.addresses[0];
  if (!ip) throw new HttpError(400, "Host resolves to a private or blocked address");
  return new Promise((resolve, reject) => {
    // Set once the TLS handshake completes: from then on the request (and the credential in it)
    // is on the wire, so a later failure is not "never sent".
    let credentialSent = false;
    let settled = false;
    const settle = (outcome: { ok: OriginResponse } | { err: Error }) => {
      if (settled) return;
      settled = true;
      init.signal.removeEventListener("abort", onAbort);
      if ("ok" in outcome) resolve(outcome.ok);
      else reject(outcome.err);
    };
    const fail = (err: Error & { code?: string }) => {
      settle({ err: Object.assign(err, { credentialSent }) });
    };
    const req = httpsRequest(
      {
        hostname: ip,
        port: init.port ?? 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method,
        servername: parsed.hostname,
        headers: { ...init.headers, host: parsed.hostname },
        // A fresh socket per call: `secureConnect` then marks exactly when the credential is on
        // the wire, which a reused keep-alive socket would not signal.
        agent: false,
        ...(init.ca ? { ca: init.ca } : {}),
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
          else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(", ");
        }
        headers["content-type"] ??= "text/plain";
        const status = res.statusCode ?? 502;
        if (!isValidOriginStatus(status)) {
          // The parser accepts any three digits; a status no client could carry is an origin
          // fault (502) that keeps the approval spent: the credential was answered.
          settle({
            err: new OriginUnreachableError(
              `Origin request failed: ${parsed.hostname} answered with an invalid HTTP status (${status})`,
              true,
              { status: "bad_status", origin_status: status },
            ),
          });
          req.destroy();
          return;
        }
        const declared = Number(headers["content-length"] ?? "");
        const tooLarge = () => {
          settle({ err: new OriginBodyTooLarge(headers) });
          req.destroy();
        };
        if (Number.isFinite(declared) && declared > RAW_RESPONSE_CAP) {
          tooLarge();
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.byteLength;
          if (total > RAW_RESPONSE_CAP) {
            tooLarge();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          settle({ ok: { status, headers, body: Buffer.concat(chunks) } });
        });
        const premature = () => {
          if (settled || res.complete) return;
          fail(Object.assign(new Error("premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
        };
        res.on("error", (err: Error & { code?: string }) => fail(err));
        res.on("aborted", premature);
        res.on("close", premature);
      },
    );
    const onAbort = () => {
      settle({ err: new OriginUnreachableError(describeOriginFailure(undefined, parsed.hostname, true, init.timeoutMs), credentialSent) });
      req.destroy();
    };
    init.signal.addEventListener("abort", onAbort, { once: true });
    req.on("socket", (socket) => {
      socket.once("secureConnect", () => {
        credentialSent = true;
      });
    });
    req.on("error", (err: Error & { code?: string }) => fail(err));
    if (init.body) req.write(init.body);
    req.end();
  });
}
