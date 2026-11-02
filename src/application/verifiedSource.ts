// Verified-source application service behind GET /v1/source (VS-B2).
// Composes the primary and fallback VerifiedSourcePort adapters over one
// bytecode fetch: the route fetches the contract code through the bound
// chain port, keys the bounded memo by address and code hash, and serves
// the mapped shape. Scoring, signals, evidence and the analyze envelope
// stay untouched: this service feeds a separate read route only. `none`
// (checked, nothing published) is distinct from `unavailable` (could not
// check): only a reached provider answering empty is `none`.
import { keccak256HexOfUtf8 } from "../domain/types.ts";
import { CodeHash } from "../domain/types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  RequestId as RequestIdType,
  Timestamp as TimestampType,
} from "../domain/types.ts";
import type { RpcPort } from "../ports/rpc.ts";
import type { ClockPort } from "../ports/clock.ts";
import type {
  VerifiedSourceMatch,
  VerifiedSourcePort,
  VerifiedSourceProvider,
  VerifiedSourceRaw,
} from "../ports/verifiedSource.ts";

// Served source file: the provider path plus the published text with
// hidden characters shown as visible markers (VS-B2 addendum). Files
// past the total byte cap keep their path with empty content, so the
// file list stays complete while the body stays bounded.
export type VerifiedSourceFile = {
  readonly path: string;
  readonly content: string;
};

// One ABI function located in the published sources: the selector from
// the canonical ABI signature plus the source range (1-based lines) from
// the declaration tokenizer. ABI entries with no located declaration
// stay out, so the UI only shows matching functions.
export type VerifiedSourceFunction = {
  readonly selector: string;
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly name: string;
  readonly signature: string;
};

export type VerifiedSourceOutcome = {
  readonly status: "verified" | "none" | "unavailable";
  readonly provider: VerifiedSourceProvider | null;
  readonly match: VerifiedSourceMatch | null;
  readonly compiler: string | null;
  readonly files: readonly VerifiedSourceFile[];
  readonly functions: readonly VerifiedSourceFunction[];
};

export type VerifiedSourceResult = {
  readonly codeHash: string;
  readonly source: VerifiedSourceOutcome;
};

export type VerifiedSourceGetError = "no-code" | "rpc-error";

export type VerifiedSourceService = {
  readonly getSource: (
    address: AddressType,
    ctx: { readonly requestId: RequestIdType; readonly deadline: TimestampType; readonly block: BlockNumberType | "latest" },
  ) => Promise<{ ok: true; value: VerifiedSourceResult } | { ok: false; error: VerifiedSourceGetError }>;
};

export type VerifiedSourceServiceOptions = {
  readonly primary: VerifiedSourcePort;
  readonly fallback?: VerifiedSourcePort | undefined;
  readonly rpc: RpcPort;
  readonly clock: ClockPort;
};

// Time-to-live for `none` memo entries (C-25, F-30): a token verified
// later must become visible, so a checked-and-empty answer expires after
// five minutes. `verified` entries live until LRU eviction; transient
// `unavailable` answers are never stored.
export const VERIFIED_SOURCE_NONE_TTL_MS = 300000;

type VerifiedSourceCacheEntry = {
  readonly outcome: VerifiedSourceOutcome;
  readonly storedAt: number;
};

// Total served source bytes across all files (VS-B2): sources can be
// large, so the body is capped while the file list stays complete.
export const MAX_VERIFIED_SOURCE_TOTAL_BYTES = 1048576;
// Bounded per-address memo (C-25): a long-lived server cannot grow
// without bound. `verified` entries are immutable once stored; `none`
// entries expire after VERIFIED_SOURCE_NONE_TTL_MS and `unavailable`
// answers are never stored.
const SOURCE_CACHE_CAP = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Line-ending normalisation (VS-B2 follow-up 2): CRLF and lone CR are
// normal, so they fold to LF before any other processing. A single
// leading BOM is stripped; any other U+FEFF is a hidden character.
export function normalizeSourceContent(content: string): string {
  let text = content;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replace(/\r\n/g, "\n");
  text = text.replace(/\r/g, "\n");
  return text;
}

