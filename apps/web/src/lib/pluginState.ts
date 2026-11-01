// Tile state for the plugin board (UI v2 §5.1). Pure: the first match
// wins, exactly in the spec table order. Never scored, never evidence:
// it only names what the analysis already reported.
//
// Analysis tools get their own neutral state (R3 D-8): they ran, they
// are not owner powers, and they never read can't tell. `ran` carries
// the tool glyph with no severity rail and no fill.
export type PluginState = "error" | "not-run" | "found-scored" | "extended" | "cant-tell" | "not-found" | "ran";

export type PluginResultLike = {
  readonly outcome: string;
  readonly findings: readonly { readonly payload?: unknown }[];
};

export type CantTellContext = {
  // Whether the hard-to-analyze detector fired on this analysis.
  readonly hardToAnalyzeFired: boolean;
  // Whether the decompiler marks transfer/transferFrom partly read.
  readonly partialTransfer: boolean;
};

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isExtendedPayload(payload: unknown): boolean {
  const record = recordOf(payload);
  return record !== null && typeof record["fact"] === "string" && record["proof"] === "extended";
}

// A scored (in-score) positive: an owner-control `feature`, a capability
// key, a clone-template hit, a decompiled function, or a hard-to-read
// cause. Unknown payload shapes are not positives.
function isScoredPayload(payload: unknown): boolean {
  const record = recordOf(payload);
  if (record === null) {
    return false;
  }
  if (typeof record["feature"] === "string") {
    return true;
  }
  if (typeof record["capability"] === "string") {
    return true;
  }
  if (typeof record["group"] === "string" && typeof record["similarity"] === "number") {
    return true;
  }
  if (typeof record["selector"] === "string" && "cause" in record) {
    return true;
  }
  return typeof record["cause"] === "string";
}

export function pluginState(
  result: PluginResultLike | undefined,
  context: CantTellContext,
  group: "owner" | "tools" = "owner",
): PluginState {
  if (result === undefined) {
    return "not-run";
  }
  if (result.outcome === "threw" || result.outcome === "invalid-output" || result.outcome === "timeout") {
    return "error";
  }
  if (result.outcome === "input-unavailable") {
    return "not-run";
  }
  const findings = result.findings;
  // Tools are not owner powers, so the can't-tell rule never applies to
  // them: a tool with output ran, a tool without output found nothing.
  if (group === "tools") {
    return findings.length > 0 ? "ran" : "not-found";
  }
  if (findings.some((finding) => isScoredPayload(finding.payload))) {
    return "found-scored";
  }
  if (findings.length > 0 && findings.every((finding) => isExtendedPayload(finding.payload))) {
    return "extended";
  }
  if (findings.length === 0 && (context.hardToAnalyzeFired || context.partialTransfer)) {
    return "cant-tell";
  }
  return "not-found";
}

export type ProofStepLike = {
  readonly ok: boolean;
};

// Headline for the proof trace (UI v2 §5.5, W-11): the wording behind
// the not-found vs can't-tell detail copy. Every step proven reads
// found; otherwise the trace names the step where it stopped, so the
// detail never guesses between "not found" and "can't tell" without
// showing its work.
export function proofHeadline(steps: readonly ProofStepLike[]): string {
  if (steps.length === 0) {
    return "No proof steps reported.";
  }
  const firstFailed = steps.findIndex((entry) => !entry.ok);
  if (firstFailed === -1) {
    return "All steps proven";
  }
  return `We stopped at step ${firstFailed + 1} of ${steps.length}`;
}

export const PLUGIN_STATE_WORD: Record<PluginState, string> = Object.freeze({
  error: "Error",
  "not-run": "Not run",
  "found-scored": "Found",
  extended: "Found",
  "cant-tell": "Can't tell",
  "not-found": "Not found",
  ran: "Ran",
});
