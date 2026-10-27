// Contract suite against the in-memory cache adapter (S-010, K-013).
// Runs the shared CachePort suite against the real Map-backed adapter, so
// the adapter proves hit, miss and corrupt-entry behaviour with no I/O,
// no clock and no new dependencies.
import { InMemoryCacheAdapter } from "../../src/adapters/cache/inMemoryCache.ts";
import type { CacheKey as CacheKeyType } from "../../src/domain/types.ts";
import type { CachePort } from "../../src/ports/cache.ts";
import { runCachePortContract } from "./cache.contract.ts";

function makeAdapter(seed?: ReadonlyMap<CacheKeyType, unknown> | undefined): CachePort {
  return new InMemoryCacheAdapter(seed === undefined ? {} : { seed });
}

runCachePortContract("in-memory cache", makeAdapter);
