// Request-scoped observability and cost frame (S-031, K-101, K-104, K-107).
// Pure helpers behind the shared application service: per-request call
// counters, placeholder cost math, a p95 helper for the timing tests and
// builders for the analysis log record and the health cost frame. Cost
// units are placeholders only (I-14, K-107): the running caps live in the
// validated operational configuration, and learned model values live solely
// in the versioned model artifact per K-210. No I/O here; every value
// arrives as a parameter and every result leaves as a frozen value.
// Driving adapters may read the clock around these helpers; this module
// never does (A-32).
import type {
  AssessmentModelPort,
  AssessmentProvider,
  CallContext,
  EvidenceList,
  MuseAssessment,
} from "../ports/assessmentModel.ts";
import type { AssessmentModelError } from "../ports/assessmentModel.ts";
import type { Result } from "../domain/result.ts";
import { REDACTED } from "../ports/config.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  CallData as CallDataType,
  PromptVersion as PromptVersionType,
  Slot as SlotType,
  StorageWord as StorageWordType,
} from "../domain/types.ts";
import type { BytecodeResult, RpcError, RpcPort } from "../ports/rpc.ts";

// Placeholder cost unit for every estimated assessment cost (K-107, I-14).
// The unit names the estimate as a placeholder; real caps and spend are
// tracked per day and provider in the demo operations outside this module.
export const PLACEHOLDER_COST_UNIT = "placeholder-cost-unit" as const;

export type CostUnit = typeof PLACEHOLDER_COST_UNIT;

// Placeholder rate: one cost unit per assessment provider call (K-107).
// Detection thresholds and model weights stay out of here; they live solely
// in the versioned model artifact per K-210.
export const PLACEHOLDER_ASSESSMENT_COST_PER_CALL = 1;

// Frozen per-request usage snapshot, safe to attach to response metadata
// and health output: counts and placeholder units only, never keys.
export type RequestUsage = {
  readonly rpcCalls: number;
  readonly assessmentCalls: number;
  readonly assessmentCostUnits: number;
  readonly costUnit: CostUnit;
};

// Log field allowlist from the I-10 table (K-509, M-16): every field in
// every emitted log record belongs to this list. The analysis record above
// carries the per-analysis subset; the remaining fields ride on health,
// assessment and cache records. Keys stay out: callers pass the key's hash
// ID (apiKeyId), never key material.
export const LOG_FIELD_ALLOWLIST: readonly string[] = Object.freeze([
  "timestamp",
  "level",
  "service",
  "environment",
  "requestId",
  "apiKeyId",
  "address",
  "codeHash",
  "skeletonHash",
  "blockNumber",
  "modelVersion",
  "artifactChecksum",
  "indexVersion",
  "templateVersion",
  "stepDurationsMs",
  "outcome",
  "rpcCallCount",
  "assessmentCallCount",
  "assessmentCostUnits",
  "costUnit",
  "cacheHit",
  "assessmentProvider",
  "assessmentModelId",
  "promptVersion",
  "decompilerVersion",
  "explanationVersion",
]);

// Allowlist check for one emitted record: true when every top-level field
// belongs to the list. Adapters run this before printing, so a new field
// fails loudly instead of leaking past the review.
export function isAllowlistedLogRecord(record: Record<string, unknown>): boolean {
  for (const key of Object.keys(record)) {
    if (!LOG_FIELD_ALLOWLIST.includes(key)) {
      return false;
    }
  }
  return true;
}

// Minimal sink shared by the counted port wrappers and the services: each
// outgoing call site records one call, and callers read the frozen total.
export type RequestCounterSink = {
  readonly recordRpcCalls: (count: number) => void;
  readonly recordAssessmentCalls: (count: number) => void;
};

export type RequestCounters = RequestCounterSink & {
  readonly snapshot: () => RequestUsage;
};

export function createRequestCounters(): RequestCounters {
  let rpcCalls = 0;
  let assessmentCalls = 0;
  return Object.freeze({
    recordRpcCalls: (count: number): void => {
      rpcCalls += count;
    },
    recordAssessmentCalls: (count: number): void => {
      assessmentCalls += count;
    },
    snapshot: (): RequestUsage =>
      Object.freeze({
        rpcCalls,
        assessmentCalls,
        assessmentCostUnits: assessmentCalls * PLACEHOLDER_ASSESSMENT_COST_PER_CALL,
        costUnit: PLACEHOLDER_COST_UNIT,
      }),
  });
}

// Counted RpcPort wrapper: delegates every call to the bound adapter and
// records one RPC call per call for the request counters (K-107, I-14).
// The wrapper holds no state of its own; the sink owns the totals.
export function withCountedRpc(rpc: RpcPort, counters: RequestCounterSink): RpcPort {
  return Object.freeze({
    getCode: (
      address: AddressType,
      ctx: CallContext,
    ): Promise<Result<BytecodeResult, RpcError>> => {
      counters.recordRpcCalls(1);
      return rpc.getCode(address, ctx);
    },
    getStorageAt: (
      address: AddressType,
      slot: SlotType,
      ctx: CallContext,
    ): Promise<Result<StorageWordType, RpcError>> => {
      counters.recordRpcCalls(1);
      return rpc.getStorageAt(address, slot, ctx);
    },
    call: (
      to: AddressType,
      data: CallDataType,
      ctx: CallContext,
    ): Promise<Result<CallDataType, RpcError>> => {
      counters.recordRpcCalls(1);
      return rpc.call(to, data, ctx);
    },
    getBlockNumber: (ctx: CallContext): Promise<Result<BlockNumberType, RpcError>> => {
      counters.recordRpcCalls(1);
      return rpc.getBlockNumber(ctx);
    },
  });
}

