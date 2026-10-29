// On-chain age plugin descriptor (session A).
// Chain-reading feature plugin, not a bytecode registry entry: age is
// the analysis block minus the deployment block, both recorded by the
// drivers (the offline extractor for training, the application service for
// serving). Weight 0 and not calibrated in the current artifact, so the
// score never reads it. Pure module: imports solely domain helpers, no
// I/O, no clock, no network.
export const ONCHAIN_AGE_PLUGIN_ID = "dev.brandklipparen.onchain-age";
export const ONCHAIN_AGE_PLUGIN_VERSION = "1.0.0";

export function tokenAgeBlocks(analysisBlock: number, deploymentBlock: number): number | null {
  if (!Number.isSafeInteger(analysisBlock) || !Number.isSafeInteger(deploymentBlock)) {
    return null;
  }
  if (analysisBlock < deploymentBlock) {
    return null;
  }
  return analysisBlock - deploymentBlock;
}

export const onchainAgePlugin = Object.freeze({
  id: ONCHAIN_AGE_PLUGIN_ID,
  version: ONCHAIN_AGE_PLUGIN_VERSION,
  weight: 0,
  calibrated: false,
  compute: Object.freeze({ tokenAgeBlocks }),
});
