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
import type { PluginListEntry } from "../components/PluginsPanel.tsx";
import { toPluginListEntries } from "./plugins.ts";

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

// Registry plugin list for the schema-driven panel (S-059, K-034, P-18).
// Enhancement only: any failure maps to null and the panel renders the
// analysis findings without registry names or output schemas, falling back
// to canonical JSON text per P-10.
// Streamed analysis events (S-100, K-101): one SSE body read as text —
// the analysis event first, then the deepening status. The caller renders
// the analysis before the deepening line; the analyze response for the
// same input stays byte-identical. Null on any failure.
export type AnalyzeStream = {
  readonly analysis: { readonly kind: string; readonly score?: unknown };
  readonly deepening: string;
};

export async function fetchAnalyzeStream(address: string, apiKey: string | null): Promise<AnalyzeStream | null> {
  try {
    const response = await fetch(`/v1/analyze/stream?address=${encodeURIComponent(address)}`, {
      headers: apiHeaders(apiKey),
    });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    const payloads: unknown[] = [];
    for (const chunk of text.split("\n\n")) {
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) {
          try {
            payloads.push(JSON.parse(line.slice("data:".length).trim()) as unknown);
          } catch {
            return null;
          }
        }
      }
    }
    const first = payloads[0] as { kind?: unknown; score?: unknown } | undefined;
    if (first === undefined || typeof first !== "object" || first === null) {
      return null;
    }
    let deepening = "pending";
    for (const payload of payloads.slice(1)) {
      const record = payload as { kind?: unknown; status?: unknown } | null;
      if (record !== null && typeof record === "object" && record.kind === "deepening" && typeof record.status === "string") {
        deepening = record.status;
      }
    }
    return { analysis: { kind: String(first.kind ?? ""), score: first.score }, deepening };
  } catch {
    return null;
  }
}

// Sentence-level explanation overlay (S-101, K-302): fetched only when
// the visitor asks. Sentences render as inert text; the drop count names
// how many model sentences failed the evidence check.
export type ExplainState =
  | { readonly status: "not-configured" }
  | { readonly status: "ready"; readonly narrative: readonly string[]; readonly droppedClaims: number }
  | { readonly status: "fallback" }
  | { readonly status: "failed" };

export async function fetchExplain(address: string, apiKey: string | null): Promise<ExplainState> {
  try {
    const response = await fetch(`/v1/explain?address=${encodeURIComponent(address)}`, {
      headers: apiHeaders(apiKey),
    });
    if (!response.ok) {
      return { status: "failed" };
    }
    const body = (await response.json()) as { explain?: unknown };
    const explain = body.explain as { kind?: unknown; narrative?: unknown; droppedClaims?: unknown } | null;
    if (explain === null || explain === undefined || typeof explain !== "object") {
      return { status: "fallback" };
    }
    if (explain.kind === "not-configured") {
      return { status: "not-configured" };
    }
    if (explain.kind === "ok" && Array.isArray(explain.narrative) && typeof explain.droppedClaims === "number") {
      const narrative = explain.narrative.filter((entry): entry is string => typeof entry === "string");
      if (narrative.length !== explain.narrative.length) {
        return { status: "fallback" };
      }
      return { status: "ready", narrative, droppedClaims: explain.droppedClaims };
    }
    return { status: "fallback" };
  } catch {
    return { status: "failed" };
  }
}

export type OnchainFeaturesState =
  | { readonly status: "not-configured" }
  | { readonly status: "ready"; readonly features: unknown }
  | { readonly status: "failed" };

// Point-in-time on-chain features (session A): serving-mode reads at the
// current block, display data only. A 501 with the onchain-not-configured
// code disables the panel; anything else unreadable is a failure.
export async function fetchOnchainFeatures(address: string, apiKey: string | null): Promise<OnchainFeaturesState> {
  try {
    const response = await fetch(`/v1/onchain-features?address=${encodeURIComponent(address)}`, {
      headers: apiHeaders(apiKey),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      if (response.status === 501 && body !== null && body.code === "onchain-not-configured") {
        return { status: "not-configured" };
      }
      return { status: "failed" };
    }
    const body = (await response.json()) as { features?: unknown };
    if (body.features === undefined || body.features === null || typeof body.features !== "object") {
      return { status: "failed" };
    }
    return { status: "ready", features: body.features };
  } catch {
    return { status: "failed" };
  }
}

export async function fetchPlugins(apiKey: string | null): Promise<readonly PluginListEntry[] | null> {
  try {
    const response = await fetch("/v1/plugins", { headers: apiHeaders(apiKey) });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { plugins?: unknown };
    const entries = toPluginListEntries(body.plugins);
    return entries;
  } catch {
    return null;
  }
}

// Mapping provider label for the experimental toggle (S-070, K-519): the
// UI names the provider and model id before the first call. Null when the
// server leaves the feature disabled.
export async function fetchPersonalizeStatus(
  apiKey: string | null,
): Promise<{ readonly provider: string; readonly modelId: string } | null> {
  try {
    const response = await fetch("/v1/personalize/status", { headers: apiHeaders(apiKey) });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      personalize?: { disabled?: unknown; provider?: unknown; modelId?: unknown };
    };
    const personalize = body.personalize;
    if (personalize === undefined || personalize.disabled === true) {
      return null;
    }
    if (typeof personalize.provider !== "string" || typeof personalize.modelId !== "string") {
      return null;
    }
    return { provider: personalize.provider, modelId: personalize.modelId };
  } catch {
    return null;
  }
}

// One explicit mapping call (S-070, K-519, P-27): the visitor's priorities
// text plus quoted plugin references for this request only. Null on any
// failure: the deterministic baseline stands.
export async function requestPersonalizeMapping(
  apiKey: string | null,
  address: string,
  priorities: string,
): Promise<unknown> {
  try {
    const response = await fetch("/v1/personalize", {
      method: "POST",
      headers: { ...apiHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify({ address, priorities }),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}
