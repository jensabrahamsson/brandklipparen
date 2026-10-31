// Pause detector plugin `dev.brandklipparen.pause` (S-115, P-12 step 1,
// P-11 extended analysis). First-party detector behind the registry:
// proves a privileged pause or trading toggle from code paths. A finding
// needs a privileged writer (a caller guard) storing a flag slot, and a
// transfer path that loads the same slot beside an equality compare (or
// an ISZERO with no range compare between the load and the gate, so a
// balance check `balance >= amount` never counts) with a conditional jump
// that can revert. The writer and the gate may live in the same function
// when solc merges code. The mode is `trading-toggle` when no store to
// the slot ever writes zero and some store writes a nonzero constant (a
// one-way enable), `pause` when a zero write exists (the flag flips both
// ways), and `unknown` otherwise. An ungated flag, a gate with no
// privileged writer, or an amount comparison stays silent. When the v1
// proof finds nothing, the same proof re-runs on the v2 reachability
// view (shared helpers included, packed-bool writes resolved) and emits
// a weight-0 `fact` finding with `proof: "extended"` that never converts
// to a signal. Pure and synchronous: this module imports solely the
// plugin API and domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import {
  TRANSFER_FROM_SELECTOR,
  TRANSFER_SELECTOR,
  analyzeOwnerControl,
  constSlotLoadNearFlavor,
  flavorBetween,
  hasOwnerCallerCheck,
  hasRevertingJumpiAfter,
  interpretRegionSlots,
  isStandardTokenWriter,
  packedBoolWriteAt,
  packedGateShift,
} from "../../../domain/ownerControl.ts";
import type { RegionFacts, SlotLookup } from "../../../domain/ownerControl.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import { disassemble, extractSelectors } from "../../../domain/selectors.ts";
import type { Selector as SelectorType } from "../../../domain/types.ts";
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
        required: Object.freeze(["slot", "mode"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "pause" }),
          fact: Object.freeze({ const: "pause" }),
          proof: Object.freeze({ const: "extended" }),
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
// fee or limits setter never doubles as a pause setter. In v2 views the
// packed-bool read resolves the shifted bit into `valueConst`, so the
// same check also proves a packed `owner|paused` slot-0 write; v1 views
// never carry packed values, so the scored finding set stays unchanged.
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

function detectV1(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode);
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
        const holder = attribution.holderOf(writePc);
        const gateHolder = attribution.holderOf(gatePc);
        if (holder === null || gateHolder === null) {
          continue;
        }
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

// Extended gate proof (P-11 session 1 follow-up): the flag read beside a
// compare, with the compare PC so the caller can prove the blocked side
// reverts. Kept beside `gatedFlagRead` (which the scored path owns) so
// the v1 proof never changes.
function gatedFlagReadPrecise(
  region: RegionFacts,
  slot: number,
): { readonly loadPc: number; readonly cmpPc: number } | null {
  if (!region.hasJumpi || !region.hasRevert) {
    return null;
  }
  const eqProof = constSlotLoadNearFlavor(region, slot, ["eq"]);
  if (eqProof !== null) {
    return Object.freeze({ loadPc: eqProof.loadPc, cmpPc: eqProof.gatePc });
  }
  const zeroProof = constSlotLoadNearFlavor(region, slot, ["iszero"]);
  if (zeroProof === null) {
    return null;
  }
  if (flavorBetween(region, ["lt", "gt"], zeroProof.loadPc, zeroProof.gatePc)) {
    return null;
  }
  return Object.freeze({ loadPc: zeroProof.loadPc, cmpPc: zeroProof.gatePc });
}

