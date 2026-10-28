// Real-token smoke harness units (Task C).
// Written first per A-21 (red): scripts/smoke-real-tokens.ts does not
// exist yet. Every fixture here is synthetic: tiny handcrafted bytecode,
// fake symbols and obviously fake addresses. The report builder and the
// confusion math are pure and take injected runners, so no test touches
// the network, the filesystem or a real binary; extdecomp is mocked.
import { describe, expect, test } from "vitest";
import {
  bandOf,
  buildReport,
  confusionSummary,
  mean,
  median,
  runSmoke,
  sanitize,
  validateFixture,
} from "../../scripts/smoke-real-tokens.ts";
import type { SmokeOutcome } from "../../scripts/smoke-real-tokens.ts";

// Synthetic placeholder addresses, built at runtime so no literal address
// appears in the source.
const FAKE_ADDR_1 = "0x" + "e1".repeat(20);
const FAKE_ADDR_2 = "0x" + "e2".repeat(20);
const FAKE_ADDR_3 = "0x" + "e3".repeat(20);
const FAKE_ADDR_4 = "0x" + "e4".repeat(20);
const FAKE_ADDR_5 = "0x" + "e5".repeat(20);

const BYTECODE_SIMPLE = "0x8063a9059cbb1460005700ff";
const BYTECODE_PLAIN = "0x8063a9059cbb1460005700";

function tokenOf(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    address: FAKE_ADDR_1,
    symbol: "FAKEA",
    name: "Fake Token A",
    label: "legit",
    labelSource: "synthetic-test-only",
    block: 18000000,
    codehash: "0x1234",
    bytecode: BYTECODE_SIMPLE,
    ...(overrides ?? {}),
  };
}

describe("smoke fixture validation (Task C)", () => {
  test("valid_synthetic_tokens_pass_and_invalid_are_reported_without_throw", () => {
    const raw = [tokenOf(), tokenOf({ symbol: "FAKEB", label: "rug", address: FAKE_ADDR_2, bytecode: "not-hex" }), "nope"];
    const { tokens, invalid } = validateFixture(raw);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.symbol).toBe("FAKEA");
    expect(invalid).toHaveLength(2);
  });

  test("unexpected_top_level_shape_reports_everything_invalid", () => {
    const { tokens, invalid } = validateFixture({ nope: true });
    expect(tokens).toHaveLength(0);
    expect(invalid.length).toBeGreaterThan(0);
  });
});

