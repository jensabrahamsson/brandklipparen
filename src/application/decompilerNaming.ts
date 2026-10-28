// Suggested-name resolution for the optional AI naming overlay (S-083,
// K-038, K-519, D-11). Opt-in and display-only: a null port (the default
// wiring) leaves the service disabled and every resolve answers
// `not-configured` with zero provider calls, so the deterministic
// pseudo-Solidity stands. Model output is validated whole against the
// requested selector set and the identifier shape below; any unknown
// selector, unparsable name, extra entry or missing entry discards the
// whole overlay as `invalid-output` — no partial overlay is ever applied,
// and the suggestions never enter the analysis.
import type {
  DecompilerNamingOutcome,
  DecompilerNamingPort,
  SuggestedName,
} from "../ports/decompilerNaming.ts";
import type { OverlayBudget } from "./overlayBudget.ts";


export const MAX_NAMING_SELECTORS = 64;

const SELECTOR_PATTERN = /^0x[0-9a-fA-F]{8}$/;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function invalidOutput(): DecompilerNamingOutcome {
  return Object.freeze({ kind: "invalid-output" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveSuggestedNames(
  port: DecompilerNamingPort,
  selectors: readonly string[],
): Promise<DecompilerNamingOutcome> {
  if (!Array.isArray(selectors) || selectors.length === 0 || selectors.length > MAX_NAMING_SELECTORS) {
    return invalidOutput();
  }
  const requested = new Set<string>();
  for (const selector of selectors) {
    if (typeof selector !== "string" || !SELECTOR_PATTERN.test(selector) || requested.has(selector)) {
      return invalidOutput();
    }
    requested.add(selector);
  }
  const outcome = await port.suggestNames(Object.freeze([...requested]));
  if (outcome.kind !== "ok") {
    return outcome;
  }
  const names: SuggestedName[] = [];
  const seen = new Set<string>();
  for (const entry of outcome.names) {
    if (!isRecord(entry)) {
      return invalidOutput();
    }
    const selector = entry["selector"];
    const suggestedName = entry["suggestedName"];
    if (
      typeof selector !== "string" ||
      !requested.has(selector) ||
      seen.has(selector) ||
      typeof suggestedName !== "string" ||
      !NAME_PATTERN.test(suggestedName)
    ) {
      return invalidOutput();
    }
    seen.add(selector);
    names.push(Object.freeze({ selector, suggestedName }));
  }
  if (seen.size !== requested.size) {
    return invalidOutput();
  }
  names.sort((left, right) => {
    if (left.selector < right.selector) {
      return -1;
    }
    if (left.selector > right.selector) {
      return 1;
    }
    return 0;
  });
  return Object.freeze({ kind: "ok", names: Object.freeze(names) });
}

export type DecompilerNamingService = {
  readonly enabled: boolean;
  resolve(selectors: readonly string[], keyId?: string | undefined): Promise<DecompilerNamingOutcome>;
};

// Explicit opt-in factory: a null port (the default) builds the disabled
// service, so naming stays off until a caller wires a real port.
export function createDecompilerNamingService(
  port: DecompilerNamingPort | null,
  budget?: OverlayBudget | undefined,
): DecompilerNamingService {
  if (port === null) {
    return Object.freeze({
      enabled: false,
      resolve: (): Promise<DecompilerNamingOutcome> =>
        Promise.resolve(Object.freeze({ kind: "not-configured" })),
    });
  }
  return Object.freeze({
    enabled: true,
    resolve: async (
      selectors: readonly string[],
      keyId?: string | undefined,
    ): Promise<DecompilerNamingOutcome> => {
      const cacheKey = `naming|${[...selectors].sort().join(",")}`;
      if (budget !== undefined && keyId !== undefined) {
        const hit = budget.lookup<DecompilerNamingOutcome>(cacheKey);
        if (hit !== null) {
          return hit;
        }
        if (!budget.trySpend(keyId)) {
          return Object.freeze({ kind: "capped" });
        }
      }
      const outcome = await resolveSuggestedNames(port, selectors);
      if (budget !== undefined && keyId !== undefined && outcome.kind === "ok") {
        budget.store(cacheKey, outcome);
      }
      return outcome;
    },
  });
}
