// Blacklist detector plugin `dev.brandklipparen.blacklist` (S-115, P-12
// step 1). First-party detector behind the registry: proves an
// owner-controlled transfer gate from code paths. A finding needs both: a
// transfer path that reads a mapping entry beside an equality compare (or
// an ISZERO with no range compare between the load and the gate, so a
// plain balance check `balance >= amount` or an allowance check never
// counts) with a conditional jump that can revert, and a privileged region
// (a caller guard) that writes a mapping slot. The two may share one
// merged function. A gated read with no privileged writer, or a privileged
// mapping write the transfer path never gates on, stays silent: the proof
// is incomplete, so no positive finding is reported. Pure and
// synchronous: this module imports solely the plugin API and domain types
// and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { analyzeOwnerControl, flavorBetween, mappingLoadNearFlavor } from "../../../domain/ownerControl.ts";
import type { RegionFacts } from "../../../domain/ownerControl.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import { extractSelectors } from "../../../domain/selectors.ts";
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

// A transfer gate on a mapping entry: the mapping load sits beside an
// equality compare, or beside an ISZERO with no range compare between the
// load and the gate, plus a conditional jump that can revert. A balance
// check (`balances[from] >= amount`) or an allowance check compiles to a
// range compare closed by ISZERO, so ISZERO counts only when no LT or GT
// sits between the load and the gate. The mapping hash marks the read as
// an address-keyed lookup rather than a plain slot read.
function gatedMappingRead(region: RegionFacts): number | null {
  if (!region.hasKeccak || !region.hasJumpi || !region.hasRevert) {
    return null;
  }
  const eqProof = mappingLoadNearFlavor(region, ["eq"]);
  if (eqProof !== null) {
    return eqProof.loadPc;
  }
  const zeroProof = mappingLoadNearFlavor(region, ["iszero"]);
  if (zeroProof === null) {
    return null;
  }
  if (flavorBetween(region, ["lt", "gt"], zeroProof.loadPc, zeroProof.gatePc)) {
    return null;
  }
  return zeroProof.loadPc;
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
  const attribution = attributeFunctions(input.bytecode);
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
    const orderedTransfers = [...transferSet].sort();
    orderedTransfers.sort((left, right) => {
      const leftSame = left === region.selector ? 1 : 0;
      const rightSame = right === region.selector ? 1 : 0;
      if (leftSame !== rightSame) {
        return leftSame - rightSame;
      }
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    });
    for (const transferSelector of orderedTransfers) {
      const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
      if (transfer === undefined) {
        continue;
      }
      const gatePc = gatedMappingRead(transfer);
      if (gatePc === null) {
        continue;
      }
      const holder = attribution.holderOf(write.pc);
      const gateHolder = attribution.holderOf(gatePc);
      if (holder === null || gateHolder === null) {
        continue;
      }
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
