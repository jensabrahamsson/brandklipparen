// Blacklist detector plugin `dev.brandklipparen.blacklist` (S-115, P-12
// step 1, P-11 extended analysis). First-party detector behind the
// registry: proves an owner-controlled transfer gate from code paths. A
// finding needs both: a transfer path that reads a mapping entry beside
// an equality compare (or an ISZERO with no range compare between the
// load and the gate, so a plain balance check `balance >= amount` or an
// allowance check never counts) with a conditional jump that can revert,
// and a privileged region (a caller guard) that writes a mapping slot.
// The two may share one merged function. A gated read with no privileged
// writer, or a privileged mapping write the transfer path never gates on,
// stays silent: the proof is incomplete, so no positive finding is
// reported. When the v1 proof finds nothing, the same proof re-runs on
// the v2 reachability view (a shared `_beforeTokenTransfer` helper joins
// every entry that reaches it) and emits a weight-0 `fact` finding with
// `proof: "extended"` that never converts to a signal. Pure and
// synchronous: this module imports solely the plugin API and domain types
// and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import {
  TRANSFER_FROM_SELECTOR,
  TRANSFER_SELECTOR,
  analyzeOwnerControl,
  flavorBetween,
  hasOwnerCallerCheck,
  hasRevertingJumpiAfter,
  interpretRegionSlots,
  isStandardTokenWriter,
  mappingBaseNearAccess,
  mappingLoadNearFlavor,
} from "../../../domain/ownerControl.ts";
import type { RegionFacts, SlotLookup } from "../../../domain/ownerControl.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import { disassemble, extractSelectors } from "../../../domain/selectors.ts";
import type { Selector as SelectorType } from "../../../domain/types.ts";
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
        required: Object.freeze([]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "blacklist" }),
          fact: Object.freeze({ const: "blacklist" }),
          proof: Object.freeze({ const: "extended" }),
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
function detectV1(input: DetectorInput): readonly PluginFinding[] {
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

// Extended gate proof (P-11 session 1 follow-up): the mapping read beside
// a compare, with the compare PC so the caller can prove the blocked side
// reverts. Kept beside `gatedMappingRead` (which the scored path owns)
// so the v1 proof never changes.
function gatedMappingReadPrecise(region: RegionFacts): { readonly loadPc: number; readonly cmpPc: number } | null {
  if (!region.hasKeccak || !region.hasJumpi || !region.hasRevert) {
    return null;
  }
  const eqProof = mappingLoadNearFlavor(region, ["eq"]);
  if (eqProof !== null) {
    return Object.freeze({ loadPc: eqProof.loadPc, cmpPc: eqProof.gatePc });
  }
  const zeroProof = mappingLoadNearFlavor(region, ["iszero"]);
  if (zeroProof === null) {
    return null;
  }
  if (flavorBetween(region, ["lt", "gt"], zeroProof.loadPc, zeroProof.gatePc)) {
    return null;
  }
  return Object.freeze({ loadPc: zeroProof.loadPc, cmpPc: zeroProof.gatePc });
}

// Extended analysis (P-11, weight-0 fact): the mapping-gate proof over
// the v2 reachability view, where a shared `_beforeTokenTransfer` helper
// joins every entry that reaches it, tightened so plain token mechanics
// never prove a list. The writer must carry a caller check against the
// proven owner slot (never a standard token entry, never an unguarded
// function), the writer mapping and the gate mapping must hash the same
// base slot (unknown on either side stays silent), and the gate must sit
// on a transfer/transferFrom path whose blocked side reverts. It runs
// only when the v1 proof found nothing, so a scored finding always wins
// and the extended finding never shadows it. The payload carries `fact`
// (never `feature`) with `proof: "extended"`, so the finding never
// converts to a signal and stays at weight 0. The title mirrors the
// 1.1.0 origin sentence for blacklist (see `ORIGIN_SENTENCE` in
// src/domain/explain.ts) with the not-in-score marker; it names no
// account, so no changer is claimed without the P-2 ownership proof.
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
  for (const region of view.regions) {
    if (isStandardTokenWriter(region.selector)) {
      continue;
    }
    const writerMember = memberOf(region.selector);
    // The v2 interpreter proves the writer slot through DUP/SWAP chains
    // and prefers its mapping base over the window scan.
    const writerSlots = interpretRegionSlots(input.bytecode, region.selector);
    const writerSlotOf: SlotLookup = (pc) => writerSlots.get(pc);
    if (!hasOwnerCallerCheck(code, writerMember, ownerSlot, writerSlotOf)) {
      continue;
    }
    for (const write of region.stores) {
      if (write.slot.kind !== "mapping") {
        continue;
      }
      const writeBase = mappingBaseNearAccess(code, writerMember, write.pc, writerSlotOf);
      if (writeBase === null) {
        continue;
      }
      const transferSelectors = [TRANSFER_SELECTOR, TRANSFER_FROM_SELECTOR]
        .filter((selector) => selector !== region.selector)
        .sort();
      for (const transferSelector of transferSelectors) {
        const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
        if (transfer === undefined) {
          continue;
        }
        const gate = gatedMappingReadPrecise(transfer);
        if (gate === null) {
          continue;
        }
        const gateMember = memberOf(transferSelector);
        const gateSlots = interpretRegionSlots(input.bytecode, transferSelector);
        const gateSlotOf: SlotLookup = (pc) => gateSlots.get(pc);
        const gateBase = mappingBaseNearAccess(code, gateMember, gate.loadPc, gateSlotOf);
        if (gateBase === null || gateBase !== writeBase) {
          continue;
        }
        if (!hasRevertingJumpiAfter(code, gateMember, gate.cmpPc)) {
          continue;
        }
        // Shared code belongs to every entry that reaches it, so the
        // single holder stays null there: fall back to the sorted holders
        // and prefer the transfer entry under proof.
        const holdersOfWrite = [...attribution.holdersOf(write.pc)].sort();
        const firstWriteHolder = holdersOfWrite[0] === undefined ? null : holdersOfWrite[0];
        const holder =
          attribution.holderOf(write.pc) ??
          (holdersOfWrite.includes(transferSelector) ? transferSelector : firstWriteHolder);
        const holdersOfGate = [...attribution.holdersOf(gate.loadPc)].sort();
        const firstGateHolder = holdersOfGate[0] === undefined ? null : holdersOfGate[0];
        const gateHolder =
          attribution.holderOf(gate.loadPc) ??
          (holdersOfGate.includes(transferSelector) ? transferSelector : firstGateHolder);
        if (holder === null || gateHolder === null) {
          continue;
        }
        const evidence: EvidenceType[] = [];
        const written = evidenceFor(input.bytecode, holder, write.pc);
        if (written !== null) {
          evidence.push(written);
        }
        const gateEvidence = evidenceFor(input.bytecode, gateHolder, gate.loadPc);
        if (gateEvidence !== null) {
          evidence.push(gateEvidence);
        }
        const nonEmpty = toNonEmpty(evidence);
        if (nonEmpty === null) {
          continue;
        }
        return Object.freeze([
          Object.freeze({
            id: `${PLUGIN_ID}:blacklist-extended`,
            pluginId: MANIFEST.id,
            title:
              "The owner can stop chosen wallets from sending tokens. Found by extended analysis; not counted in the score.",
            evidence: nonEmpty,
            payload: Object.freeze({ fact: "blacklist", proof: "extended" }),
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

export const blacklistDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
