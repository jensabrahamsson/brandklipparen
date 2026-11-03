// Pure view model for the decompiler function list (UI v2 §5.4).
// Display only: ordering, summary, filter and sentences over the frozen
// decompiler payloads. Scores, signals and evidence are untouched.
export type DecompilerStatus = "complete" | "partly-read" | "error";

export type DecompilerFunction = {
  readonly selector: string;
  readonly name: string | null;
  readonly signature: string | null;
  readonly entryPc: number | null;
  readonly startPc: number | null;
  readonly endPc: number | null;
  readonly annotations: readonly string[];
  readonly cause: string | null;
  readonly unresolvedJumps: number;
  // Owner-only writes (UI v2 §5.4 order rule): the guarded-state-update
  // annotation from the pipeline.
  readonly ownerOnly: boolean;
  // Named means a non-empty signature; anything else renders Unnamed.
  readonly named: boolean;
  readonly status: DecompilerStatus;
  // Row-1 name: signature when known, else the short name, else
  // "Unnamed 0x…". Never markup.
  readonly displayName: string;
};

export type DecompilerSegment = "all" | "owner-only" | "named";

const SELECTOR = /^0x[0-9a-fA-F]{8}$/;
const OWNER_ONLY_ANNOTATION = "token-pattern: guarded-state-update";
const DEFAULT_NAME = /^function_[0-9a-fA-F]{8}$/;

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function cleanNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function cleanAnnotations(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      out.push(entry);
    }
  }
  return Object.freeze(out);
}

// Cause mapping (UI v2 §5.4, R3 D-8): a null cause reads as complete;
// any recorded cause reads as partly read. `unexpected-control-flow`
// means jumps were not followed; `no-plain-return` only means the body
// has no plain return value (typical of old code such as USDT), and any
// unknown cause is a coverage gap, never a failure. "error" is reserved
// for detector outcome failures, which carry no rows at all. The raw
// string never leaves the Expert raw list.
export function decompilerStatusOf(cause: string | null): DecompilerStatus {
  if (cause === null) {
    return "complete";
  }
  return "partly-read";
}

export function decompilerStatusWord(status: DecompilerStatus): string {
  if (status === "partly-read") {
    return "partly read";
  }
  if (status === "error") {
    return "error";
  }
  return "fully read";
}

// One parsed row per decompiler payload. Null when the payload carries
// no valid selector: a row without a selector cannot link anywhere.
export function parseDecompilerFunction(payload: unknown): DecompilerFunction | null {
  const record = recordOf(payload);
  if (record === null) {
    return null;
  }
  const selector = cleanText(record["selector"]);
  if (selector === null || !SELECTOR.test(selector)) {
    return null;
  }
  const name = cleanText(record["name"]);
  const signature = cleanText(record["signature"]);
  const cause = cleanText(record["cause"]);
  const annotations = cleanAnnotations(record["annotations"]);
  const unresolved = cleanNumber(record["unresolvedJumps"]) ?? 0;
  const ownerOnly = annotations.includes(OWNER_ONLY_ANNOTATION);
  const named = signature !== null;
  const displayName =
    signature ?? (name !== null && !DEFAULT_NAME.test(name) ? name : selector);
  return {
    selector,
    name,
    signature,
    entryPc: cleanNumber(record["entryPc"]),
    startPc: cleanNumber(record["startPc"]),
    endPc: cleanNumber(record["endPc"]),
    annotations,
    cause,
    unresolvedJumps: unresolved,
    ownerOnly,
    named,
    status: decompilerStatusOf(cause),
    displayName,
  };
}

export function parseDecompilerFunctions(payloads: readonly unknown[]): readonly DecompilerFunction[] {
  const out: DecompilerFunction[] = [];
  for (const payload of payloads) {
    const fn = parseDecompilerFunction(payload);
    if (fn !== null) {
      out.push(fn);
    }
  }
  return Object.freeze(out);
}

// Order (UI v2 §5.4): owner-only writes first, then named functions in
// selector order, then unnamed functions in selector order.
export function sortDecompilerFunctions(
  functions: readonly DecompilerFunction[],
): readonly DecompilerFunction[] {
  return Object.freeze(
    [...functions].sort((left, right) => {
      if (left.ownerOnly !== right.ownerOnly) {
        return left.ownerOnly ? -1 : 1;
      }
      if (left.named !== right.named) {
        return left.named ? -1 : 1;
      }
      if (left.selector < right.selector) {
        return -1;
      }
      if (left.selector > right.selector) {
        return 1;
      }
      return 0;
    }),
  );
}

