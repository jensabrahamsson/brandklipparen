// Plain per-detector copy for the plugin board (UI v2 §5.1). Keyed by
// slug: the last dot segment of the plugin id when it is unique,
// otherwise the full id, URL-encoded. Never scored, never evidence:
// display strings only.
import type { PictogramName } from "./pictograms.ts";
import {
  decompilerSummaryLine,
  parseDecompilerFunctions,
  summarizeDecompilerFunctions,
} from "./decompilerView.ts";

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
  // "What this check can't tell you" (UI v2 §5.2): the honest limit in
  // plain words, paraphrased from the detector PLUGIN.md. Sentence case,
  // never the mechanism twice.
  readonly limits: string;
  // Can't-tell tile body (R3 D-9): one sentence per detector, so a wall
  // of can't-tell tiles never repeats the same line. Sentence case.
  readonly cantTellLine: string;
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

// The tile line reuses the shared decompiler summary (R3 D-8), so the
// tile, the detail header and the list summary print the same string for
// the same payloads. Any discrepancy between the three is a bug.
function decompilerLine(payloads: readonly unknown[]): string {
  return decompilerSummaryLine(summarizeDecompilerFunctions(parseDecompilerFunctions(payloads)));
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
  if (record !== null && (kind === "eip1967" || kind === "zos" || kind === "legacy-zos")) {
    const admin = textOf(record, "admin");
    const adminKind = textOf(record, "adminKind");
    if (admin !== null && adminKind !== null) {
      return `Upgradeable proxy \u00b7 admin ${admin} (${adminKind}) can replace the code`;
    }
    return "Upgradeable proxy can replace the code";
  }
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
    limits: "The code proves a stored owner and the functions it guards. Who holds the seat right now is read separately, and only at a pinned block.",
    cantTellLine: "We found no stored owner the code compares with the caller.",
  },
  pause: {
    slug: "pause",
    title: "Pause",
    question: "Can the owner freeze all transfers?",
    pictogram: "pause",
    group: "owner",
    foundLine: pauseLine,
    limits: "The code proves the freeze mechanism, not whether the switch is on right now or still callable.",
    cantTellLine: "We found no switch in the code that freezes transfers.",
  },
  blacklist: {
    slug: "blacklist",
    title: "Blacklist",
    question: "Can the owner block wallets?",
    pictogram: "blacklist",
    group: "owner",
    foundLine: () => blacklistLine(),
    limits: "The code proves the blocking mechanism, not whether it is a block list or an allow list, and not which wallets are listed.",
    cantTellLine: "We found no list in the code that blocks chosen wallets.",
  },
  mint: {
    slug: "mint",
    title: "Mint",
    question: "Can the owner create new tokens?",
    pictogram: "mint",
    group: "owner",
    foundLine: mintLine,
    limits: "The code proves new tokens can be created. Whether the function is still callable is not in the code.",
    cantTellLine: "The creation path was only partly readable, so minting stays unclear.",
  },
  "transfer-fee": {
    slug: "transfer-fee",
    title: "Transfer fee",
    question: "Can the owner change the transfer fee?",
    pictogram: "fee",
    group: "owner",
    foundLine: feeLine,
    limits: "The code proves the fee can change. The highest it can go is unknown when the setter has no cap.",
    cantTellLine: "The fee path was only partly readable, so fee changes stay unclear.",
  },
  "transfer-limits": {
    slug: "transfer-limits",
    title: "Transfer limits",
    question: "Can the owner limit what you hold or send?",
    pictogram: "limits",
    group: "owner",
    foundLine: limitsLine,
    limits: "The code proves limits can change, not the live numbers sitting in storage.",
    cantTellLine: "We found no limit value in the code that caps wallets or transfers.",
  },
  "sell-block": {
    slug: "sell-block",
    title: "Sell block",
    question: "Can selling to the pool be blocked?",
    pictogram: "sellblock",
    group: "owner",
    foundLine: sellBlockLine,
    limits: "The code proves a recipient-based block, not which direction counts as the sell.",
    cantTellLine: "The pool check was only partly readable, so selling may or may not block.",
  },
  "transfer-hooks": {
    slug: "transfer-hooks",
    title: "Transfer hooks",
    question: "Does each transfer call another contract?",
    pictogram: "hooks",
    group: "owner",
    foundLine: hooksLine,
    limits: "The code proves each transfer can call another contract, not what that contract does.",
    cantTellLine: "The call out of each transfer was only partly readable.",
  },
  "proxy-upgrade": {
    slug: "proxy-upgrade",
    title: "Proxy upgrade",
    question: "Can the code be replaced?",
    pictogram: "upgrade",
    group: "owner",
    foundLine: proxyLine,
    limits: "The code proves it can be replaced. Who can trigger the upgrade lives outside the code.",
    cantTellLine: "The upgrade path was only partly readable, so replacement stays unclear.",
  },
  capability: {
    slug: "capability",
    title: "Capability",
    question: "What can this code do at all?",
    pictogram: "capability",
    group: "tools",
    foundLine: capabilityLine,
    limits: "Presence is not reachability: a listed power may sit in dead code the token never runs.",
    cantTellLine: "The capability scan was only partly readable.",
  },
  decompiler: {
    slug: "decompiler",
    title: "Decompiler",
    question: "Which functions does the code have?",
    pictogram: "decompiler",
    group: "tools",
    foundLine: decompilerLine,
    limits: "A readable reconstruction, not the original source. Names are display only.",
    cantTellLine: "The function list was only partly readable.",
  },
  "clone-match": {
    slug: "clone-match",
    title: "Clone match",
    question: "Is this a copy of a known template?",
    pictogram: "clone",
    group: "tools",
    foundLine: cloneMatchLine,
    limits: "A similar template is a warning, not a verdict: the details can still differ.",
    cantTellLine: "The template comparison was only partly readable.",
  },
  "hard-to-analyze": {
    slug: "hard-to-analyze",
    title: "Hard to read",
    question: "Was the code hard to read?",
    pictogram: "tangle",
    group: "tools",
    foundLine: hardToAnalyzeLine,
    limits: "Marks a coverage gap, not a risk. Treat it as a reason to be careful.",
    cantTellLine: "The readability check itself was only partly readable.",
  },
});

// Temporality for the detail header (UI v2 §5.2): a renounce finding no
// longer applies; every other proven finding applies now. Quiet states
// have no temporality line.
export function temporalityLine(payloads: readonly unknown[]): string | null {
  for (const payload of payloads) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      continue;
    }
    const record = payload as Record<string, unknown>;
    if (record["feature"] === "renounce" || record["fact"] === "renounce") {
      return "No longer applies";
    }
  }
  return "Applies now";
}

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

// Status word for the neutral tool state (R3 D-8): tools ran, they did
// not find owner powers. The decompiler names its function count because
// that is what the tool read; every other tool reads plain "Ran".
export function ranStatusWord(copy: PluginCopyEntry, payloadCount: number): string {
  if (copy.slug !== "decompiler") {
    return "Ran";
  }
  return `Ran · ${payloadCount} ${payloadCount === 1 ? "function" : "functions"}`;
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
