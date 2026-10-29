// hosted open-weights adapter behind AssessmentModelPort (S-037,
// K-305, K-309). Thin provider binding over the shared chat-completions
// core: this module carries solely the hosted variable names, defaults
// and labels, while the request shape, transport handling and validation
// live in the shared core. Tests replay recorded fixtures and never
// touch the network; production passes the fetch-based transport. The
// request carries the closed evidence list only (K-302); raw bytecode
// never enters the prompt. Every call appends one log entry with
// provider and model id; entries never carry the key or response content
// (K-305, K-509). Placeholder model id and limits are test-only values,
// never learned model values (K-210).
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

// Open-weights model served on hosted per K-309 and A-34. The value is
// the provider's published model id, not a learned model value (K-210):
// tests and the composition root pass it in through the validated
// configuration, and the adapter only labels responses with it.
export const hosted_OPEN_WEIGHTS_MODEL_ID = "meta-models/muse-spark-open-1026";

// Single HTTP round trip over an injected byte channel. Headers travel
// beside the body so the adapter builds the authorization header from
// the secret at the single point of use; transports never see the key
// except inside the header value, and the key is never logged.
export type hostedOpenWeightsTransportResponse = ChatCompletionsTransportResponse;

export type hostedOpenWeightsTransportInit = ChatCompletionsTransportInit;

export type hostedOpenWeightsTransport = ChatCompletionsTransport;

// Production transport over the built-in fetch of Node. The endpoint URL
// (which may carry deployment routing) is used solely as the request
// target and is never logged or copied into errors.
export async function fetchhostedTransport(
  url: string,
  init: hostedOpenWeightsTransportInit,
): Promise<hostedOpenWeightsTransportResponse> {
  return fetchChatCompletionsTransport(url, init);
}

// One log entry per assessment call (K-305, K-309, K-509): provider and
// model id travel with the request id and the outcome, and nothing else.
// The entry never carries the key, the request body or response content,
// so hostile strings cannot leak into logs (K-502, K-308).
export type hostedAssessmentLogEntry = ChatCompletionsLogEntry;

// Placeholder operational limits for tests and offline use (A-17, I-14).
// Production passes the versioned values from the validated configuration
// through createhostedOpenWeightsAdapterFromConfig; the adapter never
// invents its own.
export const DEFAULT_hosted_TIMEOUT_MS = 30000;
export const DEFAULT_hosted_MAX_BYTES_IN = 1048576;
export const DEFAULT_hosted_MAX_BYTES_OUT = 20000;

export function resolvehostedTimeoutMs(value: number | undefined): number {
  return value ?? DEFAULT_hosted_TIMEOUT_MS;
}

export function resolvehostedMaxBytesIn(value: number | undefined): number {
  return value ?? DEFAULT_hosted_MAX_BYTES_IN;
}

export function resolvehostedMaxBytesOut(value: number | undefined): number {
  return value ?? DEFAULT_hosted_MAX_BYTES_OUT;
}

export type hostedOpenWeightsAdapterOptions = {
  readonly endpoint: string;
  readonly apiKey: SecretString;
  readonly modelId: ModelIdType;
  readonly timeoutMs?: number | undefined;
  readonly maxBytesIn?: number | undefined;
  readonly maxBytesOut?: number | undefined;
  readonly maxOutputChars?: number | undefined;
  readonly transport?: hostedOpenWeightsTransport | undefined;
  readonly onLog?: ((entry: hostedAssessmentLogEntry) => void) | undefined;
  readonly onWarn?: ((line: string) => void) | undefined;
};

const ENDPOINT_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL";
const API_KEY_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY";
const MODEL_VARIABLE = "BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID";

// The subset of the validated configuration the adapter reads (K-309,
// K-505). Optional fields accept an explicit undefined, so a missing
// value in a partial test configuration maps to the typed startup error
// below. No default provider or model is chosen here: an unset selection
// means the assessment stays disabled per the composition root (S-025),
// and Jens selects the demo default separately.
export type hostedAdapterConfig = {
  readonly assessmenthostedBaseUrl: string | undefined;
  readonly assessmenthostedApiKey: SecretString | undefined;
  readonly assessmenthostedModelId: ModelIdType | undefined;
  readonly assessmentDeadlineMs: number | undefined;
  readonly assessmentMaxInputBytes: number | undefined;
  readonly assessmentMaxOutputBytes: number | undefined;
};

export function createhostedOpenWeightsAdapterFromConfig(
  config: hostedAdapterConfig,
  transport?: hostedOpenWeightsTransport | undefined,
  onLog?: ((entry: hostedAssessmentLogEntry) => void) | undefined,
): Result<hostedOpenWeightsAdapter, ConfigError> {
  const endpoint = config.assessmenthostedBaseUrl;
  if (endpoint === undefined || endpoint.length === 0) {
    return err({ kind: "missing-variable", variable: ENDPOINT_VARIABLE });
  }
  if (!endpoint.startsWith("https://") || endpoint.length > 2048 || endpoint.includes(" ")) {
    return err({ kind: "invalid-value", variable: ENDPOINT_VARIABLE, reason: "must be an https URL" });
  }
  const apiKey = config.assessmenthostedApiKey;
  if (apiKey === undefined) {
    return err({ kind: "missing-variable", variable: API_KEY_VARIABLE });
  }
  const modelId = config.assessmenthostedModelId;
  if (modelId === undefined) {
    return err({ kind: "missing-variable", variable: MODEL_VARIABLE });
  }
  return ok(
    new hostedOpenWeightsAdapter({
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

export class hostedOpenWeightsAdapter extends ChatCompletionsAdapter implements AssessmentModelPort {
  constructor(options: hostedOpenWeightsAdapterOptions) {
    if (!options.endpoint.startsWith("https://")) {
      throw new Error("hosted endpoint must be an https URL");
    }
    super({
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      modelId: options.modelId,
      provider: "hosted-open-weights",
      timeoutMs: resolvehostedTimeoutMs(options.timeoutMs),
      maxBytesIn: resolvehostedMaxBytesIn(options.maxBytesIn),
      maxBytesOut: resolvehostedMaxBytesOut(options.maxBytesOut),
      maxOutputChars: options.maxOutputChars,
      transport: options.transport,
      onLog: options.onLog,
      onWarn: options.onWarn,
    });
  }

  provider(): "hosted-open-weights" {
    return "hosted-open-weights";
  }
}
