import type { IncomingMessage } from "node:http";

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
  return clientIpFrom(
    headerValue(req, "fly-client-ip"),
    headerValue(req, "x-forwarded-for"),
    req.socket?.remoteAddress,
    trustsProxyHeaders(),
  );
}
