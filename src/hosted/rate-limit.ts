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

export class OrgRateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #store: VaultStore | undefined;

  constructor(store?: VaultStore) {
    this.#store = store;
  }

  async allow(orgId: string, now = Date.now(), kind: RateKind = "grant"): Promise<boolean> {
    if (this.#store) {
      const start = hourWindowStart(now);
      const grant = await this.#store.countRateHits(orgId, "grant", start);
      const need = await this.#store.countRateHits(orgId, "need", start);
      if (grant + need >= MAX_PER_WINDOW) return false;
      await this.#store.incrementRateHit(orgId, kind, start);
      return true;
    }
    const cutoff = now - WINDOW_MS;
    const prev = (this.#hits.get(orgId) ?? []).filter((t) => t > cutoff);
    if (prev.length >= MAX_PER_WINDOW) {
      this.#hits.set(orgId, prev);
      return false;
    }
    prev.push(now);
    this.#hits.set(orgId, prev);
    return true;
  }
}
