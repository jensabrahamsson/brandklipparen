// Vendor-neutral chat-completions adapter behind AssessmentModelPort
// (K-305, K-309). Thin provider binding over the shared chat-completions
// core for a temporary local endpoint during development: this module
// carries solely the generic variable names, defaults and labels, while
// the request shape, transport handling and validation live in the shared
// core. Only the base URL, model id and key change next to the other
// providers. Tests replay recorded fixtures and never touch the network;
// production passes the fetch-based transport. The request carries the
// closed evidence list only (K-302); raw bytecode never enters the
// prompt. Every call appends one log entry with provider and model id;
// entries never carry the key or response content (K-305, K-509).
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
export type GenericCompatibleTransportResponse = ChatCompletionsTransportResponse;

export type GenericCompatibleTransportInit = ChatCompletionsTransportInit;

export type GenericCompatibleTransport = ChatCompletionsTransport;

// Production transport over the built-in fetch of Node. The endpoint URL
// is used solely as the request target and is never logged or copied
// into errors.
export async function fetchGenericCompatibleTransport(
  url: string,
  init: GenericCompatibleTransportInit,
): Promise<GenericCompatibleTransportResponse> {
  return fetchChatCompletionsTransport(url, init);
}

// One log entry per assessment call (K-305, K-309, K-509): provider and
// model id travel with the request id and the outcome, and nothing else.
// The entry never carries the key, the request body or response content,
// so hostile strings cannot leak into logs (K-502, K-308).
export type GenericCompatibleAssessmentLogEntry = ChatCompletionsLogEntry;

// Placeholder operational limits for tests and offline use (A-17, I-14).
// Production passes the versioned values from the validated configuration
// through createGenericCompatibleAdapterFromConfig; the adapter never
// invents its own.
export const DEFAULT_generic_COMPATIBLE_TIMEOUT_MS = 30000;
export const DEFAULT_generic_COMPATIBLE_MAX_BYTES_IN = 1048576;
export const DEFAULT_generic_COMPATIBLE_MAX_BYTES_OUT = 20000;

export function resolveGenericCompatibleTimeoutMs(value: number | undefined): number {
  return value ?? DEFAULT_generic_COMPATIBLE_TIMEOUT_MS;
}

export function resolveGenericCompatibleMaxBytesIn(value: number | undefined): number {
  return value ?? DEFAULT_generic_COMPATIBLE_MAX_BYTES_IN;
}

export function resolveGenericCompatibleMaxBytesOut(value: number | undefined): number {
  return value ?? DEFAULT_generic_COMPATIBLE_MAX_BYTES_OUT;
}

// Completion budget for the vendor-neutral provider: thinking models
// count thinking tokens against the limit, so the default is larger than
// the shared 1024-token default. Bounded at the configuration boundary.
export const DEFAULT_generic_COMPATIBLE_MAX_TOKENS = 4096;

export function resolveGenericCompatibleMaxTokens(value: number | undefined): number {
  return value ?? DEFAULT_generic_COMPATIBLE_MAX_TOKENS;
}

export type GenericCompatibleAdapterOptions = {
  readonly endpoint: string;
  readonly apiKey: SecretString;
  readonly modelId: ModelIdType;
  readonly timeoutMs?: number | undefined;
  readonly maxBytesIn?: number | undefined;
  readonly maxBytesOut?: number | undefined;
  readonly maxOutputChars?: number | undefined;
  // Optional sampling temperature in [0, 1]: sent only when set; the
  // default sends no sampling parameter at all (neither temperature
  // nor top_p).
  readonly temperature?: number | undefined;
  // Optional completion budget override: defaults to 4096.
  readonly maxTokens?: number | undefined;
  readonly transport?: GenericCompatibleTransport | undefined;
  readonly onLog?: ((entry: GenericCompatibleAssessmentLogEntry) => void) | undefined;
  readonly onWarn?: ((line: string) => void) | undefined;
};

const ENDPOINT_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL";
const API_KEY_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY";
const MODEL_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID";

// The subset of the validated configuration the adapter reads (K-309,
// K-505). Optional fields accept an explicit undefined, so a missing
// value in a partial test configuration maps to the typed startup error
// below. No default provider or model is chosen here: an unset selection
// means the assessment stays disabled per the composition root (S-025).
export type GenericCompatibleAdapterConfig = {
  readonly assessmentGenericCompatibleBaseUrl: string | undefined;
  readonly assessmentGenericCompatibleApiKey: SecretString | undefined;
  readonly assessmentGenericCompatibleModelId: ModelIdType | undefined;
  readonly assessmentDeadlineMs: number | undefined;
  readonly assessmentMaxInputBytes: number | undefined;
  readonly assessmentMaxOutputBytes: number | undefined;
  readonly assessmentGenericCompatibleTemperature: number | undefined;
  readonly assessmentGenericCompatibleMaxTokens: number | undefined;
};

export function createGenericCompatibleAdapterFromConfig(
  config: GenericCompatibleAdapterConfig,
  transport?: GenericCompatibleTransport | undefined,
  onLog?: ((entry: GenericCompatibleAssessmentLogEntry) => void) | undefined,
): Result<GenericCompatibleAdapter, ConfigError> {
  const endpoint = config.assessmentGenericCompatibleBaseUrl;
  if (endpoint === undefined || endpoint.length === 0) {
    return err({ kind: "missing-variable", variable: ENDPOINT_VARIABLE });
  }
  if (!endpoint.startsWith("https://") || endpoint.length > 2048 || endpoint.includes(" ")) {
    return err({ kind: "invalid-value", variable: ENDPOINT_VARIABLE, reason: "must be an https URL" });
  }
  const apiKey = config.assessmentGenericCompatibleApiKey;
  if (apiKey === undefined) {
    return err({ kind: "missing-variable", variable: API_KEY_VARIABLE });
  }
  const modelId = config.assessmentGenericCompatibleModelId;
  if (modelId === undefined) {
    return err({ kind: "missing-variable", variable: MODEL_VARIABLE });
  }
  return ok(
    new GenericCompatibleAdapter({
      endpoint,
      apiKey,
      modelId,
      timeoutMs: config.assessmentDeadlineMs,
      maxBytesIn: config.assessmentMaxOutputBytes,
      maxBytesOut: config.assessmentMaxInputBytes,
      maxOutputChars: config.assessmentMaxOutputBytes,
      temperature: config.assessmentGenericCompatibleTemperature,
      maxTokens: resolveGenericCompatibleMaxTokens(config.assessmentGenericCompatibleMaxTokens),
      transport,
      onLog,
    }),
  );
}

export class GenericCompatibleAdapter extends ChatCompletionsAdapter implements AssessmentModelPort {
  constructor(options: GenericCompatibleAdapterOptions) {
    if (!options.endpoint.startsWith("https://")) {
      throw new Error("compatible endpoint must be an https URL");
    }
    super({
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      modelId: options.modelId,
      provider: "generic-compatible",
      timeoutMs: resolveGenericCompatibleTimeoutMs(options.timeoutMs),
      maxBytesIn: resolveGenericCompatibleMaxBytesIn(options.maxBytesIn),
      maxBytesOut: resolveGenericCompatibleMaxBytesOut(options.maxBytesOut),
      maxOutputChars: options.maxOutputChars,
      temperature: options.temperature,
      omitSamplingParams: options.temperature === undefined,
      maxTokens: resolveGenericCompatibleMaxTokens(options.maxTokens),
      transport: options.transport,
      onLog: options.onLog,
      onWarn: options.onWarn,
    });
  }

  provider(): "generic-compatible" {
    return "generic-compatible";
  }
}
