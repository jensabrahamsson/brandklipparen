// Deterministic priority baseline (S-067, K-035, P-25). A pure,
// testable keyword/tag match over validated `PLUGIN.md` frontmatter that
// reorders and highlights sections deterministically, with no network.
// The function reads frontmatter only — never body text, finding text or
// the network. The same priorities and the same registry always give the
// same output. When no tag matches, the caller keeps the standard order:
// the matcher never invents a match.

export type PluginFrontmatterView = {
  readonly id: string;
  readonly tags: readonly string[];
  readonly severityMax: "low" | "medium" | "high";
};

export type PriorityMatch = {
  // Ordered plugin ids, best match first. Empty when nothing matches.
  readonly orderedIds: readonly string[];
  // Per matched plugin, the distinct frontmatter tags the priorities hit,
  // shown to the visitor as "Matched: honeypot, fees".
  readonly matchedTags: ReadonlyMap<string, readonly string[]>;
};

// Versioned keyword table (ADR P-25): word roots map to controlled-vocabulary
// tags. Roots match by substring on lowercase letter tokens, so stemming
// and entries never come from plugin or user data. The `near` row fires
// only when a context root sits within the proximity window.
type KeywordRow = {
  readonly roots: readonly string[];
  readonly tags: readonly string[];
  readonly near?: readonly string[] | undefined;
};

export const MATCHER_VERSION = 1;

const NEAR_WINDOW = 5;

const KEYWORD_TABLE: readonly KeywordRow[] = Object.freeze([
  { roots: Object.freeze(["sell", "sold", "exit", "stuck", "trap", "honeypot"]), tags: Object.freeze(["honeypot"]) },
  {
    roots: Object.freeze(["stop", "block", "freez", "prevent"]),
    near: Object.freeze(["sell", "transfer", "trade"]),
    tags: Object.freeze(["honeypot", "transfer-limits"]),
  },
  {
    roots: Object.freeze(["owner", "admin", "creator", "control", "power"]),
    tags: Object.freeze(["owner-powers"]),
  },
  { roots: Object.freeze(["fee", "tax", "charge", "cost"]), tags: Object.freeze(["fees"]) },
  {
    roots: Object.freeze(["upgrad", "replac", "proxy"]),
    tags: Object.freeze(["upgradeability", "proxy"]),
  },
  {
    roots: Object.freeze(["liquidity", "pool", "lock", "withdraw"]),
    tags: Object.freeze(["liquidity"]),
  },
  {
    roots: Object.freeze(["blacklist", "ban", "whitelist"]),
    tags: Object.freeze(["blacklist"]),
  },
  { roots: Object.freeze(["paus", "halt", "emergenc"]), tags: Object.freeze(["pausing"]) },
  { roots: Object.freeze(["limit", "cap", "max"]), tags: Object.freeze(["transfer-limits"]) },
  {
    roots: Object.freeze(["mint", "supply", "inflat", "print"]),
    tags: Object.freeze(["mint", "supply"]),
  },
  {
    roots: Object.freeze(["external", "oracle", "depend"]),
    tags: Object.freeze(["external-calls"]),
  },
]);

const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });

function tokenize(priorities: string): readonly string[] {
  return Object.freeze(
    priorities
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((token) => token.length > 1),
  );
}

function rowHits(tokens: readonly string[], row: KeywordRow): boolean {
  return row.roots.some((root) => tokens.some((token) => token.includes(root)));
}

function nearHits(tokens: readonly string[], row: KeywordRow): boolean {
  if (row.near === undefined) {
    return rowHits(tokens, row);
  }
  const rootPositions: number[] = [];
  const contextPositions: number[] = [];
  tokens.forEach((token, index) => {
    if (row.roots.some((root) => token.includes(root))) {
      rootPositions.push(index);
    }
    if ((row.near as readonly string[]).some((root) => token.includes(root))) {
      contextPositions.push(index);
    }
  });
  if (rootPositions.length === 0) {
    return false;
  }
  return rootPositions.some((root) => contextPositions.some((context) => Math.abs(root - context) <= NEAR_WINDOW));
}

// Pure baseline match (P-25): tokenise once, collect hit tags, then score
// each plugin by distinct tags hit with the frontmatter severity max as
// the tie-break display value. No network, no clock, no randomness.
export function matchPriorities(
  priorities: string,
  plugins: readonly PluginFrontmatterView[],
): PriorityMatch {
  const tokens = tokenize(priorities);
  if (tokens.length === 0) {
    return { orderedIds: Object.freeze([]), matchedTags: new Map() };
  }
  const hitTags = new Set<string>();
  for (const row of KEYWORD_TABLE) {
    if (nearHits(tokens, row)) {
      for (const tag of row.tags) {
        hitTags.add(tag);
      }
    }
  }
  if (hitTags.size === 0) {
    return { orderedIds: Object.freeze([]), matchedTags: new Map() };
  }
  const matched: { id: string; score: number; severity: number; tags: string[] }[] = [];
  for (const plugin of plugins) {
    const tags = plugin.tags.filter((tag) => hitTags.has(tag));
    if (tags.length === 0) {
      continue;
    }
    matched.push({
      id: plugin.id,
      score: new Set(tags).size,
      severity: SEVERITY_RANK[plugin.severityMax] ?? 0,
      tags: [...new Set(tags)].sort(),
    });
  }
  matched.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.severity !== left.severity) {
      return right.severity - left.severity;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const orderedIds = Object.freeze(matched.map((entry) => entry.id));
  const matchedTags = new Map<string, readonly string[]>();
  for (const entry of matched) {
    matchedTags.set(entry.id, Object.freeze(entry.tags));
  }
  return { orderedIds, matchedTags };
}

// Ordering-only application with the severity floor (P-26): floored ids
// clamp ahead of all non-floored ids in their standard relative order,
// the personalized order applies to the rest, and unmatched ids keep
// their standard order after the matched block. Unknown order ids are
// ignored. Members are never added, removed or reworded.
export function applyPersonalizedOrder<T extends { readonly id: string }>(
  standard: readonly T[],
  orderedIds: readonly string[],
  flooredIds: readonly string[],
): readonly T[] {
  const floored = new Set(flooredIds);
  const orderRank = new Map<string, number>();
  orderedIds.forEach((id, index) => {
    if (!orderRank.has(id)) {
      orderRank.set(id, index);
    }
  });
  const flooredBlock = standard.filter((section) => floored.has(section.id));
  const rest = standard.filter((section) => !floored.has(section.id));
  const matchedBlock = rest
    .filter((section) => orderRank.has(section.id))
    .sort((left, right) => (orderRank.get(left.id) ?? 0) - (orderRank.get(right.id) ?? 0));
  const unmatchedBlock = rest.filter((section) => !orderRank.has(section.id));
  return Object.freeze([...flooredBlock, ...matchedBlock, ...unmatchedBlock]);
}
