// Capability mapping (S-123): /health decides AI availability up front.
import { describe, expect, test } from "vitest";
import { toAiAvailability, toAvailability, toExplainCodeAvailability, toMarketAvailability } from "./capabilities.ts";
import type { HealthState } from "../types.ts";

const BASE: HealthState = {
  assessment: { disabled: true },
  investigation: { disabled: true },
  explain: { disabled: true },
  personalize: { disabled: true },
  onchain: { disabled: true },
};

describe("ai capabilities", () => {
  test("s123_disabled_capabilities_are_unavailable", () => {
    expect(toAvailability({ disabled: true })).toBe("unavailable");
    const availability = toAiAvailability(BASE);
    expect(availability).toEqual({
      investigation: "unavailable",
      explain: "unavailable",
      chat: "available",
      rug: "available",
      explainCode: "available",
      onchain: "unavailable",
    });
  });

  test("s123_configured_capabilities_are_available", () => {
    expect(toAvailability({ provider: "meta-model-api", modelId: "meta-models/muse-spark-open-1026" })).toBe(
      "available",
    );
    expect(toAvailability({ available: true })).toBe("available");
    const availability = toAiAvailability({
      ...BASE,
      investigation: { provider: "meta-model-api", modelId: "meta-models/muse-spark-open-1026" },
      explain: { provider: "meta-model-api", modelId: "meta-models/muse-spark-open-1026" },
      chat: { provider: "meta-model-api", modelId: "meta-models/muse-spark-open-1026" },
      rug: { provider: "meta-model-api", modelId: "meta-models/muse-spark-open-1026" },
      onchain: { available: true },
    });
    expect(availability).toEqual({
      investigation: "available",
      explain: "available",
      chat: "available",
      rug: "available",
      explainCode: "available",
      onchain: "available",
    });
  });

  test("dx1_market_listing_follows_the_health_market_field", () => {
    expect(toMarketAvailability(null)).toBe("unavailable");
    expect(toMarketAvailability(BASE)).toBe("unavailable");
    expect(toMarketAvailability({ ...BASE, market: { disabled: true } })).toBe("unavailable");
    expect(toMarketAvailability({ ...BASE, market: { provider: "dexscreener" } })).toBe("available");
  });

  test("s123_unknown_capabilities_keep_explicit_request", () => {
    expect(toAvailability(undefined)).toBe("available");
    const availability = toAiAvailability({ assessment: { disabled: true } });
    expect(availability).toEqual({
      investigation: "available",
      explain: "available",
      chat: "available",
      rug: "available",
      explainCode: "available",
      onchain: "available",
    });
    expect(toAiAvailability(null)).toEqual({
      investigation: "available",
      explain: "available",
      chat: "available",
      rug: "available",
      explainCode: "available",
      onchain: "available",
    });
  });

  test("vs2_explain_code_follows_the_health_explain_code_field", () => {
    expect(toExplainCodeAvailability(null)).toBe("available");
    expect(toExplainCodeAvailability({ assessment: { disabled: true } })).toBe("available");
    expect(toExplainCodeAvailability({ assessment: { disabled: true }, explainCode: { disabled: true } })).toBe(
      "unavailable",
    );
    expect(
      toExplainCodeAvailability({
        assessment: { disabled: true },
        explainCode: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
      }),
    ).toBe("available");
    // A disabled feature hides the button instead of a dead control.
    expect(
      toAiAvailability({ assessment: { disabled: true }, explainCode: { disabled: true } }).explainCode,
    ).toBe("unavailable");
  });
});
