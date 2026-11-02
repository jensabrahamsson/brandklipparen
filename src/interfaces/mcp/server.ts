// Read-only MCP server as a thin driving adapter over the shared
// application service (S-028, K-025, K-026, K-508, M-15). The adapter owns
// solely validation, the API key check and response formatting: detection
// lives in the shared application service behind AppServices, which the
// server receives through constructor injection (A-02, A-03). Success
// bodies are the service output byte for byte, so equal input gives equal
// bytes in the REST and MCP interfaces (K-027). The tools are read-only:
// every call reaches solely the reading analysis path, and unknown tools
// give a machine-readable error naming the tool. Tool outputs wrap
// contract-derived strings as content data marked for the user, never as
// instructions to the client model (M-15).
//
// Protocol: minimal JSON-RPC 2.0 over stdio with newline-delimited frames,
// driven in-process in tests through callTool and handleJsonRpc. No new
// runtime dependency is needed: validation uses plain checks plus smart
// constructors, the same as the REST adapter (K-506).
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { serializeAssessment } from "../../application/analyzeToken.ts";
import type { AppServices, DetectorSet } from "../../application/analyzeToken.ts";
import { exposeRegistry, serializePluginDocs, serializePluginList } from "../../application/pluginExposure.ts";
import type { PluginDocsMap, PluginWeightMapping } from "../../application/pluginExposure.ts";
import { serializeStoredAuditReport } from "../../application/pluginExposure.ts";
import type { StoredAuditReportMap } from "../../application/pluginExposure.ts";
import { serializeTokenAssessment } from "../../application/assessmentService.ts";
import type { AssessmentService } from "../../application/assessmentService.ts";
import { serializeTokenInvestigation } from "../../application/investigationService.ts";
import type { InvestigationService } from "../../application/investigationService.ts";
import { EXPLAIN_PROMPT_VERSION, serializeExplainOutcome } from "../../application/explainService.ts";
import type { ExplainService } from "../../application/explainService.ts";
import { EXPLAIN_CODE_PROMPT_VERSION, serializeExplainCodeOutcome } from "../../application/explainCodeService.ts";
import type { ExplainCodeService } from "../../application/explainCodeService.ts";
import { envelopeMeanings, explainCoverageIds } from "../../application/modelMeanings.ts";
import { ExplainCodeInput } from "../../ports/explainCodeModel.ts";
import { ExplainInput } from "../../ports/explainModel.ts";
import { resolveAnalysisCode } from "../../application/resolveAnalysisCode.ts";
import { snippetForSelector } from "../../application/snippetService.ts";
import type { SnippetDecompile } from "../../application/snippetService.ts";
import type { ProofService } from "../../application/proofService.ts";
import type { VerifiedSourceService } from "../../application/verifiedSource.ts";
import { decompilePreferV2 } from "../../domain/decompileV2.ts";
import type { Bytecode as BytecodeType } from "../../domain/types.ts";
import type { LiveTokensReader } from "../../ports/liveTokens.ts";
import { MARKET_CHAIN } from "../../ports/marketFeed.ts";
import type { MarketNewReader } from "../../ports/marketFeed.ts";
import { API_VERSION } from "../rest/server.ts";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { canonicalSerialize } from "../../domain/serialize.ts";
import { RequestId, Timestamp } from "../../domain/types.ts";
import type { IndexVersion, ModelVersion, TemplateVersion } from "../../domain/types.ts";
import type { CapabilityCatalogue } from "../../domain/signals.ts";
import type { SecretString } from "../../ports/config.ts";
import type { RpcPort } from "../../ports/rpc.ts";
import { createApiKeyStore } from "../rest/apiKeys.ts";
import type { ApiKeyStore } from "../rest/apiKeys.ts";
import {
  assessmentNotConfigured,
  invalidApiKey,
  investigationNotConfigured,
  keyInToolArgs,
  listingsNotConfigured,
  missingApiKey,
  notFound,
  onchainNotConfigured,
  proofNotAvailable,
  rateLimited,
  requestTooLarge,
  snippetNotAvailable,
  toMcpError,
  unknownTool,
  validationError,
} from "./errors.ts";
import { readOnchainFeatures } from "../../application/onchainFeatures.ts";
import { createRateLimiter } from "../rest/rateLimit.ts";
import type { RateLimitConfig, RateLimiter } from "../rest/rateLimit.ts";
import type { McpToolError } from "./errors.ts";
import {
  ASSESS_TOKEN_TOOL,
  EXPLAIN_FUNCTION_TOOL,
  EXPLAIN_TOKEN_TOOL,
  GET_DECOMPILED_FUNCTION_TOOL,
  GET_PLUGIN_AUDIT_TOOL,
  GET_PLUGIN_DOCS_TOOL,
  GET_PROOF_TRACE_TOOL,
  GET_VERIFIED_SOURCE_TOOL,
  INVESTIGATE_TOKEN_TOOL,
  LIST_NEW_TOKENS_TOOL,
  LIST_PLUGINS_TOOL,
  ONCHAIN_FEATURES_TOOL,
  REQUEST_ASSESSMENT_TOOL,
  TOOL_DEFINITIONS,
  TOOL_LIST_VERSION,
  findTool,
  parseAssessTokenInput,
  parseDecompiledFunctionInput,
  parseExplainFunctionInput,
  parseExplainTokenInput,
  parseGetPluginAuditInput,
  parseGetPluginDocsInput,
  parseInvestigateInput,
  parseListNewTokensInput,
  parseListPluginsInput,
  parseOnchainFeaturesInput,
  parseProofTraceInput,
  parseRequestAssessmentInput,
  parseVerifiedSourceInput,
} from "./tools.ts";
import type {
  AssessInputError,
  AssessTokenInput,
  DecompiledFunctionInput,
  ExplainFunctionInput,
  ExplainTokenInput,
  ListNewTokensInput,
  ProofTraceInput,
  ToolDefinition,
  VerifiedSourceInput,
} from "./tools.ts";
import { buildPluginToolDefinitions, pluginToolNameFor } from "./pluginTools.ts";
import { pluginResultToCanonical } from "../../application/pluginExposure.ts";

export const MCP_SERVER_NAME = "brandklipparen-mcp";
export const MCP_SERVER_VERSION = "1.0.0";
// Dated MCP protocol versions the server negotiates (S-107, K-021,
// MCP-2): the latest supported version is the fallback answer when a
// client offers a version the server does not support.
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_MCP_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  MCP_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
]);

const DEFAULT_ANALYZE_TIMEOUT_MS = 30000;
const DEFAULT_MAX_MESSAGE_BYTES = 8192;

