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
import { assessmentToCanonical, serializeAssessment } from "../../application/analyzeToken.ts";
import type { AppServices, AssessmentEnvelope, DetectorSet } from "../../application/analyzeToken.ts";
import {
  exposeManifest,
  exposeRegistry,
  serializePluginDocs,
  serializePluginList,
  weightOfMapping,
} from "../../application/pluginExposure.ts";
import type { PluginDocsMap, PluginWeightMapping } from "../../application/pluginExposure.ts";
import { serializeStoredAuditReport } from "../../application/pluginExposure.ts";
import type { StoredAuditReportMap } from "../../application/pluginExposure.ts";
import { serializeTokenAssessment } from "../../application/assessmentService.ts";
import type { AssessmentService } from "../../application/assessmentService.ts";
import { requiredFlooredSections, serializePersonalizeOutcome } from "../../application/personalizeService.ts";
import type { PersonalizeService } from "../../application/personalizeService.ts";
import { EXPLAIN_PROMPT_VERSION, serializeExplainOutcome } from "../../application/explainService.ts";
import type { ExplainService } from "../../application/explainService.ts";
import { ExplainInput } from "../../ports/explainModel.ts";
import { snippetForSelector } from "../../application/snippetService.ts";
import type { SnippetDecompile } from "../../application/snippetService.ts";
import { decompileContract } from "../../domain/evmSsa.ts";
import { CHAT_PROMPT_VERSION, serializeChatOutcome } from "../../application/chatService.ts";
import type { ChatService } from "../../application/chatService.ts";
import { ChatInput } from "../../ports/chatModel.ts";
import { RUG_PROMPT_VERSION, serializeRugOutcome } from "../../application/rugService.ts";
import type { RugService } from "../../application/rugService.ts";
import { RugInput } from "../../ports/rugModel.ts";
import type { RugRisk } from "../../ports/rugModel.ts";
import type { CalibrationView } from "../../application/calibrationView.ts";
import { MAX_NAMING_SELECTORS } from "../../application/decompilerNaming.ts";
import type { DecompilerNamingService } from "../../application/decompilerNaming.ts";
import { sectionBodyOf } from "../../application/pluginExposure.ts";
import { serializeTokenInvestigation } from "../../application/investigationService.ts";
import type { InvestigationService } from "../../application/investigationService.ts";
import {
  PLACEHOLDER_COST_UNIT,
  createRequestCounters,
} from "../../application/observability.ts";
import { Address, BlockNumber, CodeHash, RequestId, Timestamp } from "../../domain/types.ts";
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
import type { LiveTokensReader } from "../../ports/liveTokens.ts";
import type { RpcPort } from "../../ports/rpc.ts";
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
  // Decompiler naming service for the optional suggested-names overlay
  // (S-083, D-11). Absent service means the overlay stays off: the route
  // answers the not-configured envelope and the deterministic
  // pseudo-Solidity stands.
  readonly namingService?: DecompilerNamingService | undefined;
  // Explain service for the optional sentence-level overlay (S-094,
  // K-302). Absent service means the overlay stays off: the route answers
  // the not-configured envelope with zero provider calls and the
  // deterministic analysis standing.
  readonly explainService?: ExplainService | undefined;
  // Bytecode source for snippet deepening (S-095, K-008): the route reads
  // the contract code through this port and quotes the local pipeline's
  // emission per selector. Tests inject the fake RPC adapter; an absent
  // port answers 500 without touching the pipeline.
  readonly snippetRpc?: RpcPort | undefined;
  // Injectable decompile pipeline for snippet deepening (S-095): defaults
  // to the local `decompileContract` pipeline. Tests inject a counting
  // wrapper to prove unknown selectors fail before any pipeline call.
  readonly snippetDecompile?: SnippetDecompile | undefined;
  // Chat service for opt-in follow-up questions over the frozen analysis
  // (S-096, K-302). Absent service means the overlay stays off: the route
  // answers the not-configured envelope with zero provider calls and the
  // deterministic analysis standing.
  readonly chatService?: ChatService | undefined;
  // Rug narrative service for the opt-in top-risk capability summary
  // (S-097, K-302). Absent service means the overlay stays off: the route
  // answers the not-configured envelope with zero provider calls and the
  // deterministic analysis standing.
  readonly rugService?: RugService | undefined;
  // Frozen calibration snapshot for the read view (S-098, K-205, K-210):
  // built once at wiring time from the loaded artifact and its checksum.
  // The route serves this snapshot byte for byte and never loads or
  // writes the artifact. An absent snapshot answers 500.
  readonly calibration?: CalibrationView | undefined;
  // Deploy-time readiness pinning (S-099, K-104): the loaded artifact
  // checksum beside the expected checksum and the feed wiring flag. The
  // probe fails with 503 on a checksum mismatch before the plane can
  // serve analysis as ready. An absent pin answers 503 not-ready.
  readonly readiness?:
    | {
        readonly artifactChecksum: string;
        readonly expectedArtifactChecksum: string;
        readonly feedConfigured: boolean;
      }
    | undefined;
  // Mapping prompt version for the personalize cache key (P-27): the same
  // version the adapter prompt carries. Absent version disables the route
  // like an absent service.
  readonly personalizePromptVersion?: PromptVersionType | undefined;
  // Absent service means the investigation loop is disabled through
  // configuration (P-29): /v1/investigate answers
  // investigation-not-configured with zero model calls.
  readonly investigationService?: InvestigationService | undefined;
  // Live new-tokens reader (E-11 follow-up): the application service
  // snapshot behind GET /v1/live-tokens. Absent reader means the list is
  // unavailable on this server (the route answers 500).
  readonly liveTokens?: LiveTokensReader | undefined;
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
  // In-process request injection (S-092): the same routing and gates
  // without opening a listener, so tests leave no sockets open.
  readonly inject: (options: {
    readonly method?: string;
    readonly url: string;
    readonly headers?: Record<string, string>;
    readonly payload?: unknown;
  }) => Promise<{ readonly statusCode: number; readonly body: string; readonly headers: Record<string, unknown> }>;
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

