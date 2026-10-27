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
};

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSec: number };

export type RateLimiter = {
  readonly check: (keyId: string) => RateLimitDecision;
};

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

  function check(keyId: string): RateLimitDecision {
    const now = nowMs();
    const cutoff = now - MINUTE_MS;
    globalMinute = pruneOlderThan(globalMinute, cutoff);
    if (globalMinute.length >= config.globalPerMinute) {
      return { allowed: false, retryAfterSec: retryAfterForWindow(globalMinute, now) };
    }
    const keyHits = pruneOlderThan(perKeyMinute.get(keyId) ?? [], cutoff);
    if (keyHits.length >= config.perKeyPerMinute) {
      perKeyMinute.set(keyId, keyHits);
      return { allowed: false, retryAfterSec: retryAfterForWindow(keyHits, now) };
    }
    const dayKey = `${keyId}|${dayOf(now)}`;
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

  return Object.freeze({ check });
}
