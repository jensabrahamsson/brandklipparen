// Versioned REST API as a thin driving adapter (S-027, K-023, K-024).
// Fastify 5.x per the architecture stack (A-29) carries the routes under
// /v1; plain boundary checks plus smart constructors validate every input
// at the boundary (A-16). The adapter
// owns solely validation, the API key check and response formatting:
// detection lives in the shared application service behind AppServices,
// which the server receives through constructor injection (A-02, A-03).
// Success bodies are the service output byte for byte, so equal input
// gives equal bytes in every interface (K-027). The deepening per K-101
// streams in a later story; until then responses carry the header
// x-deepening-status: pending beside the fast-path envelope.
import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { serializeAssessment } from "../../application/analyzeToken.ts";
import type { AppServices, DetectorSet } from "../../application/analyzeToken.ts";
import {
  exposeManifest,
  exposeRegistry,
  serializePluginDocs,
  serializePluginList,
  weightOfMapping,
} from "../../plugins/exposure.ts";
import type { PluginDocsMap, PluginWeightMapping } from "../../plugins/exposure.ts";
import { serializeStoredAuditReport } from "../../plugins/auditReport.ts";
import type { StoredAuditReportMap } from "../../plugins/auditReport.ts";
import { serializeTokenAssessment } from "../../application/assessmentService.ts";
import type { AssessmentService } from "../../application/assessmentService.ts";
import { serializePersonalizeOutcome } from "../../application/personalizeService.ts";
import type { PersonalizeService } from "../../application/personalizeService.ts";
import { sectionBodyOf } from "../../plugins/docs.ts";
import { serializeTokenInvestigation } from "../../application/investigationService.ts";
import type { InvestigationService } from "../../application/investigationService.ts";
import {
  PLACEHOLDER_COST_UNIT,
  createRequestCounters,
} from "../../application/observability.ts";
import { Address, BlockNumber, RequestId, Timestamp } from "../../domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  IndexVersion,
  ModelVersion,
  PromptVersion as PromptVersionType,
  TemplateVersion,
} from "../../domain/types.ts";
import type { CapabilityCatalogue } from "../../domain/signals.ts";
import { canonicalSerialize } from "../../domain/serialize.ts";
import { createApiKeyStore } from "./apiKeys.ts";
import type { ApiKeyStore } from "./apiKeys.ts";
import type { SecretString } from "../../ports/config.ts";
import {
  assessmentNotConfigured,
  invalidApiKey,
  investigationNotConfigured,
  keyInUrlOrBody,
  missingApiKey,
  notFound,
  rateLimited,
  requestError,
  requestTooLarge,
  toHttpError,
  validationError,
} from "./errors.ts";
import type { HttpError } from "./errors.ts";
import { createRateLimiter } from "./rateLimit.ts";
import type { RateLimitConfig, RateLimiter } from "./rateLimit.ts";

export const API_VERSION = "v1";
export const API_KEY_HEADER = "x-api-key";
export const REQUEST_ID_HEADER = "x-request-id";
export const DEEPENING_STATUS_HEADER = "x-deepening-status";
// Strict content security policy on every response (K-507, M-13): the API
// carries data only, so no source is allowed to execute. Contract-derived
// strings travel inside JSON string values as inert text.
export const CSP_HEADER = "content-security-policy";
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
// Request-scoped cost metadata per response (S-031, K-107): assessment calls
// and placeholder assessment cost units for this request. A normal analyze
// request reports zero for both; an assessment request reports the counted
// calls (zero on a cache hit or a capped key, one on a provider call).
export const ASSESSMENT_CALLS_HEADER = "x-assessment-calls";
export const ASSESSMENT_COST_HEADER = "x-assessment-cost-units";

const DEFAULT_ANALYZE_TIMEOUT_MS = 30000;
const DEFAULT_MAX_QUERY_CHARS = 2048;
const DEFAULT_MAX_BODY_BYTES = 8192;
const DEFAULT_MAX_ADDRESS_CHARS = 1024;
const DEFAULT_MAX_BLOCK_CHARS = 64;

