// Redacted logging: the log field allowlist and secret redaction
// (K-509, M-16). Written first per A-21 (red): LOG_FIELD_ALLOWLIST and
// redactForLog do not exist in the observability module yet, so the
// imports below fail until they are implemented. No I/O, no secrets.
import { describe, expect, test } from "vitest";
import {
  buildAnalysisLogRecord,
  isAllowlistedLogRecord,
  LOG_FIELD_ALLOWLIST,
  redactForLog,
} from "../../../src/application/observability.ts";
import { REDACTED } from "../../../src/ports/config.ts";

// Placeholder secret-shaped values for the test only: neutralised shapes
// with no live target and no real key material.
const VECTORS: ReadonlyArray<{ readonly name: string; readonly input: unknown }> = Object.freeze([
  { name: "api key field", input: { apiKey: "placeholder-api-key-value" } },
  { name: "authorization header", input: { headers: { authorization: "Bearer placeholder-token" } } },
  {
    name: "key-bearing rpc url",
    input: { rpcUrl: "https://operator:placeholder-pass@rpc.example.invalid/v1?api_key=placeholder" },
  },
  { name: "bearer string", input: "Bearer placeholder-bearer-token" },
  { name: "nested password", input: { nested: { password: "placeholder-password" } } },
  { name: "secret field", input: { assessmentSecret: "placeholder-provider-secret" } },
  {
    name: "mixed record",
    input: {
      apiKeyId: "stable-key-id",
      address: "0x0102030405060708090a0b0c0d0e0f1011121314",
      nested: [{ token: "placeholder-nested-token" }, "plain note"],
    },
  },
]);

describe("redacted logging (K-509, M-16)", () => {
  test("k509_log_fields_follow_allowlist", () => {
    const record = buildAnalysisLogRecord({
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      address: "0x0102030405060708090a0b0c0d0e0f1011121314",
      codeHash: `0x${"ab".repeat(32)}`,
      modelVersion: "0.1.0",
      stepDurationsMs: { fastPathMs: 12 },
      outcome: "assessed",
      rpcCallCount: 2,
      assessmentCallCount: 0,
      assessmentCostUnits: 0,
      cacheHit: false,
    });
    expect(isAllowlistedLogRecord(record as unknown as Record<string, unknown>)).toBe(true);
    for (const key of Object.keys(record)) {
      expect(LOG_FIELD_ALLOWLIST).toContain(key);
    }
    // The required per-analysis fields from I-10 all belong to the list.
    for (const required of [
      "requestId",
      "address",
      "codeHash",
      "modelVersion",
      "stepDurationsMs",
      "outcome",
    ]) {
      expect(LOG_FIELD_ALLOWLIST).toContain(required);
    }
    // A record with a field outside the list is rejected.
    expect(
      isAllowlistedLogRecord({ ...(record as unknown as Record<string, unknown>), apiKey: "x" }),
    ).toBe(false);
  });

  test("sec1_s7_apikey_query_param_is_redacted_in_log_output", () => {
    const printed = JSON.stringify(
      redactForLog("https://api.etherscan.io/v2/api?chainid=1&apikey=synthetic-key-123&module=logs"),
    );
    expect(printed).not.toContain("synthetic-key-123");
    expect(printed).toContain("[REDACTED]");
  });

  test("k509_key_like_strings_redacted_in_output", () => {
    for (const vector of VECTORS) {
      const redacted = redactForLog(vector.input);
      const printed = JSON.stringify(redacted) ?? "";
      expect(printed).toContain(REDACTED);
    }
    // Allowed identifiers survive redaction untouched.
    const mixed = redactForLog({
      apiKeyId: "stable-key-id",
      address: "0x0102030405060708090a0b0c0d0e0f1011121314",
      codeHash: `0x${"ab".repeat(32)}`,
      outcome: "assessed",
    }) as Record<string, unknown>;
    expect(mixed["apiKeyId"]).toBe("stable-key-id");
    expect(mixed["address"]).toBe("0x0102030405060708090a0b0c0d0e0f1011121314");
    // No raw secret shape survives in any redacted vector.
    const secrets = [
      "placeholder-api-key-value",
      "placeholder-token",
      "placeholder-pass",
      "placeholder-bearer-token",
      "placeholder-password",
      "placeholder-provider-secret",
      "placeholder-nested-token",
    ];
    for (const vector of VECTORS) {
      const printed = JSON.stringify(redactForLog(vector.input)) ?? "";
      for (const secret of secrets) {
        if (JSON.stringify(vector.input)?.includes(secret) ?? false) {
          expect(printed).not.toContain(secret);
        }
      }
    }
  });
});
