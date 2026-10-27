// hosted open-weights adapter behind AssessmentModelPort (S-037,
// K-305, K-309). Driven adapter with an injectable HTTP transport: tests
// replay recorded fixtures and never touch the network; production passes
// the fetch-based transport. The request carries the closed evidence
// list only (K-302); raw bytecode never enters the prompt. The response
// is validated with validateAssessmentOutput before use (K-306, K-502,
// K-513): schema breaches and oversize output yield typed errors and keep
// the template text standing. Every call appends one log entry with
// provider and model id; entries never carry the key or response content
// (K-305, K-509). Placeholder model id and limits are test-only values,
// never learned model values (K-210).
import { err, ok } from "../../../domain/result.ts";
import type { Result } from "../../../domain/result.ts";
import type {
  ModelId as ModelIdType,
  PromptVersion as PromptVersionType,
} from "../../../domain/types.ts";
import type { ConfigError, SecretString } from "../../../ports/config.ts";
import type {
  AssessmentModelError,
  AssessmentModelLimits,
  AssessmentModelPort,
  AssessmentProvider,
  CallContext,
  EvidenceList,
  MuseAssessment,
} from "../../../ports/assessmentModel.ts";
import {
  resolveAssessmentOutputLimit,
  validateAssessmentOutput,
} from "../validateAssessment.ts";

// Open-weights model served on hosted per K-309 and A-34. The value is
// the provider's published model id, not a learned model value (K-210):
// tests and the composition root pass it in through the validated
// configuration, and the adapter only labels responses with it.
export const hosted_OPEN_WEIGHTS_MODEL_ID = "meta-models/muse-spark-open-1026";

// Single HTTP round trip over an injected byte channel. Headers travel
// beside the body so the adapter builds the authorization header from
// the secret at the single point of use; transports never see the key
// except inside the header value, and the key is never logged.
export type hostedOpenWeightsTransportResponse = {
  readonly status: number;
  readonly bodyText: string;
};

export type hostedOpenWeightsTransportInit = {
  readonly body: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
};

export type hostedOpenWeightsTransport = (
  url: string,
  init: hostedOpenWeightsTransportInit,
) => Promise<hostedOpenWeightsTransportResponse>;

// Production transport over the built-in fetch of Node. The endpoint URL
// (which may carry deployment routing) is used solely as the request
// target and is never logged or copied into errors.
export async function fetchhostedTransport(
  url: string,
  init: hostedOpenWeightsTransportInit,
): Promise<hostedOpenWeightsTransportResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return { status: response.status, bodyText: await response.text() };
}

// One log entry per assessment call (K-305, K-309, K-509): provider and
// model id travel with the request id and the outcome, and nothing else.
// The entry never carries the key, the request body or response content,
// so hostile strings cannot leak into logs (K-502, K-308).
export type hostedAssessmentLogEntry = {
  readonly requestId: string;
  readonly provider: AssessmentProvider;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly outcome: AssessmentModelError["kind"] | "ok";
};

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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Contract strings from the evidence travel as quoted data with a length
// cap in the prompt body (K-308): snippets are untrusted input, so a long
// snippet is truncated before sending and the raw bytecode never leaves
// the analysis path (K-302).
const SNIPPET_MAX_CHARS = 500;

function quoteSnippet(text: string): string {
  return text.length > SNIPPET_MAX_CHARS ? text.slice(0, SNIPPET_MAX_CHARS) : text;
}

function buildRequestBody(
  modelId: ModelIdType,
  promptVersion: PromptVersionType,
  evidence: EvidenceList,
): string {
  return JSON.stringify({
    model: modelId as string,
    promptVersion: promptVersion as string,
    evidence: {
      codeHash: evidence.codeHash as string,
      entries: evidence.evidence.map((entry) => ({
        selector: entry.selector as string,
        offset: (entry.offset as number | undefined) ?? null,
        snippet:
          entry.snippet === undefined
            ? null
            : {
                text: quoteSnippet(entry.snippet.text),
                line: entry.snippet.line,
              },
      })),
    },
  });
}

// Module-private timeout marker: only the adapter's own timeout race
// produces it, so a transport failure never maps to a timeout by accident.
class hostedTimeout {
  readonly marker = "hosted-timeout";
}

export class hostedOpenWeightsAdapter implements AssessmentModelPort {
  private readonly endpoint: string;
  private readonly apiKey: SecretString;
  private readonly modelIdValue: ModelIdType;
  private readonly timeoutMs: number;
  private readonly maxBytesIn: number;
  private readonly maxBytesOut: number;
  private readonly maxOutputChars: number;
  private readonly transport: hostedOpenWeightsTransport;
  private readonly onLog: ((entry: hostedAssessmentLogEntry) => void) | undefined;

