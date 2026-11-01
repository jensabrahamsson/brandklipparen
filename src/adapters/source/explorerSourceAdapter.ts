// Block explorer source adapter behind VerifiedSourcePort (VS-B2).
// Fallback verified-source origin: the explorer `getsourcecode` endpoint
// over chain id 1 through the existing explorer key (only bound when the
// key is configured; otherwise the composition root skips the fallback).
// Driven adapter with an injectable GET transport: tests replay recorded
// synthetic fixtures and never touch the network. The key travels from
// the environment only and stays server-side: it names no secret in any
// reply, error or log (K-505). An empty source answer means the explorer
// holds nothing for the address (`none`); transport trouble is
// `unavailable`, never `none`. The explorer carries no full/partial
// match notion, so a verified answer reports match null.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { SecretString } from "../../ports/config.ts";
import type {
  VerifiedSourceFetchError,
  VerifiedSourcePort,
  VerifiedSourceRaw,
  VerifiedSourceRawFile,
} from "../../ports/verifiedSource.ts";

// Allowlisted outbound host (K-503, M-07): every request target derives
// from this pinned base URL plus the validated address.
export const EXPLORER_SOURCE_HOST = "api.etherscan.io";
export const EXPLORER_SOURCE_BASE_URL = "https://api.etherscan.io/v2/api";
export const EXPLORER_SOURCE_CHAIN_ID = 1;

export type ExplorerSourceTransportResponse = {
  readonly status: number;
  readonly bodyText: string;
};

export type ExplorerSourceTransport = (url: string) => Promise<ExplorerSourceTransportResponse>;

async function fetchExplorerSourceTransport(url: string): Promise<ExplorerSourceTransportResponse> {
  const response = await fetch(url);
  return { status: response.status, bodyText: await response.text() };
}

export type ExplorerSourceAdapterOptions = {
  readonly apiKey: SecretString;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly transport?: ExplorerSourceTransport | undefined;
};

export const DEFAULT_EXPLORER_SOURCE_TIMEOUT_MS = 10000;
export const DEFAULT_EXPLORER_SOURCE_MAX_RESPONSE_BYTES = 8388608;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("explorer source base URL must be an https URL on the allowlisted host");
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== EXPLORER_SOURCE_HOST) {
    throw new Error("explorer source base URL must be an https URL on the allowlisted host");
  }
}

function noneResult(): VerifiedSourceRaw {
  return { status: "none", provider: "etherscan", match: null, compiler: null, files: [], abi: [] };
}

// Multi-file answers wrap the standard JSON input in doubled braces
// (`{{...}}`): the `sources` record holds one `{content}` per path.
function filesFromStandardJson(raw: string): VerifiedSourceRawFile[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const sources = parsed["sources"];
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

export class ExplorerSourceAdapter implements VerifiedSourcePort {
  private readonly apiKey: SecretString;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly transport: ExplorerSourceTransport;

  constructor(options: ExplorerSourceAdapterOptions) {
    const baseUrl = options.baseUrl ?? EXPLORER_SOURCE_BASE_URL;
    checkBaseUrl(baseUrl);
    this.apiKey = options.apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs =
      options.timeoutMs !== undefined && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_EXPLORER_SOURCE_TIMEOUT_MS;
    this.maxResponseBytes =
      options.maxResponseBytes !== undefined &&
      Number.isSafeInteger(options.maxResponseBytes) &&
      options.maxResponseBytes > 0
        ? options.maxResponseBytes
        : DEFAULT_EXPLORER_SOURCE_MAX_RESPONSE_BYTES;
    this.transport = options.transport ?? fetchExplorerSourceTransport;
  }

  async fetchVerifiedSource(address: string): Promise<Result<VerifiedSourceRaw, VerifiedSourceFetchError>> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
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
      `${this.baseUrl}?chainid=${EXPLORER_SOURCE_CHAIN_ID}&module=contract&action=getsourcecode` +
      `&address=${address}&apikey=${encodeURIComponent(this.apiKey.reveal())}`;
    let response: ExplorerSourceTransportResponse;
    try {
      response = await this.withTimeout(url);
    } catch {
      return err({ kind: "unavailable", message: "the explorer source origin is unavailable" });
    }
    if (response.bodyText.length > this.maxResponseBytes) {
      return err({ kind: "invalid-response", message: "the explorer source reply exceeds the size limit" });
    }
    if (response.status === 429) {
      return err({ kind: "unavailable", message: "the explorer source origin is unavailable" });
    }
    if (response.status < 200 || response.status >= 300) {
      return err({ kind: "unavailable", message: "the explorer source origin is unavailable" });
    }
    let body: unknown;
    try {
      body = JSON.parse(response.bodyText) as unknown;
    } catch {
      return err({ kind: "invalid-response", message: "the explorer source origin gave a non-JSON reply" });
    }
    if (!isRecord(body) || !Array.isArray(body["result"]) || body["result"].length === 0) {
      return err({ kind: "invalid-response", message: "the explorer source origin gave a malformed reply" });
    }
    const first = (body["result"] as unknown[])[0];
    if (!isRecord(first)) {
      return err({ kind: "invalid-response", message: "the explorer source origin gave a malformed reply" });
    }
    const sourceCode = typeof first["SourceCode"] === "string" ? (first["SourceCode"] as string) : "";
    if (sourceCode === "") {
      return ok(noneResult());
    }
    const abiText = typeof first["ABI"] === "string" ? (first["ABI"] as string) : "";
    let abi: readonly unknown[] = [];
    if (abiText !== "" && !/not verified/i.test(abiText)) {
      try {
        const parsedAbi = JSON.parse(abiText) as unknown;
        if (!Array.isArray(parsedAbi)) {
          return err({ kind: "invalid-response", message: "the explorer source origin gave an ABI in an unknown shape" });
        }
        abi = parsedAbi;
      } catch {
        return err({ kind: "invalid-response", message: "the explorer source origin gave an ABI in an unknown shape" });
      }
    }
    let files: VerifiedSourceRawFile[] | null = null;
    if (sourceCode.startsWith("{{")) {
      files = filesFromStandardJson(sourceCode.slice(1, -1));
    }
    if (files === null) {
      const contractName = typeof first["ContractName"] === "string" && first["ContractName"] !== ""
        ? (first["ContractName"] as string).replace(/[^A-Za-z0-9_]/g, "")
        : "Contract";
      const name = contractName === "" ? "Contract" : contractName;
      files = [{ path: `${name}.sol`, content: sourceCode }];
    }
    if (files.length === 0) {
      return ok(noneResult());
    }
    const compiler = typeof first["CompilerVersion"] === "string" && first["CompilerVersion"] !== ""
      ? (first["CompilerVersion"] as string)
      : null;
    const raw: VerifiedSourceRaw = {
      status: "verified",
      provider: "etherscan",
      match: null,
      compiler,
      files,
      abi,
    };
    return ok(raw);
  }

  private async withTimeout(url: string): Promise<ExplorerSourceTransportResponse> {
    const pending = this.transport(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const onTimeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("explorer source fetch timed out")), this.timeoutMs);
      });
      return await Promise.race([pending, onTimeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
