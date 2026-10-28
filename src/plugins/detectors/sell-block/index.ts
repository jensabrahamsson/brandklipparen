// Sell-block detector plugin `dev.brandklipparen.sell-block` (S-115,
// P-12 step 1). First-party detector behind the registry: proves
// sell-blocking honeypot branching from code paths. A finding needs all
// of the following in one transfer path: an equality compare, calldata
// beside it (the recipient under test), a stored address compare (a
// constant or hashed storage read of the pair or router), and a
// conditional jump that can revert (the sell branch). The condition is
// `pair-mapping` when a mapping read sits beside the branch (an isPair
// or balance family lookup), else `recipient-equals-stored`. An equality
// check with no stored address stays silent, since amount and allowance
// compares look the same without it. Pure and synchronous: this module
// imports solely the plugin API and domain types and pure functions
// (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { analyzeOwnerControl } from "../../../domain/ownerControl.ts";
import type { RegionFacts } from "../../../domain/ownerControl.ts";
import { containingSelector, extractSelectors } from "../../../domain/selectors.ts";
import { PcOffset } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.sell-block";

// Output schema descriptor for the finding list (ADR section 3.3): the
// draft-07 subset the registry documents. The contract suite checks the
// typed output and this descriptor against each other in both directions.
const OUTPUT_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 4,
  items: Object.freeze({
    type: "object",
    required: Object.freeze(["id", "pluginId", "title", "payload", "evidence"]),
    properties: Object.freeze({
      id: Object.freeze({ type: "string", minLength: 1 }),
      pluginId: Object.freeze({ const: PLUGIN_ID }),
      title: Object.freeze({ type: "string", minLength: 1 }),
      payload: Object.freeze({
        type: "object",
        required: Object.freeze(["feature", "condition"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "sell-block" }),
          condition: Object.freeze({
            enum: Object.freeze(["recipient-equals-stored", "pair-mapping"]),
          }),
        }),
        additionalProperties: false,
      }),
      evidence: Object.freeze({
        type: "array",
        minItems: 1,
        items: Object.freeze({
          type: "object",
          required: Object.freeze(["selector"]),
          properties: Object.freeze({
            selector: Object.freeze({ type: "string", minLength: 1 }),
            offset: Object.freeze({ type: Object.freeze(["integer", "null"]), minimum: 0 }),
          }),
          additionalProperties: false,
        }),
      }),
    }),
    additionalProperties: false,
  }),
});

function manifestOf(): DetectorPlugin["manifest"] {
  const parsed = PluginManifest.parse({
    id: PLUGIN_ID,
    version: "1.0.0",
    kind: "detector",
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Sell-block detector",
    description: "Reports transfer logic that branches on the recipient against a stored pair address.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`sell-block plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`sell-block plugin manifest carries kind ${parsed.value.kind}, expected detector`);
  }
  return parsed.value;
}

function toNonEmpty(items: EvidenceType[]): NonEmpty<EvidenceType> | null {
  const first = items[0];
  if (first === undefined) {
    return null;
  }
  return Object.freeze([first, ...items.slice(1)]) as NonEmpty<EvidenceType>;
}

function evidenceFor(
  bytecode: DetectorInput["bytecode"],
  selector: EvidenceType["selector"],
  pc: number,
): EvidenceType | null {
  const offset = PcOffset.of(pc, bytecode);
  if (!offset.ok) {
    return null;
  }
  const created = Evidence.create({ selector, offset: offset.value });
  return created.ok ? created.value : null;
}

// A sell branch in the transfer path: calldata beside an equality compare
// against a stored address (constant or hashed), with a conditional jump
// that can revert. Returns the compared storage reads proving the branch.
function sellBranch(
  region: RegionFacts,
): { condition: "recipient-equals-stored" | "pair-mapping"; reads: number[] } | null {
  if (!region.hasEq || !region.hasCalldataLoad || !region.hasJumpi || !region.hasRevert) {
    return null;
  }
  const stored = region.loads.filter(
    (load) => load.slot.kind === "const" || load.slot.kind === "mapping",
  );
  if (stored.length === 0) {
    return null;
  }
  const mapping = stored.some((load) => load.slot.kind === "mapping");
  return {
    condition: mapping ? "pair-mapping" : "recipient-equals-stored",
    reads: stored.map((load) => load.pc),
  };
}

// Sell-block proof over the frozen input. Total: arbitrary bytecode
// yields a finding list, never an exception. Deterministic: transfer
// regions scan in selector order and the first provable region wins.
// Bytecode without selectors yields no findings, since a finding without
// selector evidence is unrepresentable.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const view = analyzeOwnerControl(input.bytecode);
  const transferSet = new Set(view.transfers);
  for (const transferSelector of [...transferSet].sort()) {
    const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
    if (transfer === undefined) {
      continue;
    }
    const branch = sellBranch(transfer);
    if (branch === null) {
      continue;
    }
    const evidence: EvidenceType[] = [];
    for (const pc of branch.reads.slice(0, MANIFEST.limits.maxEvidencePerFinding)) {
      const holder = containingSelector(entries, pc) ?? transfer.selector;
      const entry = evidenceFor(input.bytecode, holder, pc);
      if (entry !== null) {
        evidence.push(entry);
      }
    }
    const nonEmpty = toNonEmpty(evidence);
    if (nonEmpty === null) {
      continue;
    }
    return Object.freeze([
      Object.freeze({
        id: `${PLUGIN_ID}:sell-block`,
        pluginId: MANIFEST.id,
        title: "Transfer path branches on the recipient against a stored address with a revert",
        evidence: nonEmpty,
        payload: Object.freeze({ feature: "sell-block", condition: branch.condition }),
      }),
    ]);
  }
  return Object.freeze([]);
}

const MANIFEST = manifestOf();

export const sellBlockDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
