// Extended-proof diagnostics behind the application service (VS-B1, S-104).
// Driving adapters (REST) reach the per-detector proof reports exclusively
// through this application module, never by importing `src/plugins`
// directly: the dependency gate forbids interfaces-to-plugins imports.
// The plugin module still owns the walk; this module fixes the direction
// of the dependency and carries the bounded per-code-hash memo so a
// long-lived server cannot grow without bound. Never part of scoring.
import { explainExtendedProof } from "../plugins/detectors/extendedProof.ts";
import type {
  ExtendedProof as PluginExtendedProof,
  ExtendedProofStep as PluginExtendedProofStep,
} from "../plugins/detectors/extendedProof.ts";
import type { Bytecode as BytecodeType } from "../domain/types.ts";

export type ExtendedProof = PluginExtendedProof;
export type ExtendedProofStep = PluginExtendedProofStep;

export type ProofService = {
  readonly proofsFor: (bytecode: BytecodeType, codeHash: string) => readonly ExtendedProof[];
};

const PROOF_CACHE_CAP = 256;

export function createProofService(): ProofService {
  const cache = new Map<string, readonly ExtendedProof[]>();
  const proofsFor = (bytecode: BytecodeType, codeHash: string): readonly ExtendedProof[] => {
    const hit = cache.get(codeHash);
    if (hit !== undefined) {
      return hit;
    }
    const proofs = explainExtendedProof(bytecode);
    if (cache.size >= PROOF_CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(codeHash, proofs);
    return proofs;
  };
  return Object.freeze({ proofsFor });
}
