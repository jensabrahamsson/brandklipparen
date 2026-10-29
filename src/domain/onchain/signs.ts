// Documented risk directions for the on-chain features (issue 2).
// Pure domain module: every mapped feature carries a domain prior decided
// from what the feature MEANS (unilateral control, locked liquidity,
// concentration), checked afterwards against TRAIN-only univariate
// evidence. A multisig or contract owner is not the same risk as an EOA
// owner: a single key acts alone, while a quorum or coded logic constrains
// unilateral action, so both are protective against the unknown baseline.
// Signs are never picked from test. A feature whose train evidence
// contradicts its prior keeps its constraint (the fit pins it at 0 rather
// than chasing noise); only a written reason here may relax one.
export type OnchainRiskDirection = "risk-increasing" | "risk-decreasing" | "excluded";

export type OnchainRiskEntry = {
  readonly direction: OnchainRiskDirection;
  readonly rationale: string;
};

export const ONCHAIN_RISK_DIRECTIONS: Readonly<Record<string, OnchainRiskEntry>> = Object.freeze({
  "owner_renounced": Object.freeze({
    direction: "risk-decreasing",
    rationale:
      "No owner can change parameters or move funds once renounced, so unilateral control is gone: protective against the unknown baseline.",
  }),
  "owner_eoa": Object.freeze({
    direction: "risk-increasing",
    rationale:
      "One externally owned key acts alone and can pause, mint, blacklist or drain at will: the classic unilateral rug control.",
  }),
  "owner_contract": Object.freeze({
    direction: "risk-decreasing",
    rationale:
      "A contract owner runs only its coded logic and cannot improvise like an EOA key; it is not the same risk as an EOA owner, so it counts protective against the unknown baseline even though hidden logic stays possible.",
  }),
  "owner_safe": Object.freeze({
    direction: "risk-decreasing",
    rationale:
      "A multisig needs a quorum of signatures, so no single key acts alone; it is not the same risk as an EOA owner and counts protective against the unknown baseline.",
  }),
  "lp_burned_share": Object.freeze({
    direction: "risk-decreasing",
    rationale: "Burned LP cannot be reclaimed to pull the pool, so a larger burned share is safer.",
  }),
  "lp_locker_share": Object.freeze({
    direction: "risk-decreasing",
    rationale:
      "Locked LP cannot be removed before expiry, so a larger locked share is safer. Train univariate evidence runs against this prior; the constraint is deliberately NOT relaxed (the fit pins the weight at 0 rather than fitting noise).",
  }),
  "lp_deployer_or_owner_share": Object.freeze({
    direction: "risk-increasing",
    rationale: "Deployer or owner held LP can be removed at will, which is the direct drain path.",
  }),
  "liquidity_removed_24h": Object.freeze({
    direction: "risk-increasing",
    rationale: "An affirmed minimum-liquidity-only supply proves the drain already happened at the snapshot block.",
  }),
  "conc_deployer_share": Object.freeze({
    direction: "risk-increasing",
    rationale: "A large deployer token share enables unilateral dumps; diagnostic-only (live parity pending).",
  }),
  "conc_top1_share": Object.freeze({
    direction: "risk-increasing",
    rationale:
      "A dominant single holder moves the price at will; diagnostic-only (live parity pending). Train univariate evidence runs below 0.5; the direction stays on domain reasoning since the feature never enters the model.",
  }),
  "conc_top10_share": Object.freeze({
    direction: "risk-increasing",
    rationale:
      "A concentrated top holder set moves the price together; diagnostic-only (live parity pending). Train univariate evidence runs below 0.5; the direction stays on domain reasoning since the feature never enters the model.",
  }),
  "liq_log10_1p_weth": Object.freeze({
    direction: "risk-decreasing",
    rationale: "Deeper quote-side liquidity absorbs sells and is costlier to fake; diagnostic-only (live parity pending).",
  }),
  "blocks_deploy_to_first_capped": Object.freeze({
    direction: "excluded",
    rationale:
      "Dropped from the model: even capped, the deploy-to-first-liquidity delay proxies launch era (the cap binds almost exclusively old legit tokens), so it must not carry weight. Kept in the mapping as a diagnostic only.",
  }),
});

// Constraint form for the logistic fitter: pos pins weights at 0 from
// below, neg pins at 0 from above, excluded features never reach a fit.
export function signConstraintOf(feature: string): "pos" | "neg" | "free" | "excluded" {
  const entry = ONCHAIN_RISK_DIRECTIONS[feature];
  if (entry === undefined) {
    return "free";
  }
  switch (entry.direction) {
    case "risk-increasing":
      return "pos";
    case "risk-decreasing":
      return "neg";
    case "excluded":
      return "excluded";
  }
}