// Counted AssessmentModelPort wrapper: delegates to the bound adapter and
// records one assessment call per assess for the request counters (K-107).
// Provider and model labelling pass through untouched.
export function withCountedAssessment(
  adapter: AssessmentModelPort,
  counters: RequestCounterSink,
): AssessmentModelPort {
  return Object.freeze({
    provider: (): AssessmentProvider => adapter.provider(),
    modelId: (): ReturnType<AssessmentModelPort["modelId"]> => adapter.modelId(),
    assess: (
      evidence: EvidenceList,
      promptVersion: PromptVersionType,
      ctx: CallContext,
    ): Promise<Result<MuseAssessment, AssessmentModelError>> => {
      counters.recordAssessmentCalls(1);
      return adapter.assess(evidence, promptVersion, ctx);
    },
  });
}

// Nearest-rank p95 over measured wall-clock durations in milliseconds
// (K-101): the timing tests measure the shared analyze path on recorded
// fixtures and assert the p95 stays within the fast-path budget. Empty
// input yields null, so a run with zero samples cannot report a value.
export function p95Ms(samples: readonly number[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[rank - 1] as number;
}

// Structured analysis log record (K-104, I-10): the required fields per
// analysis (request id, address, code hash, model version, step times and
// outcome) beside the consumption counters and the cache outcome. Secrets
// never enter this record: callers pass ids and hashes only.
export type AnalysisLogRecord = {
  readonly requestId: string;
  readonly address: string;
  readonly codeHash: string;
  readonly modelVersion: string;
  readonly stepDurationsMs: {
    readonly fastPathMs: number;
    readonly deepeningMs?: number | undefined;
  };
  readonly outcome: string;
  readonly rpcCallCount: number;
  readonly assessmentCallCount: number;
  readonly assessmentCostUnits: number;
  readonly costUnit: CostUnit;
  readonly cacheHit: boolean;
};

export type AnalysisLogInput = {
  readonly requestId: string;
  readonly address: string;
  readonly codeHash: string;
  readonly modelVersion: string;
  readonly stepDurationsMs: {
    readonly fastPathMs: number;
    readonly deepeningMs?: number | undefined;
  };
  readonly outcome: string;
  readonly rpcCallCount: number;
  readonly assessmentCallCount: number;
  readonly assessmentCostUnits: number;
  readonly cacheHit: boolean;
};

export function buildAnalysisLogRecord(input: AnalysisLogInput): AnalysisLogRecord {
  return Object.freeze({
    requestId: input.requestId,
    address: input.address,
    codeHash: input.codeHash,
    modelVersion: input.modelVersion,
    stepDurationsMs: Object.freeze({ ...input.stepDurationsMs }),
    outcome: input.outcome,
    rpcCallCount: input.rpcCallCount,
    assessmentCallCount: input.assessmentCallCount,
    assessmentCostUnits: input.assessmentCostUnits,
    costUnit: PLACEHOLDER_COST_UNIT,
    cacheHit: input.cacheHit,
  });
}

// Health cost frame (K-104, K-107, I-12): provider and model labelling with
// the placeholder cost unit for the /health response. Keys stay out: the
// frame carries the provider name and model id only, never key material.
export type HealthAssessmentFrame =
  | { readonly provider: AssessmentProvider; readonly modelId: string }
  | { readonly disabled: true };

export type HealthCostFrame = {
  readonly costUnit: CostUnit;
  readonly assessmentCostPerCall: number;
  readonly assessment: HealthAssessmentFrame;
};

export function redactForLog(value: unknown): unknown {
  return redactValue(value);
}

export function buildHealthCostFrame(input: {
  readonly assessment: HealthAssessmentFrame;
}): HealthCostFrame {
  return Object.freeze({
    costUnit: PLACEHOLDER_COST_UNIT,
    assessmentCostPerCall: PLACEHOLDER_ASSESSMENT_COST_PER_CALL,
    assessment: input.assessment,
  });
}

// Secret-shaped field names (K-509, M-16). The stable hashed key identifier
// apiKeyId is allowlisted in LOG_FIELD_ALLOWLIST and passes through;
// every other key-shaped name is redacted with the fixed marker.
const SECRET_KEY_PATTERN = /api[_-]?key|secret|passwd|password|authorization|set-cookie|\btoken\b/i;

function isSecretKey(name: string): boolean {
  if (name === "apiKeyId") {
    return false;
  }
  return SECRET_KEY_PATTERN.test(name);
}

function redactUrlCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^/\s@]+@/gi, `$1${REDACTED}@`);
}

function redactQuerySecrets(text: string): string {
  return text.replace(/([?&](?:api[_-]?key|token|secret)[^=]*=)[^&\s]*/gi, `$1${REDACTED}`);
}

function redactBearerTokens(text: string): string {
  return text
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]+/gi, `bearer ${REDACTED}`)
    .replace(/((?:x-)?api[_-]?key\s*[:=]\s*)\S+/gi, `$1${REDACTED}`);
}

// Redacts key-like material inside one string: embedded URL credentials,
// secret query parameters, bearer tokens and key header values. Plain
// identifiers such as addresses and code hashes carry none of these
// shapes and pass through unchanged.
function redactStringForLog(text: string): string {
  return redactBearerTokens(redactQuerySecrets(redactUrlCredentials(text)));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Deep redaction for one log value (K-509, M-16): secret-shaped fields and
// key-bearing strings become the fixed redaction marker, every other value
// passes through unchanged. The input is never mutated; records and arrays
// are rebuilt.
function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactStringForLog(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(value)) {
      out[name] = isSecretKey(name) ? REDACTED : redactValue(value[name]);
    }
    return out;
  }
  return value;
}
