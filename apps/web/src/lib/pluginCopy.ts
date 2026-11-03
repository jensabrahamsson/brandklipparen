// Plain per-detector copy for the plugin board (UI v2 §5.1). Keyed by
// slug: the last dot segment of the plugin id when it is unique,
// otherwise the full id, URL-encoded. Never scored, never evidence:
// display strings only.
import type { PictogramName } from "./pictograms.ts";
import { toChecksumAddress } from "./checksumAddress.ts";
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
  delegatecall: "Runs outside code",
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
    return "Code can do more than move tokens.";
  }
  return labels.join(" · ");
}

// The tile line reuses the shared decompiler summary (R3 D-8), so the
// tile, the detail header and the list summary print the same string for
// the same payloads. Any discrepancy between the three is a bug.
function decompilerLine(payloads: readonly unknown[]): string {
  return decompilerSummaryLine(summarizeDecompilerFunctions(parseDecompilerFunctions(payloads)));
}

function cloneMatchLine(): string {
  return "Matches a known template.";
}

const HARD_CAUSE_LINES: Record<string, string> = Object.freeze({
  timeout: "Timed out.",
  "resource-limit": "Too large.",
  "decompiler-error": "Decompiler failed.",
  "obfuscated-structure": "Built to be hard to read.",
});

function hardToAnalyzeLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["cause"]);
  const cause = record === null ? null : textOf(record, "cause");
  if (cause !== null && HARD_CAUSE_LINES[cause] !== undefined) {
    return HARD_CAUSE_LINES[cause] as string;
  }
  return "Code not fully read.";
}

// Status word for the readability check (hard-to-analyze). A quiet check
// reads "Readable" (callers render that for the not-found state); a
// finding reads "Obfuscated" when the cause is obfuscated code, and
// "Read incomplete" for the other causes (timeout, size, decompiler).
export function readabilityStatusWord(payloads: readonly unknown[]): "Obfuscated" | "Read incomplete" {
  const record = firstPayloadWith(payloads, ["cause"]);
  const cause = record === null ? null : textOf(record, "cause");
  return cause === "obfuscated-structure" ? "Obfuscated" : "Read incomplete";
}

// Status word for a quiet check without a finding: the readability check
// is "Readable", the clone match is "No match", every other check is
// "Not found". Callers pass the check slug, never a generic phrase.
export function quietStatusWord(slug: string): string {
  if (slug === "hard-to-analyze") {
    return "Readable";
  }
  if (slug === "clone-match") {
    return "No match";
  }
  return "Not found";
}

function ownershipLine(payloads: readonly unknown[]): string {
  const lines: string[] = [];
  for (const payload of payloads) {
    const record = recordOf(payload);
    if (record === null) {
      continue;
    }
    if (record["feature"] === "renounce" || record["fact"] === "renounce") {
      lines.push("Owner can renounce.");
      continue;
    }
    const count = record["privilegedFunctions"];
    if (typeof count === "number" && Number.isFinite(count)) {
      const word = count === 1 ? "function" : "functions";
      lines.push(`Owner controls ${count} ${word}.`);
    }
  }
  if (lines.length === 0) {
    return "Has an owner.";
  }
  return uniqueJoin(lines);
}

function pauseLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["mode"]);
  const mode = record === null ? null : textOf(record, "mode");
  if (mode === "pause") {
    return "Owner can freeze transfers.";
  }
  if (mode === "trading-toggle") {
    return "Owner can pause trading.";
  }
  return "Owner can stop transfers.";
}

function mintLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["capped", "recipient"]);
  if (record !== null) {
    if (record["capped"] === true) {
      return "Owner can mint. Capped.";
    }
    if (record["capped"] === false) {
      return "Owner can mint. No cap found.";
    }
    return "Owner can mint.";
  }
  const cappedOnly = firstPayloadWith(payloads, ["capped"]);
  if (cappedOnly !== null) {
    return cappedOnly["capped"] === true ? "Owner can mint. Capped." : "Owner can mint. No cap found.";
  }
  return "Owner can mint.";
}

function feeLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["capSlot"]);
  if (record !== null && record["capSlot"] !== null && record["capSlot"] !== undefined) {
    return "Owner can set the transfer fee. Capped.";
  }
  return "Owner can set the transfer fee.";
}

function limitsLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["limitKind"]);
  const kind = record === null ? null : textOf(record, "limitKind");
  if (kind === "max-wallet") {
    return "Owner can limit wallets.";
  }
  if (kind === "max-tx") {
    return "Owner can limit sizes.";
  }
  return "Owner can limit transfers.";
}

function sellBlockLine(): string {
  return "Owner can block sells.";
}

function hooksLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["target"]);
  const target = record === null ? null : textOf(record, "target");
  if (target === "storage") {
    return "Transfers call an owner-set contract.";
  }
  if (target === "argument") {
    return "Transfers call a contract the sender picks.";
  }
  return "Transfers call another contract.";
}

