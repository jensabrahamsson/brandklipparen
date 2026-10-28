// Selector naming and signatures (S-080, K-037, K-521). Pure
// deterministic mapping from a 4-byte dispatcher selector to a readable
// function name with its canonical signature. Rules run before the
// table, so a rule always overrides a table row; unknown selectors stay
// raw hex and never invent a name. Suggested AI names are a separate
// Stretch story (S-083) and never touch this module.
import type { FunctionEntry } from "./evmFlow.ts";

export type NameSource = "rule" | "table" | "raw";

export type FunctionName = {
  readonly name: string;
  readonly signature: string | null;
  readonly source: NameSource;
};

// Published ERC-20 selector table: name with canonical signature. The
// four published selectors the backlog names (transfer, approve,
// transferFrom, balanceOf) resolve here with three companions.
const SELECTOR_TABLE: Readonly<Record<string, { name: string; signature: string }>> = Object.freeze({
  "0x06fdde03": Object.freeze({ name: "name", signature: "name()" }),
  "0x095ea7b3": Object.freeze({ name: "approve", signature: "approve(address,uint256)" }),
  "0x18160ddd": Object.freeze({ name: "totalSupply", signature: "totalSupply()" }),
  "0x23b872dd": Object.freeze({ name: "transferFrom", signature: "transferFrom(address,address,uint256)" }),
  "0x313ce567": Object.freeze({ name: "decimals", signature: "decimals()" }),
  "0x70a08231": Object.freeze({ name: "balanceOf", signature: "balanceOf(address)" }),
  "0x95d89b41": Object.freeze({ name: "symbol", signature: "symbol()" }),
  "0xa9059cbb": Object.freeze({ name: "transfer", signature: "transfer(address,uint256)" }),
  "0xdd62ed3e": Object.freeze({ name: "allowance", signature: "allowance(address,address)" }),
});

export type NamingContext = {
  // True when the entry block is the dispatcher fallback rather than a
  // selector branch: the rule names it `fallback` even when the table
  // holds the selector.
  readonly isFallback: boolean;
};

function isHexSelector(selector: string): boolean {
  return /^0x[0-9a-fA-F]{8}$/.test(selector);
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
