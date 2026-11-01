// Open source-verification API adapter behind VerifiedSourcePort (VS-B2).
// Primary verified-source origin: the v2 contract endpoint with
// fields=sources,abi,compilation over chain id 1, reporting a full
// or partial match. Driven adapter with an injectable GET transport:
// tests replay recorded synthetic fixtures and never touch the network.
// Every request target derives from the pinned base URL plus the
// validated address; a configured override must resolve to the same
// host, and each call re-checks the host before any transport runs, so
// crafted input can never steer a request off the allowlisted host
// (K-503, M-07). A 404 means the provider holds nothing for the address
// (`none`); transport trouble is `unavailable`, never `none`.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type {
  VerifiedSourceFetchError,
  VerifiedSourceMatch,
  VerifiedSourcePort,
  VerifiedSourceRaw,
  VerifiedSourceRawFile,
} from "../../ports/verifiedSource.ts";
import { safeFetchText } from "../http/safeFetch.ts";

// Allowlisted outbound host (K-503, M-07): every request target derives
// from this pinned base URL plus the validated address.
export const SOURCIFY_HOST = "sourcify.dev";
export const SOURCIFY_BASE_URL = "https://sourcify.dev/server";
export const SOURCIFY_CHAIN_ID = 1;

export type SourcifyTransportResponse = {
  readonly status: number;
  readonly bodyText: string;
};

export type SourcifyTransport = (url: string) => Promise<SourcifyTransportResponse>;

async function fetchSourcifyTransport(url: string): Promise<SourcifyTransportResponse> {
  return safeFetchText(url, {
    timeoutMs: DEFAULT_SOURCIFY_TIMEOUT_MS,
    maxBytes: DEFAULT_SOURCIFY_MAX_RESPONSE_BYTES,
  });
}

export type SourcifySourceAdapterOptions = {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly transport?: SourcifyTransport | undefined;
};

export const DEFAULT_SOURCIFY_TIMEOUT_MS = 10000;
export const DEFAULT_SOURCIFY_MAX_RESPONSE_BYTES = 8388608;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("source base URL must be an https URL on the allowlisted host");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== SOURCIFY_HOST) {
    throw new Error("source base URL must be an https URL on the allowlisted host");
  }
}

function checkAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

// Registry match words (VS-B2 follow-up 2): the open registry answers
// `match` / `runtimeMatch` with values such as "match" or
// "exact_match". "exact_match" is a full match, "match" is partial;
// the legacy "full" / "partial" words are accepted as-is.
export function mapRegistryMatch(value: unknown): VerifiedSourceMatch | null {
  if (typeof value !== "string") {
    return null;
  }
  const word = value.toLowerCase();
  if (word === "full" || word === "exact_match") {
    return "full";
  }
  if (word === "partial" || word === "match") {
    return "partial";
  }
  return null;
}

function readMatch(body: Record<string, unknown>): VerifiedSourceMatch | null {
  for (const key of ["match", "runtimeMatch"] as const) {
    const mapped = mapRegistryMatch(body[key]);
    if (mapped !== null) {
      return mapped;
    }
  }
  return null;
}

function readCompiler(body: Record<string, unknown>): string | null {
  const compilation = body["compilation"];
  if (isRecord(compilation) && typeof compilation["compilerVersion"] === "string") {
    return compilation["compilerVersion"] as string;
  }
  if (typeof body["compilerVersion"] === "string") {
    return body["compilerVersion"] as string;
  }
  return null;
}

