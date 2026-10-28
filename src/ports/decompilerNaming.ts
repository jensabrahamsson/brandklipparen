// Decompiler naming port (S-083, K-038, K-519, D-11). Optional AI layer
// that suggests human-readable display names for function selectors. The
// suggestions are a labelled overlay only: they never enter the CFG, the
// SSA form, the emitted structure, the score or the evidence. A null port
// (the default wiring) answers `not-configured` with zero provider calls
// and the deterministic pseudo-Solidity stands.
export type SuggestedName = {
  readonly selector: string;
  readonly suggestedName: string;
};

export type DecompilerNamingOutcome =
  | { readonly kind: "ok"; readonly names: readonly SuggestedName[] }
  | { readonly kind: "not-configured" }
  | { readonly kind: "invalid-output" };

export type DecompilerNamingPort = {
  suggestNames(selectors: readonly string[]): Promise<DecompilerNamingOutcome>;
};