// Dangerous invisible characters as visible markers (VS-B2 follow-up
// 2): only bidi controls, zero-width characters and the remaining
// C0/C1 controls render as their code point in double brackets.
// Plain line/paragraph separators and soft hyphens are ordinary text
// and pass through; newlines and tabs stay structural.
const HIDDEN_CODE_POINTS: ReadonlySet<number> = (() => {
  const points = new Set<number>();
  for (let code = 0x00; code <= 0x1f; code += 1) {
    if (code !== 0x0a && code !== 0x09) {
      points.add(code);
    }
  }
  for (let code = 0x7f; code <= 0x9f; code += 1) {
    points.add(code);
  }
  for (const code of [
    0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a,
    0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
  ]) {
    points.add(code);
  }
  return points;
})();

function markerFor(code: number): string {
  return `[[U+${code.toString(16).toUpperCase().padStart(4, "0")}]]`;
}

export function markHiddenSourceChars(content: string): string {
  let out = "";
  for (const char of content) {
    const code = char.codePointAt(0) ?? 0;
    out += HIDDEN_CODE_POINTS.has(code) ? markerFor(code) : char;
  }
  return out;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Total byte cap (VS-B2): files keep their order and every path stays
// listed; content past the cap is empty instead of truncated mid-file,
// so no served file ends in a half-written line.
export function applySourceSizeCap(
  files: readonly { readonly path: string; readonly content: string }[],
  maxBytes: number = MAX_VERIFIED_SOURCE_TOTAL_BYTES,
): VerifiedSourceFile[] {
  const capped: VerifiedSourceFile[] = [];
  let used = 0;
  for (const file of files) {
    const size = utf8Length(file.content);
    if (used + size <= maxBytes) {
      used += size;
      capped.push({ path: file.path, content: file.content });
    } else {
      capped.push({ path: file.path, content: "" });
    }
  }
  return capped;
}

type SourceDeclaration = {
  readonly name: string;
  readonly paramsText: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly hasBody: boolean;
  readonly isOverride: boolean;
  readonly contractName: string | null;
  readonly contractKind: "contract" | "library" | "interface" | null;
};

// Bounds for the declaration scan (C-25): one huge flattened file must
// not stall the event loop, so each file keeps at most 2,000
// declarations and the whole answer at most 10,000. Past the cap the
// outcome stays `verified` with partial functions.
export const MAX_DECLARATIONS_PER_FILE = 2000;
export const MAX_DECLARATIONS_TOTAL = 10000;

type ContractSpan = {
  readonly name: string;
  readonly kind: "contract" | "library" | "interface";
  readonly openBrace: number;
  readonly closeBrace: number;
};

// Contract, library and interface spans in the masked text: the brace
// matching ignores comments and strings because it runs over the masked
// text, so a `{` inside a comment cannot unbalance the scan.
function contractSpansOf(masked: string): ContractSpan[] {
  const spans: ContractSpan[] = [];
  const pattern = /\b(abstract\s+contract|contract|library|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const keyword = match[1] ?? "";
    const name = match[2] ?? "";
    const kind = keyword.includes("interface") ? ("interface" as const) : keyword.includes("library") ? ("library" as const) : ("contract" as const);
    let cursor = match.index + match[0].length;
    while (cursor < masked.length && masked[cursor] !== "{") {
      cursor += 1;
    }
    if (cursor >= masked.length) {
      continue;
    }
    let depth = 1;
    let scan = cursor + 1;
    while (scan < masked.length && depth > 0) {
      if (masked[scan] === "{") {
        depth += 1;
      } else if (masked[scan] === "}") {
        depth -= 1;
      }
      scan += 1;
    }
    if (depth !== 0) {
      continue;
    }
    spans.push({ name, kind, openBrace: cursor, closeBrace: scan - 1 });
  }
  return spans;
}

// Masking pass for one source text: comments and string literals become
// spaces (newlines kept), so the declaration scan never matches a
// `function` word inside a comment or a string. Handles `//` line
// comments, `/* */` blocks and `'...'` / `"..."` literals with escapes.
// Indexes UTF-16 code units (never code points), so the masked text
// aligns with the regex and slice offsets used by the declaration
// scan even when the source holds characters outside the BMP.
function maskSourceText(content: string): string {
  const masked = content.split("");
  const blank = (index: number): void => {
    if (masked[index] !== "\n") {
      masked[index] = " ";
    }
  };
  let index = 0;
  while (index < masked.length) {
    const char = masked[index];
    const next = index + 1 < masked.length ? masked[index + 1] : "";
    if (char === "/" && next === "/") {
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < masked.length && masked[index] !== "\n") {
        blank(index);
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      blank(index);
      blank(index + 1);
      index += 2;
      while (index < masked.length && !(masked[index] === "*" && masked[index + 1] === "/")) {
        blank(index);
        index += 1;
      }
      if (index < masked.length) {
        blank(index);
        blank(index + 1);
        index += 2;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      blank(index);
      index += 1;
      while (index < masked.length && masked[index] !== "\n" && masked[index] !== quote) {
        if (masked[index] === "\\" && index + 1 < masked.length && masked[index + 1] !== "\n") {
          blank(index);
          blank(index + 1);
          index += 2;
          continue;
        }
        blank(index);
        index += 1;
      }
      if (index < masked.length && masked[index] === quote) {
        blank(index);
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

// Binary search over the sorted newline offsets: the declaration loop
// calls this per declaration, so the linear scan made huge files
// quadratic (C-25, F-30).
function lineOf(offsets: readonly number[], index: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const offset = offsets[mid];
    if (offset !== undefined && offset <= index) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low + 1;
}

// Function declarations per file (VS-B2, C-25): `function name(params)`
// with the range from the `function` keyword to the matching close
// brace, or to the `;` for bodyless declarations. Each declaration also
// records whether it has a body, whether its modifiers name `override`,
// and the enclosing contract or library, so the ABI mapping can prefer
// the override body in the compilation-target contract over a base or
// interface declaration. No compiler: parens and braces are counted
// over the masked text, so comments and strings cannot unbalance the
// scan. At most MAX_DECLARATIONS_PER_FILE declarations are kept.
export function extractSourceDeclarations(
  content: string,
): SourceDeclaration[] {
  const normalized = normalizeSourceContent(content);
  const masked = maskSourceText(normalized);
  const newlineOffsets: number[] = [];
  for (let index = 0; index < masked.length; index += 1) {
    if (masked[index] === "\n") {
      newlineOffsets.push(index);
    }
  }
  const spans = contractSpansOf(masked);
  const found: SourceDeclaration[] = [];
  const pattern = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    if (found.length >= MAX_DECLARATIONS_PER_FILE) {
      break;
    }
    const name = match[1] ?? "";
    let depth = 1;
    let cursor = match.index + match[0].length;
    while (cursor < masked.length && depth > 0) {
      if (masked[cursor] === "(") {
        depth += 1;
      } else if (masked[cursor] === ")") {
        depth -= 1;
      }
      cursor += 1;
    }
    if (depth !== 0) {
      continue;
    }
    const paramsText = normalized.slice(match.index + match[0].length, cursor - 1);
    let endLine: number | null = null;
    let hasBody = false;
    let modifiersText = "";
    let scan = cursor;
    while (scan < masked.length) {
      const char = masked[scan];
      if (char === ";") {
        endLine = lineOf(newlineOffsets, scan);
        modifiersText = normalized.slice(cursor, scan);
        break;
      }
      if (char === "{") {
        hasBody = true;
        modifiersText = normalized.slice(cursor, scan);
        let braceDepth = 1;
        scan += 1;
        while (scan < masked.length && braceDepth > 0) {
          if (masked[scan] === "{") {
            braceDepth += 1;
          } else if (masked[scan] === "}") {
            braceDepth -= 1;
          }
          scan += 1;
        }
        if (braceDepth === 0) {
          endLine = lineOf(newlineOffsets, scan - 1);
        }
        break;
      }
      scan += 1;
    }
    if (endLine === null) {
      continue;
    }
    let contractName: string | null = null;
    let contractKind: "contract" | "library" | "interface" | null = null;
    for (const span of spans) {
      if (span.openBrace <= match.index && match.index <= span.closeBrace) {
        contractName = span.name;
        contractKind = span.kind;
      }
    }
    found.push({
      name,
      paramsText,
      startLine: lineOf(newlineOffsets, match.index),
      endLine,
      hasBody,
      isOverride: /\boverride\b/.test(modifiersText),
      contractName,
      contractKind,
    });
  }
  return found;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[" || char === "<") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === ">") {
      depth = Math.max(0, depth - 1);
    }
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

// Canonical elementary type: Solidity aliases expand to the ABI form
// (`uint` -> `uint256`, `int` -> `int256`, `byte` -> `bytes1`), with any
// array suffix preserved. Other bases pass through unchanged.
export function canonicalSolType(type: string): string {
  const match = /^([^[]+)((?:\[[^\]]*\])*)$/.exec(type.trim());
  if (match === null) return type.replace(/\s/g, "");
  const base = match[1] ?? "";
  const suffix = match[2] ?? "";
  const canonical = base === "uint" ? "uint256" : base === "int" ? "int256" : base === "byte" ? "bytes1" : base;
  return `${canonical}${suffix}`;
}

function canonicalInputType(input: Record<string, unknown>): string | null {
  const type = input["type"];
  if (typeof type !== "string" || type === "") {
    return null;
  }
  if (type.startsWith("tuple")) {
    const components = input["components"];
    if (!Array.isArray(components)) {
      return null;
    }
    const inner: string[] = [];
    for (const component of components) {
      if (!isRecord(component)) {
        return null;
      }
      const nested = canonicalInputType(component);
      if (nested === null) {
        return null;
      }
      inner.push(nested);
    }
    return `(${inner.join(",")})${type.slice("tuple".length)}`;
  }
  return canonicalSolType(type);
}

type AbiFunction = {
  readonly name: string;
  readonly signature: string;
  readonly selector: string;
  readonly arity: number;
  readonly types: readonly string[];
};

function abiFunctionsOf(abi: readonly unknown[]): AbiFunction[] {
  const functions: AbiFunction[] = [];
  for (const entry of abi) {
    if (!isRecord(entry) || entry["type"] !== "function" || typeof entry["name"] !== "string") {
      continue;
    }
    const inputs = entry["inputs"];
    if (!Array.isArray(inputs)) {
      continue;
    }
    const types: string[] = [];
    let valid = true;
    for (const input of inputs) {
      if (!isRecord(input)) {
        valid = false;
        break;
      }
      const canonical = canonicalInputType(input);
      if (canonical === null) {
        valid = false;
        break;
      }
      types.push(canonical);
    }
    if (!valid) {
      continue;
    }
    const signature = `${entry["name"] as string}(${types.join(",")})`;
    functions.push({
      name: entry["name"] as string,
      signature,
      selector: keccak256HexOfUtf8(signature).slice(0, 10),
      arity: types.length,
      types: Object.freeze(types.slice()),
    });
  }
  return functions;
}

// Mappable declaration view: the stored fields plus the file. Extra
// fields are optional so existing callers and fixtures keep working;
// an absent flag counts as false and an absent contract as unknown.
export type MappableDeclaration = {
  readonly name: string;
  readonly paramsText: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly file: string;
  readonly hasBody?: boolean | undefined;
  readonly isOverride?: boolean | undefined;
  readonly contractName?: string | null | undefined;
  readonly contractKind?: "contract" | "library" | "interface" | null | undefined;
};

// BK-21: canonical parameter types of one source declaration, or null
// when a parameter carries no resolvable type (a bare name). A trailing
// parameter name and data-location keywords are dropped; tuple
// parameters keep their parenthesised form.
function declarationTypes(paramsText: string): readonly string[] | null {
  const parts = splitTopLevel(paramsText);
  const types: string[] = [];
  for (const part of parts) {
    const tokens = part.replace(/\s+/g, " ").trim().split(" ").filter((token) => token.length > 0);
    const typeTokens = tokens.filter((token) => !["memory", "calldata", "storage", "payable"].includes(token));
    if (typeTokens.length === 0) {
      return null;
    }
    const type = typeTokens.length > 1 ? typeTokens.slice(0, -1).join("") : (typeTokens[0] ?? "");
    if (type === "") {
      return null;
    }
    types.push(canonicalSolType(type.replace(/\s/g, "")));
  }
  return Object.freeze(types);
}

const ELEMENTARY_TYPE = /^(?:address|bool|string|bytes(?:[1-9]|[12][0-9]|3[0-2])?|u?int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|fixed|ufixed)(?:\[[^\]]*\])*$/;

function typesMatch(fn: AbiFunction, declaration: MappableDeclaration): boolean | null {
  const declared = declarationTypes(declaration.paramsText);
  if (declared === null || declared.length !== fn.types.length) {
    return declared === null ? null : false;
  }
  const wanted = fn.types.map((type) => canonicalSolType(type.replace(/\s/g, "")));
  let unknown = false;
  const matches = declared.every((type, index) => {
    if (type === wanted[index]) return true;
    // A user-defined or otherwise unresolved type cannot be proven
    // different from the ABI type: report unknown, never a mismatch.
    if (!ELEMENTARY_TYPE.test(type) || !(wanted[index] !== undefined && ELEMENTARY_TYPE.test(wanted[index]))) {
      unknown = true;
      return true;
    }
    return false;
  });
  return matches ? (unknown ? null : true) : false;
}

// ABI functions located in the published sources (VS-B2, C-25): matched
// by name, then by parameter count for overloads, then ranked so the
// override body wins over a base or interface declaration: a bodied
// declaration beats a bodyless one, the compilation-target contract
// beats other files, `override` beats plain, and anything beats an
// interface. Declaration order breaks the remaining ties. Each
// declaration maps at most one ABI entry, so overloads pair up instead
// of collapsing onto the first declaration.
export function mapSourceFunctions(
  abi: readonly unknown[],
  declarations: readonly MappableDeclaration[],
  compilationTarget?: { readonly path: string; readonly contractName: string } | null | undefined,
): VerifiedSourceFunction[] {
  const wanted = abiFunctionsOf(abi);
  const used = new Array<boolean>(declarations.length).fill(false);
  const mapped: VerifiedSourceFunction[] = [];
  for (const fn of wanted) {
    const candidates: number[] = [];
    for (let index = 0; index < declarations.length; index += 1) {
      const declaration = declarations[index];
      if (declaration !== undefined && !used[index] && declaration.name === fn.name) {
        candidates.push(index);
      }
    }
    if (candidates.length === 0) {
      continue;
    }
    // BK-21: same-arity overloads pair by canonical parameter types.
    // When every candidate's types resolve and none matches, abstain
    // instead of pairing by declaration order.
    if (candidates.length > 1) {
      const matching = candidates.filter((index) => {
        const declaration = declarations[index];
        return declaration !== undefined && typesMatch(fn, declaration) === true;
      });
      if (matching.length > 0) {
        candidates.length = 0;
        candidates.push(...matching);
      } else if (
        candidates.every((index) => {
          const declaration = declarations[index];
          return declaration !== undefined && typesMatch(fn, declaration) !== null;
        })
      ) {
        continue;
      }
    }
    const rankOf = (index: number): readonly number[] => {
      const declaration = declarations[index];
      const arityMatches =
        declaration !== undefined && splitTopLevel(declaration.paramsText).length === fn.arity ? 0 : 1;
      const body = declaration?.hasBody === true ? 0 : 1;
      const target =
        compilationTarget !== null &&
        compilationTarget !== undefined &&
        declaration?.file === compilationTarget.path &&
        (declaration?.contractName ?? null) === compilationTarget.contractName
          ? 0
          : 1;
      const overrideFlag = declaration?.isOverride === true ? 0 : 1;
      const kind = declaration?.contractKind === "interface" ? 1 : 0;
      return [arityMatches, body, target, overrideFlag, kind, index] as const;
    };
    candidates.sort((left, right) => {
      const leftRank = rankOf(left);
      const rightRank = rankOf(right);
      for (let rank = 0; rank < leftRank.length; rank += 1) {
        const leftValue = leftRank[rank] ?? 0;
        const rightValue = rightRank[rank] ?? 0;
        if (leftValue !== rightValue) {
          return leftValue - rightValue;
        }
      }
      return 0;
    });
    const picked = candidates[0];
    if (picked === undefined) {
      continue;
    }
    used[picked] = true;
    const declaration = declarations[picked];
    if (declaration === undefined) {
      continue;
    }
    mapped.push({
      selector: fn.selector,
      file: declaration.file,
      startLine: declaration.startLine,
      endLine: declaration.endLine,
      name: fn.name,
      signature: fn.signature,
    });
  }
  mapped.sort((left, right) => (left.selector < right.selector ? -1 : left.selector > right.selector ? 1 : 0));
  return mapped;
}

function buildOutcome(raw: VerifiedSourceRaw): VerifiedSourceOutcome {
  const normalized = raw.files.map((file) => ({ path: file.path, content: normalizeSourceContent(file.content) }));
  const sanitized = normalized.map((file) => ({ path: file.path, content: markHiddenSourceChars(file.content) }));
  const files = applySourceSizeCap(sanitized);
  const declarations: MappableDeclaration[] = [];
  for (const file of normalized) {
    for (const declaration of extractSourceDeclarations(file.content)) {
      if (declarations.length >= MAX_DECLARATIONS_TOTAL) {
        break;
      }
      declarations.push({ ...declaration, file: file.path });
    }
    if (declarations.length >= MAX_DECLARATIONS_TOTAL) {
      break;
    }
  }
  const outcome: VerifiedSourceOutcome = {
    status: "verified",
    provider: raw.provider,
    match: raw.match,
    compiler: raw.compiler,
    files,
    functions: mapSourceFunctions(raw.abi, declarations, raw.compilationTarget),
  };
  return outcome;
}

function noneOutcome(provider: VerifiedSourceProvider): VerifiedSourceOutcome {
  return { status: "none", provider, match: null, compiler: null, files: [], functions: [] };
}

function unavailableOutcome(): VerifiedSourceOutcome {
  return { status: "unavailable", provider: null, match: null, compiler: null, files: [], functions: [] };
}

export function createVerifiedSourceService(options: VerifiedSourceServiceOptions): VerifiedSourceService {
  const cache = new Map<string, VerifiedSourceCacheEntry>();
  const touch = (key: string, entry: VerifiedSourceCacheEntry): void => {
    cache.delete(key);
    cache.set(key, entry);
  };
  const getSource: VerifiedSourceService["getSource"] = async (address, ctx) => {
    const fetched = await options.rpc.getCode(address, {
      requestId: ctx.requestId,
      deadline: ctx.deadline,
      block: ctx.block,
    });
    if (!fetched.ok) {
      return { ok: false as const, error: fetched.error.kind === "no-code" ? ("no-code" as const) : ("rpc-error" as const) };
    }
    const codeHash = CodeHash.of(fetched.value.bytecode as BytecodeType);
    if (!codeHash.ok) {
      return { ok: false as const, error: "rpc-error" as const };
    }
    const hashText = codeHash.value as string;
    const key = `${(address as string).toLowerCase()}|${hashText}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      if (hit.outcome.status === "verified") {
        touch(key, hit);
        return { ok: true as const, value: { codeHash: hashText, source: hit.outcome } };
      }
      const age = (options.clock.now() as number) - hit.storedAt;
      if (age < VERIFIED_SOURCE_NONE_TTL_MS) {
        touch(key, hit);
        return { ok: true as const, value: { codeHash: hashText, source: hit.outcome } };
      }
      cache.delete(key);
    }
    const answer = (outcome: VerifiedSourceOutcome): { ok: true; value: VerifiedSourceResult } => {
      // Transient failures are never pinned: a later check may succeed.
      if (outcome.status === "unavailable") {
        return { ok: true as const, value: { codeHash: hashText, source: outcome } };
      }
      if (cache.size >= SOURCE_CACHE_CAP) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      cache.set(key, { outcome, storedAt: options.clock.now() as number });
      return { ok: true as const, value: { codeHash: hashText, source: outcome } };
    };
    const addressText = address as string;
    const primary = await options.primary.fetchVerifiedSource(addressText);
    if (primary.ok && primary.value.status === "verified") {
      return answer(buildOutcome(primary.value));
    }
    if (options.fallback === undefined) {
      return answer(primary.ok ? noneOutcome(primary.value.provider) : unavailableOutcome());
    }
    const fallback = await options.fallback.fetchVerifiedSource(addressText);
    if (fallback.ok && fallback.value.status === "verified") {
      return answer(buildOutcome(fallback.value));
    }
    // `none` only when every attempted provider was reached and holds
    // nothing: any error leaves the check incomplete (`unavailable`).
    if (primary.ok && fallback.ok) {
      return answer(noneOutcome(fallback.value.provider));
    }
    return answer(unavailableOutcome());
  };
  return Object.freeze({ getSource });
}
