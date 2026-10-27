// Contract suite against the deterministic fake (S-010, K-013).
// Runs the shared CachePort suite against the fake, so the fake proves the
// same outcomes the in-memory adapter must keep in its own run. The fake
// additionally proves the store-unavailable branch the Map-backed adapter
// never reaches on its own.
import { FakeCacheAdapter } from "../fakes/fakeCache.ts";
import type { CacheKey as CacheKeyType } from "../../src/domain/types.ts";
import type { CachePort } from "../../src/ports/cache.ts";
import { runCachePortContract } from "./cache.contract.ts";

function makeFake(seed?: ReadonlyMap<CacheKeyType, unknown> | undefined): CachePort {
  return new FakeCacheAdapter(seed === undefined ? {} : { seed });
}

runCachePortContract("fake cache", makeFake, {
  makeUnavailable: () => new FakeCacheAdapter({ mode: "store-unavailable" }),
});
