// Shared S-071 test helper: builds the default first-party detector set
// through the composition startup builder. Tests wire the returned set
// explicitly into the service and the servers; no defaulted detector set
// exists in src, so this helper is the single place tests obtain one.
import { buildDetectorSet } from "../../src/composition/root.ts";
import type { DetectorSet } from "../../src/application/analyzeToken.ts";

export function mustDefaultDetectorSet(): DetectorSet {
  const built = buildDetectorSet();
  if (!built.ok) {
    throw new Error(`default detector set failed to build: ${built.error.kind}`);
  }
  return built.value;
}
