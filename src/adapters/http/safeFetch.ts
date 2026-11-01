// Bounded HTTP fetch for driven adapters (C-24, F-28).
// Every production transport in the market, source, feed and RPC adapters
// funnels through `safeFetchText`, so a hostile upstream cannot steer the
// process off-protocol, drag it through redirects, hang it on a stalled
// body, or exhaust memory with an unbounded reply. Redirects are refused
// (`redirect: "error"`), the timeout covers headers and body alike, and the
// body streams through a byte cap instead of buffering whole. Adapters keep
// their own timeout races and post-hoc size checks as a second guard for
// injected transports; those never reach this module.
export type SafeFetchErrorKind = "protocol" | "redirect" | "too-large" | "timeout" | "network";

export class SafeFetchError extends Error {
  readonly kind: SafeFetchErrorKind;
  constructor(kind: SafeFetchErrorKind, message?: string) {
    super(message ?? `safe fetch failed: ${kind}`);
    this.name = "SafeFetchError";
    this.kind = kind;
  }
}

export type SafeFetchOptions = {
  readonly method?: "GET" | "POST" | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal | undefined;
  readonly allowedProtocols?: readonly string[] | undefined;
};

export type SafeFetchResponse = {
  readonly status: number;
  readonly bodyText: string;
};

const DEFAULT_ALLOWED_PROTOCOLS: readonly string[] = ["https:"];

// Strict digits only: a folded or suffixed value ("100, 100", "100MB")
// carries no trustworthy length, so the streamed cap decides instead.
function parseContentLength(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    return null;
  }
  const length = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(length) ? length : null;
}

function isAborted(timeoutSignal: AbortSignal, outer: AbortSignal | undefined): boolean {
  return timeoutSignal.aborted || (outer !== undefined && outer.aborted);
}

export async function safeFetchText(url: string, options: SafeFetchOptions): Promise<SafeFetchResponse> {
  const timeoutMs = options.timeoutMs;
  const maxBytes = options.maxBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("safeFetchText requires a positive integer timeoutMs");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("safeFetchText requires a positive integer maxBytes");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafeFetchError("protocol", "safe fetch refuses an unparsable URL");
  }
  const allowed = options.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;
  if (!allowed.includes(parsed.protocol)) {
    throw new SafeFetchError("protocol", `safe fetch refuses protocol ${parsed.protocol}`);
  }
  const outer = options.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = outer === undefined ? timeoutSignal : AbortSignal.any([timeoutSignal, outer]);
  const init: RequestInit = { method: options.method ?? "GET", redirect: "error", signal };
  if (options.headers !== undefined) {
    init.headers = { ...options.headers };
  }
  if (options.body !== undefined) {
    init.body = options.body;
  }
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    if (isAborted(timeoutSignal, outer)) {
      throw new SafeFetchError("timeout", "safe fetch timed out");
    }
    // With `redirect: "error"` a 3xx rejects here as a generic TypeError
    // that carries no structural redirect marker, so it shares the
    // network kind. The guarantee the caller relies on is that the
    // redirect target is never fetched, not the kind spelling.
    throw new SafeFetchError("network", "safe fetch could not complete the request");
  }
  const declared = parseContentLength(response.headers.get("content-length"));
  if (declared !== null && declared > maxBytes) {
    if (response.body !== null) {
      try {
        await response.body.cancel();
      } catch {
        // The body is already gone; the refusal stands either way.
      }
    }
    throw new SafeFetchError("too-large", "safe fetch refuses a body over the byte cap");
  }
  const stream = response.body;
  if (stream === null) {
    return { status: response.status, bodyText: "" };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        if (isAborted(timeoutSignal, outer)) {
          throw new SafeFetchError("timeout", "safe fetch timed out while reading the body");
        }
        throw new SafeFetchError("network", "safe fetch could not read the body");
      }
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The stream is already torn down; the refusal stands either way.
        }
        throw new SafeFetchError("too-large", "safe fetch aborts a body over the byte cap");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: response.status, bodyText: new TextDecoder().decode(merged) };
}
