// Tests for S-013 (K-012): the can't-tell list names an explicit data
// source per question. Written first (red) per A-21; the implementation
// lives in src/domain/cantTell.ts. The catalogue is static: these questions
// need off-chain data by construction, so no bytecode, thresholds or
// weights steer the list.
import { describe, expect, test } from "vitest";
import { standardCantTell } from "../../../src/domain/cantTell.ts";

describe("k012 can't-tell list", () => {
  test("k012_each_item_names_required_data_source", () => {
    const items = standardCantTell();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.dataSource.length).toBeGreaterThan(0);
    }
    const questions = items.map((item) => item.question);
    expect(new Set(questions).size).toBe(questions.length);
  });

  test("k012_list_covers_liquidity_owner_and_cluster_questions", () => {
    const questions = standardCantTell().map((item) => item.question);
    expect(questions).toContain("liquidity-locks");
    expect(questions).toContain("owner-shares");
    expect(questions).toContain("wallet-clusters");
  });

  test("k012_list_is_stable_and_frozen", () => {
    const first = standardCantTell();
    const second = standardCantTell();
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
