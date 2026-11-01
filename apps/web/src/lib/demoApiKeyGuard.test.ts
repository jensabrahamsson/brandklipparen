import { describe, expect, test } from "vitest";
import { demoApiKeyDefine, demoApiKeyForBuild } from "./demoApiKeyGuard.ts";

describe("demo API key production guard (SEC-1 S-1)", () => {
  test("a production build with a demo key set fails closed", () => {
    expect(() => demoApiKeyForBuild("production", "synthetic-demo-key")).toThrow(
      /must not be set for a production build/,
    );
    expect(() => demoApiKeyDefine("production", "synthetic-demo-key")).toThrow(
      /must not be set for a production build/,
    );
  });

  test("a production build without a demo key defines an empty key", () => {
    expect(demoApiKeyForBuild("production", undefined)).toBe("");
    expect(demoApiKeyForBuild("production", "")).toBe("");
    expect(demoApiKeyDefine("production", undefined)).toEqual({
      "import.meta.env.VITE_DEMO_API_KEY": '""',
    });
  });

  test("dev keeps the demo key exactly as provided", () => {
    expect(demoApiKeyForBuild("development", "synthetic-demo-key")).toBe("synthetic-demo-key");
    expect(demoApiKeyForBuild("development", undefined)).toBe("");
    expect(demoApiKeyDefine("development", "synthetic-demo-key")).toEqual({});
  });
});
