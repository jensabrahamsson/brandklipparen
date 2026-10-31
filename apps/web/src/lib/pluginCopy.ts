// Plain per-detector copy for the plugin board (UI v2 §5.1). Keyed by
// slug: the last dot segment of the plugin id when it is unique,
// otherwise the full id, URL-encoded. Never scored, never evidence:
// display strings only.
import type { PictogramName } from "./pictograms.ts";

export type PluginGroup = "owner" | "tools";

export type PluginCopyEntry = {
  readonly slug: string;
  readonly title: string;
  readonly question: string;
  readonly pictogram: PictogramName;
  readonly group: PluginGroup;
  // One plain sentence for the tile body. Receives every scored or
  // extended finding payload for the plugin; unknown shapes fall back to
  // the question so the tile never renders nothing.
  readonly foundLine: (payloads: readonly unknown[]) => string;
};

// Canonical registry order: 9 owner powers, then 4 analysis tools.
export const OWNER_POWER_SLUGS: readonly string[] = Object.freeze([
  "ownership",
  "pause",
  "blacklist",
  "mint",
  "transfer-fee",
  "transfer-limits",
  "sell-block",
  "transfer-hooks",
  "proxy-upgrade",
]);

export const TOOL_SLUGS: readonly string[] = Object.freeze([
  "capability",
  "decompiler",
  "clone-match",
  "hard-to-analyze",
]);

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function textOf(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function firstPayloadWith(
  payloads: readonly unknown[],
  keys: readonly string[],
): Record<string, unknown> | null {
  for (const payload of payloads) {
    const record = recordOf(payload);
    if (record !== null && keys.every((key) => record[key] !== undefined)) {
      return record;
    }
  }
  return null;
}

function uniqueJoin(lines: readonly string[]): string {
  return [...new Set(lines)].join(" ");
}

const CAPABILITY_LABELS: Record<string, string> = Object.freeze({
  call: "Calls other contracts",
  "storage-write": "Writes storage",
  delegatecall: "Runs other code (delegatecall)",
  selfdestruct: "Can self-destruct",
});

function capabilityLine(payloads: readonly unknown[]): string {
  const labels: string[] = [];
  for (const payload of payloads) {
    const key = textOf(recordOf(payload) ?? {}, "capability");
    const label = key === null ? null : CAPABILITY_LABELS[key];
    if (label !== undefined && label !== null && !labels.includes(label)) {
      labels.push(label);
    }
  }
  if (labels.length === 0) {
    return "This code can do more than move balances.";
  }
  return labels.join(" · ");
}

function decompilerLine(payloads: readonly unknown[]): string {
  let named = 0;
  let partial = 0;
  for (const payload of payloads) {
    const record = recordOf(payload);
    if (record === null) {
      continue;
    }
    if (typeof record["signature"] === "string" || typeof record["name"] === "string") {
      if (typeof record["signature"] === "string" && record["signature"] !== "") {
        named += 1;
      }
    }
    if (typeof record["cause"] === "string" && record["cause"] !== "") {
      partial += 1;
    } else if (record["cause"] !== null && record["cause"] !== undefined) {
      partial += 1;
    }
  }
  const total = payloads.length;
  const functionWord = total === 1 ? "function" : "functions";
  if (partial === 0) {
    return `${total} ${functionWord} · ${named} named · fully read`;
  }
  return `${total} ${functionWord} · ${named} named · ${partial} partly read`;
}

function cloneMatchLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["group"]);
  const group = record === null ? null : textOf(record, "group");
  if (group === null || group === "") {
    return "This code looks like a known template.";
  }
  return `Matches known group ${group}.`;
}

const HARD_CAUSE_LINES: Record<string, string> = Object.freeze({
  timeout: "Reading timed out.",
  "resource-limit": "Hit a size limit.",
  "decompiler-error": "Decompiler error.",
  "obfuscated-structure": "Code looks deliberately tangled.",
});

function hardToAnalyzeLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["cause"]);
  const cause = record === null ? null : textOf(record, "cause");
  if (cause !== null && HARD_CAUSE_LINES[cause] !== undefined) {
    return HARD_CAUSE_LINES[cause] as string;
  }
  return "The code was hard to read.";
}

function ownershipLine(payloads: readonly unknown[]): string {
  const lines: string[] = [];
  for (const payload of payloads) {
    const record = recordOf(payload);
    if (record === null) {
      continue;
    }
    if (record["feature"] === "renounce" || record["fact"] === "renounce") {
      lines.push("Renounce path found: the owner can give up control.");
      continue;
    }
    const count = record["privilegedFunctions"];
    if (typeof count === "number" && Number.isFinite(count)) {
      const word = count === 1 ? "function" : "functions";
      lines.push(`An owner account controls ${count} ${word}.`);
    }
  }
  if (lines.length === 0) {
    return "Someone owns this contract.";
  }
  return uniqueJoin(lines);
}

function pauseLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["mode"]);
  const mode = record === null ? null : textOf(record, "mode");
  if (mode === "pause") {
    return "The owner can freeze all transfers.";
  }
  if (mode === "trading-toggle") {
    return "The owner can switch trading on and off.";
  }
  return "The owner can stop transfers.";
}

function mintLine(payloads: readonly unknown[]): string {
  const parts = ["The owner can create new tokens."];
  const record = firstPayloadWith(payloads, ["capped", "recipient"]);
  if (record !== null) {
    if (record["capped"] === true) {
      parts.push("A cap is checked.");
    } else if (record["capped"] === false) {
      parts.push("No cap found.");
    }
    if (record["recipient"] === "stored") {
      parts.push("New tokens go to a stored address.");
    }
  } else {
    const cappedOnly = firstPayloadWith(payloads, ["capped"]);
    if (cappedOnly !== null) {
      parts.push(cappedOnly["capped"] === true ? "A cap is checked." : "No cap found.");
    }
  }
  return parts.join(" ");
}

function feeLine(payloads: readonly unknown[]): string {
  const parts = ["The owner can change the fee taken on each transfer."];
  const record = firstPayloadWith(payloads, ["capSlot"]);
  if (record !== null && record["capSlot"] !== null && record["capSlot"] !== undefined) {
    parts.push("A cap is checked when it is set.");
  }
  return parts.join(" ");
}

function limitsLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["limitKind"]);
  const kind = record === null ? null : textOf(record, "limitKind");
  if (kind === "max-wallet") {
    return "The owner can set a max per wallet.";
  }
  if (kind === "max-tx") {
    return "The owner can set a max per transaction.";
  }
  return "The owner can set a transfer limit.";
}

function sellBlockLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["condition"]);
  const condition = record === null ? null : textOf(record, "condition");
  if (condition === "pair-mapping") {
    return "Sending to listed pools can be blocked.";
  }
  return "Sending to the trading pool can be blocked.";
}

function hooksLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["target"]);
  const target = record === null ? null : textOf(record, "target");
  if (target === "storage") {
    return "Each transfer can call a contract the owner sets.";
  }
  if (target === "argument") {
    return "Each transfer can call a contract the sender picks.";
  }
  return "Each transfer can call another contract.";
}

function proxyLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["proxyKind"]);
  const kind = record === null ? null : textOf(record, "proxyKind");
  if (kind === "uups") {
    return "The code can be upgraded (UUPS proxy).";
  }
  if (kind === "eip1967") {
    return "The code can be upgraded (EIP-1967 proxy).";
  }
  return "The code can be upgraded.";
}

function blacklistLine(): string {
  return "The owner can stop chosen wallets from sending tokens.";
}

