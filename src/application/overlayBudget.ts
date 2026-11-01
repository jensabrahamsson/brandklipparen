// Shared per-key daily cost cap and exact-input cache for the opt-in
// model overlays (S-106, K-507): naming, explain, chat, rug and
// personalize. A cache hit costs zero and never touches the cap; a miss
// spends one unit for the key when the key stays within its daily cap,
// and reports capped once the key is over it. The caller passes the API
// key id, so keyless (test-only) calls behave exactly as before. Days are
// UTC dates; the clock is injectable so tests steer the day boundary.
export const MAX_OVERLAY_CACHE_ENTRIES = 500;

export type OverlayBudgetOptions = {
  readonly dailyCapPerKey: number;
  // SEC-1 S-8: global daily cap across all keys. Absent means no
  // global cap; past it every key reads as capped for the day.
  readonly globalDailyCap?: number | undefined;
  // UTC day reader (S-106): injected so tests steer the day boundary; the
  // application layer owns no clock, so callers pass wall time explicitly.
  readonly today: () => string;
};

export class OverlayBudget {
  private readonly dailyCapPerKey: number;
  private readonly globalDailyCap: number | undefined;
  private readonly today: () => string;
  private readonly spent = new Map<string, number>();
  private readonly globalSpent = new Map<string, number>();
  private readonly cached = new Map<string, unknown>();

  constructor(options: OverlayBudgetOptions) {
    this.dailyCapPerKey = options.dailyCapPerKey;
    this.globalDailyCap = options.globalDailyCap;
    this.today = options.today;
  }

  // Exact-input cache lookup: a hit returns the stored outcome and costs
  // zero, on both capped and uncapped keys.
  lookup<T>(cacheKey: string): T | null {
    const hit = this.cached.get(cacheKey);
    return hit === undefined ? null : (hit as T);
  }

  // Exact-input cache store: first write wins, oldest entries leave first
  // past the bound, so an adversarial key space cannot grow the cache
  // without limit.
  store(cacheKey: string, outcome: unknown): void {
    if (this.cached.has(cacheKey)) {
      return;
    }
    if (this.cached.size >= MAX_OVERLAY_CACHE_ENTRIES) {
      const oldest = this.cached.keys().next();
      if (!oldest.done) {
        this.cached.delete(oldest.value);
      }
    }
    this.cached.set(cacheKey, outcome);
  }

  // Daily spend gate per key: true records one cost unit and admits the
  // provider call; false leaves the meter untouched and the caller serves
  // the capped branch with zero provider calls.
  trySpend(keyId: string): boolean {
    const today = this.today();
    const meterKey = `${keyId}|${today}`;
    const used = this.spent.get(meterKey) ?? 0;
    if (used >= this.dailyCapPerKey) {
      return false;
    }
    if (this.globalDailyCap !== undefined) {
      for (const spentDay of this.globalSpent.keys()) {
        if (spentDay !== today) {
          this.globalSpent.delete(spentDay);
        }
      }
      const globalUsed = this.globalSpent.get(today) ?? 0;
      if (globalUsed >= this.globalDailyCap) {
        return false;
      }
      this.globalSpent.set(today, globalUsed + 1);
    }
    this.spent.set(meterKey, used + 1);
    return true;
  }
}
