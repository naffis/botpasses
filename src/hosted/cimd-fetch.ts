import { isBlockedIp, resolvePublicAddresses } from "./ssrf.ts";
import { HttpError } from "./errors.ts";

const BODY_CAP = 16 * 1024;
const CACHE_MS = 60 * 60 * 1000;

const cache = new Map<string, { at: number; body: unknown }>();

export async function fetchCimdDocument(
  clientIdUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let parsed: URL;
  try {
    parsed = new URL(clientIdUrl);
  } catch {
    throw new HttpError(400, "client_id must be an https URL");
  }
  if (parsed.protocol !== "https:") throw new HttpError(400, "CIMD client_id must be https");
  const cached = cache.get(clientIdUrl);
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.body;
  const addrs = await resolvePublicAddresses(parsed.hostname);
  if (addrs.some((a) => isBlockedIp(a))) {
    throw new HttpError(400, "CIMD host resolves to a blocked address");
  }
  const pinned = `${parsed.protocol}//${addrs[0]}${parsed.pathname}${parsed.search}`;
  const res = await fetchImpl(pinned, {
    method: "GET",
    redirect: "manual",
    headers: { host: parsed.hostname, accept: "application/json" },
  });
  if (res.status >= 300 && res.status < 400) {
    throw new HttpError(400, "CIMD redirects are not allowed");
  }
  if (!res.ok) throw new HttpError(400, "CIMD document fetch failed");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > BODY_CAP) throw new HttpError(400, "CIMD document too large");
  const body: unknown = JSON.parse(buf.toString("utf8"));
  cache.set(clientIdUrl, { at: now, body });
  return body;
}
