// On-chain deployer plugin descriptor (session A).
// Chain-reading feature plugin, not a bytecode registry entry: the
// deployment search and deployer discovery run through RpcPort in the
// drivers (the offline extractor for training, the application service
// for serving), and the block arithmetic is the shared pure domain
// function. Weight 0 and not calibrated in the current artifact, so the
// score never reads it. Pure module: imports solely domain helpers, no
// I/O, no clock, no network.
import { analysisBlock } from "../../../domain/onchain/pools.ts";

export const ONCHAIN_DEPLOYER_PLUGIN_ID = "dev.brandklipparen.onchain-deployer";
export const ONCHAIN_DEPLOYER_PLUGIN_VERSION = "1.0.0";

export const onchainDeployerPlugin = Object.freeze({
  id: ONCHAIN_DEPLOYER_PLUGIN_ID,
  version: ONCHAIN_DEPLOYER_PLUGIN_VERSION,
  weight: 0,
  calibrated: false,
  compute: Object.freeze({ analysisBlock }),
});