export type DecompilerSummary = {
  readonly total: number;
  readonly named: number;
  readonly partlyRead: number;
  // The contract-level jump total: every payload repeats the same
  // decompilation count, so the max (not the sum) is the honest number.
  readonly jumps: number;
};

export function summarizeDecompilerFunctions(
  functions: readonly DecompilerFunction[],
): DecompilerSummary {
  let named = 0;
  let partlyRead = 0;
  let jumps = 0;
  for (const fn of functions) {
    if (fn.named) {
      named += 1;
    }
    if (fn.status === "partly-read") {
      partlyRead += 1;
    }
    if (fn.unresolvedJumps > jumps) {
      jumps = fn.unresolvedJumps;
    }
  }
  return { total: functions.length, named, partlyRead, jumps };
}

// Summary line (UI v2 §5.4): "32 functions · 15 named · 32 partly read
// (55 jumps not followed)". Sentence case, no raw cause.
export function decompilerSummaryLine(summary: DecompilerSummary): string {
  const functionWord = summary.total === 1 ? "function" : "functions";
  const head = `${summary.total} ${functionWord} · ${summary.named} named`;
  if (summary.partlyRead === 0) {
    return `${head} · fully read`;
  }
  const jumpWord = summary.jumps === 1 ? "jump" : "jumps";
  return `${head} · ${summary.partlyRead} partly read (${summary.jumps} ${jumpWord} not followed)`;
}

// Thousands grouped with a plain space, as in the spec example.
function groupThousands(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function hexOf(pc: number | null): string {
  return pc === null ? "unknown" : `0x${pc.toString(16)}`;
}

// Expanded-body sentence (UI v2 §5.4): "Starts at 0x19b ·
// 2 646 bytes · partly read: 55 jumps were not followed."
// Bytes are endPc − startPc. No raw cause outside Expert.
export function decompilerFunctionSentence(fn: DecompilerFunction): string {
  const bytes = fn.startPc !== null && fn.endPc !== null && fn.endPc >= fn.startPc ? fn.endPc - fn.startPc : null;
  const size = bytes === null ? "unknown size" : `${groupThousands(bytes)} bytes`;
  const head = `${hexOf(fn.startPc)} · ${size}`;
  if (fn.status === "partly-read") {
    if (fn.cause === "no-plain-return") {
      return `${head} · partly read: no plain return value.`;
    }
    const jumpWord = fn.unresolvedJumps === 1 ? "jump was" : "jumps were";
    return `${head} · partly read: ${fn.unresolvedJumps} ${jumpWord} not followed.`;
  }
  if (fn.status === "error") {
    return `${head} · could not be fully read.`;
  }
  return `${head} · fully read.`;
}

// Unknown annotations render as neutral chips in sentence case; the
// owner-only annotation has its own tag and never renders as a chip.
export function annotationChipText(annotation: string): string | null {
  if (annotation === OWNER_ONLY_ANNOTATION) {
    return null;
  }
  const words = annotation.replace(/[_-]+/g, " ").replace(/[:]+/g, ": ").replace(/\s+/g, " ").trim().toLowerCase();
  if (words.length === 0) {
    return null;
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Filter row (UI v2 §5.4): text matches name, signature or selector;
// the segmented control narrows to owner-only or named rows.
export function filterDecompilerFunctions(
  functions: readonly DecompilerFunction[],
  query: string,
  segment: DecompilerSegment,
): readonly DecompilerFunction[] {
  const needle = query.trim().toLowerCase();
  return Object.freeze(
    functions.filter((fn) => {
      if (segment === "owner-only" && !fn.ownerOnly) {
        return false;
      }
      if (segment === "named" && !fn.named) {
        return false;
      }
      if (needle.length === 0) {
        return true;
      }
      return (
        fn.selector.toLowerCase().includes(needle) ||
        (fn.name !== null && fn.name.toLowerCase().includes(needle)) ||
        (fn.signature !== null && fn.signature.toLowerCase().includes(needle))
      );
    }),
  );
}

// Live count for the filter row: "12 of 32".
export function decompilerCountLine(visible: number, total: number): string {
  return `${visible} of ${total}`;
}
