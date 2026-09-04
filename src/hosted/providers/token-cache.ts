/**
 * In-process cache of minted access tokens, keyed by org, item, client id, and grant type.
 * Values never leave the process; the cache is memory only and cleared between tests.
 */
import type { OauthGrantType } from "../../hosted-types.ts";
import type { MintedToken } from "./types.ts";

const TOKEN_SKEW_MS = 60_000;

const mintCache = new Map<string, MintedToken>();

function cacheKey(orgId: string, itemId: string, clientId: string, kind: OauthGrantType): string {
  return `${orgId}:${itemId}:${clientId}:${kind}`;
}

export function clearMintCache(): void {
  mintCache.clear();
}

/** A cached token with at least one minute left, or undefined (expired entries are dropped). */
export function cachedMint(
  orgId: string,
  itemId: string,
  clientId: string,
  kind: OauthGrantType,
  now = Date.now(),
): MintedToken | undefined {
  const key = cacheKey(orgId, itemId, clientId, kind);
  const hit = mintCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt - TOKEN_SKEW_MS <= now) {
    mintCache.delete(key);
    return undefined;
  }
  return hit;
}

export function storeMint(
  orgId: string,
  itemId: string,
  clientId: string,
  kind: OauthGrantType,
  token: MintedToken,
): void {
  mintCache.set(cacheKey(orgId, itemId, clientId, kind), token);
}
