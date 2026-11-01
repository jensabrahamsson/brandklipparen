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
      dropReasons?: unknown;
      steps?: unknown;
      forcedConclusion?: unknown;
    };
    const steps = Array.isArray(report.steps)
      ? report.steps.map((entry) => toStep(entry as RawStep)).filter((entry) => entry !== null)
      : [];
    const dropRecord = report.dropReasons as { uncited?: unknown; unknownId?: unknown } | null;
    const dropReasons =
      dropRecord !== null &&
      typeof dropRecord === "object" &&
      typeof dropRecord.uncited === "number" &&
      typeof dropRecord.unknownId === "number"
        ? { uncited: dropRecord.uncited, unknownId: dropRecord.unknownId }
        : undefined;
    return {
      status: "done",
      steps,
      narrative: typeof report.narrative === "string" ? report.narrative : "",
      droppedClaims: typeof report.droppedClaims === "number" ? report.droppedClaims : 0,
      dropReasons,
      provider,
      modelId,
      forcedConclusion: report.forcedConclusion === true,
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
  | {
      readonly status: "ready";
      readonly narrative: readonly string[];
      readonly droppedClaims: number;
      readonly provider: string;
      readonly modelId: string;
    }
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
    const explain = body.explain as {
      kind?: unknown;
      narrative?: unknown;
      droppedClaims?: unknown;
      provider?: unknown;
      modelId?: unknown;
    } | null;
    if (explain === null || explain === undefined || typeof explain !== "object") {
      return { status: "fallback" };
    }
    if (explain.kind === "not-configured") {
      return { status: "not-configured" };
    }
    if (
      explain.kind === "ok" &&
      Array.isArray(explain.narrative) &&
      typeof explain.droppedClaims === "number" &&
      typeof explain.provider === "string" &&
      typeof explain.modelId === "string"
    ) {
      const narrative = explain.narrative.filter((entry): entry is string => typeof entry === "string");
      if (narrative.length !== explain.narrative.length) {
        return { status: "fallback" };
      }
      return {
        status: "ready",
        narrative,
        droppedClaims: explain.droppedClaims,
        provider: explain.provider,
        modelId: explain.modelId,
      };
    }
    return { status: "fallback" };
  } catch {
    return { status: "failed" };
  }
}

export type ChatState =
  | { readonly status: "not-configured" }
  | {
      readonly status: "ready";
      readonly answers: readonly string[];
      readonly droppedClaims: number;
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly status: "fallback" }
  | { readonly status: "failed" };

// Follow-up question over the frozen analysis (S-096, K-302): POST-only,
// the question rides in the body beside the address (500 chars max, the
// server rejects anything longer before analysis starts). Surviving
// answers render like Explain sentences; uncited answers only move the
// drop count. Scores, evidence and finding text are untouched.
export async function fetchChat(address: string, apiKey: string | null, question: string): Promise<ChatState> {
  const trimmed = question.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    return { status: "failed" };
  }
  try {
    const response = await fetch("/v1/chat", {
      method: "POST",
      headers: { ...apiHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify({ address, question: trimmed }),
    });
    if (!response.ok) {
      return { status: "failed" };
    }
    const body = (await response.json()) as { chat?: unknown };
    const chat = body.chat as {
      kind?: unknown;
      answers?: unknown;
      droppedClaims?: unknown;
      provider?: unknown;
      modelId?: unknown;
    } | null;
    if (chat === null || chat === undefined || typeof chat !== "object") {
      return { status: "fallback" };
    }
    if (chat.kind === "not-configured") {
      return { status: "not-configured" };
    }
    if (
      chat.kind === "ok" &&
      Array.isArray(chat.answers) &&
      typeof chat.droppedClaims === "number" &&
      typeof chat.provider === "string" &&
      typeof chat.modelId === "string"
    ) {
      const answers = chat.answers.filter((entry): entry is string => typeof entry === "string");
      if (answers.length !== chat.answers.length) {
        return { status: "fallback" };
      }
      return {
        status: "ready",
        answers,
        droppedClaims: chat.droppedClaims,
        provider: chat.provider,
        modelId: chat.modelId,
      };
    }
    return { status: "fallback" };
  } catch {
    return { status: "failed" };
  }
}