export type RestServerOptions = {
  readonly services: AppServices;
  readonly apiKeys: readonly SecretString[];
  readonly apiKeyPepper: SecretString | undefined;
  readonly modelVersion: ModelVersion;
  readonly indexVersion: IndexVersion;
  readonly templateVersion: TemplateVersion;
  readonly catalogue: CapabilityCatalogue;
  // Registered detector set behind the plugin routes (S-046, P-09): the
  // REST plugin list derives from this one registry value, the same value
  // the shared service runs. The composition root wires the set
  // explicitly; no defaulted set exists.
  readonly detectors: DetectorSet;
  // Calibrated detector weights read once at startup from the loaded
  // artifact (S-047, P-05, P-09); absent entries expose weight 0. Tests
  // omit it and see the uncalibrated list.
  readonly pluginWeights?: PluginWeightMapping | undefined;
  // Validated plugin docs keyed by plugin id (S-056, P-16): the same
  // records the MCP docs surface reads. An unknown plugin id, or a known
  // id without a record, gives the uniform not-found error.
  readonly pluginDocs?: PluginDocsMap | undefined;
  // Stored CI audit reports keyed by plugin id (S-058, K-516): the same
  // records the MCP audit surface reads. Read-only; an unknown plugin id,
  // or a known id without a stored report, gives the uniform not-found
  // error. The read view never triggers an audit.
  readonly pluginAudits?: StoredAuditReportMap | undefined;
  readonly analyzeTimeoutMs?: number | undefined;
  readonly maxQueryChars?: number | undefined;
  readonly maxBodyBytes?: number | undefined;
  // Absent service means the assessment feature is disabled through
  // configuration (K-309): /v1/assessment answers assessment-not-configured.
  readonly assessmentService?: AssessmentService | undefined;
  // Personalize service for the experimental AI layout mapping (S-069,
  // K-519, P-27). Absent service means the toggle stays off: the route
  // answers the not-configured envelope with the deterministic baseline
  // standing.
  readonly personalizeService?: PersonalizeService | undefined;
  // Mapping prompt version for the personalize cache key (P-27): the same
  // version the adapter prompt carries. Absent version disables the route
  // like an absent service.
  readonly personalizePromptVersion?: PromptVersionType | undefined;
  // Absent service means the investigation loop is disabled through
  // configuration (P-29): /v1/investigate answers
  // investigation-not-configured with zero model calls.
  readonly investigationService?: InvestigationService | undefined;
  // Absent limits mean the demo runs without rate limiting, as in local
  // development and in older suites; the demo configuration always sets
  // the versioned values per I-12 (K-504, M-08).
  readonly rateLimit?: RateLimitConfig | undefined;
  // Injected clock reader for the limiter; tests pass a fake clock while
  // production reads the wall clock (A-32 stays intact: the core is untouched).
  readonly rateLimitNowMs?: (() => number) | undefined;
};

export type RestServer = {
  // Binds an ephemeral or fixed local port and resolves the base URL.
  readonly listen: (host: string, port: number) => Promise<string>;
  readonly close: () => Promise<void>;
};

// Raw analyse input at the boundary: address plus an optional block, read
// from the query string (GET) or the JSON body (POST). Validated with plain
// checks here; Address.parse and parseBlock below carry the domain proof,
// so no schema library is needed at runtime (A-16).
type RawAnalyzeInput = {
  readonly address: string;
  readonly block?: string | number | undefined;
};

function parseAnalyzeInput(raw: unknown): RawAnalyzeInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const address = record["address"];
  if (
    typeof address !== "string" ||
    address.length < 1 ||
    address.length > DEFAULT_MAX_ADDRESS_CHARS
  ) {
    return null;
  }
  const block = record["block"];
  if (block === undefined) {
    return { address };
  }
  if (typeof block === "number") {
    return { address, block };
  }
  if (typeof block === "string" && block.length <= DEFAULT_MAX_BLOCK_CHARS) {
    return { address, block };
  }
  return null;
}

// Parameter names that name a secret: a request carrying one in the URL or
// the body is turned away before analysis (M-10).
const SECRET_LIKE = /key|token|secret|password|auth/i;

