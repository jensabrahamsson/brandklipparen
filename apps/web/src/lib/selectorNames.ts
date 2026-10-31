// Selector → signature names for evidence rows (UI v2 §5.3). Read from
// the decompiler payload of the same analysis, so every plugin names a
// selector the same way. Display-only: naming a selector never changes
// score, signals or evidence.
export type SelectorName = {
  // The full canonical signature, for example "approve(address,uint256)",
  // when the decompiler payload carries a non-empty one.
  readonly signature: string | null;
  // The short decompiler name, for example "approve".
  readonly name: string | null;
};

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

function isSelector(value: string): boolean {
  return /^0x[0-9a-fA-F]{8}$/.test(value);
}

// One entry per decompiler finding payload: selector, name and
// signature pass through untouched as data. Later findings for the same
// selector win, so a re-read order stays deterministic.
export function buildSelectorNames(
  decompilerFindings: readonly { readonly payload?: unknown }[],
): ReadonlyMap<string, SelectorName> {
  const names = new Map<string, SelectorName>();
  for (const finding of decompilerFindings) {
    const record = recordOf(finding.payload);
    if (record === null) {
      continue;
    }
    const selector = cleanText(record["selector"]);
    if (selector === null || !isSelector(selector)) {
      continue;
    }
    names.set(selector.toLowerCase(), {
      signature: cleanText(record["signature"]),
      name: cleanText(record["name"]),
    });
  }
  return names;
}

// The row-1 display name: the canonical signature when known, else the
// short name, else a plain "function 0x…" fallback. Never markup.
export function selectorDisplayName(selector: string, names: ReadonlyMap<string, SelectorName>): string {
  const known = names.get(selector.toLowerCase());
  if (known?.signature !== null && known?.signature !== undefined) {
    return known.signature;
  }
  if (known?.name !== null && known?.name !== undefined) {
    return known.name;
  }
  return `function ${selector}`;
}

// The short name for the copy accessible name: the decompiler name when
// known, else the display name.
export function selectorShortName(selector: string, names: ReadonlyMap<string, SelectorName>): string {
  const known = names.get(selector.toLowerCase());
  if (known?.name !== null && known?.name !== undefined) {
    return known.name;
  }
  return selectorDisplayName(selector, names);
}
