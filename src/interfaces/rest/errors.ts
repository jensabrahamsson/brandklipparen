// Uniform error format for the REST driving adapter (S-027, K-023, A-18).
// Every error response carries an HTTP status, a machine-readable code, a
// readable message in English and the request ID. Messages are fixed
// generic texts: port errors and validation details never cross the
// boundary, so responses and logs carry no internals and no secrets
// (M-16). Each application error branch maps explicitly here; a new branch
// in ApplicationError gives a type error at toHttpError until handled.
import type { ApplicationError } from "../../application/analyzeToken.ts";

export type HttpErrorCode =
  | "missing-api-key"
  | "invalid-api-key"
  | "key-in-url-or-body"
  | "validation-error"
  | "request-too-large"
  | "not-found"
  | "assessment-not-configured"
  | "upstream-unavailable"
  | "service-unavailable"
  | "internal-error";

export type HttpErrorBody = {
  readonly status: number;
  readonly code: HttpErrorCode;
  readonly message: string;
  readonly requestId: string;
};

export type HttpError = {
  readonly status: number;
  readonly body: HttpErrorBody;
};

export function requestError(
  status: number,
  code: HttpErrorCode,
  message: string,
  requestId: string,
): HttpError {
  return { status, body: { status, code, message, requestId } };
}

export function missingApiKey(requestId: string): HttpError {
  return requestError(401, "missing-api-key", "Missing API key: pass a key in the x-api-key header.", requestId);
}

export function invalidApiKey(requestId: string): HttpError {
  return requestError(401, "invalid-api-key", "Invalid API key.", requestId);
}

export function keyInUrlOrBody(requestId: string): HttpError {
  return requestError(
    401,
    "key-in-url-or-body",
    "API keys travel solely in the x-api-key header, never in the URL or body.",
    requestId,
  );
}

export function validationError(detail: string, requestId: string): HttpError {
  return requestError(400, "validation-error", detail, requestId);
}

export function requestTooLarge(requestId: string): HttpError {
  return requestError(413, "request-too-large", "Request exceeds the input size limit.", requestId);
}

export function notFound(requestId: string): HttpError {
  return requestError(404, "not-found", "Unknown path: breaking changes receive a new major version.", requestId);
}

export function assessmentNotConfigured(requestId: string): HttpError {
  return requestError(
    501,
    "assessment-not-configured",
    "Assessment is not configured: set an assessment provider to enable it.",
    requestId,
  );
}

// Translation of the shared service outcome to the HTTP error format. The
// port error contents stay on the server side: callers see a generic
// message plus their request ID for correlation.
export function toHttpError(error: ApplicationError): Omit<HttpError, "body"> & { code: HttpErrorCode; message: string } {
  switch (error.kind) {
    case "rpc-error":
      return {
        status: 502,
        code: "upstream-unavailable",
        message: "Upstream data source unavailable; retry with the same request ID.",
      };
    case "model-artifact-error":
      return {
        status: 500,
        code: "service-unavailable",
        message: "Analysis service unavailable; retry with the same request ID.",
      };
    case "domain-error":
      return {
        status: 500,
        code: "internal-error",
        message: "Analysis failed; retry with the same request ID.",
      };
  }
}