export type McpServerOptions = {
  readonly services: AppServices;
  readonly apiKeys?: readonly SecretString[] | undefined;
  readonly apiKeyPepper?: SecretString | undefined;
  // Client key from the process environment (MCP-2): in stdio mode the
  // user's own client launches this process, so a frame without a
  // top-level `auth` field uses this key. A frame `auth` always wins.
  // Loaded via BRANDKLIPPAREN_MCP_API_KEY(_FILE) at startup and verified
  // against apiKeys with the same per-key caps as any frame key.
  readonly envApiKey?: SecretString | string | undefined;
  readonly defaultApiKey?: SecretString | string | undefined;
  readonly mcpApiKey?: SecretString | string | undefined;
  readonly clientApiKey?: SecretString | string | undefined;
  readonly stdioApiKey?: SecretString | string | undefined;
  readonly modelVersion: ModelVersion;
  readonly indexVersion: IndexVersion;
  readonly templateVersion: TemplateVersion;
  readonly catalogue: CapabilityCatalogue;
  // Registered detector set behind list_plugins (S-046, P-10): the tool
  // derives from this one registry value, the same value the shared service
  // runs and GET /v1/plugins lists. The composition root wires the set
  // explicitly; no defaulted set exists.
  readonly detectors: DetectorSet;
  // Calibrated detector weights read once at startup from the loaded
  // artifact (S-047, P-05, P-10); absent entries expose weight 0.
  readonly pluginWeights?: PluginWeightMapping | undefined;
  // Validated plugin docs keyed by plugin id (S-056, P-16): the same
  // records the REST docs route reads. An unknown plugin id, or a known
  // id without a record, gives the machine-readable not-found error.
  readonly pluginDocs?: PluginDocsMap | undefined;
  // Stored CI audit reports keyed by plugin id (S-058, K-516): the same
  // records the REST audit route reads. Read-only; the tool triggers no
  // audit.
  readonly pluginAudits?: StoredAuditReportMap | undefined;
  readonly analyzeTimeoutMs?: number | undefined;
  readonly maxMessageBytes?: number | undefined;
  // Absent service means the assessment feature is disabled through
  // configuration (K-309): request_assessment answers assessment-not-configured.
  readonly assessmentService?: AssessmentService | undefined;
  // Absent service means the investigation loop is disabled through
  // configuration (P-29): investigate_token answers
  // investigation-not-configured with zero model calls.
  readonly investigationService?: InvestigationService | undefined;
  // On-chain feature reads (session A): the chain port behind serving-mode
  // reads plus the operator-configured canonical WETH address (null when
  // unset). Absent means onchain_features answers onchain-not-configured
  // with zero chain calls. Read-only; the features never enter scoring.
  readonly onchain?: { readonly rpc: RpcPort; readonly weth: string | null } | undefined;
  // Explain service for the sentence-level overlay (S-094, K-302): the
  // same service the REST /v1/explain route reads. Absent or disabled
  // means explain_token answers the not-configured envelope with zero
  // provider calls and the deterministic analysis standing.
  readonly explainService?: ExplainService | undefined;
  // Explain-code service for the per-function code explanation (VS-B3):
  // the same service the REST /v1/explain-code route reads. Absent or
  // disabled means explain_function answers the not-configured envelope
  // with zero provider calls and the deterministic code view standing.
  readonly explainCodeService?: ExplainCodeService | undefined;
  // Bytecode source for snippet, proof and code-explanation deepening
  // (S-095, VS-B1, VS-B3): the route reads the contract code through
  // this port. Absent means the deepening tools answer the typed
  // not-available error without touching the pipeline.
  readonly snippetRpc?: RpcPort | undefined;
  // Injectable decompile pipeline for snippet deepening (S-095): defaults
  // to the local pipeline. Tests inject a counting wrapper to prove
  // unknown selectors fail before any pipeline call.
  readonly snippetDecompile?: SnippetDecompile | undefined;
  // Extended-proof diagnostics (VS-B1, main spec B-3): the application
  // proof service with the bounded per-code-hash memo. Absent means proof
  // diagnostics are not available on this server.
  readonly proofService?: ProofService | undefined;
  // Verified sources (VS-B2): the application source service with the
  // bounded per-code-hash memo. Absent means the provider selection is
  // off: get_verified_source answers unavailable with zero provider
  // calls. Never part of the analysis; never in the score.
  readonly sourceService?: VerifiedSourceService | undefined;
  // Live new-tokens reader (E-11): the application service snapshot with
  // the on-chain new pairs. Absent means the on-chain leg of the listing
  // is off on this server.
  readonly liveTokens?: LiveTokensReader | undefined;
  // Market listing reader (DX-B1): the application service snapshot
  // holding the server-side listing cache. Absent means the market leg of
  // the listing is off on this server.
  readonly marketNew?: MarketNewReader | undefined;
  // Shared rate and quota limits with the REST adapter per M-08 (K-504);
  // absent limits disable the check, as in local development.
  readonly rateLimit?: RateLimitConfig | undefined;
  readonly rateLimitNowMs?: (() => number) | undefined;
};

// Tool result content: the canonical assessment text as data for the user.
// Contract-derived strings stay inside this block, so the client model
// reads them as assessment data, never as instructions (M-15).
export type McpContentBlock = {
  readonly type: "text";
  readonly text: string;
  readonly annotations: { readonly audience: readonly string[] };
};

export type McpToolResult = {
  readonly content: readonly McpContentBlock[];
  readonly isError: false;
};

export type CallToolOptions = {
  readonly apiKey?: string | undefined;
};

export type McpServer = {
  // Closed versioned tool registry (K-025, M-15).
  readonly listTools: () => readonly ToolDefinition[];
  // Direct in-process tool call used by tests and local hosts.
  readonly callTool: (
    name: string,
    args: unknown,
    options?: CallToolOptions | undefined,
  ) => Promise<Result<McpToolResult, McpToolError>>;
  // Minimal JSON-RPC 2.0 frame handler: one request object in, one response
  // object out (empty string for notifications). Never throws: malformed
  // input maps to a JSON-RPC error value.
  readonly handleJsonRpc: (raw: string) => Promise<string>;
};

function issueRequestId(): RequestId | null {
  const parsed = RequestId.parse(randomUUID());
  return parsed.ok ? parsed.value : null;
}

function textBlock(text: string): McpContentBlock {
  return Object.freeze({
    type: "text",
    text,
    annotations: Object.freeze({ audience: Object.freeze(["user"]) }),
  });
}

