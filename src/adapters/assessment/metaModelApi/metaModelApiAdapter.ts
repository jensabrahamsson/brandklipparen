// Meta Model API adapter behind AssessmentModelPort (S-036, K-305, K-309).
// Thin provider binding over the shared chat-completions core: this
// module carries solely the Meta variable names, defaults and labels,
// while the request shape, transport handling and validation live in the
// shared core. Tests replay recorded fixtures and never touch the
// network; production passes the fetch-based transport. The request
// carries the closed evidence list only (K-302); raw bytecode never
// enters the prompt. Every call appends one log entry with provider and
// model id; entries never carry the key or response content (K-305,
// K-509). Placeholder model id and limits are test-only values, never
// learned model values (K-210).
import { err, ok } from "../../../domain/result.ts";
import type { Result } from "../../../domain/result.ts";
import type {
  ModelId as ModelIdType,
} from "../../../domain/types.ts";
import type { ConfigError, SecretString } from "../../../ports/config.ts";
import type { AssessmentModelPort } from "../../../ports/assessmentModel.ts";
import {
  ChatCompletionsAdapter,
  fetchChatCompletionsTransport,
} from "../chatCompletions/chatCompletionsAdapter.ts";
import type {
  ChatCompletionsLogEntry,
  ChatCompletionsTransport,
  ChatCompletionsTransportInit,
  ChatCompletionsTransportResponse,
} from "../chatCompletions/chatCompletionsAdapter.ts";

// Single HTTP round trip over an injected byte channel. Headers travel
// beside the body so the adapter builds the authorization header from
// the secret at the single point of use; transports never see the key
// except inside the header value, and the key is never logged.
export type MetaModelApiTransportResponse = ChatCompletionsTransportResponse;

export type MetaModelApiTransportInit = ChatCompletionsTransportInit;

export type MetaModelApiTransport = ChatCompletionsTransport;

// Production transport over the built-in fetch of Node. The endpoint URL
// (which may carry deployment routing) is used solely as the request
// target and is never logged or copied into errors.
export async function fetchMetaTransport(
  url: string,
  init: MetaModelApiTransportInit,
): Promise<MetaModelApiTransportResponse> {
  return fetchChatCompletionsTransport(url, init);
}

// One log entry per assessment call (K-305, K-309, K-509): provider and
// model id travel with the request id and the outcome, and nothing else.
// The entry never carries the key, the request body or response content,
// so hostile strings cannot leak into logs (K-502, K-308).
export type MetaAssessmentLogEntry = ChatCompletionsLogEntry;

// Placeholder operational limits for tests and offline use (A-17, I-14).
// Production passes the versioned values from the validated configuration
// through createMetaModelApiAdapterFromConfig; the adapter never invents
// its own. The timeout mirrors the personalize mapping timeout (60 s) so
// a reasoning model has room to answer; the response byte cap stays at
// 1 MiB, far above the largest valid answer, so a complete assessment is
// never rejected as oversize.
export const DEFAULT_META_TIMEOUT_MS = 60000;
export const DEFAULT_META_MAX_BYTES_IN = 1048576;
export const DEFAULT_META_MAX_BYTES_OUT = 20000;

// Completion budget for one assessment call: the configured reasoning
// model reasons before answering and reasoning tokens count against this
// budget, so the bound leaves room for a low reasoning effort plus the
// assessment JSON (mirroring the personalize mapping budget).
export const DEFAULT_META_MAX_TOKENS = 8192;

// The assessment is a small structured choice, so the call asks for low
// reasoning effort (the provider rejects "none").
export const META_REASONING_EFFORT = "low";

export function resolveMetaTimeoutMs(value: number | undefined): number {
  return value ?? DEFAULT_META_TIMEOUT_MS;
}

export function resolveMetaMaxTokens(value: number | undefined): number {
  return value ?? DEFAULT_META_MAX_TOKENS;
}

export function resolveMetaMaxBytesIn(value: number | undefined): number {
  return value ?? DEFAULT_META_MAX_BYTES_IN;
}

