// Citation targets for Muse sentences (round-3 review D-5). Model
// sentences cite coverage ids beside the collected `signal:` ids; every
// known shape maps to a short plain label plus a navigation target, and
// anything unknown maps to null so the UI renders no chip at all, never
// a raw id. Scores, signals and evidence are untouched: this only
// decides how a citation chip reads and where it goes.
import type { Signal } from "../types.ts";
import { evidenceSignalKey } from "./investigation.ts";
import { copyForPluginId, pluginHref } from "./pluginCopy.ts";
import { signalTitle } from "./signals.ts";

export type CitationLamp = "found" | "notfound" | "canttell" | "check" | "partial";

export type CitationTarget =
  | { readonly kind: "signal"; readonly label: string; readonly lamp: "found"; readonly signalKey: string }
  | { readonly kind: "plugin"; readonly label: string; readonly lamp: CitationLamp; readonly href: string }
  | { readonly kind: "cant-tell"; readonly label: string; readonly lamp: "canttell" };

export type CitationContext = {
  readonly signals: readonly Signal[];
  readonly address: string;
  readonly allIds: readonly string[];
};

// Short plain titles per known signal id (D-5: chips read like the board,
// for example "Blacklist", never a raw id). A signal present in the
// result but missing here falls back to its plain signal title, which
// never carries raw hex either.
const SIGNAL_SHORT_TITLE: Readonly<Record<string, string>> = Object.freeze({
  "owner-blacklist": "Blacklist",
  mintable: "Mint",
  pausable: "Pause",
  "fee-on-transfer": "Transfer fee",
  "owner-withdraw": "Withdraw",
  "proxy-upgrade": "Proxy upgrade",
  "honeypot-transfer": "Honeypot",
});

// Short chip words per known can't-tell question, mirroring the backend
// coverage set: only these questions are citable, anything else is null.
const CANT_TELL_SHORT: Readonly<Record<string, string>> = Object.freeze({
  "liquidity-locks": "Liquidity lock",
  "owner-shares": "Owner shares",
  "wallet-clusters": "Wallet clusters",
  "team-identity": "Team identity",
  "code-intent": "Code intent",
  "external-contracts": "External contracts",
});

function lastSegment(id: string): string {
  const parts = id.split(".");
  return parts[parts.length - 1] ?? id;
}

function humanizeSegment(segment: string): string {
  const words = segment.replace(/[-_]+/g, " ").trim();
  if (words.length === 0) {
    return "";
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function pluginTitle(pluginId: string): string | null {
  const copy = copyForPluginId(pluginId);
  if (copy !== undefined && copy !== null) {
    return copy.title;
  }
  const human = humanizeSegment(lastSegment(pluginId));
  return human.length === 0 ? null : human;
}

function checkTarget(
  id: string,
  ctx: CitationContext,
): CitationTarget | null {
  const rest = id.slice("check:".length);
  const split = rest.lastIndexOf(":");
  if (split <= 0 || split === rest.length - 1) {
    return null;
  }
  const pluginId = rest.slice(0, split);
  const outcome = rest.slice(split + 1);
  if (outcome !== "not-found" && outcome !== "could-not-check") {
    return null;
  }
  const title = pluginTitle(pluginId);
  if (title === null) {
    return null;
  }
  return {
    kind: "plugin",
    label: outcome === "not-found" ? `${title} · not found` : `${title} · can't tell`,
    lamp: outcome === "not-found" ? "notfound" : "canttell",
    href: pluginHref(ctx.address, pluginId, ctx.allIds),
  };
}

function signalTarget(
  id: string,
  ctx: CitationContext,
): CitationTarget | null {
  const key = evidenceSignalKey(ctx.signals, id);
  if (key === null) {
    return null;
  }
  const signalId = id.slice("signal:".length);
  const short = SIGNAL_SHORT_TITLE[signalId];
  if (short !== undefined) {
    return { kind: "signal", label: short, lamp: "found", signalKey: key };
  }
  const signal = ctx.signals.find((candidate) => candidate.id === signalId);
  if (signal === undefined) {
    return null;
  }
  return { kind: "signal", label: signalTitle(signal), lamp: "found", signalKey: key };
}

// Every coverage id shape maps to a label plus a target; unknown ids
// map to null. Mirrors the backend citation check shapes (`signal:`,
// `check:<detector>:not-found|could-not-check`, `cant-tell:<known
// question>`, `analysis:summary`, `analysis:decompile-incomplete`).
export function citationTarget(id: string, ctx: CitationContext): CitationTarget | null {
  if (id.startsWith("signal:")) {
    return signalTarget(id, ctx);
  }
  if (id.startsWith("check:")) {
    return checkTarget(id, ctx);
  }
  if (id.startsWith("cant-tell:")) {
    const short = CANT_TELL_SHORT[id.slice("cant-tell:".length)];
    if (short === undefined) {
      return null;
    }
    return { kind: "cant-tell", label: `${short} · can't tell`, lamp: "canttell" };
  }
  if (id === "analysis:summary") {
    return {
      kind: "plugin",
      label: "What we checked",
      lamp: "check",
      href: `#/token/${encodeURIComponent(ctx.address)}/plugins`,
    };
  }
  if (id === "analysis:decompile-incomplete") {
    return {
      kind: "plugin",
      label: "Decompiler · partly read",
      lamp: "partial",
      href: pluginHref(ctx.address, "dev.brandklipparen.decompiler", ctx.allIds),
    };
  }
  return null;
}
