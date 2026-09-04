import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HttpError } from "./errors.ts";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data",
]);

export function assertAllowedHostname(hostname: string, allowlist: string[]): void {
  const host = hostname.trim().toLowerCase();
  if (!host) throw new HttpError(400, "Missing host");
  if (host.includes("*") || host.includes("/") || host.includes(":")) {
    throw new HttpError(400, "Host must be an exact hostname");
  }
  if (isIP(host) !== 0) {
    throw new HttpError(400, "IP literals are not allowed");
  }
  if (BLOCKED_HOSTS.has(host)) {
    throw new HttpError(400, "Host is not allowed");
  }
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    throw new HttpError(400, "Host is not allowed");
  }
  if (!allowlist.map((h) => h.toLowerCase()).includes(host)) {
    throw new HttpError(400, "Host is not on the item allowlist");
  }
}

function isBlockedIpv4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this-net, RFC 1918, loopback
  if (a === 169 && b === 254) return true; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast 224/4 and reserved 240/4 (incl. broadcast)
  return false;
}

/** First hextet of a canonical (node-normalised) IPv6 address, or -1 when it is compressed away. */
function firstHextet(lower: string): number {
  const head = lower.split(":")[0] ?? "";
  if (head === "") return 0;
  const n = Number.parseInt(head, 16);
  return Number.isNaN(n) ? -1 : n;
}

function isBlockedIpv6(lower: string): boolean {
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("::ffff:")) {
    return isBlockedIp(lower.slice("::ffff:".length));
  }
  if (lower.startsWith("64:ff9b:")) return true; // NAT64 well-known prefix (embeds IPv4)
  if (lower.startsWith("2002:")) return true; // 6to4 (embeds IPv4)
  if (lower.startsWith("2001:db8:")) return true; // documentation
  const first = firstHextet(lower);
  if (first < 0) return true;
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfec0) return true; // site-local (deprecated) fec0::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/**
 * Addresses the connector must never dial: loopback, RFC 1918, link-local and cloud metadata,
 * shared/benchmark/test nets, multicast and reserved, plus the IPv6 prefixes that embed or map
 * an IPv4 address (NAT64, 6to4, v4-mapped) and the documentation range.
 */
export function isBlockedIp(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const parts = address.split(".").map((p) => Number(p));
    return isBlockedIpv4(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0);
  }
  if (v === 6) {
    return isBlockedIpv6(address.toLowerCase());
  }
  return true;
}

export async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  assertAllowedHostname(hostname, [hostname]);
  const records = await lookup(hostname, { all: true, verbatim: true });
  const addrs = records.map((r) => r.address);
  if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a))) {
    throw new HttpError(400, "Host resolves to a private or blocked address");
  }
  return addrs;
}

export const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function assertSafePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new HttpError(400, "path must start with /");
  }
}
