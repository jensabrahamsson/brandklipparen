// Transfer-fee detector plugin `dev.brandklipparen.transfer-fee` (S-115,
// P-12 step 1). First-party detector behind the registry: proves an
// owner-settable transfer fee from code paths. A finding needs both: a
// privileged region (a caller guard) that stores a constant fee slot, and
// a transfer path that loads the same slot beside multiply or divide
// arithmetic. The max-fee bound is the largest constant the setter
// compares with while bounding (LT or GT present), capped at basis-point
// sense: a bound above 10000, or no bounding compare at all, reports a
// null bound instead of a guess. A fee slot the transfer path never
// computes with, or fee arithmetic with no privileged writer, stays
// silent. Pure and synchronous: this module imports solely the plugin API
// and domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { analyzeOwnerControl } from "../../../domain/ownerControl.ts";
import { containingSelector, disassemble, extractSelectors } from "../../../domain/selectors.ts";
import { PcOffset } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.transfer-fee";

// Basis-point sense cap for the reported max-fee bound: a fee cap above
// one hundred percent is not a cap, so the bound stays unknown instead
// of reporting a meaningless constant.
const MAX_SANE_BASIS_POINTS = 10000;

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
        required: Object.freeze(["feature", "slot", "maxFeeBasisPoints"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "transfer-fee" }),
          slot: Object.freeze({ type: "integer", minimum: 0 }),
          maxFeeBasisPoints: Object.freeze({ type: Object.freeze(["integer", "null"]), minimum: 0 }),
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
    displayName: "Transfer-fee detector",
    description: "Reports a fee slot set by a privileged caller and used arithmetically in the transfer path.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`transfer-fee plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`transfer-fee plugin manifest carries kind ${parsed.value.kind}, expected detector`);
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

// Largest constant PUSH in the setter region while it bounds with LT or
// GT, or null when the setter carries no bounding compare or no sane
// constant to report.
function maxFeeBound(bytecode: DetectorInput["bytecode"], entryPc: number, endPc: number): number | null {
  let bounded = false;
  let best: number | null = null;
  for (const instruction of disassemble(bytecode)) {
    if (instruction.pc < entryPc || instruction.pc >= endPc) {
      continue;
    }
    if (instruction.opcode === 0x10 || instruction.opcode === 0x11) {
      bounded = true;
    }
    if (instruction.opcode >= 0x60 && instruction.opcode <= 0x7f) {
      let value = 0;
      let fits = true;
      for (let i = 0; i < instruction.immediate.length; i += 1) {
        value = value * 256 + (instruction.immediate[i] ?? 0);
        if (value > MAX_SANE_BASIS_POINTS) {
          fits = false;
          break;
        }
      }
      if (fits && (best === null || value > best)) {
        best = value;
      }
    }
  }
  if (!bounded || best === null) {
    return null;
  }
  return best;
}

// Privileged fee proof over the frozen input. Total: arbitrary bytecode
// yields a finding list, never an exception. Deterministic: candidate
// slots scan ascending and the lowest provable slot wins. Bytecode without
// selectors yields no findings, since a finding without selector evidence
// is unrepresentable.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const view = analyzeOwnerControl(input.bytecode);
  const privilegedSet = new Set(view.privileged);
  const transferSet = new Set(view.transfers);
  const candidates = new Set<number>();
  for (const region of view.regions) {
    if (!privilegedSet.has(region.selector)) {
      continue;
    }
    for (const store of region.stores) {
      if (store.slot.kind === "const" && !store.valueIsZero) {
        candidates.add(store.slot.value);
      }
    }
  }
  const orderedSlots = [...candidates].sort((left, right) => left - right);
  const orderedRegions = view.regions.slice().sort((left, right) => left.entryPc - right.entryPc);
  for (const slot of orderedSlots) {
    for (let order = 0; order < orderedRegions.length; order += 1) {
      const region = orderedRegions[order];
      if (region === undefined) {
        continue;
      }
      const following = orderedRegions[order + 1];
      const regionEnd = following === undefined ? Number.MAX_SAFE_INTEGER : following.entryPc;
      if (!privilegedSet.has(region.selector)) {
        continue;
      }
      const store = region.stores.find(
        (candidate) => candidate.slot.kind === "const" && candidate.slot.value === slot,
      );
      if (store === undefined) {
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
        const read = transfer.loads.find(
          (load) => load.slot.kind === "const" && load.slot.value === slot,
        );
        if (read === undefined) {
          continue;
        }
        if (!transfer.hasMul && !transfer.hasDiv) {
          continue;
        }
        const holder = containingSelector(entries, store.pc) ?? region.selector;
        const readerHolder = containingSelector(entries, read.pc) ?? transfer.selector;
        const evidence: EvidenceType[] = [];
        const write = evidenceFor(input.bytecode, holder, store.pc);
        if (write !== null) {
          evidence.push(write);
        }
        const seen = evidenceFor(input.bytecode, readerHolder, read.pc);
        if (seen !== null) {
          evidence.push(seen);
        }
        const nonEmpty = toNonEmpty(evidence);
        if (nonEmpty === null) {
          continue;
        }
        return Object.freeze([
          Object.freeze({
            id: `${PLUGIN_ID}:transfer-fee`,
            pluginId: MANIFEST.id,
            title: "Privileged caller sets a fee slot used arithmetically in the transfer path",
            evidence: nonEmpty,
            payload: Object.freeze({
              feature: "transfer-fee",
              slot,
              maxFeeBasisPoints: maxFeeBound(input.bytecode, region.entryPc, regionEnd),
            }),
          }),
        ]);
      }
    }
  }
  return Object.freeze([]);
}

const MANIFEST = manifestOf();

export const transferFeeDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