function proxyLine(payloads: readonly unknown[]): string {
  const record = firstPayloadWith(payloads, ["proxyKind"]);
  const kind = record === null ? null : textOf(record, "proxyKind");
  if (record !== null && (kind === "eip1967" || kind === "zos" || kind === "legacy-zos")) {
    const admin = textOf(record, "admin");
    if (admin !== null && textOf(record, "adminKind") !== null) {
      return `Proxy. Admin ${toChecksumAddress(admin)} can swap the code.`;
    }
    return "Proxy. Can swap the code.";
  }
  if (kind === "uups") {
    return "Code can be swapped (UUPS).";
  }
  if (kind === "eip1967") {
    return "Code can be swapped (EIP-1967).";
  }
  return "Code can be swapped.";
}

function blacklistLine(): string {
  return "Owner can block wallets.";
}

export const PLUGIN_COPY: Record<string, PluginCopyEntry> = Object.freeze({
  ownership: {
    slug: "ownership",
    title: "Ownership",
    question: "Is there an owner?",
    pictogram: "owner",
    group: "owner",
    foundLine: ownershipLine,
    limits: "Proves an owner exists. Who owns it is read live.",
    cantTellLine: "No owner found in the code.",
  },
  pause: {
    slug: "pause",
    title: "Pause",
    question: "Can the owner freeze transfers?",
    pictogram: "pause",
    group: "owner",
    foundLine: pauseLine,
    limits: "Proves a freeze exists, not whether it is on.",
    cantTellLine: "No freeze found.",
  },
  blacklist: {
    slug: "blacklist",
    title: "Blacklist",
    question: "Can the owner block wallets?",
    pictogram: "blacklist",
    group: "owner",
    foundLine: () => blacklistLine(),
    limits: "Proves blocking exists, not who is blocked.",
    cantTellLine: "No blocklist found.",
  },
  mint: {
    slug: "mint",
    title: "Mint",
    question: "Can the owner create new tokens?",
    pictogram: "mint",
    group: "owner",
    foundLine: mintLine,
    limits: "Proves minting exists, not that it is still usable.",
    cantTellLine: "Minting unclear. Code partly unreadable.",
  },
  "transfer-fee": {
    slug: "transfer-fee",
    title: "Transfer fee",
    question: "Can the owner change the transfer fee?",
    pictogram: "fee",
    group: "owner",
    foundLine: feeLine,
    limits: "Fee can change. Max unknown without a cap.",
    cantTellLine: "Fee unclear. Code partly unreadable.",
  },
  "transfer-limits": {
    slug: "transfer-limits",
    title: "Transfer limits",
    question: "Can the owner cap what you hold or send?",
    pictogram: "limits",
    group: "owner",
    foundLine: limitsLine,
    limits: "Limits can change. Live values unknown.",
    cantTellLine: "No limits found.",
  },
  "sell-block": {
    slug: "sell-block",
    title: "Sell block",
    question: "Can the owner block selling?",
    pictogram: "sellblock",
    group: "owner",
    foundLine: sellBlockLine,
    limits: "Proves a pool block exists.",
    cantTellLine: "Sell block unclear. Code partly unreadable.",
  },
  "transfer-hooks": {
    slug: "transfer-hooks",
    title: "Transfer hooks",
    question: "Do transfers call another contract?",
    pictogram: "hooks",
    group: "owner",
    foundLine: hooksLine,
    limits: "Not what it does.",
    cantTellLine: "Transfer calls partly unreadable.",
  },
  "proxy-upgrade": {
    slug: "proxy-upgrade",
    title: "Proxy upgrade",
    question: "Can the code be swapped?",
    pictogram: "upgrade",
    group: "owner",
    foundLine: proxyLine,
    limits: "Proves it can. Who can is read live.",
    cantTellLine: "Unclear. Code partly unreadable.",
  },
  capability: {
    slug: "capability",
    title: "Capability",
    question: "What can this code do?",
    pictogram: "capability",
    group: "tools",
    foundLine: capabilityLine,
    limits: "A listed power may be dead code.",
    cantTellLine: "Capabilities partly unreadable.",
  },
  decompiler: {
    slug: "decompiler",
    title: "Decompiler",
    question: "What functions exist?",
    pictogram: "decompiler",
    group: "tools",
    foundLine: decompilerLine,
    limits: "Rebuilt from bytes. Names may be guesses.",
    cantTellLine: "Function list partly unreadable.",
  },
  "clone-match": {
    slug: "clone-match",
    title: "Clone match",
    question: "Is this a known scam template?",
    pictogram: "clone",
    group: "tools",
    foundLine: cloneMatchLine,
    limits: "Similar is a warning, not proof.",
    cantTellLine: "Template comparison partly unreadable.",
  },
  "hard-to-analyze": {
    slug: "hard-to-analyze",
    title: "Obfuscated code",
    question: "Is the code hard to read?",
    pictogram: "tangle",
    group: "tools",
    foundLine: hardToAnalyzeLine,
    limits: "Code too tangled to read fully. Hidden powers may be missed.",
    cantTellLine: "Code partly unreadable.",
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
      return "Lifted";
    }
  }
  return "Active";
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
