// Uniform error format for the MCP driving adapter (S-028, K-025, K-508).
// Every tool failure is a machine-readable value: a code, a readable
// message in English and the request ID. Messages are fixed generic texts:
// port errors and validation details never cross the boundary, so responses
// and logs carry no internals and no secrets (M-16). A call to an unknown
// tool carries the tool name in the response (K-025, M-15). Each application
// error branch maps explicitly here; a new branch in ApplicationError gives
// a type error at toMcpError until handled.
import type { ApplicationError } from "../../application/analyzeToken.ts";

export type McpErrorCode =
  | "missing-api-key"
  | "invalid-api-key"
  | "key-in-url-or-body"
  | "validation-error"
  | "request-too-large"
  | "unknown-tool"
  | "assessment-not-configured"
  | "investigation-not-configured"
  | "onchain-not-configured"
  | "rate-limited"
  | "upstream-unavailable"
  | "service-unavailable"
  | "internal-error";

export type McpToolError = {
  readonly code: McpErrorCode;
  readonly message: string;
  readonly requestId: string;
  readonly tool?: string | undefined;
};

export function mcpError(
  code: McpErrorCode,
  message: string,
  requestId: string,
  tool?: string | undefined,
): McpToolError {
  return tool === undefined ? { code, message, requestId } : { code, message, requestId, tool };
}

export function missingApiKey(requestId: string): McpToolError {
  return mcpError(
    "missing-api-key",
    "Missing API key: pass a key alongside the tool call.",
    requestId,
  );
}

export function invalidApiKey(requestId: string): McpToolError {
  return mcpError("invalid-api-key", "Invalid API key.", requestId);
}

export function keyInToolArgs(requestId: string): McpToolError {
  return mcpError(
    "key-in-url-or-body",
    "API keys travel outside the tool arguments, never inside them.",
    requestId,
  );
}

export function validationError(detail: string, requestId: string): McpToolError {
  return mcpError("validation-error", detail, requestId);
}

export function requestTooLarge(requestId: string): McpToolError {
  return mcpError("request-too-large", "Request exceeds the input size limit.", requestId);
}

export function rateLimited(retryAfterSec: number, requestId: string): McpToolError {
  return mcpError(
    "rate-limited",
    `Rate limit exceeded; retry after ${retryAfterSec} seconds with the same request ID.`,
    requestId,
  );
}

export function unknownTool(name: string, requestId: string): McpToolError {
  return mcpError(
    "unknown-tool",
    `Unknown tool: ${JSON.stringify(name)}. The tool list is closed; see tools/list.`,
    requestId,
    name,
  );
}

export function assessmentNotConfigured(requestId: string): McpToolError {
  return mcpError(
    "assessment-not-configured",
    "Assessment is not configured: set an assessment provider to enable it.",
    requestId,
  );
}

export function investigationNotConfigured(requestId: string): McpToolError {
  return mcpError(
    "investigation-not-configured",
    "Investigation is not configured: set the investigation provider key to enable it.",
    requestId,
  );
}

export function onchainNotConfigured(requestId: string): McpToolError {
  return mcpError(
    "onchain-not-configured",
    "On-chain features are not configured: bind a chain port to enable them.",
    requestId,
  );
}

// Translation of the shared service outcome to the MCP error format. The
// port error contents stay on the server side: callers see a generic
// message plus their request ID for correlation.
export function toMcpError(error: ApplicationError): Omit<McpToolError, "requestId"> {
  switch (error.kind) {
    case "rpc-error":
      return {
        code: "upstream-unavailable",
        message: "Upstream data source unavailable; retry with the same request ID.",
      };
    case "model-artifact-error":
      return {
        code: "service-unavailable",
        message: "Analysis service unavailable; retry with the same request ID.",
      };
    case "domain-error":
      return {
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
      };
  }
}