// Extended analysis (P-11, weight-0 fact): the flag proof over the v2
// reachability view, where shared helpers join every entry that reaches
// them and packed-bool writes resolve to their bit, tightened so plain
// token mechanics never prove a pause. The writer must carry a caller
// check against the proven owner slot (never a standard token entry),
// the gate must sit on a transfer/transferFrom path whose blocked side
// reverts, and a packed writer must write the same slot and bit the gate
// reads (old-solc EXP-built shifts included). It runs only when the v1
// proof found nothing, so a scored finding always wins and the extended
// finding never shadows it. The payload carries `fact` (never `feature`)
// with `proof: "extended"`, so the finding never converts to a signal
// and stays at weight 0. The title mirrors the 1.1.0 origin sentence for
// pause (see `ORIGIN_SENTENCE` in src/domain/explain.ts) with the
// not-in-score marker; it names no account, so no changer is claimed
// without the P-2 ownership proof.
function detectExtended(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode, { mode: "v2" });
  const view = analyzeOwnerControl(input.bytecode, { reach: "v2" });
  if (view.ownerSlot === null) {
    return Object.freeze([]);
  }
  const ownerSlot = view.ownerSlot;
  const code = disassemble(input.bytecode);
  const memberOf = (selector: SelectorType): ((pc: number) => boolean) => {
    return (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
  };
  const sstoreIndexAt = (pc: number): number => code.findIndex((instruction) => instruction.pc === pc);
  const candidates = new Set<number>();
  for (const region of view.regions) {
    if (isStandardTokenWriter(region.selector)) {
      continue;
    }
    // The v2 interpreter proves the writer guard through DUP/SWAP chains.
    const candidateSlots = interpretRegionSlots(input.bytecode, region.selector);
    const candidateSlotOf: SlotLookup = (pc) => candidateSlots.get(pc);
    if (!hasOwnerCallerCheck(code, memberOf(region.selector), ownerSlot, candidateSlotOf)) {
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
      if (isStandardTokenWriter(region.selector)) {
        continue;
      }
      const writerMember = memberOf(region.selector);
      const writerSlots = interpretRegionSlots(input.bytecode, region.selector);
      const writerSlotOf: SlotLookup = (pc) => writerSlots.get(pc);
      if (!hasOwnerCallerCheck(code, writerMember, ownerSlot, writerSlotOf)) {
        continue;
      }
      const writePc = flagWriter(region, slot);
      if (writePc === null) {
        continue;
      }
      // A packed writer proves a bit position that the gate must read
      // back: same slot and same shift, or the pair never proves one
      // flag. A plain (non-packed) writer carries no position, so only
      // the slot must match.
      const writeIndex = sstoreIndexAt(writePc);
      const packedWrite =
        writeIndex >= 0 ? (packedBoolWriteAt(code, writeIndex, slot, writerSlotOf) ?? null) : null;
      const orderedTransfers = [TRANSFER_SELECTOR, TRANSFER_FROM_SELECTOR]
        .filter((selector) => selector !== region.selector)
        .sort();
      for (const transferSelector of orderedTransfers) {
        const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
        if (transfer === undefined) {
          continue;
        }
        const gateMember = memberOf(transferSelector);
        let gateEvidencePc: number | null = null;
        if (packedWrite !== null && packedWrite.shift !== null) {
          const transferSlots = interpretRegionSlots(input.bytecode, transferSelector);
          const transferSlotOf: SlotLookup = (pc) => transferSlots.get(pc);
          const gate = packedGateShift(code, gateMember, slot, transferSlotOf);
          if (gate === null || gate.shift !== packedWrite.shift) {
            continue;
          }
          if (!hasRevertingJumpiAfter(code, gateMember, gate.cmpPc)) {
            continue;
          }
          gateEvidencePc = gate.loadPc;
        } else {
          const gate = gatedFlagReadPrecise(transfer, slot);
          if (gate === null) {
            continue;
          }
          if (!hasRevertingJumpiAfter(code, gateMember, gate.cmpPc)) {
            continue;
          }
          gateEvidencePc = gate.loadPc;
        }
        // Shared code belongs to every entry that reaches it, so the
        // single holder stays null there: fall back to the sorted holders
        // and prefer the transfer entry under proof.
        const holdersOfWrite = [...attribution.holdersOf(writePc)].sort();
        const firstWriteHolder = holdersOfWrite[0] === undefined ? null : holdersOfWrite[0];
        const holder =
          attribution.holderOf(writePc) ??
          (holdersOfWrite.includes(transferSelector) ? transferSelector : firstWriteHolder);
        const holdersOfGate = [...attribution.holdersOf(gateEvidencePc)].sort();
        const firstGateHolder = holdersOfGate[0] === undefined ? null : holdersOfGate[0];
        const gateHolder =
          attribution.holderOf(gateEvidencePc) ??
          (holdersOfGate.includes(transferSelector) ? transferSelector : firstGateHolder);
        if (holder === null || gateHolder === null) {
          continue;
        }
        const evidence: EvidenceType[] = [];
        const written = evidenceFor(input.bytecode, holder, writePc);
        if (written !== null) {
          evidence.push(written);
        }
        const gate = evidenceFor(input.bytecode, gateHolder, gateEvidencePc);
        if (gate !== null) {
          evidence.push(gate);
        }
        const nonEmpty = toNonEmpty(evidence);
        if (nonEmpty === null) {
          continue;
        }
        return Object.freeze([
          Object.freeze({
            id: `${PLUGIN_ID}:pause-extended`,
            pluginId: MANIFEST.id,
            title: "The owner can freeze all transfers. Found by extended analysis; not counted in the score.",
            evidence: nonEmpty,
            payload: Object.freeze({
              fact: "pause",
              slot,
              mode: toggleMode(view.regions, slot),
              proof: "extended",
            }),
          }),
        ]);
      }
    }
  }
  return Object.freeze([]);
}

function detect(input: DetectorInput): readonly PluginFinding[] {
  const v1 = detectV1(input);
  if (v1.length > 0) {
    return v1;
  }
  return detectExtended(input);
}

const MANIFEST = manifestOf();

export const pauseDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