  constructor(options: hostedOpenWeightsAdapterOptions) {
    if (!options.endpoint.startsWith("https://")) {
      throw new Error("hosted endpoint must be an https URL");
    }
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.modelIdValue = options.modelId;
    this.timeoutMs = resolvehostedTimeoutMs(options.timeoutMs);
    this.maxBytesIn = resolvehostedMaxBytesIn(options.maxBytesIn);
    this.maxBytesOut = resolvehostedMaxBytesOut(options.maxBytesOut);
    this.maxOutputChars = resolveAssessmentOutputLimit(options.maxOutputChars);
    this.transport = options.transport ?? fetchhostedTransport;
    this.onLog = options.onLog;
  }

  provider(): AssessmentProvider {
    return "hosted-open-weights";
  }

  modelId(): ModelIdType {
    return this.modelIdValue;
  }

  limits(): AssessmentModelLimits {
    return {
      deadlineMs: this.timeoutMs,
      maxBytesIn: this.maxBytesIn,
      maxBytesOut: this.maxBytesOut,
      maxConcurrency: 1,
      retryBudget: 0,
    };
  }

  async assess(
    evidence: EvidenceList,
    promptVersion: PromptVersionType,
    ctx: CallContext,
  ): Promise<Result<MuseAssessment, AssessmentModelError>> {
    const finish = (
      outcome: AssessmentModelError["kind"] | "ok",
    ): void => {
      this.onLog?.({
        requestId: ctx.requestId as string,
        provider: "hosted-open-weights",
        modelId: this.modelIdValue as string,
        promptVersion: promptVersion as string,
        outcome,
      });
    };
    const body = buildRequestBody(this.modelIdValue, promptVersion, evidence);
    if (byteLength(body) > this.maxBytesOut) {
      const error: AssessmentModelError = {
        kind: "invalid-output",
        message: "assessment request exceeds the input size limit",
      };
      finish(error.kind);
      return err(error);
    }
    const sent = await this.invoke(body, ctx);
    if (!sent.ok) {
      finish(sent.error.kind);
      return sent;
    }
    const response = sent.value;
    if (response.status === 429) {
      const error: AssessmentModelError = {
        kind: "rate-limited",
        message: "assessment provider rate limited the request",
      };
      finish(error.kind);
      return err(error);
    }
    if (response.status === 408 || response.status === 504) {
      const error: AssessmentModelError = {
        kind: "timeout",
        message: "assessment provider timed out",
      };
      finish(error.kind);
      return err(error);
    }
    if (response.status >= 500 && response.status <= 599) {
      const error: AssessmentModelError = {
        kind: "unavailable",
        message: "assessment provider is unavailable",
      };
      finish(error.kind);
      return err(error);
    }
    if (response.status < 200 || response.status >= 300) {
      const error: AssessmentModelError = {
        kind: "invalid-output",
        message: `assessment provider answered with status ${response.status}`,
      };
      finish(error.kind);
      return err(error);
    }
    if (byteLength(response.bodyText) > this.maxBytesIn) {
      const error: AssessmentModelError = {
        kind: "output-too-large",
        message: "assessment response exceeds the output size limit",
        limitChars: this.maxOutputChars,
      };
      finish(error.kind);
      return err(error);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.bodyText) as unknown;
    } catch {
      const error: AssessmentModelError = {
        kind: "invalid-output",
        message: "assessment response is not valid JSON",
      };
      finish(error.kind);
      return err(error);
    }
    const validated = validateAssessmentOutput(raw, evidence, {
      provider: "hosted-open-weights",
      modelId: this.modelIdValue,
      promptVersion,
      maxOutputChars: this.maxOutputChars,
    });
    if (!validated.ok) {
      finish(validated.error.kind);
      return validated;
    }
    finish("ok");
    return validated;
  }

  // The configured timeout bounds every call; a context deadline in the
  // future caps it further. A deadline already passed (as in frozen
  // recorded fixtures) does not fail the call ahead of the transport:
  // the timeout race still bounds the call, and production contexts
  // always carry future deadlines.
  private effectiveTimeoutMs(ctx: CallContext): number {
    const remaining = (ctx.deadline as number) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return this.timeoutMs;
    }
    return Math.min(this.timeoutMs, Math.floor(remaining));
  }

  private async invoke(
    body: string,
    ctx: CallContext,
  ): Promise<Result<hostedOpenWeightsTransportResponse, AssessmentModelError>> {
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
      const onTimeout = new Promise<hostedOpenWeightsTransportResponse>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new hostedTimeout());
        }, this.effectiveTimeoutMs(ctx));
      });
      const response = await Promise.race([pending, onTimeout]);
      return ok(response);
    } catch (error) {
      if (error instanceof hostedTimeout || controller.signal.aborted) {
        return err({ kind: "timeout", message: "assessment call timed out" });
      }
      return err({ kind: "unavailable", message: "assessment provider is unavailable" });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
