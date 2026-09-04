import type { IncomingMessage } from "node:http";
import { isIPv4, isIPv6 } from "node:net";

/** Upper bound on distinct keys held in memory; the least recently touched key is evicted first. */
export const LIMITER_MAX_KEYS = 10_000;

/**
 * Sliding-window hit counter keyed by caller-chosen strings (an IP, an email).
 * Bounded: past `maxKeys` the least recently used key is dropped, so a flood of
 * distinct spoofed addresses cannot grow the map without limit.
 */
export class IpWindowLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #maxKeys: number;

  constructor(maxKeys = LIMITER_MAX_KEYS) {
    this.#maxKeys = Math.max(1, maxKeys);
  }

  get size(): number {
    return this.#hits.size;
  }

  allow(key: string, max: number, windowMs: number, now: number): boolean {
    const cutoff = now - windowMs;
    const prev = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    // Re-insert so Map iteration order doubles as recency order.
    this.#hits.delete(key);
    const allowed = prev.length < max;
    if (allowed) prev.push(now);
    this.#hits.set(key, prev);
    this.#evict();
    return allowed;
  }

  #evict(): void {
    while (this.#hits.size > this.#maxKeys) {
      const oldest = this.#hits.keys().next();
      if (oldest.done) return;
      this.#hits.delete(oldest.value);
    }
  }
}

/**
 * Resolve the caller's address. Proxy headers are read only when `trustProxy` is set (behind
 * Fly, or `VAULT_TRUST_PROXY=1`): `Fly-Client-IP` (set by the Fly proxy, never by the client),
 * then the LAST hop of `X-Forwarded-For` (appended by the proxy; clients can prepend but not
 * append). Without a trusted proxy every header is attacker-controlled, so the socket peer is
 * the only address that counts.
 */
export function clientIpFrom(
  flyClientIp: string | undefined,
  forwarded: string | undefined,
  remote: string | undefined,
  trustProxy = true,
): string {
  const peer = remote?.trim() || "0.0.0.0";
  if (!trustProxy) return peer;
  const fly = flyClientIp?.trim();
  if (fly) return fly;
  const hops = (forwarded ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const last = hops.at(-1);
  if (last) return last;
  return peer;
}

/**
 * Cloudflare's published egress ranges (https://www.cloudflare.com/ips/). With the orange
 * cloud on, the address Fly sees is one of these and the visitor is in `CF-Connecting-IP`.
 * Override with `VAULT_TRUSTED_PROXY_CIDRS` when the list changes or another CDN fronts a plane.
 */
export const CLOUDFLARE_PROXY_CIDRS: readonly string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

type ParsedIp = { bits: 32 | 128; value: bigint };

function stripZone(ip: string): string {
  const zone = ip.indexOf("%");
  return zone === -1 ? ip : ip.slice(0, zone);
}

function ipv4ToBigInt(ip: string): bigint {
  return ip.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
  let text = ip;
  // Embedded IPv4 tail (`::ffff:203.0.113.9`): fold it into two hextets.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToBigInt(tail);
    const hi = ((v4 >> 16n) & 0xffffn).toString(16);
    const lo = (v4 & 0xffffn).toString(16);
    text = `${text.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const [head = "", rest] = text.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = rest !== undefined && rest ? rest.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = rest === undefined ? headParts : [...headParts, ...Array<string>(Math.max(0, missing)).fill("0"), ...tailParts];
  return parts.reduce((acc, hextet) => (acc << 16n) | BigInt(parseInt(hextet || "0", 16)), 0n);
}

/** IPv4 or IPv6 (zone ids and IPv4-mapped IPv6 handled). Undefined for anything else. */
export function parseIp(raw: string | undefined): ParsedIp | undefined {
  const ip = stripZone((raw ?? "").trim());
  if (!ip) return undefined;
  if (isIPv4(ip)) return { bits: 32, value: ipv4ToBigInt(ip) };
  if (isIPv6(ip)) {
    const value = ipv6ToBigInt(ip);
    // ::ffff:a.b.c.d is the IPv4 address for range purposes (dual-stack sockets report it).
    if (value >> 32n === 0xffffn) return { bits: 32, value: value & 0xffffffffn };
    return { bits: 128, value };
  }
  return undefined;
}

type Cidr = { bits: 32 | 128; network: bigint; prefix: number };

function parseCidr(raw: string): Cidr | undefined {
  const [ipPart, prefixPart] = raw.trim().split("/");
  const ip = parseIp(ipPart);
  if (!ip) return undefined;
  const prefix = prefixPart === undefined ? ip.bits : Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) return undefined;
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(ip.bits - prefix);
  return { bits: ip.bits, network: ip.value & mask, prefix };
}

/** True when `ip` lies inside any of `cidrs`. Malformed entries on either side never match. */
export function ipInCidrs(ip: string | undefined, cidrs: readonly string[]): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  for (const raw of cidrs) {
    const cidr = parseCidr(raw);
    if (!cidr || cidr.bits !== parsed.bits) continue;
    const shift = BigInt(cidr.bits - cidr.prefix);
    if (parsed.value >> shift === cidr.network >> shift) return true;
  }
  return false;
}

/**
 * The proxies whose `CF-Connecting-IP` is believed. Unset: Cloudflare's ranges. Set: a
 * comma-separated CIDR list; an empty value means no proxy is trusted and the header is ignored.
 */
export function trustedProxyCidrs(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env.VAULT_TRUSTED_PROXY_CIDRS;
  if (raw === undefined) return CLOUDFLARE_PROXY_CIDRS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type ClientIpHeaders = {
  cfConnectingIp?: string;
  flyClientIp?: string;
  forwarded?: string;
  remote?: string;
};

export type ClientIpTrust = {
  trustProxyHeaders: boolean;
  trustedProxyCidrs: readonly string[];
};

/**
 * Full resolution: the peer as Fly saw it (`clientIpFrom`), then one more hop through the CDN.
 * `CF-Connecting-IP` is only read when that peer is inside the trusted proxy ranges; a client
 * that reaches the plane directly can set the header but cannot make its own address Cloudflare's.
 */
export function clientIpFromHeaders(headers: ClientIpHeaders, trust: ClientIpTrust): string {
  const peer = clientIpFrom(headers.flyClientIp, headers.forwarded, headers.remote, trust.trustProxyHeaders);
  const cf = headers.cfConnectingIp?.trim() ?? "";
  if (cf && parseIp(cf) && ipInCidrs(peer, trust.trustedProxyCidrs)) return cf;
  return peer;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.join(",");
  return raw;
}

/** Proxy headers are authoritative only behind Fly, or when the deployer opts in with VAULT_TRUST_PROXY=1. */
export function trustsProxyHeaders(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.FLY_APP_NAME?.trim()) || env.VAULT_TRUST_PROXY === "1";
}

export function requestClientIp(req: IncomingMessage): string {
  return clientIpFromHeaders(
    {
      cfConnectingIp: headerValue(req, "cf-connecting-ip"),
      flyClientIp: headerValue(req, "fly-client-ip"),
      forwarded: headerValue(req, "x-forwarded-for"),
      remote: req.socket?.remoteAddress,
    },
    { trustProxyHeaders: trustsProxyHeaders(), trustedProxyCidrs: trustedProxyCidrs() },
  );
}
