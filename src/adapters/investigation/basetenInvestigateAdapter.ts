// hosted open-weights adapter behind InvestigationModelPort (S-073,
// K-036, K-520, K-513, P-30). Driven adapter with an injectable HTTP
// transport: tests replay recorded fixtures and never touch the network;
// production passes the fetch-based transport. The request carries the
// closed frozen input only; the response is validated with
// validateInvestigationDecision before use. Without a configured endpoint,
// key or model id the factory binds the not-configured adapter whose
// every call answers `not-configured` with zero sends (P-29). Every call
// appends one log entry with provider and model id; entries never carry
// the key or response content.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { ModelId as ModelIdType } from "../../domain/types.ts";
import type { ConfigError, SecretString } from "../../ports/config.ts";
import type {
  InvestigationCallContext,
  InvestigationDecision,
  InvestigationModelError,
  InvestigationModelInput,
  InvestigationModelPort,
  InvestigationProvider,
} from "../../ports/investigationModel.ts";
import {
  DEFAULT_INVESTIGATION_MAX_OUTPUT_CHARS,
  validateInvestigationDecision,
} from "./validateInvestigation.ts";

export const INVESTIGATE_OPEN_WEIGHTS_MODEL_ID = "meta-models/muse-spark-open-1026";

export type hostedInvestigateTransportResponse = {
  readonly status: number;
  readonly bodyText: string;
};

export type hostedInvestigateTransportInit = {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
};

export type hostedInvestigateTransport = (
  url: string,
  init: hostedInvestigateTransportInit,
) => Promise<hostedInvestigateTransportResponse>;

export async function fetchhostedInvestigateTransport(
  url: string,
  init: hostedInvestigateTransportInit,
): Promise<hostedInvestigateTransportResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return { status: response.status, bodyText: await response.text() };
}

export type hostedInvestigateLogEntry = {
  readonly requestId: string;
  readonly provider: InvestigationProvider;
  readonly modelId: string;
  readonly outcome: InvestigationModelError["kind"] | "ok";
};

// Placeholder operational limits for tests and offline use. Production
// passes the versioned values from the validated configuration; the
// adapter never invents its own.
export const DEFAULT_INVESTIGATE_TIMEOUT_MS = 30000;
export const DEFAULT_INVESTIGATE_MAX_BYTES_IN = 65536;
export const DEFAULT_INVESTIGATE_MAX_BYTES_OUT = 65536;

