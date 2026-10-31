// Selector naming and signatures (S-080, K-037, K-521). Pure
// deterministic mapping from a 4-byte dispatcher selector to a readable
// function name with its canonical signature. Rules run before the
// table, so a rule always overrides a table row; unknown selectors stay
// raw hex and never invent a name. Suggested AI names are a separate
// Stretch story (S-083) and never touch this module. The table is
// versioned offline data (M-02e): every row pairs the canonical
// signature text with its 4-byte selector, and the unit test recomputes
// each selector from its signature through the shared keccak helper, so
// a wrong row fails the suite instead of reaching a prompt.
import type { FunctionEntry } from "./evmFlow.ts";

export type NameSource = "rule" | "table" | "raw";

export type FunctionName = {
  readonly name: string;
  readonly signature: string | null;
  readonly source: NameSource;
};

// Published selector table: name with canonical signature. The ERC-20
// rows resolve the standard token behavior; the ownership, pausable,
// access-control, mint and blacklist rows resolve the common admin
// functions the detectors gate on. Every selector below is the first
// four bytes of keccak256 over its signature, pinned by the unit test.
const SELECTOR_TABLE: Readonly<Record<string, { name: string; signature: string }>> = Object.freeze({
  "0x06fdde03": Object.freeze({ name: "name", signature: "name()" }),
  "0x095ea7b3": Object.freeze({ name: "approve", signature: "approve(address,uint256)" }),
  "0x0ecb93c0": Object.freeze({ name: "addBlackList", signature: "addBlackList(address)" }),
  "0x18160ddd": Object.freeze({ name: "totalSupply", signature: "totalSupply()" }),
  "0x23b872dd": Object.freeze({ name: "transferFrom", signature: "transferFrom(address,address,uint256)" }),
  "0x2f2ff15d": Object.freeze({ name: "grantRole", signature: "grantRole(bytes32,address)" }),
  "0x313ce567": Object.freeze({ name: "decimals", signature: "decimals()" }),
  "0x3f4ba83a": Object.freeze({ name: "unpause", signature: "unpause()" }),
  "0x40c10f19": Object.freeze({ name: "mint", signature: "mint(address,uint256)" }),
  "0x5c975abb": Object.freeze({ name: "paused", signature: "paused()" }),
  "0x70a08231": Object.freeze({ name: "balanceOf", signature: "balanceOf(address)" }),
  "0x715018a6": Object.freeze({ name: "renounceOwnership", signature: "renounceOwnership()" }),
  "0x8456cb59": Object.freeze({ name: "pause", signature: "pause()" }),
  "0x8da5cb5b": Object.freeze({ name: "owner", signature: "owner()" }),
  "0x91d14854": Object.freeze({ name: "hasRole", signature: "hasRole(bytes32,address)" }),
  "0x95d89b41": Object.freeze({ name: "symbol", signature: "symbol()" }),
  "0xa9059cbb": Object.freeze({ name: "transfer", signature: "transfer(address,uint256)" }),
  "0xdd62ed3e": Object.freeze({ name: "allowance", signature: "allowance(address,address)" }),
  "0xf2fde38b": Object.freeze({ name: "transferOwnership", signature: "transferOwnership(address)" }),
});

// Offline table version (M-02e). A new row ships beside a version bump
// and the keccak pin test below it, so model input and display labels
// always name the same set.
export const SELECTOR_TABLE_VERSION = "1.0.0";

export type NamingContext = {
  // True when the entry block is the dispatcher fallback rather than a
  // selector branch: the rule names it `fallback` even when the table
  // holds the selector.
  readonly isFallback: boolean;
};

function isHexSelector(selector: string): boolean {
  return /^0x[0-9a-fA-F]{8}$/.test(selector);
}

// Table-only lookup for model input and display labels (M-02e): the
// canonical signature for a known selector, or null for an unknown one.
// Unknown selectors stay the raw selector at the call site; the lookup
// never invents a name.
export function tableSignatureFor(selector: string): string | null {
  const row = SELECTOR_TABLE[selector.toLowerCase()];
  return row === undefined ? null : row.signature;
}

// Every versioned table row for the keccak pin test: signature text with
// its recorded selector.
export function tableRows(): ReadonlyArray<{ readonly signature: string; readonly selector: string }> {
  return Object.freeze(
    Object.entries(SELECTOR_TABLE).map(([selector, row]) =>
      Object.freeze({ signature: row.signature, selector }),
    ),
  );
}

// nameForSelector assigns names by 4-byte rules or table (S-080): the
// fallback rule first, then the published table, then raw hex. A table
// row never overrides a rule.
export function nameForSelector(selector: string, context: NamingContext): FunctionName {
  const lower = selector.toLowerCase();
  if (context.isFallback) {
    return Object.freeze({ name: "fallback", signature: null, source: "rule" as NameSource });
  }
  const row = SELECTOR_TABLE[lower];
  if (row !== undefined) {
    return Object.freeze({ name: row.name, signature: row.signature, source: "table" as NameSource });
  }
  if (isHexSelector(selector)) {
    return Object.freeze({ name: `function_${lower.slice(2)}`, signature: null, source: "raw" as NameSource });
  }
  return Object.freeze({ name: "function_unknown", signature: null, source: "raw" as NameSource });
}

// Names for every resolved entry: an entry is the fallback exactly when
// its block is the topology fallback block.
export function resolveFunctionNames(
  entries: readonly FunctionEntry[],
  fallbackBlock: number | null,
): readonly (FunctionEntry & { named: FunctionName })[] {
  return Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        ...entry,
        named: nameForSelector(entry.selector, { isFallback: fallbackBlock !== null && entry.entryBlock === fallbackBlock }),
      }),
    ),
  );
}