// Field selection (S-092, K-023): allowlisted projection of the assessed
// envelope, read from the query string (GET) or the JSON body (POST) beside
// the address. Absent `fields` means the full envelope byte for byte; a
// present list names 1 to 16 canonical section names and the response
// carries the envelope kind plus exactly those sections. Unknown, empty or
// oversize lists fail as `validation-error` before analysis starts.
const ANALYZE_FIELD_NAMES = [
  "target",
  "block",
  "proxy",
  "codeHash",
  "modelVersion",
  "artifactChecksum",
  "indexVersion",
  "templateVersion",
  "assessedAt",
  "probabilities",
  "score",
  "signals",
  "pluginResults",
  "explanation",
  "cantTell",
] as const;

function parseFields(raw: unknown): { ok: true; value: readonly string[] | null } | { ok: false } {
  if (raw === undefined) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false };
  }
  const seen: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name.length === 0) {
      continue;
    }
    if (!(ANALYZE_FIELD_NAMES as readonly string[]).includes(name)) {
      return { ok: false };
    }
    if (!seen.includes(name)) {
      seen.push(name);
    }
  }
  if (seen.length === 0 || seen.length > 16) {
    return { ok: false };
  }
  return { ok: true, value: Object.freeze(seen.slice()) };
}

// Shared assessed body for the analyze routes (S-092, S-093): the full
// envelope byte for byte without a field list, or the envelope kind plus
// exactly the listed sections through the same canonical serializer.
function assessedBodyOf(envelope: AssessmentEnvelope, fields: readonly string[] | null): string {
  if (fields === null) {
    return serializeAssessment(envelope);
  }
  const canonical = assessmentToCanonical(envelope) as Record<string, unknown>;
  const projected: Record<string, unknown> = { kind: "assessed" };
  for (const name of fields) {
    projected[name] = canonical[name];
  }
  return canonicalSerialize(projected as never);
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

  // Calibration read view (S-098, K-205, K-210): the frozen snapshot
  // built at wiring time from the loaded artifact and its checksum,
  // served byte for byte behind the same API-key gate as the plugin list.
  // The route never loads or writes the artifact, so repeated reads are
  // byte-identical with zero artifact calls.
  app.get("/v1/calibration", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const requestId = issueRequestId();
    const gated = gateKeyOnly(request, request.query, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const view = options.calibration;
    if (view === undefined) {
      return sendError(reply, requestError(500, "internal-error", "Calibration view is not available on this server.", requestId as string));
    }
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .type("application/json")
      .send(JSON.stringify({ status: "ok", apiVersion: API_VERSION, calibration: view }));
  });

  // Deploy-time readiness probe (S-099, K-104, K-402): keyless like the
  // health check so orchestrators can poll it. It names the loaded
  // artifact checksum, each AI plugin as configured or not-configured
  // from the actual wiring, and the feed flag. A checksum mismatch — or
  // a missing pin — fails with 503 instead of reporting ready, so a bad
  // artifact can never serve analysis as ready.
  app.get("/ready", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    void request;
    const requestId = issueRequestId();
    const pin = options.readiness;
    const assessment = options.assessmentService;
    const aiPlugins = [
      {
        id: "assessment",
        configured: assessment !== undefined && assessment.provider !== null && assessment.modelId !== null,
      },
      { id: "investigation", configured: options.investigationService !== undefined },
      { id: "personalize", configured: options.personalizeService !== undefined },
      {
        id: "naming",
        configured: options.namingService !== undefined && options.namingService.enabled,
      },
      {
        id: "explain",
        configured: options.explainService !== undefined && options.explainService.enabled,
      },
      {
        id: "chat",
        configured: options.chatService !== undefined && options.chatService.enabled,
      },
      {
        id: "rug",
        configured: options.rugService !== undefined && options.rugService.enabled,
      },
    ];
    if (pin === undefined) {
      return reply
        .code(503)
        .header(REQUEST_ID_HEADER, requestId)
        .type("application/json")
        .send(JSON.stringify({ status: "not-ready", apiVersion: API_VERSION, reason: "readiness-not-configured" }));
    }
    if (pin.artifactChecksum !== pin.expectedArtifactChecksum) {
      return reply
        .code(503)
        .header(REQUEST_ID_HEADER, requestId)
        .type("application/json")
        .send(
          JSON.stringify({
            status: "not-ready",
            apiVersion: API_VERSION,
            artifactChecksum: pin.artifactChecksum,
            reason: "artifact-checksum-mismatch",
            aiPlugins,
            feed: { configured: pin.feedConfigured },
          }),
        );
    }
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .type("application/json")
      .send(
        JSON.stringify({
          status: "ready",
          apiVersion: API_VERSION,
          artifactChecksum: pin.artifactChecksum,
          aiPlugins,
          feed: { configured: pin.feedConfigured },
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
    // Field selection runs before the service call (S-092): a bad list
    // fails without spending analysis work.
    const rawFields =
      typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)["fields"]
        : undefined;
    const fields = parseFields(rawFields);
    if (!fields.ok) {
      return sendError(
        reply,
        validationError(
          "Invalid fields: expected 1 to 16 comma-separated section names from the documented list.",
          requestId as string,
        ),
      );
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
    // Field projection (S-092): the no-contract branch is unchanged, while
    // the assessed envelope carries the kind plus exactly the listed
    // sections through the same canonical serializer.
    const assessedBody = assessedBodyOf(analysed.value.envelope, fields.value);
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .header(DEEPENING_STATUS_HEADER, "pending")
      .header(ASSESSMENT_CALLS_HEADER, String(usage.assessmentCalls))
      .header(ASSESSMENT_COST_HEADER, String(usage.assessmentCostUnits))
      .type("application/json")
      .send(assessedBody);
  }

  // Streaming analysis events (S-093, K-101): the same gate, field list and
  // deterministic analysis as the analyze routes, delivered as one SSE body
  // in a single send — the analysis event first, then the deepening status.
  // No socket is hijacked and none stays open: the CSP hook still applies
  // and the analyze response for the same input stays byte-identical.
  async function handleAnalyzeStream(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const requestId = issueRequestId();
    const rawInput = request.query;
    const gated = gateRequest(request, rawInput, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const rawFields =
      typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)["fields"]
        : undefined;
    const fields = parseFields(rawFields);
    if (!fields.ok) {
      return sendError(
        reply,
        validationError(
          "Invalid fields: expected 1 to 16 comma-separated section names from the documented list.",
          requestId as string,
        ),
      );
    }
    const { address, block } = gated.value;
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
        .header(ASSESSMENT_CALLS_HEADER, String(usage.assessmentCalls))
        .header(ASSESSMENT_COST_HEADER, String(usage.assessmentCostUnits))
        .type("application/json")
        .send(body);
    }
    if (request.raw.destroyed) {
      return reply;
    }
    const assessedBody = assessedBodyOf(analysed.value.envelope, fields.value);
    const streamBody = `data: ${assessedBody}\n\ndata: ${JSON.stringify({ kind: "deepening", status: "pending" })}\n\n`;
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .header(ASSESSMENT_CALLS_HEADER, String(usage.assessmentCalls))
      .header(ASSESSMENT_COST_HEADER, String(usage.assessmentCostUnits))
      .header("cache-control", "no-cache")
      .type("text/event-stream")
      .send(streamBody);
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

  // Live new-tokens list (E-11 follow-up): the current snapshot newest
  // first behind the same API-key gate as the other read routes (K-024).
  // `?since=` (milliseconds since the epoch) trims to items created
  // after that instant for incremental polling. A missing reader answers
  // 500; a feed without a source answers `not-configured` inside the
  // body, never as an error status.
  app.get("/v1/live-tokens", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const requestId = issueRequestId();
    const gated = gateKeyOnly(request, request.query, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const reader = options.liveTokens;
    if (reader === undefined) {
      return sendError(
        reply,
        requestError(500, "internal-error", "Live tokens are not available on this server.", requestId as string),
      );
    }
    const rawSince = (request.query as Record<string, unknown>)["since"];
    let since: number | undefined;
    if (rawSince !== undefined) {
      if (typeof rawSince !== "string" || !/^\d+$/.test(rawSince)) {
        return sendError(
          reply,
          validationError("Invalid since: expected milliseconds since the epoch.", requestId),
        );
      }
      since = Number(rawSince);
    }
    const snapshot = reader.snapshot(since);
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .type("application/json")
      .send(
        JSON.stringify({
          source: snapshot.source,
          status: snapshot.status,
          ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
          updatedAt: snapshot.updatedAt,
          items: snapshot.items,
          apiVersion: API_VERSION,
        }),
      );
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
        flooredSectionIds: [...requiredFlooredSections(analysis.signals)],
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
      store.keyId(gated.value.apiKey) ?? "unknown-key",
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

  // Optional suggested-names overlay for decompiled functions (S-083, D-11):
  // one explicit per-request POST carrying the selectors the Expert view
  // already shows. The route always answers 200 with the outcome envelope:
  // `not-configured` without a wired naming service, `invalid-output` for
  // malformed selectors or unparsable model output, and the labelled
  // display-only names otherwise. Scores, evidence and emitted structure
  // are untouched: this route runs no analysis.
  app.post("/v1/naming", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const requestId = issueRequestId();
    const gated = gateKeyOnly(request, request.body, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const body = (request.body ?? {}) as { selectors?: unknown };
    const selectors = body.selectors;
    if (
      !Array.isArray(selectors) ||
      selectors.length === 0 ||
      selectors.length > MAX_NAMING_SELECTORS ||
      !selectors.every(
        (entry): entry is string => typeof entry === "string" && /^0x[0-9a-fA-F]{8}$/.test(entry),
      )
    ) {
      return sendError(
        reply,
        validationError(
          "Invalid selectors: expected 1 to 64 entries shaped 0x plus 8 hex characters.",
          requestId as string,
        ),
      );
    }
    const service = options.namingService;
    if (service === undefined || !service.enabled) {
      return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          naming: { kind: "not-configured" },
        }),
      );
    }
    const outcome = await service.resolve(selectors, store.keyId(gated.value.apiKey) ?? "unknown-key");
    if (outcome.kind === "ok") {
      return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          naming: {
            kind: "ok",
            names: outcome.names.map((entry) => ({
              selector: entry.selector,
              suggestedName: entry.suggestedName,
            })),
          },
        }),
      );
    }
    return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
      JSON.stringify({
        status: "ok",
        apiVersion: API_VERSION,
        naming: { kind: outcome.kind },
      }),
    );
  });

  // Optional sentence-level explanation overlay (S-094, K-302): the same
  // gate and the same deterministic analysis as the analyze routes, then
  // one overlay call over the frozen envelope. The route always answers
  // 200 with the outcome envelope: `not-configured` without a wired
  // service, `invalid-output` for malformed model output, and the checked
  // narrative otherwise. Citations name collected `signal:<id>` evidence
  // only; anything else drops with a count. Scores, evidence and finding
  // text are untouched: the analysis runs first and stands beside the
  // overlay in every branch.
  async function handleExplain(request: FastifyRequest, reply: FastifyReply, rawInput: unknown): Promise<FastifyReply> {
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
    const envelope = analysed.value.envelope;
    const service = options.explainService;
    if (service === undefined || !service.enabled) {
      return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          codeHash: envelope.codeHash as string,
          explain: { kind: "not-configured" },
        }),
      );
    }
    const input = ExplainInput.create({
      codeHash: envelope.codeHash as string,
      evidenceIds: envelope.signals.map((signal) => `signal:${signal.id as string}`),
      promptVersion: EXPLAIN_PROMPT_VERSION,
    });
    if (input === null) {
      return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          codeHash: envelope.codeHash as string,
          explain: { kind: "invalid-output" },
        }),
      );
    }
    const outcome = await service.explain(input, store.keyId(gated.value.apiKey) ?? "unknown-key");
    return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
      JSON.stringify({
        status: "ok",
        apiVersion: API_VERSION,
        codeHash: envelope.codeHash as string,
        explain: JSON.parse(serializeExplainOutcome(outcome)),
      }),
    );
  }

  app.get("/v1/analyze", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleAnalyze(request, reply, request.query);
  });

  app.post("/v1/analyze", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleAnalyze(request, reply, request.body);
  });

  app.get("/v1/analyze/stream", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleAnalyzeStream(request, reply);
  });

  // Snippet deepening per selector (S-095, K-008, K-010): the same key
  // and address gate as the analyze routes, then the selector shape check,
  // then one bytecode fetch, then the fast-path dispatcher gate, and only
  // then the local decompilation pipeline. A malformed selector fails
  // before any fetch; an unknown selector fails before any pipeline call.
  // The quoted lines come from the pipeline's own emission for the
  // selector, each carrying its selector, 1-based line number and text.
  async function handleSnippet(request: FastifyRequest, reply: FastifyReply, rawInput: unknown): Promise<FastifyReply> {
    const requestId = issueRequestId();
    const gated = gateRequest(request, rawInput, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const rawSelector =
      typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)["selector"]
        : undefined;
    if (typeof rawSelector !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(rawSelector)) {
      return sendError(
        reply,
        validationError("Invalid selector: expected 0x followed by 8 hex characters.", requestId as string),
      );
    }
    const rpc = options.snippetRpc;
    if (rpc === undefined) {
      return sendError(reply, requestError(500, "internal-error", "Snippet deepening is not available on this server.", requestId));
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return sendError(reply, requestError(500, "internal-error", "Analysis failed; retry with the same request ID.", requestId));
    }
    const fetched = await rpc.getCode(gated.value.address, {
      requestId,
      deadline: deadline.value,
      block: gated.value.block,
    });
    if (!fetched.ok) {
      if (fetched.error.kind === "no-code") {
        return sendError(reply, notFound(requestId));
      }
      return sendError(reply, requestError(502, "upstream-unavailable", "Upstream data source unavailable; retry with the same request ID.", requestId));
    }
    const codeHash = CodeHash.of(fetched.value.bytecode);
    if (!codeHash.ok) {
      return sendError(reply, requestError(500, "internal-error", "Analysis failed; retry with the same request ID.", requestId));
    }
    const snippet = snippetForSelector(
      fetched.value.bytecode,
      rawSelector,
      options.snippetDecompile ?? decompileContract,
    );
    if (!snippet.ok) {
      return sendError(
        reply,
        validationError("Unknown selector: the contract dispatcher carries no such entry.", requestId as string),
      );
    }
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .type("application/json")
      .send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          codeHash: codeHash.value as string,
          snippet: {
            selector: snippet.value.selector,
            entryPc: snippet.value.entryPc,
            lines: snippet.value.lines.map((line) => ({
              selector: line.selector,
              lineNumber: line.lineNumber,
              text: line.text,
            })),
          },
        }),
      );
  }

  app.get("/v1/explain", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleExplain(request, reply, request.query);
  });

  app.post("/v1/explain", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleExplain(request, reply, request.body);
  });

  // Opt-in follow-up questions over the frozen analysis (S-096, K-302):
  // the same gate and the same deterministic analysis as the analyze
  // routes, then one overlay call carrying the caller's question. The
  // route always answers 200 with the outcome envelope: `not-configured`
  // without a wired service, `invalid-output` for malformed model output,
  // and the checked answers otherwise. A missing or oversize question
  // fails as `validation-error` before analysis starts. Citations name
  // collected `signal:<id>` evidence only; anything else drops with a
  // count. Scores, evidence and finding text are untouched.
  async function handleChat(request: FastifyRequest, reply: FastifyReply, rawInput: unknown): Promise<FastifyReply> {
    const requestId = issueRequestId();
    const gated = gateRequest(request, rawInput, requestId);
    if (!gated.ok) {
      return sendError(reply, gated.error);
    }
    const rawQuestion =
      typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)["question"]
        : undefined;
    if (typeof rawQuestion !== "string" || rawQuestion.length === 0 || rawQuestion.length > 500) {
      return sendError(
        reply,
        validationError("Invalid question: expected a non-empty string of at most 500 characters.", requestId as string),
      );
    }
    const { address, block } = gated.value;
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
    const envelope = analysed.value.envelope;
    const service = options.chatService;
    if (service === undefined || !service.enabled) {
      return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          codeHash: envelope.codeHash as string,
          chat: { kind: "not-configured" },
        }),
      );
    }
    const input = ChatInput.create({
      codeHash: envelope.codeHash as string,
      evidenceIds: envelope.signals.map((signal) => `signal:${signal.id as string}`),
      question: rawQuestion,
      promptVersion: CHAT_PROMPT_VERSION,
    });
    if (input === null) {
      return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          codeHash: envelope.codeHash as string,
          chat: { kind: "invalid-output" },
        }),
      );
    }
    const outcome = await service.chat(input, store.keyId(gated.value.apiKey) ?? "unknown-key");
    return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
      JSON.stringify({
        status: "ok",
        apiVersion: API_VERSION,
        codeHash: envelope.codeHash as string,
        chat: JSON.parse(serializeChatOutcome(outcome)),
      }),
    );
  }

  // Opt-in capability summary for the top risk type (S-097, K-302): the
  // same gate and the same deterministic analysis as the analyze routes,
  // then one overlay call with the top risk read from the frozen
  // envelope's probabilities (strict maximum; ties keep the fixed
  // rug-pull, honeypot, bot-pump order). The route always answers 200
  // with the outcome envelope: `not-configured` without a wired service,
  // `invalid-output` for malformed model output, and the checked narrative
  // otherwise. Citations name collected `signal:<id>` evidence only;
  // anything else drops with a count. Scores, evidence and finding text
  // are untouched.
  function topRiskOf(probabilities: { readonly "rug-pull": unknown; readonly honeypot: unknown; readonly "bot-pump": unknown }): RugRisk {
    const rug = probabilities["rug-pull"] as number;
    const honey = probabilities.honeypot as number;
    const bot = probabilities["bot-pump"] as number;
    let top: RugRisk = "rug-pull";
    let best: number = rug;
    if (honey > best) {
      top = "honeypot";
      best = honey;
    }
    if (bot > best) {
      top = "bot-pump";
    }
    return top;
  }

  async function handleRug(request: FastifyRequest, reply: FastifyReply, rawInput: unknown): Promise<FastifyReply> {
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
    const envelope = analysed.value.envelope;
    const topRisk = topRiskOf(envelope.probabilities as { readonly "rug-pull": unknown; readonly honeypot: unknown; readonly "bot-pump": unknown });
    const service = options.rugService;
    if (service === undefined || !service.enabled) {
      return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          codeHash: envelope.codeHash as string,
          topRisk,
          rug: { kind: "not-configured" },
        }),
      );
    }
    const input = RugInput.create({
      codeHash: envelope.codeHash as string,
      evidenceIds: envelope.signals.map((signal) => `signal:${signal.id as string}`),
      topRisk,
      promptVersion: RUG_PROMPT_VERSION,
    });
    if (input === null) {
      return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
        JSON.stringify({
          status: "ok",
          apiVersion: API_VERSION,
          codeHash: envelope.codeHash as string,
          topRisk,
          rug: { kind: "invalid-output" },
        }),
      );
    }
    const outcome = await service.narrate(input, store.keyId(gated.value.apiKey) ?? "unknown-key");
    return reply.code(200).header(REQUEST_ID_HEADER, requestId).type("application/json").send(
      JSON.stringify({
        status: "ok",
        apiVersion: API_VERSION,
        codeHash: envelope.codeHash as string,
        topRisk,
        rug: JSON.parse(serializeRugOutcome(outcome)),
      }),
    );
  }

  app.get("/v1/snippet", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleSnippet(request, reply, request.query);
  });

  app.post("/v1/snippet", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleSnippet(request, reply, request.body);
  });

  app.get("/v1/chat", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleChat(request, reply, request.query);
  });

  app.post("/v1/chat", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleChat(request, reply, request.body);
  });

  app.get("/v1/rug", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleRug(request, reply, request.query);
  });

  app.post("/v1/rug", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleRug(request, reply, request.body);
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
    inject: async (options: {
      readonly method?: string;
      readonly url: string;
      readonly headers?: Record<string, string>;
      readonly payload?: unknown;
    }) => {
      const response = await app.inject(options as never);
      return {
        statusCode: response.statusCode,
        body: response.body,
        headers: response.headers as Record<string, unknown>,
      };
    },
  });
}
