// hosted open-weights adapter behind InvestigationModelPort (S-073,
// K-036, K-520, K-513, P-30). Thin provider binding over the shared
// chat-completions core in investigateChatCompletions.ts: this module
// carries solely the hosted variable names, defaults and labels, while
// the request shape, transport handling and validation live in the
// shared core. Tests replay recorded fixtures and never touch the
// network; production passes the fetch-based transport.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { ModelId as ModelIdType } from "../../domain/types.ts";
import type { ConfigError, SecretString } from "../../ports/config.ts";
import type {
  InvestigationModelPort,
  InvestigationProvider,
} from "../../ports/investigationModel.ts";
import {
  InvestigateChatCompletionsAdapter,
  NotConfiguredInvestigateAdapter,
  fetchInvestigateChatTransport,
} from "./investigateChatCompletions.ts";
import type {
  InvestigateChatCompletionsOptions,
  InvestigateChatLogEntry,
  InvestigateChatTransport,
  InvestigateChatTransportInit,
  InvestigateChatTransportResponse,
} from "./investigateChatCompletions.ts";

export const INVESTIGATE_OPEN_WEIGHTS_MODEL_ID = "meta-models/muse-spark-open-1026";

export type hostedInvestigateTransportResponse = InvestigateChatTransportResponse;

export type hostedInvestigateTransportInit = InvestigateChatTransportInit;

export type hostedInvestigateTransport = InvestigateChatTransport;

export { fetchInvestigateChatTransport as fetchhostedInvestigateTransport };

export type hostedInvestigateLogEntry = InvestigateChatLogEntry;

export {
  DEFAULT_INVESTIGATE_MAX_BYTES_IN,
  DEFAULT_INVESTIGATE_MAX_BYTES_OUT,
  DEFAULT_INVESTIGATE_TIMEOUT_MS,
  INVESTIGATE_CHAT_MAX_TOKENS,
  INVESTIGATE_CHAT_PATH,
  INVESTIGATE_CHAT_TEMPERATURE,
  NotConfiguredInvestigateAdapter,
  buildInvestigateSystemPrompt,
  joinInvestigateChatUrl,
  stripInvestigateJsonFence,
} from "./investigateChatCompletions.ts";

export type hostedInvestigateAdapterOptions = Omit<InvestigateChatCompletionsOptions, "provider"> & {
  // Provider label for the bound endpoint. Defaults to the open-weights
  // loop; the composition root passes the vendor-neutral value when the
  // investigation shares the assessment endpoint configuration for a
  // temporary local endpoint during development.
  readonly provider?: InvestigationProvider | undefined;
};

const ENDPOINT_VARIABLE = "BRANDKLIPPAREN_INVESTIGATE_hosted_BASE_URL";

export type InvestigateAdapterConfig = {
  readonly investigatehostedBaseUrl: string | undefined;
  readonly investigatehostedApiKey: SecretString | undefined;
  readonly investigatehostedModelId: ModelIdType | undefined;
  readonly investigateDeadlineMs?: number | undefined;
  readonly investigateMaxInputBytes?: number | undefined;
  readonly investigateMaxOutputBytes?: number | undefined;
};

// Binds the real adapter when endpoint, key and model id are all set, and
// the not-configured adapter otherwise. The not-configured branch is not
// an error: the investigation answers `not-configured` per request with
// the deterministic analysis standing (P-29).
export function createhostedInvestigateAdapterFromConfig(
  config: InvestigateAdapterConfig,
  transport?: hostedInvestigateTransport | undefined,
  onLog?: ((entry: hostedInvestigateLogEntry) => void) | undefined,
): Result<InvestigationModelPort, ConfigError> {
  const endpoint = config.investigatehostedBaseUrl;
  const apiKey = config.investigatehostedApiKey;
  const modelId = config.investigatehostedModelId;
  if (endpoint === undefined || apiKey === undefined || modelId === undefined) {
    return ok(
      new NotConfiguredInvestigateAdapter({
        provider: "hosted-open-weights",
        modelId,
        defaultModelId: INVESTIGATE_OPEN_WEIGHTS_MODEL_ID as ModelIdType,
        message: "investigation is not configured: set the hosted key",
      }),
    );
  }
  if (!endpoint.startsWith("https://") || endpoint.length > 2048 || endpoint.includes(" ")) {
    return err({ kind: "invalid-value", variable: ENDPOINT_VARIABLE, reason: "must be an https URL" });
  }
  return ok(
    new hostedInvestigateAdapter({
      endpoint,
      apiKey,
      modelId,
      timeoutMs: config.investigateDeadlineMs,
      maxBytesIn: config.investigateMaxOutputBytes,
      maxBytesOut: config.investigateMaxInputBytes,
      maxOutputChars: config.investigateMaxOutputBytes,
      transport,
      onLog,
    }),
  );
}

export class hostedInvestigateAdapter extends InvestigateChatCompletionsAdapter implements InvestigationModelPort {
  constructor(options: hostedInvestigateAdapterOptions) {
    if (!options.endpoint.startsWith("https://")) {
      throw new Error("hosted investigate endpoint must be an https URL");
    }
    super({
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      modelId: options.modelId,
      provider: options.provider ?? "hosted-open-weights",
      timeoutMs: options.timeoutMs,
      maxBytesIn: options.maxBytesIn,
      maxBytesOut: options.maxBytesOut,
      maxOutputChars: options.maxOutputChars,
      jsonResponseFormat: options.jsonResponseFormat,
      transport: options.transport,
      onLog: options.onLog,
    });
  }
}
