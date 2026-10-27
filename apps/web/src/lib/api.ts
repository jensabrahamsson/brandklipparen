// Typed REST client over the published v1 schema (A-04). All contract
// values travel as inert JSON text and are rendered as text only (K-507):
// no HTML parsing, no eval, no script injection surface.

import type { AnalyzeResult, AnalyzeSuccess, AssessmentState, HealthState } from "../types.ts";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

type ErrorBody = {
  readonly code?: unknown;
  readonly message?: unknown;
};

async function readError(response: Response, fallbackCode: string): Promise<ApiError> {
  let code = fallbackCode;
  let message = `Request failed with status ${response.status}.`;
  try {
    const body = (await response.json()) as ErrorBody;
    if (typeof body.code === "string" && body.code.length > 0) {
      code = body.code;
    }
    if (typeof body.message === "string" && body.message.length > 0) {
      message = body.message;
    }
  } catch {
    // Keep the fallback: a non-JSON error body is still a typed error.
  }
  return new ApiError(code, response.status, message);
}

function apiHeaders(apiKey: string | null): Record<string, string> {
  if (apiKey === null || apiKey.length === 0) {
    return {};
  }
  return { "x-api-key": apiKey };
}

function analyzeUrl(address: string): string {
  return `/v1/analyze?address=${encodeURIComponent(address)}`;
}

function assessmentUrl(address: string): string {
  return `/v1/assessment?address=${encodeURIComponent(address)}`;
}

function toAnalyzeResult(body: unknown, response: Response): AnalyzeResult {
  const record = body as Record<string, unknown>;
  if (record["kind"] === "no-contract") {
    return {
      kind: "no-contract",
      target: String(record["target"] ?? ""),
      block: Number(record["block"] ?? 0),
    };
  }
  const success = body as AnalyzeSuccess;
  const deepening = response.headers.get("x-deepening-status");
  return { ...success, deepening: deepening === "ready" ? "ready" : "pending" };
}

export async function analyzeToken(address: string, apiKey: string | null): Promise<AnalyzeResult> {
  const response = await fetch(analyzeUrl(address), { headers: apiHeaders(apiKey) });
  if (!response.ok) {
    throw await readError(response, "request-failed");
  }
  return toAnalyzeResult(await response.json(), response);
}

export async function fetchAssessment(address: string, apiKey: string | null): Promise<AssessmentState> {
  const response = await fetch(assessmentUrl(address), { headers: apiHeaders(apiKey) });
  if (!response.ok) {
    throw await readError(response, "request-failed");
  }
  const record = (await response.json()) as Record<string, unknown>;
  const assessment = record["assessment"] as { text?: unknown; provider?: unknown; modelId?: unknown } | null;
  if (assessment === null || assessment === undefined || typeof assessment.text !== "string") {
    return { status: "not-configured" };
  }
  return {
    status: "ready",
    text: assessment.text,
    provider: typeof assessment.provider === "string" ? assessment.provider : "unknown",
    modelId: typeof assessment.modelId === "string" ? assessment.modelId : "unknown",
  };
}

export async function fetchHealth(): Promise<HealthState> {
  const response = await fetch("/health");
  if (!response.ok) {
    throw await readError(response, "request-failed");
  }
  return (await response.json()) as HealthState;
}
