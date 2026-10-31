import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, PERSONALIZE_TIMEOUT_MS, analyzeToken, fetchAssessment, fetchHealth, requestPersonalizeMapping } from "./api.ts";
import type { AnalyzeSuccess } from "../types.ts";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const ANALYZE_FIXTURE: AnalyzeSuccess = {
  kind: "assessed",
  target: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  block: 18000000,
  proxy: { kind: "none" },
  codeHash: "0xabc",
  modelVersion: "0.1.0",
  artifactChecksum: "checksum",
  indexVersion: "1.0.0",
  templateVersion: "1.0.0",
  assessedAt: 1700000000000,
  probabilities: { "rug-pull": 0.62, honeypot: 0.91, "bot-pump": 0.34 },
  score: 84,
  signals: [],
  explanation: { kind: "template", templateVersion: "1.0.0", claims: [] },
  cantTell: [],
  deepening: "pending",
};

describe("REST API client (K-021, K-305)", () => {
  test("k021_analyze_returns_score_and_probabilities", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      expect(String(url)).toContain("/v1/analyze");
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["x-api-key"]).toBe("demo-key");
      return jsonResponse(200, ANALYZE_FIXTURE, { "x-deepening-status": "pending" });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await analyzeToken("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "demo-key");
      expect(result.kind).toBe("assessed");
      if (result.kind !== "assessed") {
        return;
      }
      expect(result.score).toBe(84);
      expect(result.probabilities["honeypot"]).toBeCloseTo(0.91);
      expect(result.deepening).toBe("pending");
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("k021_analyze_validation_error_maps_to_typed_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          status: 400,
          code: "validation-error",
          message: "Invalid address: expected 0x followed by 40 hex characters.",
          requestId: "123e4567-e89b-12d3-a456-426614174000",
        }),
      ),
    );
    try {
      await expect(analyzeToken("0x123", "demo-key")).rejects.toMatchObject({ code: "validation-error" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("k305_assessment_not_configured_maps_to_typed_error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(501, {
          status: 501,
          code: "assessment-not-configured",
          message: "Assessment is not configured: set an assessment provider to enable it.",
          requestId: "123e4567-e89b-12d3-a456-426614174000",
        }),
      ),
    );
    try {
      const error = await fetchAssessment("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "demo-key").catch(
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("assessment-not-configured");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("k305_health_disabled_reports_not_configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, { status: "ok", apiVersion: "v1", assessment: { disabled: true }, costUnits: "placeholder-cost-unit" }),
      ),
    );
    try {
      const health = await fetchHealth();
      expect(health.assessment).toEqual({ disabled: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// Timeout cover for the AI personalize mapping call (P1-8): a slow
// model call must fall back to the deterministic order instead of
// hanging the page. Uses an injected fetch that never resolves on its
// own, asserting the caller observes the fallback (null) result.
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (init: RequestInit | undefined) => Promise<Response>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit): Promise<Response> => impl(init)),
  );
}

function hangingFetch(): (init: RequestInit | undefined) => Promise<Response> {
  // Never resolves by itself: only the abort signal settles it, the way a
  // hung provider connection behaves when the timeout fires.
  return (init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
}

test("personalize mapping times out after 15 seconds", () => {
  expect(PERSONALIZE_TIMEOUT_MS).toBe(15000);
});

test("personalize mapping falls back to null when the provider hangs", async () => {
  let seenInit: RequestInit | undefined;
  stubFetch((init) => {
    seenInit = init;
    return hangingFetch()(init);
  });
  const result = await requestPersonalizeMapping(null, "0xabc", "fees", { timeoutMs: 20 });
  expect(result).toBeNull();
  expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
});

test("personalize mapping returns the parsed body on success", async () => {
  const body = { personalize: { kind: "ok" } };
  let seenBody = "";
  stubFetch((init) => {
    seenBody = String(init?.body ?? "");
    return Promise.resolve({ ok: true, json: async () => body }) as unknown as Promise<Response>;
  });
  const result = await requestPersonalizeMapping(null, "0xabc", "fees", { timeoutMs: 1000 });
  expect(result).toEqual(body);
  expect(seenBody).toContain("fees");
});

test("personalize mapping falls back to null on server error", async () => {
  stubFetch(() => Promise.resolve({ ok: false, json: async () => ({}) }) as unknown as Promise<Response>);
  const result = await requestPersonalizeMapping(null, "0xabc", "fees", { timeoutMs: 1000 });
  expect(result).toBeNull();
});
