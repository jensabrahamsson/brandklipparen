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
import type { AppServices } from "../../application/analyzeToken.ts";
import { serializeTokenAssessment } from "../../application/assessmentService.ts";
import type { AssessmentService } from "../../application/assessmentService.ts";
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import { canonicalSerialize } from "../../domain/serialize.ts";
import { RequestId, Timestamp } from "../../domain/types.ts";
import type { IndexVersion, ModelVersion, TemplateVersion } from "../../domain/types.ts";
import type { CapabilityCatalogue } from "../../domain/signals.ts";
import type { SecretString } from "../../ports/config.ts";
import { createApiKeyStore } from "../rest/apiKeys.ts";
import type { ApiKeyStore } from "../rest/apiKeys.ts";
import {
  assessmentNotConfigured,
  invalidApiKey,
  keyInToolArgs,
  missingApiKey,
  requestTooLarge,
  toMcpError,
  unknownTool,
  validationError,
} from "./errors.ts";
import type { McpToolError } from "./errors.ts";
import {
  ASSESS_TOKEN_TOOL,
  REQUEST_ASSESSMENT_TOOL,
  TOOL_DEFINITIONS,
  TOOL_LIST_VERSION,
  findTool,
  parseAssessTokenInput,
  parseRequestAssessmentInput,
} from "./tools.ts";
import type { AssessTokenInput, ToolDefinition } from "./tools.ts";

export const MCP_SERVER_NAME = "brandklipparen-mcp";
export const MCP_SERVER_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSION = "1.0";

const DEFAULT_ANALYZE_TIMEOUT_MS = 30000;
const DEFAULT_MAX_MESSAGE_BYTES = 8192;

export type McpServerOptions = {
  readonly services: AppServices;
  readonly apiKeys?: readonly SecretString[] | undefined;
  readonly apiKeyPepper?: SecretString | undefined;
  readonly modelVersion: ModelVersion;
  readonly indexVersion: IndexVersion;
  readonly templateVersion: TemplateVersion;
  readonly catalogue: CapabilityCatalogue;
  readonly analyzeTimeoutMs?: number | undefined;
  readonly maxMessageBytes?: number | undefined;
  // Absent service means the assessment feature is disabled through
  // configuration (K-309): request_assessment answers assessment-not-configured.
  readonly assessmentService?: AssessmentService | undefined;
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
  const keyGate = (options.apiKeys ?? []).length > 0;
  const analyzeTimeoutMs = options.analyzeTimeoutMs ?? DEFAULT_ANALYZE_TIMEOUT_MS;
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

  // Shared tool gate (A-11, A-16, K-026): API key, message size and the
  // published input schema. Both reading tools reuse the same gate, so
  // assess_token and request_assessment face identical limits. The stable
  // key id names the caller to the cost meter without exposing the key.
  function gateToolArgs(
    args: unknown,
    parse: (raw: unknown) => { readonly kind: string; readonly message?: string } | { readonly input: AssessTokenInput },
    requestId: RequestId,
    callOptions: CallToolOptions | undefined,
  ): Result<{ readonly input: AssessTokenInput; readonly apiKeyId: string }, McpToolError> {
    let apiKeyId = "anonymous";
    if (keyGate) {
      const candidate = callOptions?.apiKey;
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
      return err(validationError("Invalid arguments: expected an object with address and block.", requestId as string));
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
          return err(validationError("Invalid arguments: expected an object with address and block.", requestId as string));
      }
    }
    return ok({ input: parsed.input, apiKeyId });
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
    if (findTool(name) === null) {
      return err(unknownTool(name, requestId as string));
    }
    if (name === ASSESS_TOKEN_TOOL) {
      return runAssessToken(args, requestId, callOptions);
    }
    if (name === REQUEST_ASSESSMENT_TOOL) {
      return runRequestAssessment(args, requestId, callOptions);
    }
    return err(unknownTool(name, requestId as string));
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
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        });
      case "ping":
        return jsonRpcResult(id, {});
      case "tools/list":
        return jsonRpcResult(id, { tools: TOOL_DEFINITIONS, toolListVersion: TOOL_LIST_VERSION });
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
          const code = failure.code === "unknown-tool" ? -32601 : -32602;
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

  return Object.freeze({ listTools: () => TOOL_DEFINITIONS, callTool, handleJsonRpc });
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
    });
  });
  return Object.freeze({
    close: () => {
      closed = true;
      reader.close();
    },
  });
}
