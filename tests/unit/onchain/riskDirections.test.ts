// Risk-direction table tests (issue 2): every on-chain feature carries a
// documented domain prior, Safe/multisig and contract owners are protective
// (never EOA-like risk), and the era-proxied deploy-to-first feature is
// excluded from the model. Signs come from domain reasoning, never test.
import { describe, expect, test } from "vitest";
import { ONCHAIN_RISK_DIRECTIONS } from "../../../src/domain/onchain/signs.ts";
import { ONCHAIN_FEATURE_NAMES } from "../../../src/domain/onchain/snapshot.ts";

describe("onchain risk directions", () => {
  test("every mapped feature has a documented direction", () => {
    for (const name of ONCHAIN_FEATURE_NAMES) {
      const entry = ONCHAIN_RISK_DIRECTIONS[name];
      expect(entry).toBeDefined();
      expect(entry?.rationale.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("multisig and contract owners are protective, never EOA-like", () => {
    expect(ONCHAIN_RISK_DIRECTIONS["owner_safe"]?.direction).toBe("risk-decreasing");
    expect(ONCHAIN_RISK_DIRECTIONS["owner_contract"]?.direction).toBe("risk-decreasing");
    expect(ONCHAIN_RISK_DIRECTIONS["owner_eoa"]?.direction).toBe("risk-increasing");
    expect(ONCHAIN_RISK_DIRECTIONS["owner_renounced"]?.direction).toBe("risk-decreasing");
  });

  test("the era-proxied deploy-to-first feature is excluded from the model", () => {
    expect(ONCHAIN_RISK_DIRECTIONS["blocks_deploy_to_first_capped"]?.direction).toBe("excluded");
  });

  test("locked and burned shares stay protective without relaxation to noise", () => {
    expect(ONCHAIN_RISK_DIRECTIONS["lp_locker_share"]?.direction).toBe("risk-decreasing");
    expect(ONCHAIN_RISK_DIRECTIONS["lp_burned_share"]?.direction).toBe("risk-decreasing");
    expect(ONCHAIN_RISK_DIRECTIONS["lp_deployer_or_owner_share"]?.direction).toBe("risk-increasing");
    expect(ONCHAIN_RISK_DIRECTIONS["liquidity_removed_24h"]?.direction).toBe("risk-increasing");
  });
});