function issueRequestId(): RequestId {
  const parsed = RequestId.parse(randomUUID());
  if (!parsed.ok) {
    throw new Error("generated request id fails its own format");
  }
  return parsed.value;
}

function sendError(reply: FastifyReply, error: HttpError): FastifyReply {
  const withHeaders = reply
    .code(error.status)
    .header(REQUEST_ID_HEADER, error.body.requestId)
    .type("application/json");
  if (error.retryAfterSec !== undefined) {
    // Retryable machine error (K-504, M-08): the caller reads the wait
    // from the header as well as the message.
    withHeaders.header("retry-after", String(error.retryAfterSec));
  }
  return withHeaders.send(JSON.stringify(error.body));
}

function hasSecretLikeKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).some((name) => SECRET_LIKE.test(name));
}

function parseBlock(raw: string | number | undefined): { ok: true; value: BlockNumberType | "latest" } | { ok: false } {
  if (raw === undefined || raw === "latest") {
    return { ok: true, value: "latest" };
  }
  if (typeof raw === "number") {
    const parsed = BlockNumber.of(raw);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false };
  }
  if (/^\d+$/.test(raw)) {
    const parsed = BlockNumber.of(Number(raw));
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false };
  }
  return { ok: false };
}

export function createRestServer(options: RestServerOptions): RestServer {
  const store: ApiKeyStore = createApiKeyStore({ keys: options.apiKeys, pepper: options.apiKeyPepper });
  const limiter: RateLimiter | null =
    options.rateLimit === undefined
      ? null
      : createRateLimiter(options.rateLimit, options.rateLimitNowMs);
  const analyzeTimeoutMs = options.analyzeTimeoutMs ?? DEFAULT_ANALYZE_TIMEOUT_MS;
  const maxQueryChars = options.maxQueryChars ?? DEFAULT_MAX_QUERY_CHARS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const app: FastifyInstance = Fastify({ logger: false, bodyLimit: maxBodyBytes });

  app.setErrorHandler(async (error: FastifyError, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const requestId = issueRequestId();
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return sendError(reply, requestTooLarge(requestId));
    }
    void request;
    return sendError(reply, validationError("Invalid request: expected a JSON object with address and block.", requestId));
  });

  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    void request;
    return sendError(reply, notFound(issueRequestId()));
  });

  // The policy rides on every response, including errors and the health
  // check, so no route weakens the client posture (M-13).
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header(CSP_HEADER, CONTENT_SECURITY_POLICY);
    return payload;
  });

  app.get("/health", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    void request;
    const requestId = issueRequestId();
    // Minimal observability and cost frame (S-031, K-104, K-107, I-12):
    // provider and model labelling with the placeholder cost unit. Keys
    // stay out: the frame names the provider and model id only.
    const service = options.assessmentService;
    const assessment =
      service === undefined || service.provider === null || service.modelId === null
        ? { disabled: true }
        : { provider: service.provider, modelId: service.modelId };
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .type("application/json")
      .send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          assessment,
          costUnits: PLACEHOLDER_COST_UNIT,
        }),
      );
  });

  // Shared boundary gate for the analysis routes (A-11, A-16): URL size,
  // secret-like keys, API key and typed address and block. The assessment
  // route reuses the same gate, so both routes face identical limits.
  type GatedInput = {
    readonly apiKey: string;
    readonly address: AddressType;
    readonly block: BlockNumberType | "latest";
  };

  // Shared key gate for every versioned route (K-024): URL size,
  // secret-like keys, API key and the rate and quota step. Analysis routes
  // add typed address and block parsing on top; the plugin list routes stop
  // here, so listing faces the identical key and quota limits.
  function gateKeyOnly(
    request: FastifyRequest,
    rawInput: unknown,
    requestId: RequestId,
  ): { readonly ok: true; readonly value: { readonly apiKey: string } } | { readonly ok: false; readonly error: HttpError } {
    if ((request.raw.url ?? "").length > maxQueryChars) {
      return { ok: false, error: requestTooLarge(requestId as string) };
    }
    if (hasSecretLikeKey(request.query) || hasSecretLikeKey(rawInput)) {
      return { ok: false, error: keyInUrlOrBody(requestId as string) };
    }
    const headerKey = request.headers[API_KEY_HEADER];
    if (headerKey === undefined) {
      return { ok: false, error: missingApiKey(requestId as string) };
    }
    if (typeof headerKey !== "string" || !store.verify(headerKey)) {
      return { ok: false, error: invalidApiKey(requestId as string) };
    }
    // Rate and quota step before every expensive step (K-504, M-08): a key
    // over its per-minute rate or its daily quota receives a retryable
    // machine error with a retry time, and the analysis never starts.
    if (limiter !== null) {
      const keyId = store.keyId(headerKey) ?? "unknown-key";
      const decision = limiter.check(keyId);
      if (!decision.allowed) {
        return { ok: false, error: rateLimited(decision.retryAfterSec, requestId as string) };
      }
    }
    return { ok: true, value: { apiKey: headerKey } };
  }

  function gateRequest(
    request: FastifyRequest,
    rawInput: unknown,
    requestId: RequestId,
  ): { readonly ok: true; readonly value: GatedInput } | { readonly ok: false; readonly error: HttpError } {
    const keyed = gateKeyOnly(request, rawInput, requestId);
    if (!keyed.ok) {
      return keyed;
    }
    const parsedInput = parseAnalyzeInput(rawInput);
    if (parsedInput === null) {
      return {
        ok: false,
        error: validationError("Invalid address: expected 0x followed by 40 hex characters.", requestId as string),
      };
    }
    const address = Address.parse(parsedInput.address);
    if (!address.ok) {
      return {
        ok: false,
        error: validationError("Invalid address: expected 0x followed by 40 hex characters.", requestId as string),
      };
    }
    const block = parseBlock(parsedInput.block);
    if (!block.ok) {
      return {
        ok: false,
        error: validationError("Invalid block: expected latest or a non-negative integer.", requestId as string),
      };
    }
    return { ok: true, value: { apiKey: keyed.value.apiKey, address: address.value, block: block.value } };
  }

  // Current day as YYYY-MM-DD for the per-key daily cost meter (I-14).
  // Driving adapters may read the clock; the core stays pure (A-32).
  function currentDay(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async function handleAnalyze(request: FastifyRequest, reply: FastifyReply, rawInput: unknown): Promise<FastifyReply> {
    const requestId = issueRequestId();
    const gated = gateRequest(request, rawInput, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const { address, block } = gated.value;
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return sendError(reply, requestError(500, "internal-error", "Analysis failed; retry with the same request ID.", requestId));
    }
    // Request-scoped counters (S-031, K-107): the analyze path carries zero
    // assessment calls, and the headers report it for this request.
    const counters = createRequestCounters();
    const analysed = await options.services.analyzeToken(
      {
        address,
        block,
        requestId,
        deadline: deadline.value,
        modelVersion: options.modelVersion,
        indexVersion: options.indexVersion,
        templateVersion: options.templateVersion,
        catalogue: options.catalogue,
      },
      counters,
    );
    if (!analysed.ok) {
      const mapped = toHttpError(analysed.error);
      return sendError(
        reply,
        requestError(mapped.status, mapped.code, mapped.message, requestId),
      );
    }
    const usage = counters.snapshot();
    if (analysed.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: analysed.value.target as string,
        block: analysed.value.block as number,
      });
      return reply
        .code(200)
        .header(REQUEST_ID_HEADER, requestId)
        .header(DEEPENING_STATUS_HEADER, "pending")
        .header(ASSESSMENT_CALLS_HEADER, String(usage.assessmentCalls))
        .header(ASSESSMENT_COST_HEADER, String(usage.assessmentCostUnits))
        .type("application/json")
        .send(body);
    }
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .header(DEEPENING_STATUS_HEADER, "pending")
      .header(ASSESSMENT_CALLS_HEADER, String(usage.assessmentCalls))
      .header(ASSESSMENT_COST_HEADER, String(usage.assessmentCostUnits))
      .type("application/json")
      .send(serializeAssessment(analysed.value.envelope));
  }

  // On-request Muse contract assessment (S-038, K-305, K-309): same gate
  // as the analysis routes, then the shared assessment service. Scores and
  // evidence pass through untouched; the assessment lands in its own field
  // with provider and model id labelling. A capped key or a provider error
  // still answers 200 with the template explanation standing (K-306).
  async function handleAssessment(request: FastifyRequest, reply: FastifyReply, rawInput: unknown): Promise<FastifyReply> {
    const requestId = issueRequestId();
    const gated = gateRequest(request, rawInput, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const service = options.assessmentService;
    if (service === undefined) {
      return sendError(reply, assessmentNotConfigured(requestId));
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return sendError(reply, requestError(500, "internal-error", "Analysis failed; retry with the same request ID.", requestId));
    }
    const counters = createRequestCounters();
    const requested = await service.requestForToken(
      {
        address: gated.value.address,
        block: gated.value.block,
        requestId,
        deadline: deadline.value,
        modelVersion: options.modelVersion,
        indexVersion: options.indexVersion,
        templateVersion: options.templateVersion,
        catalogue: options.catalogue,
        apiKeyId: store.keyId(gated.value.apiKey) ?? "unknown-key",
        day: currentDay(),
      },
      counters,
    );
    if (!requested.ok) {
      const mapped = toHttpError(requested.error);
      return sendError(
        reply,
        requestError(mapped.status, mapped.code, mapped.message, requestId),
      );
    }
    if (requested.value.kind === "disabled") {
      return sendError(reply, assessmentNotConfigured(requestId));
    }
    const usage = counters.snapshot();
    if (requested.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: requested.value.target as string,
        block: requested.value.block as number,
      });
      return reply
        .code(200)
        .header(REQUEST_ID_HEADER, requestId)
        .header(DEEPENING_STATUS_HEADER, "pending")
        .header(ASSESSMENT_CALLS_HEADER, String(usage.assessmentCalls))
        .header(ASSESSMENT_COST_HEADER, String(usage.assessmentCostUnits))
        .type("application/json")
        .send(body);
    }
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .header(DEEPENING_STATUS_HEADER, "pending")
      .header(ASSESSMENT_CALLS_HEADER, String(usage.assessmentCalls))
      .header(ASSESSMENT_COST_HEADER, String(usage.assessmentCostUnits))
      .type("application/json")
      .send(serializeTokenAssessment(requested.value));
  }

  // Opt-in investigation loop (S-075, K-036, P-37): same gate as the
  // analysis routes, then the deterministic analysis followed by the shared
  // investigation service. Scores and evidence pass through untouched; the
  // trace and the citation-checked narrative land in their own fields with
  // provider and model id labelling. Without a service the route answers
  // investigation-not-configured with zero model calls (P-29).
  async function handleInvestigate(request: FastifyRequest, reply: FastifyReply, rawInput: unknown): Promise<FastifyReply> {
    const requestId = issueRequestId();
    const gated = gateRequest(request, rawInput, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const service = options.investigationService;
    if (service === undefined) {
      return sendError(reply, investigationNotConfigured(requestId));
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return sendError(reply, requestError(500, "internal-error", "Analysis failed; retry with the same request ID.", requestId));
    }
    const counters = createRequestCounters();
    const analysed = await options.services.analyzeToken(
      {
        address: gated.value.address,
        block: gated.value.block,
        requestId,
        deadline: deadline.value,
        modelVersion: options.modelVersion,
        indexVersion: options.indexVersion,
        templateVersion: options.templateVersion,
        catalogue: options.catalogue,
      },
      counters,
    );
    if (!analysed.ok) {
      const mapped = toHttpError(analysed.error);
      return sendError(
        reply,
        requestError(mapped.status, mapped.code, mapped.message, requestId),
      );
    }
    const usage = counters.snapshot();
    if (analysed.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: analysed.value.target as string,
        block: analysed.value.block as number,
      });
      return reply
        .code(200)
        .header(REQUEST_ID_HEADER, requestId)
        .header(DEEPENING_STATUS_HEADER, "pending")
        .header(ASSESSMENT_CALLS_HEADER, String(usage.assessmentCalls))
        .header(ASSESSMENT_COST_HEADER, String(usage.assessmentCostUnits))
        .type("application/json")
        .send(body);
    }
    // Quota identity for the investigation cost meter (S-077, I-14): the
    // stable key id and the current day travel with the request, so an
    // over-cap key ends capped with zero new model calls.
    const investigated = await service.investigateEnvelope(
      analysed.value.envelope,
      {
        requestId,
        deadline: deadline.value,
        block: analysed.value.envelope.block,
      },
      { now: () => Date.now() },
      {
        apiKeyId: store.keyId(gated.value.apiKey) ?? "unknown-key",
        day: currentDay(),
      },
    );
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .header(DEEPENING_STATUS_HEADER, "pending")
      .header(ASSESSMENT_CALLS_HEADER, String(usage.assessmentCalls))
      .header(ASSESSMENT_COST_HEADER, String(usage.assessmentCostUnits))
      .type("application/json")
      .send(
        serializeTokenInvestigation(
          analysed.value.envelope,
          investigated,
          service.provider(),
          service.modelId(),
        ),
      );
  }

  // Step-events stream for the investigation (S-075, K-036, P-37): the same
  // gate and the same deterministic analysis, then one `step` event per
  // recorded trace step in order, then a final `report` event. Rationale
  // and narrative travel as JSON strings, so model text stays inert data.
  // The deterministic analysis response is unchanged whether or not an
  // investigation runs: the stream carries its own envelope copy.
  async function handleInvestigateEvents(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const requestId = issueRequestId();
    const gated = gateRequest(request, request.query, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const service = options.investigationService;
    if (service === undefined) {
      return sendError(reply, investigationNotConfigured(requestId));
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return sendError(reply, requestError(500, "internal-error", "Analysis failed; retry with the same request ID.", requestId));
    }
    const counters = createRequestCounters();
    const analysed = await options.services.analyzeToken(
      {
        address: gated.value.address,
        block: gated.value.block,
        requestId,
        deadline: deadline.value,
        modelVersion: options.modelVersion,
        indexVersion: options.indexVersion,
        templateVersion: options.templateVersion,
        catalogue: options.catalogue,
      },
      counters,
    );
    if (!analysed.ok) {
      const mapped = toHttpError(analysed.error);
      return sendError(
        reply,
        requestError(mapped.status, mapped.code, mapped.message, requestId),
      );
    }
    if (analysed.value.kind === "no-contract") {
      return reply
        .code(200)
        .header(REQUEST_ID_HEADER, requestId)
        .type("application/json")
        .send(
          canonicalSerialize({
            kind: "no-contract",
            target: analysed.value.target as string,
            block: analysed.value.block as number,
          }),
        );
    }
    const envelope = analysed.value.envelope;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      [REQUEST_ID_HEADER]: requestId as string,
      [CSP_HEADER]: CONTENT_SECURITY_POLICY,
    });
    const send = (payload: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    try {
      const investigated = await service.investigateEnvelope(
        envelope,
        {
          requestId,
          deadline: deadline.value,
          block: envelope.block,
        },
        {
          now: () => Date.now(),
          onStep: (step) => {
            send({
              kind: "step",
              step: step.step,
              toolId: step.toolId,
              rationale: step.rationale,
              evidenceIds: step.evidenceIds.slice(),
            });
          },
        },
        {
          apiKeyId: store.keyId(gated.value.apiKey) ?? "unknown-key",
          day: currentDay(),
        },
      );
      send({
        kind: "report",
        investigation: investigated,
        investigationProvider: service.provider(),
        investigationModel: service.modelId(),
      });
    } catch {
      send({ kind: "report", investigation: { status: "failed" } });
    }
    reply.raw.end();
    return reply;
  }

  // Registry exposure (S-046, P-09): the plugin list derives from the one
  // registry value, behind the same API-key gate as the analysis routes
  // (K-024). No route is hand-written per plugin; detector invocation rides
  // the existing analysis routes and surfaces under `pluginResults`.
  const detectors = options.detectors;
  const pluginWeights: PluginWeightMapping = options.pluginWeights ?? {};
  const pluginDocs: PluginDocsMap = options.pluginDocs ?? new Map();
  const pluginAudits: StoredAuditReportMap = options.pluginAudits ?? new Map();

  app.get("/v1/plugins", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const requestId = issueRequestId();
    const gated = gateKeyOnly(request, request.query, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .type("application/json")
      .send(serializePluginList(exposeRegistry(detectors.registry, pluginWeights, pluginDocs)));
  });

  app.get<{ Params: { id: string } }>(
    "/v1/plugins/:id",
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const requestId = issueRequestId();
      const gated = gateKeyOnly(request, request.query, requestId);
      if (!gated.ok) {
        return sendError(reply, gated.error);
      }
      const id = (request.params as { id?: unknown }).id;
      const entry =
        typeof id === "string"
          ? detectors.registry.entries.find((candidate) => candidate.manifest.id === id)
          : undefined;
      if (entry === undefined) {
        return sendError(reply, notFound(requestId));
      }
      const weight = weightOfMapping(pluginWeights, entry.manifest.id);
      const singleDocs = typeof id === "string" ? pluginDocs.get(id) : undefined;
      return reply
        .code(200)
        .header(REQUEST_ID_HEADER, requestId)
        .type("application/json")
        .send(canonicalSerialize(exposeManifest(entry.manifest, weight, singleDocs) as never));
    },
  );

  // Plugin docs exposure (S-056, P-16): the validated `PLUGIN.md` record
  // from the one registry-adjacent value, behind the same API-key gate as
  // the plugin list (K-024). Read-only; an unknown plugin id gives the
  // uniform not-found error (A-18).
  app.get<{ Params: { id: string } }>(
    "/v1/plugins/:id/docs",
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const requestId = issueRequestId();
      const gated = gateKeyOnly(request, request.query, requestId);
      if (!gated.ok) {
        return sendError(reply, gated.error);
      }
      const id = (request.params as { id?: unknown }).id;
      const registered =
        typeof id === "string"
          ? detectors.registry.entries.some((candidate) => candidate.manifest.id === id)
          : false;
      const docs = typeof id === "string" ? pluginDocs.get(id) : undefined;
      if (!registered || docs === undefined) {
        return sendError(reply, notFound(requestId));
      }
      return reply
        .code(200)
        .header(REQUEST_ID_HEADER, requestId)
        .type("application/json")
        .send(serializePluginDocs(docs));
    },
  );

  // Stored CI audit report read view (S-058, K-516): the last report per
  // plugin with its three separate states (deterministic, ai, human-review)
  // plus provider and model id on the advisory branch. Read-only behind
  // the same API-key gate; an unknown id or a missing report gives the
  // uniform not-found error (A-18). The read view triggers no audit.
  app.get<{ Params: { id: string } }>(
    "/v1/plugins/:id/audit",
    async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      const requestId = issueRequestId();
      const gated = gateKeyOnly(request, request.query, requestId);
      if (!gated.ok) {
        return sendError(reply, gated.error);
      }
      const id = (request.params as { id?: unknown }).id;
      const registered =
        typeof id === "string"
          ? detectors.registry.entries.some((candidate) => candidate.manifest.id === id)
          : false;
      const report = typeof id === "string" ? pluginAudits.get(id) : undefined;
      if (!registered || report === undefined) {
        return sendError(reply, notFound(requestId));
      }
      return reply
        .code(200)
        .header(REQUEST_ID_HEADER, requestId)
        .type("application/json")
        .send(serializeStoredAuditReport(report));
    },
  );

  // Mapping provider label for the experimental toggle (S-070, K-519):
  // the UI names the provider and model id before the first call.
  app.get("/v1/personalize/status", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const requestId = issueRequestId();
    const gated = gateKeyOnly(request, request.query, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const service = options.personalizeService;
    const personalize =
      service === undefined
        ? { disabled: true }
        : { provider: service.provider, modelId: service.modelId };
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .type("application/json")
      .send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          personalize,
        }),
      );
  });

  // Experimental AI personalize mapping (S-069, K-519, P-27): one
  // explicit per-request POST carrying the visitor's priorities text.
  // The frozen analysis runs first; the mapping call quotes priorities
  // and per-plugin frontmatter references as data. The route always
  // answers 200 with the outcome envelope: any error kind means the
  // deterministic baseline stands (P-28 fallback) with scores, evidence
  // and text unchanged. The priorities text is never logged.
  app.post("/v1/personalize", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const requestId = issueRequestId();
    const gated = gateRequest(request, request.body, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const body = (request.body ?? {}) as { priorities?: unknown };
    if (typeof body.priorities !== "string" || body.priorities.length === 0 || body.priorities.length > 500) {
      return sendError(
        reply,
        validationError("Invalid priorities: expected 1 to 500 characters of visitor text.", requestId as string),
      );
    }
    const { address, block } = gated.value;
    const service = options.personalizeService;
    const promptVersion = options.personalizePromptVersion;
    if (service === undefined || promptVersion === undefined) {
      return reply
        .code(200)
        .header(REQUEST_ID_HEADER, requestId)
        .type("application/json")
        .send(
          JSON.stringify({
            status: "ok",
            apiVersion: API_VERSION,
            personalize: JSON.parse(
              serializePersonalizeOutcome({
                kind: "error",
                error: "not-configured",
                message: "AI personalize is not configured for this server",
              }),
            ),
          }),
        );
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return sendError(reply, requestError(500, "internal-error", "Analysis failed; retry with the same request ID.", requestId));
    }
    const counters = createRequestCounters();
    const analysed = await options.services.analyzeToken(
      {
        address,
        block,
        requestId,
        deadline: deadline.value,
        modelVersion: options.modelVersion,
        indexVersion: options.indexVersion,
        templateVersion: options.templateVersion,
        catalogue: options.catalogue,
      },
      counters,
    );
    if (!analysed.ok) {
      const mapped = toHttpError(analysed.error);
      return sendError(
        reply,
        requestError(mapped.status, mapped.code, mapped.message, requestId),
      );
    }
    if (analysed.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: analysed.value.target as string,
        block: analysed.value.block as number,
      });
      return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(body);
    }
    const analysis = analysed.value.envelope;
    const score = analysis.score;
    const presentSections = ["summary", "score", "signals", "plugin-findings", "evidence", "cant-tell", "expert-detail"];
    const outcome = await service.requestPersonalize(
      {
        codeHash: analysis.codeHash,
        scoreBand: score >= 60 ? "high" : score >= 30 ? "medium" : "low",
        sectionIds: presentSections,
        pluginIds: analysis.pluginResults.map((entry) => entry.pluginId as string),
        flooredSectionIds: ["summary", "score"],
        priorities: body.priorities,
        plugins: analysis.pluginResults.map((entry) => {
          const docs = pluginDocs.get(entry.pluginId as string);
          const excerpt =
            docs === undefined
              ? ""
              : `${sectionBodyOf(docs.markdown, "What it checks")}\n${sectionBodyOf(docs.markdown, "Why it matters to you")}`.slice(0, 1000);
          return {
            pluginId: entry.pluginId as string,
            tags: docs === undefined ? [] : [...docs.frontmatter.tags],
            severityMax: docs === undefined ? "low" : docs.frontmatter.severity.max,
            quotedExcerpt: excerpt,
          };
        }),
        promptVersion,
      },
      { requestId, deadline: deadline.value, block: gated.value.block },
    );
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .type("application/json")
      .send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          personalize: JSON.parse(serializePersonalizeOutcome(outcome)),
        }),
      );
  });

  app.get("/v1/analyze", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleAnalyze(request, reply, request.query);
  });

  app.post("/v1/analyze", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleAnalyze(request, reply, request.body);
  });

  app.get("/v1/assessment", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleAssessment(request, reply, request.query);
  });

  app.post("/v1/assessment", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleAssessment(request, reply, request.body);
  });

  app.get("/v1/investigate", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleInvestigate(request, reply, request.query);
  });

  app.post("/v1/investigate", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleInvestigate(request, reply, request.body);
  });

  app.get("/v1/investigate/events", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleInvestigateEvents(request, reply);
  });

  return Object.freeze({
    listen: async (host: string, port: number): Promise<string> => {
      return app.listen({ host, port });
    },
    close: async (): Promise<void> => {
      await app.close();
    },
  });
}
