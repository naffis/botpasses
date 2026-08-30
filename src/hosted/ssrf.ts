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

export function isBlockedIp(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const parts = address.split(".").map((p) => Number(p));
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (v === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("::ffff:")) {
      const mapped = lower.slice("::ffff:".length);
      return isBlockedIp(mapped);
    }
    return false;
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
