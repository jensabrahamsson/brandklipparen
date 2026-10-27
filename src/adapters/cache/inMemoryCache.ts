// In-memory CachePort adapter (S-010, K-013, M-14).
// Driven adapter behind CachePort with no I/O, no clock, no randomness and
// no new dependencies: entries live in insertion order in a Map, reads
// validate every entry at the boundary (A-16) and writes validate before
// storing, so poisoned or truncated bytes never reach the service. The
// optional entry cap is a placeholder operational default; a file-backed
// volume adapter joins in a later story for the demo cache directory.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type {
  CacheError,
  CachedAssessment,
  CachePort,
} from "../../ports/cache.ts";
import type { CacheKey as CacheKeyType } from "../../domain/types.ts";
import { validateCacheEntry } from "./validateCacheEntry.ts";

// Placeholder cap on stored entries (I-08, I-14): the versioned
// operational configuration carries the running value in a later story.
// The oldest entry leaves first when the cap is reached.
export const DEFAULT_MAX_CACHE_ENTRIES = 1000;

export type InMemoryCacheOptions = {
  readonly seed?: ReadonlyMap<CacheKeyType, unknown> | undefined;
  readonly maxEntries?: number | undefined;
};

export class InMemoryCacheAdapter implements CachePort {
  private readonly store = new Map<string, unknown>();
  private readonly maxEntries: number;

  constructor(options: InMemoryCacheOptions = {}) {
    this.maxEntries =
      options.maxEntries === undefined ||
      !Number.isSafeInteger(options.maxEntries) ||
      options.maxEntries <= 0
        ? DEFAULT_MAX_CACHE_ENTRIES
        : options.maxEntries;
    if (options.seed !== undefined) {
      for (const [key, raw] of options.seed) {
        this.store.set(key as string, raw);
      }
    }
  }

  size(): number {
    return this.store.size;
  }

  // Diagnostic hook for contract tests and poisoning drills (M-14):
  // writes raw bytes without the put validation, so the suite and a drill
  // can prove that reads reject corrupt entries. Production paths use
  // put and never call this method.
  injectRaw(key: CacheKeyType, raw: unknown): void {
    this.store.set(key as string, raw);
  }

  async get(key: CacheKeyType): Promise<Result<CachedAssessment | null, CacheError>> {
    if (!this.store.has(key as string)) {
      return ok(null);
    }
    return validateCacheEntry(key, this.store.get(key as string));
  }

  async put(key: CacheKeyType, value: CachedAssessment): Promise<Result<void, CacheError>> {
    const checked = validateCacheEntry(key, value);
    if (!checked.ok) {
      return err(checked.error);
    }
    if (!this.store.has(key as string) && this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) {
        this.store.delete(oldest.value);
      }
    }
    this.store.set(key as string, checked.value);
    return ok(undefined);
  }
}
