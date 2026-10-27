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
import type { AppServices } from "../../application/analyzeToken.ts";
import { Address, BlockNumber, RequestId, Timestamp } from "../../domain/types.ts";
import type {
  BlockNumber as BlockNumberType,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
} from "../../domain/types.ts";
import type { CapabilityCatalogue } from "../../domain/signals.ts";
import { canonicalSerialize } from "../../domain/serialize.ts";
import { createApiKeyStore } from "./apiKeys.ts";
import type { ApiKeyStore } from "./apiKeys.ts";
import type { SecretString } from "../../ports/config.ts";
import {
  invalidApiKey,
  keyInUrlOrBody,
  missingApiKey,
  notFound,
  requestError,
  requestTooLarge,
  toHttpError,
  validationError,
} from "./errors.ts";
import type { HttpError } from "./errors.ts";

export const API_VERSION = "v1";
export const API_KEY_HEADER = "x-api-key";
export const REQUEST_ID_HEADER = "x-request-id";
export const DEEPENING_STATUS_HEADER = "x-deepening-status";

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
  readonly analyzeTimeoutMs?: number | undefined;
  readonly maxQueryChars?: number | undefined;
  readonly maxBodyBytes?: number | undefined;
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
  return reply
    .code(error.status)
    .header(REQUEST_ID_HEADER, error.body.requestId)
    .type("application/json")
    .send(JSON.stringify(error.body));
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

  app.get("/health", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    void request;
    const requestId = issueRequestId();
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .type("application/json")
      .send(JSON.stringify({ status: "ok", apiVersion: API_VERSION }));
  });

  async function handleAnalyze(request: FastifyRequest, reply: FastifyReply, rawInput: unknown): Promise<FastifyReply> {
    const requestId = issueRequestId();
    if ((request.raw.url ?? "").length > maxQueryChars) {
      return sendError(reply, requestTooLarge(requestId));
    }
    if (hasSecretLikeKey(request.query) || hasSecretLikeKey(rawInput)) {
      return sendError(reply, keyInUrlOrBody(requestId));
    }
    const headerKey = request.headers[API_KEY_HEADER];
    if (headerKey === undefined) {
      return sendError(reply, missingApiKey(requestId));
    }
    if (typeof headerKey !== "string" || !store.verify(headerKey)) {
      return sendError(reply, invalidApiKey(requestId));
    }
    const parsedInput = parseAnalyzeInput(rawInput);
    if (parsedInput === null) {
      return sendError(
        reply,
        validationError("Invalid address: expected 0x followed by 40 hex characters.", requestId),
      );
    }
    const address = Address.parse(parsedInput.address);
    if (!address.ok) {
      return sendError(
        reply,
        validationError("Invalid address: expected 0x followed by 40 hex characters.", requestId),
      );
    }
    const block = parseBlock(parsedInput.block);
    if (!block.ok) {
      return sendError(
        reply,
        validationError("Invalid block: expected latest or a non-negative integer.", requestId),
      );
    }
    const deadline = Timestamp.of(Date.now() + analyzeTimeoutMs);
    if (!deadline.ok) {
      return sendError(reply, requestError(500, "internal-error", "Analysis failed; retry with the same request ID.", requestId));
    }
    const analysed = await options.services.analyzeToken({
      address: address.value,
      block: block.value,
      requestId,
      deadline: deadline.value,
      modelVersion: options.modelVersion,
      indexVersion: options.indexVersion,
      templateVersion: options.templateVersion,
      catalogue: options.catalogue,
    });
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
      return reply
        .code(200)
        .header(REQUEST_ID_HEADER, requestId)
        .header(DEEPENING_STATUS_HEADER, "pending")
        .type("application/json")
        .send(body);
    }
    return reply
      .code(200)
      .header(REQUEST_ID_HEADER, requestId)
      .header(DEEPENING_STATUS_HEADER, "pending")
      .type("application/json")
      .send(serializeAssessment(analysed.value.envelope));
  }

  app.get("/v1/analyze", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleAnalyze(request, reply, request.query);
  });

  app.post("/v1/analyze", async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    return handleAnalyze(request, reply, request.body);
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
