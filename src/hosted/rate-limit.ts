import type { VaultStore } from "../store/types.ts";

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;

export type RateKind = "grant" | "need";

function hourWindowStart(now: number): string {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCMilliseconds(0);
  return d.toISOString();
}

/**
 * 30 grant-or-need hits per org per UTC hour. Increment first, then compare the returned count,
 * so concurrent callers cannot all read "29" and each be admitted (S15 TOCTOU). A denied call
 * still counts against the window. The two kinds share one budget but live in two rows, so a
 * burst mixing kinds can deny a little early; it can never admit late.
 */
export class OrgRateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #store: VaultStore | undefined;

  constructor(store?: VaultStore) {
    this.#store = store;
  }

  async allow(orgId: string, now = Date.now(), kind: RateKind = "grant"): Promise<boolean> {
    if (this.#store) {
      const start = hourWindowStart(now);
      const mine = await this.#store.incrementRateHit(orgId, kind, start);
      const other: RateKind = kind === "grant" ? "need" : "grant";
      const theirs = await this.#store.countRateHits(orgId, other, start);
      return mine + theirs <= MAX_PER_WINDOW;
    }
    const cutoff = now - WINDOW_MS;
    const prev = (this.#hits.get(orgId) ?? []).filter((t) => t > cutoff);
    prev.push(now);
    this.#hits.set(orgId, prev);
    return prev.length <= MAX_PER_WINDOW;
  }
}
