// Meta Model API investigate adapter behind InvestigationModelPort.
// Thin provider binding over the shared chat-completions core in
// investigateChatCompletions.ts: this module carries solely the Meta
// variable names, defaults and labels, while the request shape,
// transport handling and validation live in the shared core. Tests
// replay recorded fixtures and never touch the network; production
// passes the fetch-based transport. Every call appends one log entry
// with provider and model id; entries never carry the key or response
// content. The configured model id defaults to muse-spark-1.3; the key
// arrives only through its pointer file in the demo.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { ModelId as ModelIdType } from "../../domain/types.ts";
import { ModelId } from "../../domain/types.ts";
import type { ConfigError, SecretString } from "../../ports/config.ts";
import type { InvestigationModelPort } from "../../ports/investigationModel.ts";
import {
  InvestigateChatCompletionsAdapter,
  NotConfiguredInvestigateAdapter,
  fetchInvestigateChatTransport,
} from "./investigateChatCompletions.ts";
import type {
  InvestigateChatLogEntry,
  InvestigateChatTransport,
  InvestigateChatTransportInit,
  InvestigateChatTransportResponse,
} from "./investigateChatCompletions.ts";

export const INVESTIGATE_META_MODEL_ID = "muse-spark-1.3";

// Single HTTP round trip over an injected byte channel. Headers travel
// beside the body so the adapter builds the authorization header from
// the secret at the single point of use; transports never see the key
// except inside the header value, and the key is never logged.
export type MetaInvestigateTransportResponse = InvestigateChatTransportResponse;

export type MetaInvestigateTransportInit = InvestigateChatTransportInit;

export type MetaInvestigateTransport = InvestigateChatTransport;

// Production transport over the built-in fetch of Node. The endpoint URL
// (which may carry deployment routing) is used solely as the request
// target and is never logged or copied into errors.
export async function fetchMetaInvestigateTransport(
  url: string,
  init: MetaInvestigateTransportInit,
): Promise<MetaInvestigateTransportResponse> {
  return fetchInvestigateChatTransport(url, init);
}

// One log entry per investigation call: provider and model id travel with
// the request id and the outcome, and nothing else. The entry never
// carries the key, the request body or response content, so hostile
// strings cannot leak into logs.
export type MetaInvestigateLogEntry = InvestigateChatLogEntry;

export type MetaModelApiInvestigateAdapterOptions = {
  readonly endpoint: string;
  readonly apiKey: SecretString;
  readonly modelId: ModelIdType;
  readonly timeoutMs?: number | undefined;
  readonly maxBytesIn?: number | undefined;
  readonly maxBytesOut?: number | undefined;
  readonly maxOutputChars?: number | undefined;
  readonly transport?: MetaInvestigateTransport | undefined;
  readonly onLog?: ((entry: MetaInvestigateLogEntry) => void) | undefined;
};

const ENDPOINT_VARIABLE = "BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL";

// The subset of the validated configuration the adapter reads. Optional
// fields accept an explicit undefined, so a missing value in a partial
// test configuration maps to the not-configured adapter below. No
// provider is chosen here: an unset selection leaves the investigation
// disabled per the composition root. The model id defaults to
// muse-spark-1.3 when unset.
export type InvestigateMetaAdapterConfig = {
  readonly investigateMetaBaseUrl: string | undefined;
  readonly investigateMetaApiKey: SecretString | undefined;
  readonly investigateMetaModelId: ModelIdType | undefined;
  readonly investigateDeadlineMs: number | undefined;
  readonly investigateMaxInputBytes: number | undefined;
  readonly investigateMaxOutputBytes: number | undefined;
};

function defaultMetaModelId(): ModelIdType {
  const parsed = ModelId.parse(INVESTIGATE_META_MODEL_ID);
  if (!parsed.ok) {
    throw new Error("the pinned investigate Meta model id must parse");
  }
  return parsed.value;
}

export function createMetaModelApiInvestigateAdapterFromConfig(
  config: InvestigateMetaAdapterConfig,
  transport?: MetaInvestigateTransport | undefined,
  onLog?: ((entry: MetaInvestigateLogEntry) => void) | undefined,
): Result<InvestigationModelPort, ConfigError> {
  const endpoint = config.investigateMetaBaseUrl;
  const apiKey = config.investigateMetaApiKey;
  if (endpoint === undefined || apiKey === undefined) {
    return ok(
      new NotConfiguredInvestigateAdapter({
        provider: "meta-model-api",
        modelId: config.investigateMetaModelId,
        defaultModelId: defaultMetaModelId(),
        message: "investigation is not configured: set the Meta key",
      }),
    );
  }
  if (!endpoint.startsWith("https://") || endpoint.length > 2048 || endpoint.includes(" ")) {
    return err({ kind: "invalid-value", variable: ENDPOINT_VARIABLE, reason: "must be an https URL" });
  }
  return ok(
    new MetaModelApiInvestigateAdapter({
      endpoint,
      apiKey,
      modelId: config.investigateMetaModelId ?? defaultMetaModelId(),
      timeoutMs: config.investigateDeadlineMs,
      maxBytesIn: config.investigateMaxOutputBytes,
      maxBytesOut: config.investigateMaxInputBytes,
      maxOutputChars: config.investigateMaxOutputBytes,
      transport,
      onLog,
    }),
  );
}

export class MetaModelApiInvestigateAdapter
  extends InvestigateChatCompletionsAdapter
  implements InvestigationModelPort
{
  constructor(options: MetaModelApiInvestigateAdapterOptions) {
    if (!options.endpoint.startsWith("https://")) {
      throw new Error("Meta Model API investigate endpoint must be an https URL");
    }
    super({
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      modelId: options.modelId,
      provider: "meta-model-api",
      timeoutMs: options.timeoutMs,
      maxBytesIn: options.maxBytesIn,
      maxBytesOut: options.maxBytesOut,
      maxOutputChars: options.maxOutputChars,
      transport: options.transport,
      onLog: options.onLog,
    });
  }

  override provider(): "meta-model-api" {
    return "meta-model-api";
  }
}
