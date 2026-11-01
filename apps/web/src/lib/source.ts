// Verified-source client (addendum VS-B2 §A6, UI §A1). Fetches
// `/v1/source?address=`, which reports whether the token author
// published source and, when verified, the files plus the function
// line ranges. "none" (checked, nothing published) stays distinct
// from "unavailable" (could not check): the empty states read
// differently. Display text only; never in the score.
export type SourceStatus = "verified" | "none" | "unavailable";

export type SourceMatch = "full" | "partial" | null;

export type SourceFile = {
  readonly path: string;
  readonly content: string;
};

export type SourceFunction = {
  readonly selector: string;
  readonly signature: string | null;
  readonly name: string | null;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
};

export type SourcePcEntry = {
  readonly file: string;
  readonly line: number;
};

export type SourceResult = {
  readonly status: SourceStatus;
  readonly provider: string;
  readonly match: SourceMatch;
  readonly compiler: string | null;
  readonly files: readonly SourceFile[];
  readonly functions: readonly SourceFunction[];
  readonly pcToLine: Readonly<Record<string, SourcePcEntry>>;
};

export type SourceState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly result: SourceResult }
  | { readonly kind: "failed" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toSourceFile(entry: unknown): SourceFile | null {
  if (!isRecord(entry) || typeof entry["path"] !== "string" || typeof entry["content"] !== "string") {
    return null;
  }
  return { path: entry["path"], content: entry["content"] };
}

function toSourceFunction(entry: unknown): SourceFunction | null {
  if (!isRecord(entry) || typeof entry["selector"] !== "string") {
    return null;
  }
  const file = entry["file"];
  const startLine = entry["startLine"];
  const endLine = entry["endLine"];
  if (typeof file !== "string" || typeof startLine !== "number" || typeof endLine !== "number") {
    return null;
  }
  return {
    selector: entry["selector"],
    signature: typeof entry["signature"] === "string" ? entry["signature"] : null,
    name: typeof entry["name"] === "string" ? entry["name"] : null,
    file,
    startLine,
    endLine,
  };
}

function toPcToLine(entry: unknown): Readonly<Record<string, SourcePcEntry>> {
  if (!isRecord(entry)) {
    return {};
  }
  const out: Record<string, SourcePcEntry> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!isRecord(value) || typeof value["file"] !== "string" || typeof value["line"] !== "number") {
      continue;
    }
    out[key] = { file: value["file"], line: value["line"] };
  }
  return out;
}

export function toSourceResult(body: unknown): SourceResult | null {
  if (!isRecord(body)) {
    return null;
  }
  const source = body["source"];
  if (!isRecord(source)) {
    return null;
  }
  const status = source["status"];
  if (status !== "verified" && status !== "none" && status !== "unavailable") {
    return null;
  }
  const match = source["match"];
  const files = Array.isArray(source["files"])
    ? source["files"].map(toSourceFile).filter((file): file is SourceFile => file !== null)
    : [];
  const functions = Array.isArray(source["functions"])
    ? source["functions"].map(toSourceFunction).filter((fn): fn is SourceFunction => fn !== null)
    : [];
  return {
    status,
    provider: typeof source["provider"] === "string" ? source["provider"] : "unknown",
    match: match === "full" || match === "partial" ? match : null,
    compiler: typeof source["compiler"] === "string" ? source["compiler"] : null,
    files,
    functions,
    pcToLine: toPcToLine(source["pcToLine"]),
  };
}

// The 1-based lines of one verified function, clamped to the file.
export function sourceFunctionLines(file: SourceFile, fn: SourceFunction): string[] {
  const all = file.content.split("\n");
  const start = Math.max(1, Math.min(fn.startLine, all.length));
  const end = Math.max(start, Math.min(fn.endLine, all.length));
  return all.slice(start - 1, end);
}

export function findSourceFunction(result: SourceResult, selector: string): SourceFunction | null {
  const wanted = selector.toLowerCase();
  return result.functions.find((fn) => fn.selector.toLowerCase() === wanted) ?? null;
}

export function findSourceFile(result: SourceResult, path: string): SourceFile | null {
  return result.files.find((file) => file.path === path) ?? null;
}

const sourceCache = new Map<string, Promise<SourceResult>>();

export function clearSourceCache(): void {
  sourceCache.clear();
}

async function loadSource(address: string, apiKey: string | null): Promise<SourceResult> {
  const headers: Record<string, string> = {};
  if (apiKey !== null && apiKey.length > 0) {
    headers["x-api-key"] = apiKey;
  }
  const response = await fetch(`/v1/source?address=${encodeURIComponent(address)}`, { headers });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  const parsed = toSourceResult(await response.json());
  if (parsed === null) {
    throw new Error("Verified source is not available for this token.");
  }
  return parsed;
}

// One `/v1/source` request per address, shared across panes. Failures
// never poison the cache: the empty state offers Retry instead.
export function fetchSource(address: string, apiKey: string | null): Promise<SourceResult> {
  const key = address.toLowerCase();
  const cached = sourceCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending = loadSource(address, apiKey);
  sourceCache.set(key, pending);
  void pending.catch(() => {
    if (sourceCache.get(key) === pending) {
      sourceCache.delete(key);
    }
  });
  return pending;
}
