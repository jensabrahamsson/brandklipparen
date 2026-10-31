import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ApiError,
  PERSONALIZE_TIMEOUT_MS,
  analyzeToken,
  fetchAssessment,
  fetchChat,
  fetchHealth,
  fetchRug,
  pickExplainSource,
  requestPersonalizeMapping,
} from "./api.ts";
import type { AnalyzeSuccess } from "../types.ts";
import type { HealthState } from "../types.ts";

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

test("personalize mapping composes a caller abort with the timeout", async () => {
  let seenInit: RequestInit | undefined;
  stubFetch((init) => {
    seenInit = init;
    return hangingFetch()(init);
  });
  const controller = new AbortController();
  const pending = requestPersonalizeMapping(null, "0xabc", "fees", { timeoutMs: 1000, signal: controller.signal });
  controller.abort();
  const result = await pending;
  expect(result).toBeNull();
  expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  expect(seenInit?.signal?.aborted).toBe(true);
});

// Muse console overlays (UI v2 §1.2, W-3): /v1/chat answers and /v1/rug
// narratives parse beside /v1/explain, and the single Explain button
// picks the first configured source.
describe("muse console overlays", () => {
  const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  function chatOk(): Response {
    return jsonResponse(200, {
      chat: {
        kind: "ok",
        answers: ["The owner can stop you from selling."],
        droppedClaims: 1,
        provider: "meta-model-api",
        modelId: "muse-spark-1.3",
      },
    });
  }

  test("chat_posts_the_question_and_returns_answers", async () => {
    let seenUrl = "";
    let seenBody = "";
    let seenMethod = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
        seenUrl = String(url);
        seenMethod = String(init?.method ?? "GET");
        seenBody = String(init?.body ?? "");
        return chatOk();
      }),
    );
    try {
      const state = await fetchChat(ADDRESS, null, "Can the owner stop me selling?");
      expect(seenUrl).toContain("/v1/chat");
      expect(seenMethod).toBe("POST");
      expect(seenBody).toContain("Can the owner stop me selling?");
      expect(state.status).toBe("ready");
      if (state.status !== "ready") {
        return;
      }
      expect(state.answers).toEqual(["The owner can stop you from selling."]);
      expect(state.droppedClaims).toBe(1);
      expect(state.modelId).toBe("muse-spark-1.3");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("chat_rejects_empty_and_oversize_questions_without_a_request", async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => chatOk());
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await fetchChat(ADDRESS, null, "   ")).toEqual({ status: "failed" });
      expect(await fetchChat(ADDRESS, null, "x".repeat(501))).toEqual({ status: "failed" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("chat_not_configured_maps_to_not_configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { chat: { kind: "not-configured" } })));
    try {
      expect(await fetchChat(ADDRESS, null, "Can the owner stop me selling?")).toEqual({
        status: "not-configured",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("rug_returns_the_narrative_with_its_model", async () => {
    let seenUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string): Promise<Response> => {
        seenUrl = String(url);
        return jsonResponse(200, {
          rug: {
            kind: "ok",
            narrative: ["The owner controls the transfer path."],
            droppedClaims: 0,
            provider: "meta-model-api",
            modelId: "muse-spark-1.3",
          },
        });
      }),
    );
    try {
      const state = await fetchRug(ADDRESS, null);
      expect(seenUrl).toContain("/v1/rug");
      expect(state.status).toBe("ready");
      if (state.status !== "ready") {
        return;
      }
      expect(state.narrative).toEqual(["The owner controls the transfer path."]);
      expect(state.modelId).toBe("muse-spark-1.3");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("rug_not_configured_maps_to_not_configured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { rug: { kind: "not-configured" } })));
    try {
      expect(await fetchRug(ADDRESS, null)).toEqual({ status: "not-configured" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("explain_source_prefers_explain_then_rug_then_assessment", () => {
    const disabled = { disabled: true } as const;
    const configured = { provider: "meta-model-api", modelId: "muse-spark-1.3" } as const;
    const base: HealthState = {
      assessment: disabled,
      investigation: disabled,
      explain: disabled,
      chat: disabled,
      rug: disabled,
      onchain: { disabled: true },
    };
    expect(pickExplainSource(null)).toBe("explain");
    expect(pickExplainSource({ ...base, explain: configured })).toBe("explain");
    expect(pickExplainSource({ ...base, rug: configured })).toBe("rug");
    expect(pickExplainSource({ ...base, assessment: configured })).toBe("assessment");
    expect(pickExplainSource(base)).toBeNull();
  });
});