function safeJsonLength(value: unknown): number | null {
  try {
    return JSON.stringify(value)?.length ?? null;
  } catch {
    return null;
  }
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const store: ApiKeyStore = createApiKeyStore({
    keys: options.apiKeys ?? [],
    pepper: options.apiKeyPepper,
  });
  const envApiKeyRaw =
    options.envApiKey ?? options.defaultApiKey ?? options.mcpApiKey ?? options.clientApiKey ?? options.stdioApiKey;
  const envApiKey: string | undefined =
    envApiKeyRaw === undefined
      ? undefined
      : typeof envApiKeyRaw === "string"
        ? envApiKeyRaw
        : envApiKeyRaw.reveal();
  // A frame or call-option key always wins; the env key only fills the
  // gap a standard client leaves (MCP-2).
  const effectiveApiKey = (callOptions: CallToolOptions | undefined): string | undefined =>
    callOptions?.apiKey ?? envApiKey;
  const keyGate = (options.apiKeys ?? []).length > 0;
  const analyzeTimeoutMs = options.analyzeTimeoutMs ?? DEFAULT_ANALYZE_TIMEOUT_MS;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const limiter: RateLimiter | null =
    options.rateLimit === undefined
      ? null
      : createRateLimiter(options.rateLimit, options.rateLimitNowMs);

  // Per-plugin tool snapshot (S-048, K-031): one reading tool per
  // registered detector, frozen at server creation. Names outside this
  // snapshot answer `unknown-tool` without analysis.
  const pluginBuilt = buildPluginToolDefinitions(options.detectors.registry);
  const pluginDefinitions: readonly ToolDefinition[] = pluginBuilt.ok ? pluginBuilt.value : [];
  const pluginIdByToolName = new Map<string, string>();
  for (const entry of options.detectors.registry.entries) {
    pluginIdByToolName.set(pluginToolNameFor(entry.manifest.id), entry.manifest.id);
  }
  const allDefinitions: readonly ToolDefinition[] = Object.freeze([...TOOL_DEFINITIONS, ...pluginDefinitions]);
  const findAnyTool = (name: string): ToolDefinition | null =>
    (findTool(name) ?? pluginDefinitions.find((tool) => tool.name === name) ?? null);

  // Shared tool gate (A-11, A-16, K-026): API key, message size and the
  // published input schema. All reading tools reuse the same gate, so
  // every tool faces identical key, size and quota limits. The stable
  // key id names the caller to the cost meter without exposing the key.
  function gateParsed<T>(
    args: unknown,
    parse: (raw: unknown) => AssessInputError | { readonly kind: string; readonly message?: string } | { readonly input: T },
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
    usage: string,
  ): Result<{ readonly input: T; readonly apiKeyId: string }, McpToolError> {
    let apiKeyId = "anonymous";
    if (keyGate) {
      const candidate = effectiveApiKey(callOptions);
      if (candidate === undefined) {
        return err(missingApiKey(requestId as string));
      }
      if (!store.verify(candidate)) {
        return err(invalidApiKey(requestId as string));
      }
      apiKeyId = store.keyId(candidate) ?? "unknown-key";
    }
    const argLength = safeJsonLength(args);
    if (argLength === null) {
      return err(validationError(`Invalid arguments: expected ${usage}.`, requestId as string));
    }
    if (argLength > maxMessageBytes) {
      return err(requestTooLarge(requestId as string));
    }
    const parsed = parse(args);
    if ("kind" in parsed) {
      switch (parsed.kind) {
        case "request-too-large":
          return err(requestTooLarge(requestId as string));
        case "key-in-url-or-body":
          return err(keyInToolArgs(requestId as string));
        case "validation-error":
          return err(validationError(parsed.message ?? "Invalid arguments.", requestId as string));
        default:
          return err(validationError(`Invalid arguments: expected ${usage}.`, requestId as string));
      }
    }
    // Rate and quota step before every expensive tool call (K-504, M-08),
    // shared with the REST adapter: over-limit keys receive a retryable
    // machine error and the analysis never starts.
    if (limiter !== null) {
      const decision = limiter.check(apiKeyId);
      if (!decision.allowed) {
        return err(rateLimited(decision.retryAfterSec, requestId as string));
      }
    }
    return ok({ input: parsed.input, apiKeyId });
  }

  function gateToolArgs(
    args: unknown,
    parse: (raw: unknown) => { readonly kind: string; readonly message?: string } | { readonly input: AssessTokenInput },
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Result<{ readonly input: AssessTokenInput; readonly apiKeyId: string }, McpToolError> {
    return gateParsed(args, parse, requestId, callOptions, "an object with address and block");
  }

  // Current day as YYYY-MM-DD for the per-key daily cost meter (I-14).
  // Driving adapters may read the clock; the core stays pure (A-32).
  function currentDay(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async function runAssessToken(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateToolArgs(args, parseAssessTokenInput, requestId, callOptions);
    if (!gated.ok) {
      return err(gated.error);
    }
    const parsed = { input: gated.value.input };
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    const analysed = await options.services.analyzeToken({
      address: parsed.input.address,
      block: parsed.input.block,
      requestId,
      deadline: deadline.value,
      modelVersion: options.modelVersion,
      indexVersion: options.indexVersion,
      templateVersion: options.templateVersion,
      catalogue: options.catalogue,
    });
    if (!analysed.ok) {
      const mapped = toMcpError(analysed.error);
      return err({ ...mapped, requestId });
    }
    if (analysed.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: analysed.value.target as string,
        block: analysed.value.block as number,
      });
      return ok({ content: Object.freeze([textBlock(body)]), isError: false });
    }
    return ok({
      content: Object.freeze([textBlock(serializeAssessment(analysed.value.envelope))]),
      isError: false,
    });
  }

  // On-request Muse contract assessment (S-038, K-305, K-309): the same
  // gate as assess_token, then the shared assessment service. Scores and
  // evidence pass through untouched; the assessment lands in its own field
  // with provider and model id labelling. A capped key or a provider error
  // still answers with the template explanation standing (K-306).
  async function runRequestAssessment(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateToolArgs(args, parseRequestAssessmentInput, requestId, callOptions);
    if (!gated.ok) {
      return err(gated.error);
    }
    const service = options.assessmentService;
    if (service === undefined) {
      return err(assessmentNotConfigured(requestId as string));
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId: requestId as string,
      } satisfies McpToolError);
    }
    const requested = await service.requestForToken({
      address: gated.value.input.address,
      block: gated.value.input.block,
      requestId,
      deadline: deadline.value,
      modelVersion: options.modelVersion,
      indexVersion: options.indexVersion,
      templateVersion: options.templateVersion,
      catalogue: options.catalogue,
      apiKeyId: gated.value.apiKeyId,
      day: currentDay(),
    });
    if (!requested.ok) {
      const mapped = toMcpError(requested.error);
      return err({ ...mapped, requestId: requestId as string });
    }
    if (requested.value.kind === "disabled") {
      return err(assessmentNotConfigured(requestId as string));
    }
    if (requested.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: requested.value.target as string,
        block: requested.value.block as number,
      });
      return ok({ content: Object.freeze([textBlock(body)]), isError: false });
    }
    return ok({
      content: Object.freeze([textBlock(serializeTokenAssessment(requested.value))]),
      isError: false,
    });
  }

  // Opt-in investigation loop (S-075, K-036, P-37): the same gate as
  // assess_token, then the deterministic analysis followed by the shared
  // investigation service. Scores and evidence pass through untouched; the
  // trace and the citation-checked narrative land in their own fields with
  // provider and model id labelling. Read-only like every other tool.
  async function runInvestigate(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateToolArgs(args, parseInvestigateInput, requestId, callOptions);
    if (!gated.ok) {
      return err(gated.error);
    }
    const service = options.investigationService;
    if (service === undefined) {
      return err(investigationNotConfigured(requestId as string));
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    const analysed = await options.services.analyzeToken({
      address: gated.value.input.address,
      block: gated.value.input.block,
      requestId,
      deadline: deadline.value,
      modelVersion: options.modelVersion,
      indexVersion: options.indexVersion,
      templateVersion: options.templateVersion,
      catalogue: options.catalogue,
    });
    if (!analysed.ok) {
      const mapped = toMcpError(analysed.error);
      return err({ ...mapped, requestId });
    }
    if (analysed.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: analysed.value.target as string,
        block: analysed.value.block as number,
      });
      return ok({ content: Object.freeze([textBlock(body)]), isError: false });
    }
    const investigated = await service.investigateEnvelope(
      analysed.value.envelope,
      {
        requestId,
        deadline: deadline.value,
        block: analysed.value.envelope.block,
      },
      { now: () => Date.now() },
      { apiKeyId: gated.value.apiKeyId, day: currentDay() },
    );
    return ok({
      content: Object.freeze([
        textBlock(
          serializeTokenInvestigation(
            analysed.value.envelope,
            investigated,
            service.provider(),
            service.modelId(),
          ),
        ),
      ]),
      isError: false,
    });
  }

  // Point-in-time on-chain features (session A): the same gate as
  // assess_token, then the shared on-chain service in serving mode.
  // Display data only, never scored; an absent chain port answers
  // onchain-not-configured with zero chain calls. Read-only like every
  // other tool.
  async function runOnchainFeatures(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateToolArgs(args, parseOnchainFeaturesInput, requestId, callOptions);
    if (!gated.ok) {
      return err(gated.error);
    }
    const onchain = options.onchain;
    if (onchain === undefined) {
      return err(onchainNotConfigured(requestId as string));
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    const features = await readOnchainFeatures(onchain.rpc, {
      token: gated.value.input.address,
      requestId,
      deadline: deadline.value,
      mode: "serving",
      weth: onchain.weth,
      nowMs: Date.now,
      headBlock: gated.value.input.block === "latest" ? undefined : (gated.value.input.block as number),
    });
    return ok({
      content: Object.freeze([textBlock(JSON.stringify({ features }))]),
      isError: false,
    });
  }

  // Resolved analysis code shared by the deepening tools (C-4, F-6): the
  // implementation behind a proxy, matching the scored analysis. Absent
  // chain access answers the caller-supplied not-available error; an
  // unreadable target maps to the typed not-found and upstream errors, so
  // port contents never cross the boundary.
  async function resolveToolCode(
    address: AssessTokenInput["address"],
    block: AssessTokenInput["block"],
    requestId: RequestId,
    missing: McpToolError,
  ): Promise<
    Result<
      {
        readonly bytecode: BytecodeType;
        readonly codeHash: string;
        readonly codeAddress: AssessTokenInput["address"];
      },
      McpToolError
    >
  > {
    const rpc = options.snippetRpc;
    if (rpc === undefined) {
      return err(missing);
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    const resolved = await resolveAnalysisCode({ rpc }, {
      address,
      block,
      requestId,
      deadline: deadline.value,
    });
    if (!resolved.ok) {
      if (resolved.error.kind === "no-contract") {
        return err(notFound(requestId as string));
      }
      if (resolved.error.kind === "rpc-error") {
        return err({
          code: "upstream-unavailable",
          message: "Upstream data source unavailable; retry with the same request ID.",
          requestId,
        } satisfies McpToolError);
      }
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    return ok({
      bytecode: resolved.value.bytecode,
      codeHash: resolved.value.codeHash as string,
      codeAddress: resolved.value.codeAddress,
    });
  }

  // Sentence-level explanation overlay (S-094, K-302): the same gate and
  // the same deterministic analysis as assess_token, then one overlay
  // call over the frozen envelope through the shared explain service.
  // The route-mirror envelope carries `not-configured` without a wired
  // service and `invalid-output` for malformed model output, in both
  // cases with the deterministic analysis standing. Scores, evidence and
  // finding text are untouched: the analysis runs first and stands
  // beside the overlay in every branch.
  async function runExplainToken(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateParsed<ExplainTokenInput>(
      args,
      parseExplainTokenInput,
      requestId,
      callOptions,
      "an object with address and block",
    );
    if (!gated.ok) {
      return err(gated.error);
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    const analysed = await options.services.analyzeToken({
      address: gated.value.input.address,
      block: gated.value.input.block,
      requestId,
      deadline: deadline.value,
      modelVersion: options.modelVersion,
      indexVersion: options.indexVersion,
      templateVersion: options.templateVersion,
      catalogue: options.catalogue,
    });
    if (!analysed.ok) {
      const mapped = toMcpError(analysed.error);
      return err({ ...mapped, requestId });
    }
    if (analysed.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: analysed.value.target as string,
        block: analysed.value.block as number,
      });
      return ok({ content: Object.freeze([textBlock(body)]), isError: false });
    }
    const envelope = analysed.value.envelope;
    const codeHash = envelope.codeHash as string;
    const service = options.explainService;
    if (service === undefined || !service.enabled) {
      return ok({
        content: Object.freeze([
          textBlock(
            JSON.stringify({
              status: "ok",
              apiVersion: API_VERSION,
              codeHash,
              explain: { kind: "not-configured" },
            }),
          ),
        ]),
        isError: false,
      });
    }
    const input = ExplainInput.create({
      codeHash,
      evidenceIds: [...envelope.signals.map((signal) => `signal:${signal.id as string}`), ...explainCoverageIds(envelope)],
      promptVersion: EXPLAIN_PROMPT_VERSION,
      meanings: envelopeMeanings(envelope),
    });
    if (input === null) {
      return ok({
        content: Object.freeze([
          textBlock(
            JSON.stringify({
              status: "ok",
              apiVersion: API_VERSION,
              codeHash,
              explain: { kind: "invalid-output" },
            }),
          ),
        ]),
        isError: false,
      });
    }
    const outcome = await service.explain(input, gated.value.apiKeyId);
    return ok({
      content: Object.freeze([
        textBlock(
          JSON.stringify({
            status: "ok",
            apiVersion: API_VERSION,
            codeHash,
            explain: JSON.parse(serializeExplainOutcome(outcome)),
          }),
        ),
      ]),
      isError: false,
    });
  }

  // Per-function code explanation overlay (VS-B3): the same gate as
  // assess_token plus the selector and view checks, then the frozen
  // function lines for that view, then the shared analysis, then one
  // overlay call carrying the selector-filtered evidence meanings. The
  // route-mirror envelope carries `not-configured` without a wired
  // service and `invalid-output` for malformed model output. Scores,
  // evidence and finding text are untouched: the analysis runs first and
  // stands beside the overlay in every branch.
  async function runExplainFunction(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateParsed<ExplainFunctionInput>(
      args,
      parseExplainFunctionInput,
      requestId,
      callOptions,
      "an object with address, selector and view",
    );
    if (!gated.ok) {
      return err(gated.error);
    }
    const service = options.explainCodeService;
    if (service === undefined || !service.enabled) {
      return ok({
        content: Object.freeze([
          textBlock(JSON.stringify({ status: "ok", apiVersion: API_VERSION, explainCode: { kind: "not-configured" } })),
        ]),
        isError: false,
      });
    }
    const resolved = await resolveToolCode(
      gated.value.input.address,
      gated.value.input.block,
      requestId,
      snippetNotAvailable(requestId as string),
    );
    if (!resolved.ok) {
      return err(resolved.error);
    }
    const codeHash = resolved.value.codeHash;
    const rawSelector = gated.value.input.selector;
    const rawView = gated.value.input.view;
    const wantedSelector = rawSelector.toLowerCase();
    let viewLines: { readonly lineNumber: number; readonly text: string }[];
    let viewFile: string | undefined;
    if (rawView === "decompiled") {
      const snippet = snippetForSelector(
        resolved.value.bytecode,
        rawSelector,
        options.snippetDecompile ?? decompilePreferV2,
      );
      if (!snippet.ok) {
        return err(
          validationError(
            "Unknown selector: the contract dispatcher carries no such entry.",
            requestId as string,
          ),
        );
      }
      viewLines = snippet.value.lines.map((line) => ({ lineNumber: line.lineNumber, text: line.text }));
    } else {
      const sourceService = options.sourceService;
      if (sourceService === undefined) {
        return err(
          validationError(
            "No verified source covers this function: the source lookup is not available on this server.",
            requestId as string,
          ),
        );
      }
      const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
      if (!deadline.ok) {
        return err({
          code: "internal-error",
          message: "Analysis failed; retry with the same request ID.",
          requestId,
        } satisfies McpToolError);
      }
      // The explanation covers the implementation behind a proxy,
      // matching the scored analysis.
      const result = await sourceService.getSource(resolved.value.codeAddress, {
        requestId,
        deadline: deadline.value,
        block: gated.value.input.block,
      });
      if (!result.ok) {
        if (result.error === "no-code") {
          return err(notFound(requestId as string));
        }
        return err({
          code: "upstream-unavailable",
          message: "Upstream data source unavailable; retry with the same request ID.",
          requestId,
        } satisfies McpToolError);
      }
      if (result.value.source.status !== "verified") {
        return err(
          validationError(
            "No verified source covers this function: the author published no source code.",
            requestId as string,
          ),
        );
      }
      const located = result.value.source.functions.find(
        (entry) => entry.selector.toLowerCase() === wantedSelector,
      );
      if (located === undefined) {
        return err(
          validationError("No verified source covers this function.", requestId as string),
        );
      }
      const file = result.value.source.files.find((entry) => entry.path === located.file);
      if (file === undefined) {
        return err(
          validationError("No verified source covers this function.", requestId as string),
        );
      }
      const fileLines = file.content.split("\n");
      const ranged = fileLines.slice(located.startLine - 1, located.endLine);
      if (ranged.length === 0) {
        return err(
          validationError("No verified source covers this function.", requestId as string),
        );
      }
      viewLines = ranged.map((text, index) => ({ lineNumber: located.startLine + index, text }));
      viewFile = located.file;
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    const analysed = await options.services.analyzeToken({
      address: gated.value.input.address,
      block: gated.value.input.block,
      requestId,
      deadline: deadline.value,
      modelVersion: options.modelVersion,
      indexVersion: options.indexVersion,
      templateVersion: options.templateVersion,
      catalogue: options.catalogue,
    });
    if (!analysed.ok) {
      const mapped = toMcpError(analysed.error);
      return err({ ...mapped, requestId });
    }
    if (analysed.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: analysed.value.target as string,
        block: analysed.value.block as number,
      });
      return ok({ content: Object.freeze([textBlock(body)]), isError: false });
    }
    const envelope = analysed.value.envelope;
    const meanings = envelopeMeanings(envelope).filter((meaning) =>
      meaning.selectors.some((labelled) => labelled.selector.toLowerCase() === wantedSelector),
    );
    const evidenceIds = meanings.map((meaning) => meaning.id);
    const input = ExplainCodeInput.create({
      codeHash,
      selector: rawSelector,
      view: rawView,
      promptVersion: EXPLAIN_CODE_PROMPT_VERSION,
      lines: viewLines,
      ...(viewFile === undefined ? {} : { file: viewFile }),
      evidenceIds,
      meanings,
    });
    if (input === null) {
      return ok({
        content: Object.freeze([
          textBlock(
            JSON.stringify({
              status: "ok",
              apiVersion: API_VERSION,
              codeHash,
              selector: rawSelector,
              view: rawView,
              explainCode: { kind: "invalid-output" },
            }),
          ),
        ]),
        isError: false,
      });
    }
    const outcome = await service.explainCode(input, gated.value.apiKeyId);
    return ok({
      content: Object.freeze([
        textBlock(
          JSON.stringify({
            status: "ok",
            apiVersion: API_VERSION,
            codeHash,
            selector: input.selector,
            view: rawView,
            explainCode: JSON.parse(serializeExplainCodeOutcome(outcome)),
          }),
        ),
      ]),
      isError: false,
    });
  }

  // Snippet deepening per selector (S-095, K-008): the same gate as
  // assess_token plus the selector check, then one bytecode fetch through
  // the resolved implementation, then the local decompilation pipeline.
  // Unknown selectors fail before any pipeline call; quoted lines come
  // from the pipeline's own emission. Display text only, never scored.
  async function runGetDecompiledFunction(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateParsed<DecompiledFunctionInput>(
      args,
      parseDecompiledFunctionInput,
      requestId,
      callOptions,
      "an object with address and selector",
    );
    if (!gated.ok) {
      return err(gated.error);
    }
    const resolved = await resolveToolCode(
      gated.value.input.address,
      gated.value.input.block,
      requestId,
      snippetNotAvailable(requestId as string),
    );
    if (!resolved.ok) {
      return err(resolved.error);
    }
    const snippet = snippetForSelector(
      resolved.value.bytecode,
      gated.value.input.selector,
      options.snippetDecompile ?? decompilePreferV2,
    );
    if (!snippet.ok) {
      return err(
        validationError(
          "Unknown selector: the contract dispatcher carries no such entry.",
          requestId as string,
        ),
      );
    }
    return ok({
      content: Object.freeze([
        textBlock(
          JSON.stringify({
            status: "ok",
            apiVersion: API_VERSION,
            codeHash: resolved.value.codeHash,
            snippet: {
              selector: snippet.value.selector,
              entryPc: snippet.value.entryPc,
              lines: snippet.value.lines.map((line) => ({
                selector: line.selector,
                lineNumber: line.lineNumber,
                text: line.text,
                pcs: line.pcs.slice(),
              })),
            },
          }),
        ),
      ]),
      isError: false,
    });
  }

  // Extended-proof diagnostics (VS-B1, main spec B-3): the same gate as
  // assess_token, then one bytecode fetch through the resolved
  // implementation, then the local proof walk over the frozen code. The
  // response carries the per-detector reports with code locations; it is
  // never part of the analysis and never enters the score.
  async function runGetProofTrace(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateParsed<ProofTraceInput>(
      args,
      parseProofTraceInput,
      requestId,
      callOptions,
      "an object with address and block",
    );
    if (!gated.ok) {
      return err(gated.error);
    }
    if (options.snippetRpc === undefined) {
      return err(proofNotAvailable(requestId as string));
    }
    const proofService = options.proofService;
    if (proofService === undefined) {
      return err(proofNotAvailable(requestId as string));
    }
    const resolved = await resolveToolCode(
      gated.value.input.address,
      gated.value.input.block,
      requestId,
      proofNotAvailable(requestId as string),
    );
    if (!resolved.ok) {
      return err(resolved.error);
    }
    const proofs = proofService.proofsFor(resolved.value.bytecode, resolved.value.codeHash);
    return ok({
      content: Object.freeze([
        textBlock(
          JSON.stringify({
            status: "ok",
            apiVersion: API_VERSION,
            codeHash: resolved.value.codeHash,
            proofs: proofs.map((report) => ({
              detector: report.detector,
              steps: report.steps.map((entry) => ({ ...entry })),
            })),
          }),
        ),
      ]),
      isError: false,
    });
  }

  // Verified contract sources (VS-B2): the same gate as assess_token plus
  // an optional function selector, then the application source service
  // through the resolved implementation address. The tool answers the
  // summarised record (status, match, compiler, functions) with full file
  // content only for the requested function range. Never part of the
  // analysis; never in the score.
  async function runGetVerifiedSource(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateParsed<VerifiedSourceInput>(
      args,
      parseVerifiedSourceInput,
      requestId,
      callOptions,
      "an object with address and an optional functionSelector",
    );
    if (!gated.ok) {
      return err(gated.error);
    }
    const service = options.sourceService;
    if (service === undefined) {
      return ok({
        content: Object.freeze([
          textBlock(
            JSON.stringify({
              status: "ok",
              apiVersion: API_VERSION,
              source: {
                status: "unavailable",
                provider: null,
                match: null,
                compiler: null,
                files: [],
                functions: [],
              },
            }),
          ),
        ]),
        isError: false,
      });
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    let codeAddress = gated.value.input.address;
    const codeRpc = options.snippetRpc;
    if (codeRpc !== undefined) {
      const resolved = await resolveAnalysisCode({ rpc: codeRpc }, {
        address: gated.value.input.address,
        block: gated.value.input.block,
        requestId,
        deadline: deadline.value,
      });
      if (!resolved.ok) {
        if (resolved.error.kind === "no-contract") {
          return err(notFound(requestId as string));
        }
        if (resolved.error.kind === "rpc-error") {
          return err({
            code: "upstream-unavailable",
            message: "Upstream data source unavailable; retry with the same request ID.",
            requestId,
          } satisfies McpToolError);
        }
        return err({
          code: "internal-error",
          message: "Analysis failed; retry with the same request ID.",
          requestId,
        } satisfies McpToolError);
      }
      codeAddress = resolved.value.codeAddress;
    }
    const result = await service.getSource(codeAddress, {
      requestId,
      deadline: deadline.value,
      block: gated.value.input.block,
    });
    if (!result.ok) {
      if (result.error === "no-code") {
        return err(notFound(requestId as string));
      }
      return err({
        code: "upstream-unavailable",
        message: "Upstream data source unavailable; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    const source = result.value.source;
    const functions = source.functions.map((entry) => ({
      selector: entry.selector,
      name: entry.name,
      signature: entry.signature,
      file: entry.file,
      startLine: entry.startLine,
      endLine: entry.endLine,
    }));
    const wanted = gated.value.input.functionSelector?.toLowerCase();
    if (wanted === undefined) {
      return ok({
        content: Object.freeze([
          textBlock(
            JSON.stringify({
              status: "ok",
              apiVersion: API_VERSION,
              codeHash: result.value.codeHash,
              source: {
                status: source.status,
                provider: source.provider,
                match: source.match,
                compiler: source.compiler,
                files: [],
                functions,
              },
            }),
          ),
        ]),
        isError: false,
      });
    }
    const located = functions.find((entry) => entry.selector.toLowerCase() === wanted);
    if (located === undefined) {
      return err(
        validationError("No verified source covers this function.", requestId as string),
      );
    }
    const file = source.files.find((entry) => entry.path === located.file);
    if (file === undefined) {
      return err(
        validationError("No verified source covers this function.", requestId as string),
      );
    }
    const ranged = file.content.split("\n").slice(located.startLine - 1, located.endLine);
    if (ranged.length === 0) {
      return err(
        validationError("No verified source covers this function.", requestId as string),
      );
    }
    return ok({
      content: Object.freeze([
        textBlock(
          JSON.stringify({
            status: "ok",
            apiVersion: API_VERSION,
            codeHash: result.value.codeHash,
            source: {
              status: source.status,
              provider: source.provider,
              match: source.match,
              compiler: source.compiler,
              files: [],
              functions,
              file: {
                path: file.path,
                startLine: located.startLine,
                endLine: located.endLine,
                content: ranged.join("\n"),
              },
            },
          }),
        ),
      ]),
      isError: false,
    });
  }

  // New-token listings (E-11, DX-B1): the same key and quota gate as the
  // other tools, then the on-chain new-pair snapshot beside the market
  // listing cache. Display data only, never scored and never starting an
  // analysis: items already analysed carry their deterministic summary.
  async function runListNewTokens(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateParsed<ListNewTokensInput>(
      args,
      parseListNewTokensInput,
      requestId,
      callOptions,
      "an optional chain and since",
    );
    if (!gated.ok) {
      return err(gated.error);
    }
    const live = options.liveTokens;
    const market = options.marketNew;
    if (live === undefined && market === undefined) {
      return err(listingsNotConfigured(requestId as string));
    }
    const liveSnapshot = live?.snapshot(gated.value.input.sinceMs) ?? null;
    let marketSnapshot: unknown = null;
    if (market !== undefined) {
      try {
        marketSnapshot = await market.getMarket(MARKET_CHAIN);
      } catch {
        return err({
          code: "upstream-unavailable",
          message: "Market listing is unavailable; retry with the same request ID.",
          requestId,
        } satisfies McpToolError);
      }
    }
    return ok({
      content: Object.freeze([
        textBlock(
          JSON.stringify({
            status: "ok",
            apiVersion: API_VERSION,
            chain: MARKET_CHAIN,
            live: liveSnapshot,
            market: marketSnapshot,
          }),
        ),
      ]),
      isError: false,
    });
  }

  // Registry exposure (S-046, K-031, P-10): the registry-derived reading
  // tool returns the same manifest list as GET /v1/plugins in a text
  // content block marked as data for the user (M-15). Findings keep riding
  // the existing assess_token output under pluginResults.
  async function runListPlugins(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const detectors = options.detectors;
    let apiKeyId = "anonymous";
    if (keyGate) {
      const candidate = effectiveApiKey(callOptions);
      if (candidate === undefined) {
        return err(missingApiKey(requestId as string));
      }
      if (!store.verify(candidate)) {
        return err(invalidApiKey(requestId as string));
      }
      apiKeyId = store.keyId(candidate) ?? "unknown-key";
    }
    const argLength = safeJsonLength(args);
    if (argLength === null) {
      return err(validationError("Invalid arguments: list_plugins takes no arguments.", requestId as string));
    }
    if (argLength > maxMessageBytes) {
      return err(requestTooLarge(requestId as string));
    }
    const parsed = parseListPluginsInput(args);
    if ("kind" in parsed) {
      switch (parsed.kind) {
        case "request-too-large":
          return err(requestTooLarge(requestId as string));
        case "key-in-url-or-body":
          return err(keyInToolArgs(requestId as string));
        case "validation-error":
        default:
          return err(validationError(parsed.message ?? "Invalid arguments.", requestId as string));
      }
    }
    // Rate and quota step shared with the analysis tools (K-504, M-08):
    // an over-limit key receives the retryable machine error here too.
    if (limiter !== null) {
      const decision = limiter.check(apiKeyId);
      if (!decision.allowed) {
        return err(rateLimited(decision.retryAfterSec, requestId as string));
      }
    }
    const weights: PluginWeightMapping = options.pluginWeights ?? {};
    const docs = options.pluginDocs ?? new Map();
    return ok({
      content: Object.freeze([textBlock(serializePluginList(exposeRegistry(detectors.registry, weights, docs)))]),
      isError: false,
    });
  }

  // Plugin docs exposure (S-056, K-033, P-16): the validated `PLUGIN.md`
  // record from the one registry-adjacent value in a text content block
  // marked as data for the user (M-15). An unknown plugin id gives the
  // machine-readable not-found error following the unknown-tool pattern.
  async function runGetPluginDocs(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const detectors = options.detectors;
    let apiKeyId = "anonymous";
    if (keyGate) {
      const candidate = effectiveApiKey(callOptions);
      if (candidate === undefined) {
        return err(missingApiKey(requestId as string));
      }
      if (!store.verify(candidate)) {
        return err(invalidApiKey(requestId as string));
      }
      apiKeyId = store.keyId(candidate) ?? "unknown-key";
    }
    const argLength = safeJsonLength(args);
    if (argLength === null) {
      return err(validationError("Invalid arguments: expected an object with id.", requestId as string));
    }
    if (argLength > maxMessageBytes) {
      return err(requestTooLarge(requestId as string));
    }
    const parsed = parseGetPluginDocsInput(args);
    if ("kind" in parsed) {
      switch (parsed.kind) {
        case "request-too-large":
          return err(requestTooLarge(requestId as string));
        case "key-in-url-or-body":
          return err(keyInToolArgs(requestId as string));
        case "validation-error":
        default:
          return err(validationError(parsed.message ?? "Invalid arguments.", requestId as string));
      }
    }
    if (limiter !== null) {
      const decision = limiter.check(apiKeyId);
      if (!decision.allowed) {
        return err(rateLimited(decision.retryAfterSec, requestId as string));
      }
    }
    const id = parsed.id;
    const registered = detectors.registry.entries.some((candidate) => candidate.manifest.id === id);
    const docs = (options.pluginDocs ?? new Map()).get(id);
    if (!registered || docs === undefined) {
      return err(validationError(`Unknown plugin id: ${JSON.stringify(id)}.`, requestId as string));
    }
    return ok({ content: Object.freeze([textBlock(serializePluginDocs(docs))]), isError: false });
  }

  // Stored CI audit report read view (S-058, K-516): the stored record for
  // one registered plugin in a text content block marked as data for the
  // user (M-15), byte-identical to GET /v1/plugins/:id/audit for the same
  // record (K-027). An unknown plugin id, or a known id without a stored
  // report, gives the machine-readable not-found error following the
  // unknown-tool pattern. The tool triggers no audit.
  async function runGetPluginAudit(
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const detectors = options.detectors;
    let apiKeyId = "anonymous";
    if (keyGate) {
      const candidate = effectiveApiKey(callOptions);
      if (candidate === undefined) {
        return err(missingApiKey(requestId as string));
      }
      if (!store.verify(candidate)) {
        return err(invalidApiKey(requestId as string));
      }
      apiKeyId = store.keyId(candidate) ?? "unknown-key";
    }
    const argLength = safeJsonLength(args);
    if (argLength === null) {
      return err(validationError("Invalid arguments: expected an object with id.", requestId as string));
    }
    if (argLength > maxMessageBytes) {
      return err(requestTooLarge(requestId as string));
    }
    const parsed = parseGetPluginAuditInput(args);
    if ("kind" in parsed) {
      switch (parsed.kind) {
        case "request-too-large":
          return err(requestTooLarge(requestId as string));
        case "key-in-url-or-body":
          return err(keyInToolArgs(requestId as string));
        case "validation-error":
        default:
          return err(validationError(parsed.message ?? "Invalid arguments.", requestId as string));
      }
    }
    if (limiter !== null) {
      const decision = limiter.check(apiKeyId);
      if (!decision.allowed) {
        return err(rateLimited(decision.retryAfterSec, requestId as string));
      }
    }
    const id = parsed.id;
    const registered = detectors.registry.entries.some((candidate) => candidate.manifest.id === id);
    const report = (options.pluginAudits ?? new Map()).get(id);
    if (!registered || report === undefined) {
      return err(validationError(`Unknown plugin id: ${JSON.stringify(id)}.`, requestId as string));
    }
    return ok({ content: Object.freeze([textBlock(serializeStoredAuditReport(report))]), isError: false });
  }

  // Per-plugin detector tool (S-048, K-031): the same gate and analysis
  // as assess_token, then the response filtered to one plugin id. Scores
  // and evidence pass through untouched in the shared path; this tool
  // only narrows the serialized view to the snapshot entry.
  async function runPluginTool(
    pluginId: string,
    args: unknown,
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const gated = gateToolArgs(args, parseAssessTokenInput, requestId, callOptions);
    if (!gated.ok) {
      return err(gated.error);
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId,
      } satisfies McpToolError);
    }
    const analysed = await options.services.analyzeToken({
      address: gated.value.input.address,
      block: gated.value.input.block,
      requestId,
      deadline: deadline.value,
      modelVersion: options.modelVersion,
      indexVersion: options.indexVersion,
      templateVersion: options.templateVersion,
      catalogue: options.catalogue,
    });
    if (!analysed.ok) {
      const mapped = toMcpError(analysed.error);
      return err({ ...mapped, requestId });
    }
    if (analysed.value.kind === "no-contract") {
      const body = canonicalSerialize({
        kind: "no-contract",
        target: analysed.value.target as string,
        block: analysed.value.block as number,
      });
      return ok({ content: Object.freeze([textBlock(body)]), isError: false });
    }
    const entry = analysed.value.envelope.pluginResults.find(
      (candidate) => candidate.pluginId === pluginId,
    );
    const canonical =
      entry === undefined
        ? { pluginId, findings: [] as readonly import("../../domain/serialize.ts").CanonicalValue[] }
        : (pluginResultToCanonical(entry) as unknown as {
            pluginId: string;
            findings: readonly import("../../domain/serialize.ts").CanonicalValue[];
          });
    const body = canonicalSerialize({
      plugin: { id: canonical.pluginId, findings: canonical.findings },
    });
    return ok({ content: Object.freeze([textBlock(body)]), isError: false });
  }

  async function callTool(
    name: string,
    args: unknown,
    callOptions?: CallToolOptions | undefined,
  ): Promise<Result<McpToolResult, McpToolError>> {
    const requestId = issueRequestId();
    if (requestId === null) {
      return err({
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
        requestId: "00000000-0000-4000-8000-000000000000",
      });
    }
    try {
      if (findAnyTool(name) === null) {
        return err(unknownTool(name, requestId as string));
      }
      if (name === ASSESS_TOKEN_TOOL) {
        return await runAssessToken(args, requestId, callOptions);
      }
      if (name === REQUEST_ASSESSMENT_TOOL) {
        return await runRequestAssessment(args, requestId, callOptions);
      }
      if (name === LIST_PLUGINS_TOOL) {
        return await runListPlugins(args, requestId, callOptions);
      }
      if (name === GET_PLUGIN_DOCS_TOOL) {
        return await runGetPluginDocs(args, requestId, callOptions);
      }
      if (name === GET_PLUGIN_AUDIT_TOOL) {
        return await runGetPluginAudit(args, requestId, callOptions);
      }
      if (name === INVESTIGATE_TOKEN_TOOL) {
        return await runInvestigate(args, requestId, callOptions);
      }
      if (name === ONCHAIN_FEATURES_TOOL) {
        return await runOnchainFeatures(args, requestId, callOptions);
      }
      if (name === EXPLAIN_TOKEN_TOOL) {
        return await runExplainToken(args, requestId, callOptions);
      }
      if (name === EXPLAIN_FUNCTION_TOOL) {
        return await runExplainFunction(args, requestId, callOptions);
      }
      if (name === GET_DECOMPILED_FUNCTION_TOOL) {
        return await runGetDecompiledFunction(args, requestId, callOptions);
      }
      if (name === GET_VERIFIED_SOURCE_TOOL) {
        return await runGetVerifiedSource(args, requestId, callOptions);
      }
      if (name === GET_PROOF_TRACE_TOOL) {
        return await runGetProofTrace(args, requestId, callOptions);
      }
      if (name === LIST_NEW_TOKENS_TOOL) {
        return await runListNewTokens(args, requestId, callOptions);
      }
      const pluginId = pluginIdByToolName.get(name);
      if (pluginId !== undefined) {
        return await runPluginTool(pluginId, args, requestId, callOptions);
      }
      return err(unknownTool(name, requestId as string));
    } catch {
      return err({
        code: "internal-error",
        message: "Internal error.",
        requestId: requestId as string,
      });
    }
  }

  function jsonRpcError(
    id: string | number | null,
    code: number,
    message: string,
    data?: Record<string, unknown> | undefined,
  ): string {
    const errorValue: Record<string, unknown> = { code, message };
    if (data !== undefined) {
      errorValue["data"] = data;
    }
    return JSON.stringify({ jsonrpc: "2.0", id, error: errorValue });
  }

  function jsonRpcResult(id: string | number | null, result: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  }

  async function handleJsonRpc(raw: string): Promise<string> {
    if (raw.length > maxMessageBytes) {
      return jsonRpcError(null, -32600, "Request exceeds the input size limit.", {
        code: "request-too-large",
      });
    }
    let message: unknown;
    try {
      message = JSON.parse(raw) as unknown;
    } catch {
      return jsonRpcError(null, -32700, "Parse error: expected one JSON-RPC object per line.");
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return jsonRpcError(null, -32600, "Invalid request: expected a JSON-RPC object.", {
        code: "validation-error",
      });
    }
    const record = message as Record<string, unknown>;
    if (record["jsonrpc"] !== "2.0" || typeof record["method"] !== "string") {
      const id = typeof record["id"] === "string" || typeof record["id"] === "number" ? record["id"] : null;
      return jsonRpcError(id, -32600, "Invalid request: expected JSON-RPC 2.0 with a method.", {
        code: "validation-error",
      });
    }
    const method = record["method"] as string;
    const idRaw = record["id"];
    const id: string | number | null =
      typeof idRaw === "string" || typeof idRaw === "number" ? idRaw : null;
    const isNotification = idRaw === undefined;
    if (isNotification) {
      return "";
    }
    const params = record["params"];
    const auth = typeof record["auth"] === "string" ? (record["auth"] as string) : undefined;
    switch (method) {
      case "initialize": {
        // Handshake negotiation (S-107, MCP-2): accept the client's
        // version when supported; otherwise answer with the server's
        // latest supported version per the MCP negotiation rules
        // instead of failing.
        const offered =
          typeof params === "object" && params !== null && !Array.isArray(params)
            ? (params as Record<string, unknown>)["protocolVersion"]
            : undefined;
        const negotiated =
          typeof offered === "string" && SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(offered)
            ? offered
            : MCP_PROTOCOL_VERSION;
        return jsonRpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        });
      }
      case "ping":
        return jsonRpcResult(id, {});
      case "tools/list":
        return jsonRpcResult(id, { tools: allDefinitions, toolListVersion: TOOL_LIST_VERSION });
      case "tools/call": {
        if (typeof params !== "object" || params === null || Array.isArray(params)) {
          return jsonRpcError(id, -32602, "Invalid params: expected name and arguments.", {
            code: "validation-error",
          });
        }
        const call = params as Record<string, unknown>;
        if (typeof call["name"] !== "string") {
          return jsonRpcError(id, -32602, "Invalid params: expected a tool name.", {
            code: "validation-error",
          });
        }
        const toolName = call["name"] as string;
        const toolArgs = call["arguments"] ?? {};
        const outcome = await callTool(toolName, toolArgs, auth === undefined ? undefined : { apiKey: auth });
        if (!outcome.ok) {
          const failure = outcome.error;
          const code = failure.code === "unknown-tool" ? -32601 : failure.code === "internal-error" ? -32603 : -32602;
          const data: Record<string, unknown> = { code: failure.code, requestId: failure.requestId };
          if (failure.tool !== undefined) {
            data["tool"] = failure.tool;
          }
          return jsonRpcError(id, code, failure.message, data);
        }
        return jsonRpcResult(id, { content: outcome.value.content, isError: false });
      }
      default:
        return jsonRpcError(id, -32601, `Unknown method: ${JSON.stringify(method)}.`, {
          code: "unknown-tool",
          tool: method,
        });
    }
  }

  return Object.freeze({ listTools: () => allDefinitions, callTool, handleJsonRpc });
}

// Minimal stdio transport: newline-delimited JSON-RPC frames on stdin,
// one response frame per line on stdout. Notifications receive no reply.
export function serveStdio(server: McpServer): { readonly close: () => void } {
  const reader = createInterface({ input: process.stdin, terminal: false });
  let closed = false;
  reader.on("line", (line: string) => {
    if (closed || line.trim().length === 0) {
      return;
    }
    void server.handleJsonRpc(line).then((response) => {
      if (!closed && response.length > 0) {
        process.stdout.write(`${response}\n`);
      }
    }).catch(() => {
      if (!closed) {
        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error.", data: { code: "internal-error" } },
        });
        process.stdout.write(`${body}\n`);
      }
    });
  });
  return Object.freeze({
    close: () => {
      closed = true;
      reader.close();
    },
  });
}
