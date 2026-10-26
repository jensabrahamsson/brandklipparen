// Can't-tell list (K-012): the questions bytecode analysis leaves open.
// Pure domain module with a static catalogue. Each item names the data
// source that would settle the question; liquidity locks, owner shares,
// wallet clusters, team and intent need off-chain data by construction, so
// no bytecode, threshold or weight steers this list.
export type CantTellQuestion =
  | "liquidity-locks"
  | "owner-shares"
  | "wallet-clusters"
  | "team-identity"
  | "code-intent"
  | "external-contracts";

export type CantTellDataSource =
  | "liquidity-lock-registry"
  | "holder-distribution-feed"
  | "wallet-cluster-index"
  | "team-disclosure"
  | "code-audit-report"
  | "contract-analysis-queue";

export type CantTellItem = {
  readonly question: CantTellQuestion;
  readonly dataSource: CantTellDataSource;
};

const CATALOGUE: readonly CantTellItem[] = Object.freeze([
  { question: "liquidity-locks", dataSource: "liquidity-lock-registry" },
  { question: "owner-shares", dataSource: "holder-distribution-feed" },
  { question: "wallet-clusters", dataSource: "wallet-cluster-index" },
  { question: "team-identity", dataSource: "team-disclosure" },
  { question: "code-intent", dataSource: "team-disclosure" },
  { question: "external-contracts", dataSource: "contract-analysis-queue" },
]);

// The standard list shown beside the score. Returns a new frozen array on
// every run, so callers cannot mutate the shared catalogue.
export function standardCantTell(): readonly CantTellItem[] {
  return Object.freeze(CATALOGUE.slice());
}
