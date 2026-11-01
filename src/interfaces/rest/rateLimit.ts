// In-process rate and quota limiter for the driving adapters (K-504,
// M-08, M-09). The limiter bounds expensive analysis paths per API key and
// globally: a per-key sliding minute window, a per-key daily quota and a
// global sliding minute window. Limits come from the validated operational
// configuration (I-08, I-12); detection thresholds, weights and learned
// values stay out of here and live solely in the versioned model artifact
// per K-210. The clock arrives as an injected function, so tests steer time
// with a fake clock and production passes a wall-clock reader; this module
// performs no I/O of its own. Denials carry a retry time in seconds, so
// callers answer with a machine-readable retryable error per A-18.
export type RateLimitConfig = {
  readonly perKeyPerMinute: number;
  readonly perKeyPerDay: number;
  readonly globalPerMinute: number;
  // SEC-1 S-2: largest share of the global minute window one key may
  // use, in percent (1..100). Absent means 50, so one key cannot
  // exhaust the global budget for the other keys.
  readonly perKeyGlobalSharePercent?: number | undefined;
};

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSec: number };

export type RateLimiter = {
  readonly check: (keyId: string) => RateLimitDecision;
  // Number of retained per-key daily meters, after stale-day pruning.
  readonly dailyMeterCount: () => number;
};

export const DEFAULT_PER_KEY_GLOBAL_SHARE_PERCENT = 50;

export function resolvePerKeyGlobalSharePercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PER_KEY_GLOBAL_SHARE_PERCENT;
  }
  return Math.min(100, Math.max(1, Math.floor(value)));
}

const MINUTE_MS = 60_000;

// Start of the next UTC day after now, so a daily quota denial names the
// wait until the quota resets.
function secondsUntilNextUtcDay(now: number): number {
  const day = new Date(now);
  const next = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function pruneOlderThan(hits: number[], cutoff: number): number[] {
  let start = 0;
  while (start < hits.length && (hits[start] ?? 0) <= cutoff) {
    start += 1;
  }
  return hits.slice(start);
}

function retryAfterForWindow(hits: number[], now: number): number {
  const oldest = hits[0] ?? now;
  return Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1000));
}

export function createRateLimiter(
  config: RateLimitConfig,
  nowMs: () => number = () => Date.now(),
): RateLimiter {
  const perKeyMinute = new Map<string, number[]>();
  const perKeyDay = new Map<string, number>();
  let globalMinute: number[] = [];

  // SEC-1 S-6: drop daily meters from past days on every check, so
  // the map stays bounded by the keys seen today.
  function pruneStaleDays(today: string): void {
    for (const meterKey of perKeyDay.keys()) {
      if (!meterKey.endsWith(`|${today}`)) {
        perKeyDay.delete(meterKey);
      }
    }
  }

  function check(keyId: string): RateLimitDecision {
    const now = nowMs();
    const today = dayOf(now);
    pruneStaleDays(today);
    const cutoff = now - MINUTE_MS;
    globalMinute = pruneOlderThan(globalMinute, cutoff);
    const keyHits = pruneOlderThan(perKeyMinute.get(keyId) ?? [], cutoff);
    if (keyHits.length >= config.perKeyPerMinute) {
      perKeyMinute.set(keyId, keyHits);
      return { allowed: false, retryAfterSec: retryAfterForWindow(keyHits, now) };
    }
    // Per-key share of the global window (S-2): checked before the
    // global total so a denied share spends no global budget.
    const sharePercent = resolvePerKeyGlobalSharePercent(config.perKeyGlobalSharePercent);
    const perKeyGlobalCap = Math.max(
      1,
      Math.floor((config.globalPerMinute * sharePercent) / 100),
    );
    if (keyHits.length >= perKeyGlobalCap) {
      perKeyMinute.set(keyId, keyHits);
      return { allowed: false, retryAfterSec: retryAfterForWindow(keyHits, now) };
    }
    if (globalMinute.length >= config.globalPerMinute) {
      perKeyMinute.set(keyId, keyHits);
      return { allowed: false, retryAfterSec: retryAfterForWindow(globalMinute, now) };
    }
    const dayKey = `${keyId}|${today}`;
    const consumed = perKeyDay.get(dayKey) ?? 0;
    if (consumed >= config.perKeyPerDay) {
      perKeyMinute.set(keyId, keyHits);
      return { allowed: false, retryAfterSec: secondsUntilNextUtcDay(now) };
    }
    perKeyMinute.set(keyId, [...keyHits, now]);
    globalMinute = [...globalMinute, now];
    perKeyDay.set(dayKey, consumed + 1);
    return { allowed: true };
  }

  return Object.freeze({
    check,
    dailyMeterCount: (): number => perKeyDay.size,
  });
}