export const PLUGIN_COPY: Record<string, PluginCopyEntry> = Object.freeze({
  ownership: {
    slug: "ownership",
    title: "Ownership",
    question: "Does someone own this contract?",
    pictogram: "owner",
    group: "owner",
    foundLine: ownershipLine,
  },
  pause: {
    slug: "pause",
    title: "Pause",
    question: "Can the owner freeze all transfers?",
    pictogram: "pause",
    group: "owner",
    foundLine: pauseLine,
  },
  blacklist: {
    slug: "blacklist",
    title: "Blacklist",
    question: "Can the owner block wallets?",
    pictogram: "blacklist",
    group: "owner",
    foundLine: () => blacklistLine(),
  },
  mint: {
    slug: "mint",
    title: "Mint",
    question: "Can the owner create new tokens?",
    pictogram: "mint",
    group: "owner",
    foundLine: mintLine,
  },
  "transfer-fee": {
    slug: "transfer-fee",
    title: "Transfer fee",
    question: "Can the owner change the transfer fee?",
    pictogram: "fee",
    group: "owner",
    foundLine: feeLine,
  },
  "transfer-limits": {
    slug: "transfer-limits",
    title: "Transfer limits",
    question: "Can the owner limit what you hold or send?",
    pictogram: "limits",
    group: "owner",
    foundLine: limitsLine,
  },
  "sell-block": {
    slug: "sell-block",
    title: "Sell block",
    question: "Can selling to the pool be blocked?",
    pictogram: "sellblock",
    group: "owner",
    foundLine: sellBlockLine,
  },
  "transfer-hooks": {
    slug: "transfer-hooks",
    title: "Transfer hooks",
    question: "Does each transfer call another contract?",
    pictogram: "hooks",
    group: "owner",
    foundLine: hooksLine,
  },
  "proxy-upgrade": {
    slug: "proxy-upgrade",
    title: "Proxy upgrade",
    question: "Can the code be replaced?",
    pictogram: "upgrade",
    group: "owner",
    foundLine: proxyLine,
  },
  capability: {
    slug: "capability",
    title: "Capability",
    question: "What can this code do at all?",
    pictogram: "capability",
    group: "tools",
    foundLine: capabilityLine,
  },
  decompiler: {
    slug: "decompiler",
    title: "Decompiler",
    question: "Which functions does the code have?",
    pictogram: "decompiler",
    group: "tools",
    foundLine: decompilerLine,
  },
  "clone-match": {
    slug: "clone-match",
    title: "Clone match",
    question: "Is this a copy of a known template?",
    pictogram: "clone",
    group: "tools",
    foundLine: cloneMatchLine,
  },
  "hard-to-analyze": {
    slug: "hard-to-analyze",
    title: "Hard to read",
    question: "Was the code hard to read?",
    pictogram: "tangle",
    group: "tools",
    foundLine: hardToAnalyzeLine,
  },
});

function lastSegment(id: string): string {
  const parts = id.split(".");
  return parts[parts.length - 1] ?? id;
}

// Slug rule (UI v2 §1.3): the last dot segment when it is unique across
// the registry, otherwise the full id, URL-encoded for the hash.
export function slugForPluginId(id: string, allIds: readonly string[]): string {
  const short = lastSegment(id);
  const collisions = allIds.filter((candidate) => candidate !== id && lastSegment(candidate) === short);
  if (collisions.length === 0) {
    return short;
  }
  return id;
}

// Copy applies to the canonical first-party detectors only. A
// third-party id with the same last segment (for example a test double)
// never borrows the first-party question and sentence: it renders in the
// PluginsPanel fallback instead.
export function copyForPluginId(id: string): PluginCopyEntry | null {
  if (!id.startsWith("dev.brandklipparen.")) {
    return null;
  }
  return PLUGIN_COPY[lastSegment(id)] ?? null;
}

export function pluginHref(address: string, pluginId: string, allIds: readonly string[]): string {
  return `#/token/${encodeURIComponent(address)}/plugins/${encodeURIComponent(slugForPluginId(pluginId, allIds))}`;
}

export function pluginIdForSlug(slug: string, allIds: readonly string[]): string | null {
  for (const id of allIds) {
    if (slugForPluginId(id, allIds) === slug) {
      return id;
    }
  }
  return null;
}
