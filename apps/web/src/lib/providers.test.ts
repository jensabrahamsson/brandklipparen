import { describe, expect, test } from "vitest";
import { modelDisplayLabel, providerDisplayName } from "./providers.ts";

describe("model display label", () => {
  test("the configured model reads as a human label", () => {
    expect(modelDisplayLabel("muse-spark-1.3")).toBe("Muse Spark 1.3 · Meta");
  });

  test("unknown model ids pass through unchanged", () => {
    expect(modelDisplayLabel("other-model-1")).toBe("other-model-1");
  });

  test("provider display name stays mapped", () => {
    expect(providerDisplayName("meta-model-api")).toBe("Meta Model API");
  });
});