export type SnippetLine = {
  readonly lineNumber: number;
  readonly text: string;
  // Exact instruction PCs of the printed statement (VS-B1): an evidence
  // offset maps to exactly the line whose pcs include it. Structural
  // lines (header, braces, comments) carry no PCs. Older servers omit
  // the field, which reads as no PCs.
  readonly pcs: readonly number[];
};

export type SnippetResult = {
  readonly selector: string;
  readonly entryPc: number;
  readonly lines: readonly SnippetLine[];
};

// Snippet cache for evidence rows (UI v2 §5.3): one `/v1/snippet`
// request per address + selector, shared across rows and re-expands.
// Display text only; scores, signals and evidence are untouched.
const snippetCache = new Map<string, Promise<SnippetResult>>();

export function clearSnippetCache(): void {
  snippetCache.clear();
}

function snippetKey(address: string, selector: string): string {
  return `${address.toLowerCase()}:${selector.toLowerCase()}`;
}

function toSnippetResult(body: unknown): SnippetResult | null {
  const record = body as { snippet?: unknown };
  const snippet = record.snippet as
    | { selector?: unknown; entryPc?: unknown; lines?: unknown }
    | null
    | undefined;
  if (snippet === null || snippet === undefined || typeof snippet !== "object") {
    return null;
  }
  if (typeof snippet.selector !== "string" || typeof snippet.entryPc !== "number" || !Array.isArray(snippet.lines)) {
    return null;
  }
  const lines: SnippetLine[] = [];
  for (const entry of snippet.lines) {
    const line = entry as { lineNumber?: unknown; text?: unknown; pcs?: unknown };
    if (typeof line.lineNumber !== "number" || typeof line.text !== "string") {
      return null;
    }
    const pcs = Array.isArray(line.pcs)
      ? line.pcs.filter((pc): pc is number => typeof pc === "number" && Number.isFinite(pc))
      : [];
    lines.push({ lineNumber: line.lineNumber, text: line.text, pcs: Object.freeze(pcs) });
  }
  return { selector: snippet.selector, entryPc: snippet.entryPc, lines };
}

export function fetchSnippet(address: string, selector: string, apiKey: string | null): Promise<SnippetResult> {
  const key = snippetKey(address, selector);
  const cached = snippetCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending: Promise<SnippetResult> = loadSnippet(address, selector, apiKey);
  snippetCache.set(key, pending);
  // A failed snippet must not poison the cache: the next expand retries
  // the request instead of replaying the failure.
  void pending.catch(() => {
    if (snippetCache.get(key) === pending) {
      snippetCache.delete(key);
    }
  });
  return pending;
}

async function loadSnippet(address: string, selector: string, apiKey: string | null): Promise<SnippetResult> {
  const response = await fetch(
    `/v1/snippet?address=${encodeURIComponent(address)}&selector=${encodeURIComponent(selector)}`,
    { headers: apiHeaders(apiKey) },
  );
  if (!response.ok) {
    throw await readError(response, "request-failed");
  }
  const parsed = toSnippetResult(await response.json());
  if (parsed === null) {
    throw new ApiError("request-failed", 200, "Readable code is not available for this function.");
  }
  return parsed;
}

export type RugState =
  | { readonly status: "not-configured" }
  | {
      readonly status: "ready";
      readonly narrative: readonly string[];
      readonly droppedClaims: number;
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly status: "fallback" }
  | { readonly status: "failed" };

