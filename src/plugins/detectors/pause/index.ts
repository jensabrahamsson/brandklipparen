// Pause detector plugin `dev.brandklipparen.pause` (S-115, P-12 step 1).
// First-party detector behind the registry: proves a privileged pause or
// trading toggle from code paths. A finding needs both: a privileged
// region (a caller guard) that stores a constant flag slot, and a
// transfer path that loads the same slot and reverts through a compare
// and a conditional jump. The mode is `trading-toggle` when no store to
// the slot ever writes zero and some store writes a nonzero constant
// (a one-way enable), `pause` when a zero write exists (the flag flips
// both ways), and `unknown` otherwise. An ungated flag, or a gate with no
// privileged writer, stays silent. Pure and synchronous: this module
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

const PLUGIN_ID = "dev.brandklipparen.pause";

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
        required: Object.freeze(["feature", "slot", "mode"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "pause" }),
          slot: Object.freeze({ type: "integer", minimum: 0 }),
          mode: Object.freeze({ enum: Object.freeze(["pause", "trading-toggle", "unknown"]) }),
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
    displayName: "Pause detector",
    description: "Reports a boolean flag set by a privileged caller that gates the transfer path.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`pause plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`pause plugin manifest carries kind ${parsed.value.kind}, expected detector`);
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

// A transfer gate on a constant flag slot: the slot loads beside an
// equality compare and a conditional jump that can revert. Ordered
// compares (LT, GT) belong to limit checks, not boolean flags, so a
// region carrying them never proves a pause gate.
function gatedFlagRead(region: RegionFacts, slot: number): number | null {
  if (!region.hasJumpi || !region.hasRevert) {
    return null;
  }
  if (region.hasLt || region.hasGt) {
    return null;
  }
  if (!region.hasEq && !region.hasIsZero) {
    return null;
  }
  const read = region.loads.find(
    (load) => load.slot.kind === "const" && load.slot.value === slot,
  );
  return read === undefined ? null : read.pc;
}

function toggleMode(regions: readonly RegionFacts[], slot: number): "pause" | "trading-toggle" | "unknown" {
  let zeroWrite = false;
  let nonzeroWrite = false;
  for (const region of regions) {
    for (const store of region.stores) {
      if (store.slot.kind !== "const" || store.slot.value !== slot) {
        continue;
      }
      if (store.valueIsZero) {
        zeroWrite = true;
      } else if (store.valueConst !== null && store.valueConst !== 0) {
        nonzeroWrite = true;
      }
    }
  }
  if (zeroWrite) {
    return "pause";
  }
  if (nonzeroWrite) {
    return "trading-toggle";
  }
  return "unknown";
}

// Privileged flag proof over the frozen input. Total: arbitrary bytecode
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
      if (store.slot.kind === "const") {
        candidates.add(store.slot.value);
      }
    }
  }
  const orderedSlots = [...candidates].sort((left, right) => left - right);
  for (const slot of orderedSlots) {
    for (const region of view.regions) {
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
        const gatePc = gatedFlagRead(transfer, slot);
        if (gatePc === null) {
          continue;
        }
        const holder = containingSelector(entries, store.pc) ?? region.selector;
        const gateHolder = containingSelector(entries, gatePc) ?? transfer.selector;
        const evidence: EvidenceType[] = [];
        const written = evidenceFor(input.bytecode, holder, store.pc);
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
            id: `${PLUGIN_ID}:pause`,
            pluginId: MANIFEST.id,
            title: "Privileged caller sets a flag that gates the transfer path",
            evidence: nonEmpty,
            payload: Object.freeze({
              feature: "pause",
              slot,
              mode: toggleMode(view.regions, slot),
            }),
          }),
        ]);
      }
    }
  }
  return Object.freeze([]);
}

const MANIFEST = manifestOf();

export const pauseDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