describe("smoke report math (Task C)", () => {
  test("bands_follow_the_ui_thresholds", () => {
    expect(bandOf(0)).toBe("Low");
    expect(bandOf(29)).toBe("Low");
    expect(bandOf(30)).toBe("Elevated");
    expect(bandOf(59)).toBe("Elevated");
    expect(bandOf(60)).toBe("High");
    expect(bandOf(100)).toBe("High");
  });

  test("mean_and_median_cover_empty_and_even_inputs", () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(mean([10, 20, 30])).toBe(20);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  test("sanitize_removes_addresses_and_hashes", () => {
    // Synthetic placeholders only: repeated digits, never a real address.
    const dirty =
      "no code at address " + FAKE_ADDR_3 + " plus 0x" +
      "ab".repeat(32) +
      " plus 0x" +
      "cd".repeat(12) +
      " tail";
    const clean = sanitize(dirty);
    expect(clean).not.toContain(FAKE_ADDR_3);
    expect(clean).not.toMatch(/0x[0-9a-fA-F]{20,}/);
    expect(clean).toContain("[address]");
    expect(clean).toContain("[hash]");
    expect(clean).toContain("[bytes]");
  });
});

function outcomeOf(overrides: Partial<SmokeOutcome> & { symbol: string }): SmokeOutcome {
  return {
    status: "ok",
    label: "legit",
    proxy: false,
    score: 10,
    band: "Low",
    topEvidence: [],
    runtimeMs: 5,
    ...overrides,
  } as SmokeOutcome;
}

describe("smoke confusion summary (Task C)", () => {
  test("confusion_flags_legit_high_risk_and_bad_low_risk", () => {
    const outcomes: SmokeOutcome[] = [
      outcomeOf({ symbol: "GOODA", label: "legit", score: 10, band: "Low" }),
      outcomeOf({ symbol: "GOODB", label: "legit", score: 95, band: "High" }),
      outcomeOf({ symbol: "BADA", label: "rug", score: 90, band: "High" }),
      outcomeOf({ symbol: "BADB", label: "honeypot", score: 5, band: "Low" }),
    ];
    const summary = confusionSummary(outcomes);
    expect(summary.legitHighRisk).toEqual(["GOODB"]);
    expect(summary.badLowRisk).toEqual(["BADB"]);
    expect(summary.counts.legit.High).toBe(1);
    expect(summary.counts.bad.Low).toBe(1);
  });
});

describe("smoke report builder (Task C)", () => {
  test("report_names_symbols_only_and_covers_every_section", () => {
    const outcomes: SmokeOutcome[] = [outcomeOf({ symbol: "FAKEA", score: 42, band: "Elevated" })];
    const markdown = buildReport({
      outcomes,
      invalid: [{ index: 3, symbol: "BROKEN", errors: ["missing bytecode"] }],
      extdecomp: {
        enabled: true,
        successRate: 1,
        meanFunctions: 2,
        meanOwnSelectors: 1,
        deltas: [{ symbol: "FAKEA", extdecompFunctions: 2, ownSelectors: 1, success: true }],
      },
      totalMs: 120,
      startedAt: "2026-10-28T12:00:00.000Z",
    });
    for (const section of [
      "Per-token results",
      "Confusion summary",
      "Score by label",
      "Crashes and timeouts",
      "extdecomp comparison",
    ]) {
      expect(markdown).toContain(section);
    }
    expect(markdown).toContain("FAKEA");
    expect(markdown).toContain("BROKEN");
    expect(markdown).not.toContain(FAKE_ADDR_1);
    expect(markdown).not.toContain(BYTECODE_SIMPLE);
  });
});

describe("smoke label provenance (labelSource, labelNote, labelBasis)", () => {
  test("long_label_sources_validate_up_to_the_relaxed_limit", () => {
    const { tokens, invalid } = validateFixture([
      tokenOf({ labelSource: "p".repeat(280) }),
      tokenOf({ symbol: "FAKEB", address: FAKE_ADDR_2, labelSource: "q".repeat(4096) }),
    ]);
    expect(invalid).toEqual([]);
    expect(tokens).toHaveLength(2);
  });

  test("label_source_past_the_relaxed_limit_is_rejected", () => {
    const { tokens, invalid } = validateFixture([tokenOf({ labelSource: "p".repeat(4097) })]);
    expect(tokens).toHaveLength(0);
    expect(invalid).toHaveLength(1);
  });

  test("label_note_and_label_basis_validate", () => {
    const { tokens, invalid } = validateFixture([
      tokenOf({ labelNote: "saw the incident thread", labelBasis: "incident-report" }),
      tokenOf({ symbol: "FAKEB", address: FAKE_ADDR_2, labelNote: "", labelBasis: "dataset" }),
      tokenOf({ symbol: "FAKEC", address: FAKE_ADDR_3, labelBasis: "token-list" }),
    ]);
    expect(invalid).toEqual([]);
    expect(tokens).toHaveLength(3);
  });

  test("unknown_label_basis_and_non_string_note_are_rejected", () => {
    const { tokens, invalid } = validateFixture([
      tokenOf({ labelBasis: "gossip" }),
      tokenOf({ symbol: "FAKEB", address: FAKE_ADDR_2, labelNote: 42 }),
    ]);
    expect(tokens).toHaveLength(0);
    expect(invalid).toHaveLength(2);
  });

  test("provenance_fields_never_reach_the_report", () => {
    const longSource = "p".repeat(280);
    const { tokens, invalid } = validateFixture([
      tokenOf({ labelSource: longSource, labelNote: "private note", labelBasis: "dataset" }),
    ]);
    expect(invalid).toEqual([]);
    expect(tokens).toHaveLength(1);
    const markdown = buildReport({
      outcomes: [outcomeOf({ symbol: "FAKEA", label: "legit", score: 35, band: "Elevated" })],
      invalid,
      extdecomp: { enabled: false, successRate: 0, meanFunctions: 0, meanOwnSelectors: 0, deltas: [] },
      totalMs: 5,
      startedAt: "2026-10-28T12:00:00.000Z",
    });
    expect(markdown).not.toContain(longSource);
    expect(markdown).not.toContain("private note");
  });
});

describe("smoke offline wiring (Task C)", () => {
  test("offline_catalogue_matches_composed_servers", async () => {
    const { DEFAULT_CAPABILITY_CATALOGUE } = await import("../../src/composition/app.ts");
    const { OFFLINE_CAPABILITY_CATALOGUE } = await import("../../scripts/smoke-real-tokens.ts");
    expect(OFFLINE_CAPABILITY_CATALOGUE).toEqual(DEFAULT_CAPABILITY_CATALOGUE);
  });
});

describe("smoke runner (Task C)", () => {
  test("run_smoke_records_ok_timeout_and_crash_per_token", async () => {
    const { tokens } = validateFixture([
      tokenOf(),
      tokenOf({ symbol: "HANG", address: FAKE_ADDR_4 }),
      tokenOf({ symbol: "BOOM", address: FAKE_ADDR_5 }),
    ]);
    const analyze = async (token: { symbol: string }): Promise<{ score: number; topEvidence: string[] }> => {
      if (token.symbol === "HANG") {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      if (token.symbol === "BOOM") {
        throw new Error("synthetic analysis crash");
      }
      return { score: 12, topEvidence: ["signal:0xa9059cbb (selector 0xa9059cbb)"] };
    };
    const decompile = async (): Promise<{ success: boolean; functions: number }> => ({ success: true, functions: 1 });
    const { outcomes } = await runSmoke(tokens, { analyze, decompile, timeoutMs: 50 });
    expect(outcomes.map((outcome) => outcome.symbol)).toEqual(["FAKEA", "HANG", "BOOM"]);
    expect(outcomes[0]?.status).toBe("ok");
    const hang = outcomes[1];
    expect(hang?.status).toBe("timeout");
    if (hang?.status === "timeout") {
      expect(hang.error).toContain("timed out");
    }
    expect(outcomes[2]?.status).toBe("crash");
  });

  test("run_smoke_counts_own_selectors_without_a_decompiler", async () => {
    const { tokens } = validateFixture([tokenOf({ bytecode: BYTECODE_PLAIN })]);
    const seen: string[] = [];
    const analyze = async (): Promise<{ score: number; topEvidence: string[] }> => {
      seen.push("analyzed");
      return { score: 7, topEvidence: [] };
    };
    const { outcomes } = await runSmoke(tokens, { analyze, timeoutMs: 5000 });
    expect(seen).toEqual(["analyzed"]);
    const first = outcomes[0];
    expect(first?.status).toBe("ok");
    if (first?.status === "ok") {
      expect(first.ownSelectors).toBeGreaterThan(0);
    }
  });
});
