// Typed REST client over the published v1 schema (A-04). All contract
// values travel as inert JSON text and are rendered as text only (K-507):
// no HTML parsing, no eval, no script injection surface.

import type {
  AnalyzeResult,
  AnalyzeSuccess,
  AssessmentState,
  HealthState,
  InvestigationState,
  InvestigationStep,
} from "../types.ts";

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

function investigateUrl(address: string): string {
  return `/v1/investigate?address=${encodeURIComponent(address)}`;
}

function investigateEventsUrl(address: string): string {
  return `/v1/investigate/events?address=${encodeURIComponent(address)}`;
}

type RawStep = {
  readonly step?: unknown;
  readonly toolId?: unknown;
  readonly rationale?: unknown;
  readonly evidenceIds?: unknown;
};

function toStep(raw: RawStep): InvestigationStep | null {
  if (
    typeof raw.step !== "number" ||
    typeof raw.toolId !== "string" ||
    typeof raw.rationale !== "string" ||
    !Array.isArray(raw.evidenceIds) ||
    !raw.evidenceIds.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return { step: raw.step, toolId: raw.toolId, rationale: raw.rationale, evidenceIds: raw.evidenceIds };
}

function toInvestigationState(body: unknown): InvestigationState {
  const record = body as Record<string, unknown>;
  const envelope = record["investigation"] as
    | { status?: unknown; report?: unknown; reason?: unknown; partial?: unknown }
    | undefined;
  const provider = typeof record["investigationProvider"] === "string" ? record["investigationProvider"] : "unknown";
  const modelId = typeof record["investigationModel"] === "string" ? record["investigationModel"] : "unknown";
  if (envelope === null || envelope === undefined || typeof envelope !== "object") {
    return { status: "failed", message: "Investigation failed.", steps: [] };
  }
  if (envelope.status === "not-configured") {
    return { status: "not-configured" };
  }
  if (envelope.status === "done") {
    const report = (envelope.report ?? {}) as {
      narrative?: unknown;
      droppedClaims?: unknown;
      steps?: unknown;
    };
    const steps = Array.isArray(report.steps)
      ? report.steps.map((entry) => toStep(entry as RawStep)).filter((entry) => entry !== null)
      : [];
    return {
      status: "done",
      steps,
      narrative: typeof report.narrative === "string" ? report.narrative : "",
      droppedClaims: typeof report.droppedClaims === "number" ? report.droppedClaims : 0,
      provider,
      modelId,
    };
  }
  const reason = (envelope.reason ?? {}) as { kind?: unknown; message?: unknown };
  const kind = typeof reason.kind === "string" ? reason.kind : "unknown";
  const message = typeof reason.message === "string" ? reason.message : "Investigation failed.";
  const partial = Array.isArray(envelope.partial)
    ? envelope.partial.map((entry) => toStep(entry as RawStep)).filter((entry) => entry !== null)
    : [];
  if (kind === "step-limit" || kind === "token-limit" || kind === "deadline") {
    return { status: "limit", message, steps: partial };
  }
  return { status: "failed", message, steps: partial };
}

// Completed-report path (S-076 fallback): POST-equivalent GET of the final
// envelope renders the same trace when the events transport is absent.
export async function fetchInvestigation(address: string, apiKey: string | null): Promise<InvestigationState> {
  const response = await fetch(investigateUrl(address), { headers: apiHeaders(apiKey) });
  if (!response.ok) {
    const failure = await readError(response, "request-failed");
    if (failure.code === "investigation-not-configured" || response.status === 501) {
      return { status: "not-configured" };
    }
    throw failure;
  }
  return toInvestigationState(await response.json());
}

// Step-events stream (S-076, K-036, P-37): one event per trace step in
// order, then the final report. Every event payload renders as inert text.
// Any transport failure throws, and the caller falls back to the
// completed-report path above.
export async function streamInvestigationEvents(
  address: string,
  apiKey: string | null,
  onStep: (step: InvestigationStep) => void,
): Promise<InvestigationState> {
  const response = await fetch(investigateEventsUrl(address), { headers: apiHeaders(apiKey) });
  if (!response.ok) {
    const failure = await readError(response, "request-failed");
    if (failure.code === "investigation-not-configured" || response.status === 501) {
      return { status: "not-configured" };
    }
    throw failure;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error("Investigation stream is unavailable.");
  }
  if (response.body === null) {
    throw new Error("Investigation stream is unavailable.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: InvestigationState | null = null;
  for (;;) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
      if (line === undefined) {
        continue;
      }
      const payload = JSON.parse(line.slice("data:".length).trim()) as { kind?: unknown };
      if (payload.kind === "step") {
        const step = toStep(payload as RawStep);
        if (step !== null) {
          onStep(step);
        }
      } else if (payload.kind === "report") {
        final = toInvestigationState(payload);
      }
    }
    if (chunk.done) {
      break;
    }
  }
  if (final === null) {
    throw new Error("Investigation stream ended without a report.");
  }
  // Streamed steps already reached the panel through onStep; the report
  // carries the same steps for readers without the stream.
  return final;
}

// Opt-in investigation with streaming and POST fallback (S-076): the
// events transport renders live steps; when it is absent or fails, the
// completed report renders the same trace.
export async function requestInvestigation(
  address: string,
  apiKey: string | null,
  onStep: (step: InvestigationStep) => void,
): Promise<{ state: InvestigationState; streamed: InvestigationStep[] }> {
  const streamed: InvestigationStep[] = [];
  const collect = (step: InvestigationStep): void => {
    streamed.push(step);
    onStep(step);
  };
  try {
    const state = await streamInvestigationEvents(address, apiKey, collect);
    if (state.status === "done") {
      return { state: { ...state, steps: streamed.length > 0 ? streamed : state.steps }, streamed };
    }
    if ((state.status === "limit" || state.status === "failed") && streamed.length > 0) {
      return { state: { ...state, steps: streamed }, streamed };
    }
    return { state, streamed };
  } catch {
    const state = await fetchInvestigation(address, apiKey);
    return { state, streamed };
  }
}
