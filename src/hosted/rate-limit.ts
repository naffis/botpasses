import type { RateHitKind, VaultStore } from "../store/types.ts";

const HOUR_MS = 60 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;

export type RateKind = RateHitKind;

type Bucket = { windowMs: number; max: number; shares: RateKind[] };

/**
 * `grant` and `need` share one budget of 30 per org per UTC hour. `approve_code` has its own:
 * 20 attempts per org per 15 minutes, so a guesser cannot walk the 8-digit space through many
 * sessions while a typo-prone operator still gets a few tries.
 */
function bucketOf(kind: RateKind): Bucket {
  switch (kind) {
    case "grant":
      return { windowMs: HOUR_MS, max: 30, shares: ["need"] };
    case "need":
      return { windowMs: HOUR_MS, max: 30, shares: ["grant"] };
    case "approve_code":
      return { windowMs: QUARTER_HOUR_MS, max: 20, shares: [] };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled rate kind: ${String(exhaustive)}`);
    }
  }
}

function windowStart(now: number, windowMs: number): string {
  return new Date(Math.floor(now / windowMs) * windowMs).toISOString();
}

/**
 * Increment first, then compare the returned count, so concurrent callers cannot all read
 * "29" and each be admitted (S15 TOCTOU). A denied call still counts against the window.
 * Shared kinds live in separate rows, so a burst mixing kinds can deny a little early; it
 * can never admit late.
 */
export class OrgRateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #store: VaultStore | undefined;

  constructor(store?: VaultStore) {
    this.#store = store;
  }

  async allow(orgId: string, now = Date.now(), kind: RateKind = "grant"): Promise<boolean> {
    const bucket = bucketOf(kind);
    if (this.#store) {
      const start = windowStart(now, bucket.windowMs);
      let total = await this.#store.incrementRateHit(orgId, kind, start);
      for (const other of bucket.shares) {
        total += await this.#store.countRateHits(orgId, other, start);
      }
      return total <= bucket.max;
    }
    const key = `${orgId}:${[kind, ...bucket.shares].sort().join("+")}`;
    const cutoff = now - bucket.windowMs;
    const prev = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    prev.push(now);
    this.#hits.set(key, prev);
    return prev.length <= bucket.max;
  }
}