// Capability summary for the top risk type (S-097, K-302): one opt-in
// overlay call beside Explain. The narrative renders like Explain
// sentences with the same drop count; scores and evidence are untouched.
export async function fetchRug(address: string, apiKey: string | null): Promise<RugState> {
  try {
    const response = await fetch(`/v1/rug?address=${encodeURIComponent(address)}`, {
      headers: apiHeaders(apiKey),
    });
    if (!response.ok) {
      return { status: "failed" };
    }
    const body = (await response.json()) as { rug?: unknown };
    const rug = body.rug as {
      kind?: unknown;
      narrative?: unknown;
      droppedClaims?: unknown;
      provider?: unknown;
      modelId?: unknown;
    } | null;
    if (rug === null || rug === undefined || typeof rug !== "object") {
      return { status: "fallback" };
    }
    if (rug.kind === "not-configured") {
      return { status: "not-configured" };
    }
    if (
      rug.kind === "ok" &&
      Array.isArray(rug.narrative) &&
      typeof rug.droppedClaims === "number" &&
      typeof rug.provider === "string" &&
      typeof rug.modelId === "string"
    ) {
      const narrative = rug.narrative.filter((entry): entry is string => typeof entry === "string");
      if (narrative.length !== rug.narrative.length) {
        return { status: "fallback" };
      }
      return {
        status: "ready",
        narrative,
        droppedClaims: rug.droppedClaims,
        provider: rug.provider,
        modelId: rug.modelId,
      };
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
// failure: the deterministic baseline stands. The call times out after 15
// seconds (overridable in tests): a slow model call falls back to the
// deterministic order instead of hanging the page. An optional caller
// signal composes with the timeout via AbortSignal.any when available, so
// toggling AI off or editing priorities can cancel the in-flight call.
export const PERSONALIZE_TIMEOUT_MS = 15000;
export async function requestPersonalizeMapping(
  apiKey: string | null,
  address: string,
  priorities: string,
  options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<unknown> {
  const timeoutMs = options?.timeoutMs ?? PERSONALIZE_TIMEOUT_MS;
  try {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    let signal: AbortSignal = timeoutSignal;
    if (options?.signal !== undefined) {
      const combine = (AbortSignal as unknown as { any?: (signals: readonly AbortSignal[]) => AbortSignal }).any;
      if (typeof combine === "function") {
        signal = combine([timeoutSignal, options.signal]);
      } else if (options.signal.aborted) {
        return null;
      } else {
        signal = timeoutSignal;
      }
    }
    const response = await fetch("/v1/personalize", {
      method: "POST",
      headers: { ...apiHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify({ address, priorities }),
      signal,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

// Explain source for the single console button (UI v2 §1.2, owner
// decision: Explain + assessment + rug narrative merge into one
// button). First configured feature wins: /v1/explain, then /v1/rug,
// then /v1/assessment. Unknown fields (older servers) keep the previous
// explicit-request behaviour and count as available, so explain stays
// the default. Null when none of the three is configured: the console
// then shows the one-line state with no buttons at all.
export type ExplainSource = "explain" | "rug" | "assessment";

// Per-function code explanation (addendum §A2.5, VS-B3, VS-2): POST
// /v1/explain-code with the address, selector and active pane view.
// The response carries a summary plus line-anchored notes; every cited
// line was checked server-side and anything uncited counts into
// droppedClaims. Scores, evidence and finding text are untouched: this
// is a labelled overlay beside the deterministic code view.
export type ExplainCodeView = "decompiled" | "source";

export type ExplainCodeLineCite = {
  readonly kind: "line";
  readonly selector: string;
  readonly view: ExplainCodeView;
  readonly line: number;
};

export type ExplainCodeEvidenceCite = {
  readonly kind: "evidence";
  readonly id: string;
};

export type ExplainCodeCite = ExplainCodeLineCite | ExplainCodeEvidenceCite;

export type ExplainCodeSummarySentence = {
  readonly text: string;
  readonly cites: readonly ExplainCodeCite[];
};

export type ExplainCodeNote = {
  // Sorted 1-based line numbers in the explained view. The note anchors
  // to from..to; from equals to for a single line.
  readonly lines: readonly number[];
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly cites: readonly ExplainCodeCite[];
};

export type ExplainCodeState =
  | {
      readonly status: "ready";
      readonly summary: readonly ExplainCodeSummarySentence[];
      readonly notes: readonly ExplainCodeNote[];
      readonly droppedClaims: number;
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly status: "not-configured" }
  | { readonly status: "invalid-output" }
  | { readonly status: "capped" }
  | { readonly status: "failed" };

function isExplainCodeView(value: unknown): value is ExplainCodeView {
  return value === "decompiled" || value === "source";
}

function toExplainCodeCite(
  cite: unknown,
  selector: string,
  view: ExplainCodeView,
): ExplainCodeCite | null {
  if (typeof cite === "string") {
    const lineMatch = /^line:(\d+)$/.exec(cite);
    if (lineMatch?.[1] !== undefined) {
      const line = Number.parseInt(lineMatch[1], 10);
      if (Number.isSafeInteger(line) && line >= 1) {
        return { kind: "line", selector, view, line };
      }
      return null;
    }
    if (cite.length > 0) {
      return { kind: "evidence", id: cite };
    }
    return null;
  }
  if (typeof cite !== "object" || cite === null) {
    return null;
  }
  const record = cite as Record<string, unknown>;
  if (record["kind"] === "line") {
    const line = record["line"];
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
      return null;
    }
    const citeSelector = typeof record["selector"] === "string" ? record["selector"] : selector;
    const citeView = isExplainCodeView(record["view"]) ? record["view"] : view;
    return { kind: "line", selector: citeSelector, view: citeView, line };
  }
  if (record["kind"] === "evidence" && typeof record["id"] === "string" && record["id"].length > 0) {
    return { kind: "evidence", id: record["id"] };
  }
  return null;
}

function toExplainCodeSummary(
  entry: unknown,
  selector: string,
  view: ExplainCodeView,
): ExplainCodeSummarySentence | null {
  if (typeof entry === "string") {
    return entry.length > 0 ? { text: entry, cites: [] } : null;
  }
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const record = entry as { text?: unknown; cites?: unknown };
  if (typeof record.text !== "string" || record.text.length === 0) {
    return null;
  }
  const cites =
    record.cites === undefined
      ? []
      : Array.isArray(record.cites)
        ? record.cites.map((cite) => toExplainCodeCite(cite, selector, view)).filter((cite) => cite !== null)
        : null;
  if (cites === null) {
    return null;
  }
  return { text: record.text, cites };
}

function toExplainCodeNote(
  entry: unknown,
  selector: string,
  view: ExplainCodeView,
): ExplainCodeNote | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const record = entry as { lines?: unknown; text?: unknown; cites?: unknown };
  if (!Array.isArray(record.lines) || record.lines.length === 0) {
    return null;
  }
  const lines = record.lines
    .filter((line): line is number => typeof line === "number" && Number.isSafeInteger(line) && line >= 1)
    .sort((first, second) => first - second);
  if (lines.length !== record.lines.length || typeof record.text !== "string" || record.text.length === 0) {
    return null;
  }
  const cites =
    record.cites === undefined
      ? []
      : Array.isArray(record.cites)
        ? record.cites.map((cite) => toExplainCodeCite(cite, selector, view)).filter((cite) => cite !== null)
        : null;
  if (cites === null) {
    return null;
  }
  return { lines, from: lines[0] as number, to: lines[lines.length - 1] as number, text: record.text, cites };
}

function toExplainCodeState(body: unknown, selector: string, view: ExplainCodeView): ExplainCodeState {
  const record = body as { explainCode?: unknown };
  const explainCode = record.explainCode as { kind?: unknown } | null | undefined;
  if (explainCode === null || explainCode === undefined || typeof explainCode !== "object") {
    return { status: "failed" };
  }
  if (explainCode.kind === "not-configured") {
    return { status: "not-configured" };
  }
  if (explainCode.kind === "invalid-output") {
    return { status: "invalid-output" };
  }
  if (explainCode.kind === "capped" || explainCode.kind === "rate-limited") {
    return { status: "capped" };
  }
  if (explainCode.kind !== "ok") {
    return { status: "failed" };
  }
  const envelope = explainCode as {
    summary?: unknown;
    notes?: unknown;
    droppedClaims?: unknown;
    provider?: unknown;
    modelId?: unknown;
  };
  if (!Array.isArray(envelope.summary) || !Array.isArray(envelope.notes)) {
    return { status: "invalid-output" };
  }
  if (typeof envelope.droppedClaims !== "number" || typeof envelope.provider !== "string" || typeof envelope.modelId !== "string") {
    return { status: "invalid-output" };
  }
  // Entry-level problems drop that entry and count it, the same
  // discipline as the server check: one bad sentence never hides the
  // rest. A note without usable lines is dropped, never guessed.
  let dropped = envelope.droppedClaims;
  const summary: ExplainCodeSummarySentence[] = [];
  for (const entry of envelope.summary) {
    const sentence = toExplainCodeSummary(entry, selector, view);
    if (sentence === null) {
      dropped += 1;
    } else {
      summary.push(sentence);
    }
  }
  const notes: ExplainCodeNote[] = [];
  for (const entry of envelope.notes) {
    const note = toExplainCodeNote(entry, selector, view);
    if (note === null) {
      dropped += 1;
    } else {
      notes.push(note);
    }
  }
  return { status: "ready", summary, notes, droppedClaims: dropped, provider: envelope.provider, modelId: envelope.modelId };
}

// Session cache for per-function explanations (addendum §A2.2): one
// POST per address + selector + view. Re-opening a function shows the
// stored result instantly with no new request. Failures never poison
// the cache: the next press retries. "Ask again" clears the entry first
// so the visitor knowingly spends another request.
const explainCodeCache = new Map<string, Promise<ExplainCodeState>>();
const explainCodeSettled = new Map<string, ExplainCodeState>();

export function clearExplainCodeCache(): void {
  explainCodeCache.clear();
  explainCodeSettled.clear();
}

function explainCodeKey(address: string, selector: string, view: ExplainCodeView): string {
  return `${address.toLowerCase()}:${selector.toLowerCase()}:${view}`;
}

async function loadExplainCode(
  address: string,
  selector: string,
  view: ExplainCodeView,
  apiKey: string | null,
): Promise<ExplainCodeState> {
  let response: Response;
  try {
    response = await fetch("/v1/explain-code", {
      method: "POST",
      headers: { ...apiHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify({ address, selector, view }),
    });
  } catch {
    return { status: "failed" };
  }
  if (!response.ok) {
    if (response.status === 429) {
      return { status: "capped" };
    }
    const failure = await readError(response, "request-failed");
    if (failure.code === "rate-limited" || failure.code === "daily-limit") {
      return { status: "capped" };
    }
    return { status: "failed" };
  }
  try {
    return toExplainCodeState(await response.json(), selector, view);
  } catch {
    return { status: "failed" };
  }
}

// "Ask again" spends another request knowingly: drop the stored entry
// first so the next press reaches the server again.
export function refreshExplainCode(
  address: string,
  selector: string,
  view: ExplainCodeView,
  apiKey: string | null,
): Promise<ExplainCodeState> {
  const key = explainCodeKey(address, selector, view);
  explainCodeCache.delete(key);
  explainCodeSettled.delete(key);
  return fetchExplainCode(address, selector, view, apiKey);
}

export function fetchExplainCode(
  address: string,
  selector: string,
  view: ExplainCodeView,
  apiKey: string | null,
): Promise<ExplainCodeState> {
  const key = explainCodeKey(address, selector, view);
  const cached = explainCodeCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending = loadExplainCode(address, selector, view, apiKey);
  explainCodeCache.set(key, pending);
  void pending.then((state) => {
  if (state.status === "failed") {
    if (explainCodeCache.get(key) === pending) {
      explainCodeCache.delete(key);
    }
    return;
  }
  // Settled overlays stay for the session so re-opening a function
  // shows them instantly with no new request (addendum §A2.2).
  explainCodeSettled.set(key, state);
});
  return pending;
}

// The settled overlay for an address + selector + view, if this
// session already holds one. Lets a re-opened function render its
// stored explanation instantly without a new request or consent.
export function peekExplainCode(
  address: string,
  selector: string,
  view: ExplainCodeView,
): ExplainCodeState | null {
  return explainCodeSettled.get(explainCodeKey(address, selector, view)) ?? null;
}

// Extended-proof diagnostics (UI v2 §5.5, W-11): one GET per address
// beside the analysis, cached for the session so re-opening a detail
// costs nothing. Display data only; scores, signals and evidence are
// untouched, and the response never enters the analyze envelope.
export type ProofStep = {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly selector?: string | undefined;
  readonly pc?: number | undefined;
};

export type ProofReport = {
  readonly detector: string;
  readonly steps: readonly ProofStep[];
};

export type ProofState = { readonly status: "ready"; readonly codeHash: string; readonly proofs: readonly ProofReport[] } | { readonly status: "failed" };

function toProofStep(entry: unknown): ProofStep | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  if (typeof record["step"] !== "string" || typeof record["ok"] !== "boolean" || typeof record["detail"] !== "string") {
    return null;
  }
  let step: ProofStep = { step: record["step"], ok: record["ok"], detail: record["detail"] };
  if (typeof record["selector"] === "string" && /^0x[0-9a-fA-F]{8}$/.test(record["selector"])) {
    step = { ...step, selector: record["selector"] };
  }
  if (typeof record["pc"] === "number" && Number.isSafeInteger(record["pc"])) {
    step = { ...step, pc: record["pc"] };
  }
  return step;
}

function toProofState(body: unknown): ProofState {
  const record = body as { codeHash?: unknown; proofs?: unknown };
  if (typeof record.codeHash !== "string" || !Array.isArray(record.proofs)) {
    return { status: "failed" };
  }
  const proofs: ProofReport[] = [];
  for (const entry of record.proofs) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const report = entry as { detector?: unknown; steps?: unknown };
    if (typeof report.detector !== "string" || !Array.isArray(report.steps)) {
      continue;
    }
    const steps = report.steps.map(toProofStep).filter((step): step is ProofStep => step !== null);
    proofs.push({ detector: report.detector, steps });
  }
  return { status: "ready", codeHash: record.codeHash, proofs };
}

const proofCache = new Map<string, Promise<ProofState>>();

export function clearProofCache(): void {
  proofCache.clear();
}

async function loadProof(address: string, apiKey: string | null): Promise<ProofState> {
  let response: Response;
  try {
    response = await fetch(`/v1/proof?address=${encodeURIComponent(address)}`, { headers: apiHeaders(apiKey) });
  } catch {
    return { status: "failed" };
  }
  if (!response.ok) {
    return { status: "failed" };
  }
  try {
    return toProofState(await response.json());
  } catch {
    return { status: "failed" };
  }
}

export function fetchProof(address: string, apiKey: string | null): Promise<ProofState> {
  const key = address.toLowerCase();
  const cached = proofCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending = loadProof(address, apiKey);
  proofCache.set(key, pending);
  // A failed proof must not poison the cache: the next expand retries
  // the request instead of replaying the failure.
  void pending.then((state) => {
    if (state.status === "failed" && proofCache.get(key) === pending) {
      proofCache.delete(key);
    }
  });
  return pending;
}

export function pickExplainSource(health: HealthState | null): ExplainSource | null {
  if (health === null) {
    return "explain";
  }
  if (health.explain === undefined || !("disabled" in health.explain)) {
    return "explain";
  }
  if (health.rug === undefined || !("disabled" in health.rug)) {
    return "rug";
  }
  if (health.assessment === undefined || !("disabled" in health.assessment)) {
    return "assessment";
  }
  return null;
}
