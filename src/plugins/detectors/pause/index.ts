// Pause detector plugin `dev.brandklipparen.pause` (S-115, P-12 step 1).
// First-party detector behind the registry: proves a privileged pause or
// trading toggle from code paths. A finding needs a privileged writer
// (a caller guard) storing a flag slot, and a transfer path that loads the
// same slot beside an equality compare (or an ISZERO with no range compare
// between the load and the gate, so a balance check `balance >= amount`
// never counts) with a conditional jump that can revert. The writer and
// the gate may live in the same function when solc merges code. The mode
// is `trading-toggle` when no store to the slot ever writes zero and some
// store writes a nonzero constant (a one-way enable), `pause` when a zero
// write exists (the flag flips both ways), and `unknown` otherwise. An
// ungated flag, a gate with no privileged writer, or an amount comparison
// stays silent. Pure and synchronous: this module imports solely the
// plugin API and domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { analyzeOwnerControl, constSlotLoadNearFlavor, flavorBetween } from "../../../domain/ownerControl.ts";
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
// equality compare, or beside an ISZERO with no range compare between the
// load and the gate, plus a conditional jump that can revert. A bounded
// amount check in the same region keeps its own LT or GT, but the veto is
// positional: only a compare between this load and this gate disqualifies
// the boolean reading, so an unrelated bound elsewhere never vetoes it.
function gatedFlagRead(region: RegionFacts, slot: number): number | null {
  if (!region.hasJumpi || !region.hasRevert) {
    return null;
  }
  const eqProof = constSlotLoadNearFlavor(region, slot, ["eq"]);
  if (eqProof !== null) {
    return eqProof.loadPc;
  }
  const zeroProof = constSlotLoadNearFlavor(region, slot, ["iszero"]);
  if (zeroProof === null) {
    return null;
  }
  if (flavorBetween(region, ["lt", "gt"], zeroProof.loadPc, zeroProof.gatePc)) {
    return null;
  }
  return zeroProof.loadPc;
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
// A flag write: the writer stores zero (disabling) or a small boolean
// constant (enabling), never a computed amount or a large constant. A
// computed or large store is a rate or a limit, not a boolean flag, so a
// fee or limits setter never doubles as a pause setter.
function flagWriter(region: RegionFacts, slot: number): number | null {
  const store = region.stores.find(
    (candidate) => candidate.slot.kind === "const" && candidate.slot.value === slot,
  );
  if (store === undefined) {
    return null;
  }
  if (store.valueIsZero) {
    return store.pc;
  }
  if (store.valueConst !== null && store.valueConst <= 1) {
    return store.pc;
  }
  return null;
}

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
      if (store.slot.kind !== "const") {
        continue;
      }
      if (store.valueIsZero || (store.valueConst !== null && store.valueConst <= 1)) {
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
      const writePc = flagWriter(region, slot);
      if (writePc === null) {
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
        const gatePc = gatedFlagRead(transfer, slot);
        if (gatePc === null) {
          continue;
        }
        const holder = containingSelector(entries, writePc) ?? region.selector;
        const gateHolder = containingSelector(entries, gatePc) ?? transfer.selector;
        const evidence: EvidenceType[] = [];
        const written = evidenceFor(input.bytecode, holder, writePc);
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
