// Capability mapping (S-123): /health decides AI availability up front.
import { describe, expect, test } from "vitest";
import { toAiAvailability, toAvailability } from "./capabilities.ts";
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
      onchain: "unavailable",
    });
  });

  test("s123_configured_capabilities_are_available", () => {
    expect(toAvailability({ provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" })).toBe(
      "available",
    );
    expect(toAvailability({ available: true })).toBe("available");
    const availability = toAiAvailability({
      ...BASE,
      investigation: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
      explain: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
      chat: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
      rug: { provider: "hosted-open-weights", modelId: "meta-models/muse-spark-open-1026" },
      onchain: { available: true },
    });
    expect(availability).toEqual({
      investigation: "available",
      explain: "available",
      chat: "available",
      rug: "available",
      onchain: "available",
    });
  });

  test("s123_unknown_capabilities_keep_explicit_request", () => {
    expect(toAvailability(undefined)).toBe("available");
    const availability = toAiAvailability({ assessment: { disabled: true } });
    expect(availability).toEqual({
      investigation: "available",
      explain: "available",
      chat: "available",
      rug: "available",
      onchain: "available",
    });
    expect(toAiAvailability(null)).toEqual({
      investigation: "available",
      explain: "available",
      chat: "available",
      rug: "available",
      onchain: "available",
    });
  });
});
