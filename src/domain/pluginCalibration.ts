// Calibrated plugin weights read from the versioned model artifact only
// (S-047, P-05, K-210). A detector finding enters the score only when the
// artifact names its plugin id in `pluginWeights`; an unnamed plugin
// carries weight 0 and its findings stay display records in
// `pluginResults`. The lookup reads the artifact value and nothing else:
// the manifest `capabilities` and the finding payload never steer it, so a
// plugin cannot raise its own influence. Pure domain module: no I/O, no
// clock, no randomness.
import type { ModelArtifact } from "./risk.ts";

// Weight for a plugin without a calibrated entry: its findings never reach
// scoring.
export const UNCALIBRATED_PLUGIN_WEIGHT = 0;

// Calibrated weight for one plugin id from the artifact only. Unknown,
// non-finite, or negative stored values fall back to 0, so a malformed
// mapping entry can only silence a plugin, never amplify one.
export function pluginWeightOf(artifact: ModelArtifact, pluginId: string): number {
  // When the artifact carries fitted per-head weights, score() uses those
  // heads (risk.ts), so the exposed weight is the largest head weight: a
  // detector fitted to 0 on both heads reports 0, never the catalogue 1.
  const heads = artifact.detectorHeadWeights?.[pluginId];
  if (heads !== undefined) {
    const rug = typeof heads["rug-pull"] === "number" && Number.isFinite(heads["rug-pull"]) ? heads["rug-pull"] : 0;
    const honeypot = typeof heads.honeypot === "number" && Number.isFinite(heads.honeypot) ? heads.honeypot : 0;
    return Math.max(0, rug, honeypot);
  }
  const stored: unknown = artifact.pluginWeights[pluginId];
  if (typeof stored !== "number" || !Number.isFinite(stored) || stored < 0) {
    return UNCALIBRATED_PLUGIN_WEIGHT;
  }
  return stored;
}
