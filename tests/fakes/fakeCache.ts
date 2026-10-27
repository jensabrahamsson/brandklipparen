// Deterministic in-memory fake for CachePort (A-23, K-013, K-511).
// Test-only adapter with no I/O, no clock and no randomness: the same
// sequence of puts and gets gives the same outcomes on every run. The fake
// shares the adapter's boundary check, so the contract suite proves the
// same corrupt-entry behaviour in both. The mode flag replays a store the
// service cannot reach, and call counts stay observable, so tests verify
// zero cache calls where the analysis must stay uncached and zero external
// calls on a hit. Placeholder limits are test-only values (K-210).
import { err, ok } from "../../src/domain/result.ts";
import type { Result } from "../../src/domain/result.ts";
import type {
  CacheError,
  CachedAssessment,
  CachePort,
} from "../../src/ports/cache.ts";
import type { CacheKey as CacheKeyType } from "../../src/domain/types.ts";
import { validateCacheEntry } from "../../src/adapters/cache/validateCacheEntry.ts";

export type FakeCacheMode = "ok" | "store-unavailable";

export type FakeCacheOptions = {
  readonly mode?: FakeCacheMode | undefined;
  readonly seed?: ReadonlyMap<CacheKeyType, unknown> | undefined;
};

export class FakeCacheAdapter implements CachePort {
  private mode: FakeCacheMode;
  private readonly store = new Map<string, unknown>();
  private gets = 0;
  private puts = 0;

  constructor(options: FakeCacheOptions = {}) {
    this.mode = options.mode ?? "ok";
    if (options.seed !== undefined) {
      for (const [key, raw] of options.seed) {
        this.store.set(key as string, raw);
      }
    }
  }

  setMode(mode: FakeCacheMode): void {
    this.mode = mode;
  }

  get getCalls(): number {
    return this.gets;
  }

  get putCalls(): number {
    return this.puts;
  }

  resetCounts(): void {
    this.gets = 0;
    this.puts = 0;
  }

  // Test hook for corruption drills (M-14): writes raw bytes without the
  // put validation, so a test can prove that reads fall back to a fresh
  // analysis. Production paths use put and never call this method.
  injectRaw(key: CacheKeyType, raw: unknown): void {
    this.store.set(key as string, raw);
  }

  async get(key: CacheKeyType): Promise<Result<CachedAssessment | null, CacheError>> {
    this.gets += 1;
    if (this.mode === "store-unavailable") {
      return err({ kind: "store-unavailable", message: "fake cache store is unavailable" });
    }
    if (!this.store.has(key as string)) {
      return ok(null);
    }
    return validateCacheEntry(key, this.store.get(key as string));
  }

  async put(key: CacheKeyType, value: CachedAssessment): Promise<Result<void, CacheError>> {
    this.puts += 1;
    if (this.mode === "store-unavailable") {
      return err({ kind: "store-unavailable", message: "fake cache store is unavailable" });
    }
    const checked = validateCacheEntry(key, value);
    if (!checked.ok) {
      return err(checked.error);
    }
    this.store.set(key as string, checked.value);
    return ok(undefined);
  }
}
