// Blacklist detector plugin `dev.brandklipparen.blacklist` (S-115, P-12
// step 1). First-party detector behind the registry: proves an
// owner-controlled transfer gate from code paths. A finding needs both: a
// transfer path that reads a mapping entry and reverts on its value, and a
// privileged region (a caller guard) that writes a mapping slot. A gated
// read with no privileged writer, or a privileged mapping write the
// transfer path never gates on, stays silent: the proof is incomplete, so
// no positive finding is reported. Pure and synchronous: this module
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

const PLUGIN_ID = "dev.brandklipparen.blacklist";

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
        required: Object.freeze(["feature"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "blacklist" }),
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
    displayName: "Blacklist detector",
    description: "Reports a transfer gate on a mapping entry that a privileged caller can set.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`blacklist plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`blacklist plugin manifest carries kind ${parsed.value.kind}, expected detector`);
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

// A transfer gate: a mapping read whose value steers a revert through a
// compare and a conditional jump. The mapping hash marks the read as an
// address-keyed lookup rather than a plain slot read.
function gatedMappingRead(region: RegionFacts): number | null {
  if (!region.hasKeccak || !region.hasJumpi || !region.hasRevert) {
    return null;
  }
  if (!region.hasEq && !region.hasIsZero) {
    return null;
  }
  const read = region.loads.find((load) => load.slot.kind === "mapping");
  return read === undefined ? null : read.pc;
}

// Privileged mapping write proof over the frozen input. Total: arbitrary
// bytecode yields a finding list, never an exception. Deterministic:
// regions scan in selector order and the single finding names the first
// provable pair. Bytecode without selectors yields no findings, since a
// finding without selector evidence is unrepresentable.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const view = analyzeOwnerControl(input.bytecode);
  const privilegedSet = new Set(view.privileged);
  const transferSet = new Set(view.transfers);
  for (const region of view.regions) {
    if (!privilegedSet.has(region.selector)) {
      continue;
    }
    const write = region.stores.find((store) => store.slot.kind === "mapping");
    if (write === undefined) {
      continue;
    }
    for (const transferSelector of transferSet) {
      if (transferSelector === region.selector) {
        continue;
      }
      const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
      if (transfer === undefined) {
        continue;
      }
      const gatePc = gatedMappingRead(transfer);
      if (gatePc === null) {
        continue;
      }
      const holder = containingSelector(entries, write.pc) ?? region.selector;
      const gateHolder = containingSelector(entries, gatePc) ?? transfer.selector;
      const evidence: EvidenceType[] = [];
      const written = evidenceFor(input.bytecode, holder, write.pc);
      if (written !== null) {
        evidence.push(written);
      }
      const gate = evidenceFor(input.bytecode, gateHolder, gatePc);
      if (gate !== null) {
        evidence.push(gate);
      }
      const nonEmpty = toNonEmpty(evidence);
      if (nonEmpty === null) {
        continue;
      }
      return Object.freeze([
        Object.freeze({
          id: `${PLUGIN_ID}:blacklist`,
          pluginId: MANIFEST.id,
          title: "Privileged caller can set a mapping entry that gates the transfer path",
          evidence: nonEmpty,
          payload: Object.freeze({ feature: "blacklist" }),
        }),
      ]);
    }
  }
  return Object.freeze([]);
}

const MANIFEST = manifestOf();

export const blacklistDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
