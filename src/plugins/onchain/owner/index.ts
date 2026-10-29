// On-chain owner plugin descriptor (session A).
// Chain-reading feature plugin, not a bytecode registry entry: the
// computation is the shared pure domain function, and the drivers (the
// offline extractor for training, the application service for serving)
// fetch the chain snapshot through RpcPort. Weight 0 and not calibrated in
// the current artifact, so the score never reads it. Pure module: imports
// solely domain helpers, no I/O, no clock, no network.
import { ownerFeatureOf } from "../../../domain/onchain/features.ts";
import { classifyOwner } from "../../../domain/onchain/lockers.ts";

export const ONCHAIN_OWNER_PLUGIN_ID = "dev.brandklipparen.onchain-owner";
export const ONCHAIN_OWNER_PLUGIN_VERSION = "1.0.0";

export const onchainOwnerPlugin = Object.freeze({
  id: ONCHAIN_OWNER_PLUGIN_ID,
  version: ONCHAIN_OWNER_PLUGIN_VERSION,
  weight: 0,
  calibrated: false,
  compute: Object.freeze({ ownerFeatureOf, classifyOwner }),
});
