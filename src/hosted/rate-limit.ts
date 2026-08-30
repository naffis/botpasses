const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;

export class OrgRateLimiter {
  readonly #hits = new Map<string, number[]>();

  allow(orgId: string, now = Date.now()): boolean {
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