export function resolveMetaMaxBytesOut(value: number | undefined): number {
  return value ?? DEFAULT_META_MAX_BYTES_OUT;
}

export type MetaModelApiAdapterOptions = {
  readonly endpoint: string;
  readonly apiKey: SecretString;
  readonly modelId: ModelIdType;
  readonly timeoutMs?: number | undefined;
  readonly maxBytesIn?: number | undefined;
  readonly maxBytesOut?: number | undefined;
  readonly maxOutputChars?: number | undefined;
  // Optional completion budget override: defaults to 8192.
  readonly maxTokens?: number | undefined;
  readonly transport?: MetaModelApiTransport | undefined;
  readonly onLog?: ((entry: MetaAssessmentLogEntry) => void) | undefined;
  readonly onWarn?: ((line: string) => void) | undefined;
};

const ENDPOINT_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL";
const API_KEY_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY";
const MODEL_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID";

// The subset of the validated configuration the adapter reads (K-309,
// K-505). Optional fields accept an explicit undefined, so a missing
// value in a partial test configuration maps to the typed startup error
// below. No default provider or model is chosen here: an unset selection
// means the assessment stays disabled per the composition root (S-025),
// and Jens selects the demo default separately.
export type MetaAdapterConfig = {
  readonly assessmentMetaBaseUrl: string | undefined;
  readonly assessmentMetaApiKey: SecretString | undefined;
  readonly assessmentMetaModelId: ModelIdType | undefined;
  readonly assessmentDeadlineMs: number | undefined;
  readonly assessmentMaxInputBytes: number | undefined;
  readonly assessmentMaxOutputBytes: number | undefined;
};

export function createMetaModelApiAdapterFromConfig(
  config: MetaAdapterConfig,
  transport?: MetaModelApiTransport | undefined,
  onLog?: ((entry: MetaAssessmentLogEntry) => void) | undefined,
): Result<MetaModelApiAdapter, ConfigError> {
  const endpoint = config.assessmentMetaBaseUrl;
  if (endpoint === undefined || endpoint.length === 0) {
    return err({ kind: "missing-variable", variable: ENDPOINT_VARIABLE });
  }
  if (!endpoint.startsWith("https://") || endpoint.length > 2048 || endpoint.includes(" ")) {
    return err({ kind: "invalid-value", variable: ENDPOINT_VARIABLE, reason: "must be an https URL" });
  }
  const apiKey = config.assessmentMetaApiKey;
  if (apiKey === undefined) {
    return err({ kind: "missing-variable", variable: API_KEY_VARIABLE });
  }
  const modelId = config.assessmentMetaModelId;
  if (modelId === undefined) {
    return err({ kind: "missing-variable", variable: MODEL_VARIABLE });
  }
  return ok(
    new MetaModelApiAdapter({
      endpoint,
      apiKey,
      modelId,
      timeoutMs: config.assessmentDeadlineMs,
      maxBytesIn: config.assessmentMaxOutputBytes,
      maxBytesOut: config.assessmentMaxInputBytes,
      maxOutputChars: config.assessmentMaxOutputBytes,
      transport,
      onLog,
    }),
  );
}

export class MetaModelApiAdapter extends ChatCompletionsAdapter implements AssessmentModelPort {
  constructor(options: MetaModelApiAdapterOptions) {
    if (!options.endpoint.startsWith("https://")) {
      throw new Error("Meta Model API endpoint must be an https URL");
    }
    super({
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      modelId: options.modelId,
      provider: "meta-model-api",
      timeoutMs: resolveMetaTimeoutMs(options.timeoutMs),
      maxBytesIn: resolveMetaMaxBytesIn(options.maxBytesIn),
      maxBytesOut: resolveMetaMaxBytesOut(options.maxBytesOut),
      maxOutputChars: options.maxOutputChars,
      maxTokens: resolveMetaMaxTokens(options.maxTokens),
      reasoningEffort: META_REASONING_EFFORT,
      transport: options.transport,
      onLog: options.onLog,
      onWarn: options.onWarn,
    });
  }

  provider(): "meta-model-api" {
    return "meta-model-api";
  }
}
