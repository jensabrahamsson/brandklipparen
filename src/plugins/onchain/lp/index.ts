// On-chain LP plugin descriptor (session A).
// Chain-reading feature plugin, not a bytecode registry entry: the
// computation is the shared pure domain function, and the drivers (the
// offline extractor for training, the application service for serving)
// fetch the chain snapshot through RpcPort. Weight 0 and not calibrated in
// the current artifact, so the score never reads it. Pure module: imports
// solely domain helpers, no I/O, no clock, no network.
import { lpBucketsOf } from "../../../domain/onchain/features.ts";

export const ONCHAIN_LP_PLUGIN_ID = "dev.brandklipparen.onchain-lp";
export const ONCHAIN_LP_PLUGIN_VERSION = "1.0.0";

export const onchainLpPlugin = Object.freeze({
  id: ONCHAIN_LP_PLUGIN_ID,
  version: ONCHAIN_LP_PLUGIN_VERSION,
  weight: 0,
  calibrated: false,
  compute: Object.freeze({ lpBucketsOf }),
});