function readFiles(body: Record<string, unknown>): VerifiedSourceRawFile[] | null {
  const sources = body["sources"];
  if (sources === undefined) {
    return [];
  }
  if (!isRecord(sources)) {
    return null;
  }
  const files: VerifiedSourceRawFile[] = [];
  for (const [path, entry] of Object.entries(sources)) {
    if (typeof path !== "string" || path.length === 0 || path.length > 512) {
      continue;
    }
    if (isRecord(entry) && typeof entry["content"] === "string") {
      files.push({ path, content: entry["content"] as string });
    }
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

function readAbi(body: Record<string, unknown>): readonly unknown[] | null {
  const abi = body["abi"];
  if (abi === undefined) {
    return [];
  }
  if (!Array.isArray(abi)) {
    return null;
  }
  return abi;
}

export class SourcifySourceAdapter implements VerifiedSourcePort {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly transport: SourcifyTransport;

  constructor(options: SourcifySourceAdapterOptions = {}) {
    const baseUrl = options.baseUrl ?? SOURCIFY_BASE_URL;
    checkBaseUrl(baseUrl);
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs =
      options.timeoutMs !== undefined && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_SOURCIFY_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes !== undefined &&
      Number.isSafeInteger(options.maxResponseBytes) &&
      options.maxResponseBytes > 0
        ? options.maxResponseBytes
        : DEFAULT_SOURCIFY_MAX_RESPONSE_BYTES;
    this.transport = options.transport ?? fetchSourcifyTransport;
  }

  async fetchVerifiedSource(address: string): Promise<Result<VerifiedSourceRaw, VerifiedSourceFetchError>> {
    if (!checkAddress(address)) {
      return err({ kind: "invalid-response", message: "the source request carries a malformed address" });
    }
    let hostOk = false;
    try {
      checkBaseUrl(this.baseUrl);
      hostOk = true;
    } catch {
      hostOk = false;
    }
    if (!hostOk) {
      return err({ kind: "invalid-response", message: "the source base URL leaves the allowlisted host" });
    }
    const url =
      `${this.baseUrl}/v2/contract/${SOURCIFY_CHAIN_ID}/${address}` +
      `?fields=${encodeURIComponent("sources,abi,compilation")}`;
    let response: SourcifyTransportResponse;
    try {
      response = await this.withTimeout(url);
    } catch {
      return err({ kind: "unavailable", message: "the verified-source origin is unavailable" });
    }
    if (response.bodyText.length > this.maxResponseBytes) {
      return err({ kind: "invalid-response", message: "the verified-source reply exceeds the size limit" });
    }
    if (response.status === 404) {
      return ok({ status: "none", provider: "sourcify", match: null, compiler: null, files: [], abi: [] });
    }
    if (response.status < 200 || response.status >= 300) {
      return err({ kind: "unavailable", message: "the verified-source origin is unavailable" });
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bodyText) as unknown;
    } catch {
      return err({ kind: "invalid-response", message: "the verified-source origin gave a non-JSON reply" });
    }
    if (!isRecord(body)) {
      return err({ kind: "invalid-response", message: "the verified-source origin gave a malformed reply" });
    }
    const files = readFiles(body);
    if (files === null) {
      return err({ kind: "invalid-response", message: "the verified-source origin gave files in an unknown shape" });
    }
    const abi = readAbi(body);
    if (abi === null) {
      return err({ kind: "invalid-response", message: "the verified-source origin gave an ABI in an unknown shape" });
    }
    if (files.length === 0) {
      return ok({ status: "none", provider: "sourcify", match: null, compiler: null, files: [], abi: [] });
    }
    const raw: VerifiedSourceRaw = {
      status: "verified",
      provider: "sourcify",
      match: readMatch(body),
      compiler: readCompiler(body),
      files,
      abi,
    };
    return ok(raw);
  }

  private async withTimeout(url: string): Promise<SourcifyTransportResponse> {
    const pending = this.transport(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const onTimeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("verified-source fetch timed out")), this.timeoutMs);
      });
      return await Promise.race([pending, onTimeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

// Binds the primary adapter. The open origin needs no key, so this
// factory never answers not-configured: disabling happens through the
// provider selection in the composition root.
export function createSourcifySourceAdapter(
  options: SourcifySourceAdapterOptions = {},
): SourcifySourceAdapter {
  return new SourcifySourceAdapter(options);
}