export type hostedInvestigateAdapterOptions = {
  readonly endpoint: string;
  readonly apiKey: SecretString;
  readonly modelId: ModelIdType;
  readonly timeoutMs?: number | undefined;
  readonly maxBytesIn?: number | undefined;
  readonly maxBytesOut?: number | undefined;
  readonly maxOutputChars?: number | undefined;
  readonly transport?: hostedInvestigateTransport | undefined;
  readonly onLog?: ((entry: hostedInvestigateLogEntry) => void) | undefined;
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
    return ok(new NotConfiguredInvestigateAdapter(modelId));
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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function buildRequestBody(input: InvestigationModelInput): string {
  return JSON.stringify({
    codeHash: input.codeHash as string,
    scoreBand: input.scoreBand,
    signalIds: input.signalIds.slice(),
    tools: input.tools.map((tool) => ({
      toolId: tool.toolId,
      description: tool.description,
      argNames: tool.argNames.slice(),
    })),
    trace: input.trace.map((entry) => ({
      step: entry.step,
      toolId: entry.toolId,
      rationale: entry.rationale,
      evidenceIds: entry.evidenceIds.slice(),
    })),
    budgets: { ...input.budgets },
  });
}

class hostedInvestigateTimeout {
  readonly marker = "hosted-investigate-timeout";
}

// Not-configured adapter (P-29): bound when the key is absent. Every call
// answers `not-configured` with zero sends; the model id labels the state
// when configured, and the default open-weights id otherwise.
export class NotConfiguredInvestigateAdapter implements InvestigationModelPort {
  private readonly modelIdValue: ModelIdType | undefined;

  constructor(modelId?: ModelIdType | undefined) {
    this.modelIdValue = modelId;
  }

  provider(): InvestigationProvider {
    return "hosted-open-weights";
  }

  modelId(): ModelIdType {
    const value = this.modelIdValue ?? (INVESTIGATE_OPEN_WEIGHTS_MODEL_ID as ModelIdType);
    return value;
  }

  async decide(): Promise<Result<InvestigationDecision, InvestigationModelError>> {
    return err({ kind: "not-configured", message: "investigation is not configured: set the hosted key" });
  }
}

export class hostedInvestigateAdapter implements InvestigationModelPort {
  private readonly endpoint: string;
  private readonly apiKey: SecretString;
  private readonly modelIdValue: ModelIdType;
  private readonly timeoutMs: number;
  private readonly maxBytesIn: number;
  private readonly maxBytesOut: number;
  private readonly maxOutputChars: number;
  private readonly transport: hostedInvestigateTransport;
  private readonly onLog: ((entry: hostedInvestigateLogEntry) => void) | undefined;

  constructor(options: hostedInvestigateAdapterOptions) {
    if (!options.endpoint.startsWith("https://")) {
      throw new Error("hosted investigate endpoint must be an https URL");
    }
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.modelIdValue = options.modelId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_INVESTIGATE_TIMEOUT_MS;
    this.maxBytesIn = options.maxBytesIn ?? DEFAULT_INVESTIGATE_MAX_BYTES_IN;
    this.maxBytesOut = options.maxBytesOut ?? DEFAULT_INVESTIGATE_MAX_BYTES_OUT;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_INVESTIGATION_MAX_OUTPUT_CHARS;
    this.transport = options.transport ?? fetchhostedInvestigateTransport;
    this.onLog = options.onLog;
  }

  provider(): InvestigationProvider {
    return "hosted-open-weights";
  }

  modelId(): ModelIdType {
    return this.modelIdValue;
  }

  async decide(
    input: InvestigationModelInput,
    ctx: InvestigationCallContext,
  ): Promise<Result<InvestigationDecision, InvestigationModelError>> {
    const finish = (outcome: InvestigationModelError["kind"] | "ok"): void => {
      this.onLog?.({
        requestId: ctx.requestId as string,
        provider: "hosted-open-weights",
        modelId: this.modelIdValue as string,
        outcome,
      });
    };
    const body = buildRequestBody(input);
    if (byteLength(body) > this.maxBytesOut) {
      const error: InvestigationModelError = {
        kind: "invalid-output",
        message: "investigation request exceeds the input size limit",
      };
      finish(error.kind);
      return err(error);
    }
    const sent = await this.invoke(body);
    if (!sent.ok) {
      finish(sent.error.kind);
      return sent;
    }
    const response = sent.value;
    if (response.status === 429) {
      const error: InvestigationModelError = {
        kind: "rate-limited",
        message: "investigation provider rate limited the request",
      };
      finish(error.kind);
      return err(error);
    }
    if (response.status === 408 || response.status === 504) {
      const error: InvestigationModelError = { kind: "timeout", message: "investigation provider timed out" };
      finish(error.kind);
      return err(error);
    }
    if (response.status >= 500 && response.status <= 599) {
      const error: InvestigationModelError = { kind: "unavailable", message: "investigation provider is unavailable" };
      finish(error.kind);
      return err(error);
    }
    if (response.status < 200 || response.status >= 300) {
      const error: InvestigationModelError = {
        kind: "invalid-output",
        message: "investigation provider gave an unexpected status",
      };
      finish(error.kind);
      return err(error);
    }
    if (byteLength(response.bodyText) > this.maxBytesIn) {
      const error: InvestigationModelError = {
        kind: "output-too-large",
        message: "investigation response exceeds the output size limit",
        limitChars: this.maxOutputChars,
      };
      finish(error.kind);
      return err(error);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.bodyText) as unknown;
    } catch {
      const error: InvestigationModelError = {
        kind: "invalid-output",
        message: "investigation response is not valid JSON",
      };
      finish(error.kind);
      return err(error);
    }
    const validated = validateInvestigationDecision(raw, {
      provider: "hosted-open-weights",
      modelId: this.modelIdValue,
      maxOutputChars: this.maxOutputChars,
    });
    if (!validated.ok) {
      finish(validated.error.kind);
      return validated;
    }
    finish("ok");
    return validated;
  }

  private async invoke(body: string): Promise<Result<hostedInvestigateTransportResponse, InvestigationModelError>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = this.transport(this.endpoint, {
        body,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey.reveal()}`,
        },
        signal: controller.signal,
      });
      const onTimeout = new Promise<hostedInvestigateTransportResponse>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new hostedInvestigateTimeout());
        }, this.timeoutMs);
      });
      const response = await Promise.race([pending, onTimeout]);
      return ok(response);
    } catch (error) {
      if (error instanceof hostedInvestigateTimeout || controller.signal.aborted) {
        return err({ kind: "timeout", message: "investigation call timed out" });
      }
      return err({ kind: "unavailable", message: "investigation provider is unavailable" });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
