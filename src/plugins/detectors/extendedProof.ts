// Extended-proof diagnostics (P-11 follow-up): pure per-detector proof
// reports for the v2 extended facts. `explainExtendedProof` re-runs the
// same search each extended detector runs — owner slot, guarded writer
// regions, candidate slots or bases, packed write proof, transfer gate,
// same slot and bit or same base, reverting jump — and reports every step
// in order, so a later "why not found" view can name the first step that
// failed. Not used in scoring: diagnostics never enter findings, signals
// or the score. Pure and synchronous: this module imports solely detector
// modules and domain types and pure functions (P-03).
import type { Bytecode as BytecodeType, Selector as SelectorType } from "../../domain/types.ts";
import { attributeFunctions } from "../../domain/evmFlow.ts";
import { disassemble, extractSelectors } from "../../domain/selectors.ts";
import type { Instruction } from "../../domain/selectors.ts";
import {
  TRANSFER_FROM_SELECTOR,
  TRANSFER_SELECTOR,
  analyzeOwnerControl,
  callGraphBodyPcs,
  constSlotLoadNearFlavor,
  exprMappingBase,
  hasRevertingGateAfter,
  hasRevertingSide,
  interpretRegionExprs,
  interpretRegionSlots,
  isStandardTokenWriter,
  mappingBaseNearAccess,
  ownerCheckVia,
  packedBoolWriteAt,
  packedBoolWriteExpr,
  packedGateReadExpr,
  packedGateShift,
  packedMappingGateExpr,
  packedMappingGateShift,
  privilegedGuardKind,
  supplySlotOf,
} from "../../domain/ownerControl.ts";
import type {
  OwnerControlView,
  RegionFacts,
  RegionExprs,
  SlotLookup,
} from "../../domain/ownerControl.ts";
import { flagWriter, gatedFlagReadPrecise, pauseDetectorPlugin } from "./pause/index.ts";
import { blacklistDetectorPlugin, gatedMappingReadPrecise } from "./blacklist/index.ts";
import { condUsesSlotArithmetically, transferFeeDetectorPlugin } from "./transfer-fee/index.ts";
import {
  limitTransferGate,
  transferLimitsDetectorPlugin,
  transferUsesSlotArithmetically,
} from "./transfer-limits/index.ts";
import {
  bodyStores,
  creditRecipient,
  mintDetectorPlugin,
  supplyIncrease,
  writerCapped,
} from "./mint/index.ts";

// One proof step: the stable step id, whether it held, and a short
// English detail naming the concrete values (slots, bases, selectors).
export type ExtendedProofStep = {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
};

// The per-detector report: the detector id with its ordered steps. The
// first step with `ok: false` is the first step that failed.
export type ExtendedProof = {
  readonly detector: string;
  readonly steps: readonly ExtendedProofStep[];
};

const OWNER_SLOT = "owner-slot";
const WRITER_REGIONS = "writer-regions";
const CANDIDATE_SLOTS = "candidate-slots";
const CANDIDATE_BASES = "candidate-bases";
const PACKED_WRITE_PROOF = "packed-write-proof";
const TRANSFER_GATE = "transfer-gate";
const SAME_SLOT_AND_BIT = "same-slot-and-bit";
const SAME_BASE = "same-base";
const SAME_SLOT = "same-slot";
const REVERTING_JUMPI = "reverting-jumpi";
const TRANSFER_USE = "transfer-use";
const SUBTRACTION = "subtraction";
const SUPPLY_SLOT = "supply-slot";
const SUPPLY_WRITE = "supply-write";
const BALANCE_CREDIT = "balance-credit";
const INCREASE_PROOF = "increase-proof";

function step(name: string, ok: boolean, detail: string): ExtendedProofStep {
  return Object.freeze({ step: name, ok, detail });
}

function blockedTail(firstFailed: string, names: readonly string[]): ExtendedProofStep[] {
  return names.map((name) => step(name, false, `not evaluated: ${firstFailed} failed`));
}

// Leading ok count of a step chain: stages run in order, so progress
// stops at the first failure, mirroring the detector's nested search.
function chainProgress(flags: readonly boolean[]): number {
  let progress = 0;
  for (const flag of flags) {
    if (!flag) {
      break;
    }
    progress += 1;
  }
  return progress;
}

type GuardedWriter = {
  readonly region: RegionFacts;
  readonly slotOf: SlotLookup;
  readonly exprs: RegionExprs;
  readonly guardVia: "expr" | "window";
};

type ExtendedOpeningBlocked = {
  readonly kind: "blocked";
  readonly firstFailed: string;
  readonly steps: readonly ExtendedProofStep[];
};

type ExtendedOpeningOpen = {
  readonly kind: "open";
  readonly steps: readonly ExtendedProofStep[];
  readonly ownerSlot: number;
  readonly code: readonly Instruction[];
  readonly writers: readonly GuardedWriter[];
  readonly attribution: ReturnType<typeof attributeFunctions>;
  readonly view: OwnerControlView;
};

type ExtendedOpening = ExtendedOpeningBlocked | ExtendedOpeningOpen;

// Shared preamble both extended detectors run: selectors exist, the v2
// owner slot is proven, and at least one non-standard writer region
// carries a caller check against that slot. Anything less blocks the
// rest, and the blocked steps name the first failure.
function openExtended(bytecode: BytecodeType): ExtendedOpening {
  const entries = extractSelectors(bytecode);
  if (entries.length === 0) {
    const firstFailed = OWNER_SLOT;
    return {
      kind: "blocked",
      firstFailed,
      steps: Object.freeze([
        step(OWNER_SLOT, false, "no function selectors, so no owner slot is proven"),
        step(WRITER_REGIONS, false, `not evaluated: ${firstFailed} failed`),
      ]),
    };
  }
  const attribution = attributeFunctions(bytecode, { mode: "v2" });
  const view = analyzeOwnerControl(bytecode, { reach: "v2" });
  if (view.ownerSlot === null) {
    const firstFailed = OWNER_SLOT;
    return {
      kind: "blocked",
      firstFailed,
      steps: Object.freeze([
        step(OWNER_SLOT, false, "no constant owner slot beside a caller guard"),
        step(WRITER_REGIONS, false, `not evaluated: ${firstFailed} failed`),
      ]),
    };
  }
  const ownerSlot: number = view.ownerSlot;
  const code = disassemble(bytecode);
  const writers: GuardedWriter[] = [];
  for (const region of view.regions) {
    if (isStandardTokenWriter(region.selector)) {
      continue;
    }
    const slots = interpretRegionSlots(bytecode, region.selector);
    const slotOf: SlotLookup = (pc) => slots.get(pc);
    const exprs = interpretRegionExprs(bytecode, region.selector);
    const member = (pc: number): boolean => attribution.holdersOf(pc).includes(region.selector);
    const via = ownerCheckVia(code, member, ownerSlot, slotOf, exprs.jumpis, bytecode);
    if (via === null) {
      continue;
    }
    writers.push({ region, slotOf, exprs, guardVia: via });
  }
  const guardList = writers.map((writer) => `${writer.region.selector as string} (via ${writer.guardVia})`).sort();
  const steps: ExtendedProofStep[] = [
    step(OWNER_SLOT, true, `owner slot ${ownerSlot} proven beside a caller guard`),
    step(
      WRITER_REGIONS,
      writers.length > 0,
      writers.length > 0
        ? `guarded writer regions: ${guardList.join(", ")}`
        : "no writer region with a caller check against the owner slot",
    ),
  ];
  if (writers.length === 0) {
    return { kind: "blocked", firstFailed: WRITER_REGIONS, steps: Object.freeze(steps) };
  }
  return {
    kind: "open",
    steps: Object.freeze(steps),
    ownerSlot,
    code,
    writers: Object.freeze(writers),
    attribution,
    view,
  };
}

// Diagnostic-only packed shape check for a mapping SSTORE: a member SLOAD
// within 64 PCs back with AND, NOT and OR between the load and the store
// and no jump, halt or destination between them. It never proves a base;
// the detector's base proof owns that. Used only to describe the write.
function mappingRmwAt(
  insns: readonly Instruction[],
  sstoreIndex: number,
  isMember: (pc: number) => boolean,
): boolean {
  let loadIndex = -1;
  for (let back = sstoreIndex - 1, steps = 0; back >= 0 && steps < 64; back -= 1, steps += 1) {
    const candidate = insns[back];
    if (candidate === undefined) {
      break;
    }
    if (candidate.opcode === 0x54 && isMember(candidate.pc)) {
      loadIndex = back;
      break;
    }
  }
  if (loadIndex < 0) {
    return false;
  }
  let hasOr = false;
  let hasAnd = false;
  let hasNot = false;
  for (let at = loadIndex + 1; at < sstoreIndex; at += 1) {
    const opcode = insns[at]?.opcode;
    if (opcode === undefined) {
      return false;
    }
    if (
      opcode === 0x5b ||
      opcode === 0x56 ||
      opcode === 0x57 ||
      opcode === 0x00 ||
      opcode === 0xfd ||
      opcode === 0xf3 ||
      opcode === 0xfe
    ) {
      return false;
    }
    if (opcode === 0x17) {
      hasOr = true;
    } else if (opcode === 0x16) {
      hasAnd = true;
    } else if (opcode === 0x19) {
      hasNot = true;
    }
  }
  return hasOr && hasAnd && hasNot;
}

type StepChain = readonly [ExtendedProofStep, ExtendedProofStep, ExtendedProofStep, ExtendedProofStep];

function explainPause(bytecode: BytecodeType): ExtendedProof {
  const detector = pauseDetectorPlugin.manifest.id;
  const done = (steps: readonly ExtendedProofStep[]): ExtendedProof =>
    Object.freeze({ detector, steps: Object.freeze(steps.slice()) });
  const opening = openExtended(bytecode);
  if (opening.kind === "blocked") {
    return done([
      ...opening.steps,
      ...blockedTail(opening.firstFailed, [
        CANDIDATE_SLOTS,
        PACKED_WRITE_PROOF,
        TRANSFER_GATE,
        SAME_SLOT_AND_BIT,
        REVERTING_JUMPI,
      ]),
    ]);
  }
  const { code, writers, attribution, view } = opening;
  const memberOf = (selector: SelectorType): ((pc: number) => boolean) => {
    return (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
  };
  const sstoreIndexAt = (pc: number): number =>
    code.findIndex((instruction) => instruction.pc === pc);
  const candidates = new Set<number>();
  for (const writer of writers) {
    for (const store of writer.region.stores) {
      if (store.slot.kind !== "const") {
        continue;
      }
      if (store.valueIsZero || (store.valueConst !== null && store.valueConst <= 1)) {
        candidates.add(store.slot.value);
        continue;
      }
      const writeIndex = sstoreIndexAt(store.pc);
      const legacyPacked =
        writeIndex >= 0 ? packedBoolWriteAt(code, writeIndex, store.slot.value, writer.slotOf) : null;
      const exprPacked = packedBoolWriteExpr(store.slot.value, writer.exprs.stores.get(store.pc));
      if (legacyPacked !== null || exprPacked !== null) {
        candidates.add(store.slot.value);
      }
    }
  }
  const steps: ExtendedProofStep[] = [...opening.steps];
  if (candidates.size === 0) {
    steps.push(
      step(CANDIDATE_SLOTS, false, "no constant or packed flag write by a guarded writer"),
      ...blockedTail(CANDIDATE_SLOTS, [
        PACKED_WRITE_PROOF,
        TRANSFER_GATE,
        SAME_SLOT_AND_BIT,
        REVERTING_JUMPI,
      ]),
    );
    return done(steps);
  }
  const orderedSlots = [...candidates].sort((left, right) => left - right);
  steps.push(step(CANDIDATE_SLOTS, true, `candidate flag slots: ${orderedSlots.join(", ")}`));
  const chains: StepChain[] = [];
  const consider = (chain: StepChain): void => {
    chains.push(chain);
  };
  for (const slot of orderedSlots) {
    for (const writer of writers) {
      const writerName = writer.region.selector as string;
      const legacyWritePc = flagWriter(writer.region, slot);
      let writePc = legacyWritePc;
      if (writePc === null) {
        const exprStores = [...writer.exprs.stores.entries()]
          .filter(([, record]) => packedBoolWriteExpr(slot, record) !== null)
          .map(([pc]) => pc)
          .sort((left, right) => left - right);
        const first = exprStores[0];
        if (first === undefined) {
          consider([
            step(PACKED_WRITE_PROOF, false, `no constant or packed write to slot ${slot} by ${writerName}`),
            step(TRANSFER_GATE, false, `not evaluated: no writer store for slot ${slot}`),
            step(SAME_SLOT_AND_BIT, false, `not evaluated: no writer store for slot ${slot}`),
            step(REVERTING_JUMPI, false, `not evaluated: no writer store for slot ${slot}`),
          ]);
          continue;
        }
        writePc = first;
      }
      const writeIndex = sstoreIndexAt(writePc);
      const legacyPacked =
        writeIndex >= 0 ? packedBoolWriteAt(code, writeIndex, slot, writer.slotOf) : null;
      const exprPacked = packedBoolWriteExpr(slot, writer.exprs.stores.get(writePc));
      const packedWrite =
        exprPacked !== null
          ? { value: 1 as const, shift: exprPacked.bit, via: "expr" as const }
          : legacyPacked !== null
            ? { value: legacyPacked.value, shift: legacyPacked.shift, via: "window" as const }
            : null;
      const writeStep = step(
        PACKED_WRITE_PROOF,
        true,
        packedWrite !== null
          ? `packed bool write to slot ${slot} by ${writerName} (bit ${packedWrite.shift === null ? "unknown position" : packedWrite.shift} via ${packedWrite.via})`
          : `constant flag write to slot ${slot} by ${writerName} (via window)`,
      );
      const orderedTransfers = [TRANSFER_SELECTOR, TRANSFER_FROM_SELECTOR]
        .filter((selector) => selector !== writer.region.selector)
        .sort();
      for (const transferSelector of orderedTransfers) {
        const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
        if (transfer === undefined) {
          continue;
        }
        const transferName = transferSelector as string;
        const gateMember = memberOf(transferSelector);
        const gateSlots = interpretRegionSlots(bytecode, transferSelector);
        const gateSlotOf: SlotLookup = (pc) => gateSlots.get(pc);
        const gateExprs = interpretRegionExprs(bytecode, transferSelector);
        if (packedWrite !== null && packedWrite.shift !== null) {
          const exprGate = packedGateReadExpr(gateExprs.jumpis, gateMember, slot);
          const windowGate = packedGateShift(code, gateMember, slot, gateSlotOf);
          const gate =
            exprGate !== null && exprGate.shift === packedWrite.shift
              ? { loadPc: exprGate.jumpiPc, cmpPc: exprGate.jumpiPc - 1, shift: exprGate.shift, via: "expr" as const }
              : windowGate !== null
                ? { ...windowGate, via: "window" as const }
                : null;
          if (gate === null) {
            consider([
              writeStep,
              step(TRANSFER_GATE, false, `no packed gate reading slot ${slot} on transfer ${transferName}`),
              step(SAME_SLOT_AND_BIT, false, `not evaluated: no packed gate on transfer ${transferName}`),
              step(REVERTING_JUMPI, false, `not evaluated: no packed gate on transfer ${transferName}`),
            ]);
            continue;
          }
          const pairOk = gate.shift === packedWrite.shift;
          const gateStep = step(
            TRANSFER_GATE,
            true,
            `packed gate on transfer ${transferName} reads slot ${slot} bit ${gate.shift} via ${gate.via}`,
          );
          const pairStep = step(
            SAME_SLOT_AND_BIT,
            pairOk,
            pairOk
              ? `gate bit ${gate.shift} matches writer bit ${packedWrite.shift} via ${gate.via}`
              : `gate bit ${gate.shift} differs from writer bit ${packedWrite.shift}`,
          );
          // The expr gate names its JUMPI directly; the window gate
          // names its compare, so the legacy search finds the JUMPI.
          const revertOk =
            pairOk &&
            (gate.via === "expr"
              ? hasRevertingSide(bytecode, code, gateMember, gate.loadPc, "fall")
              : hasRevertingGateAfter(bytecode, code, gateMember, gate.cmpPc));
          consider([
            writeStep,
            gateStep,
            pairStep,
            step(
              REVERTING_JUMPI,
              revertOk,
              revertOk
                ? `blocked side reverts after the compare via ${gate.via}`
                : pairOk
                  ? "no reverting jump after the compare"
                  : "not evaluated: slot and bit differ",
            ),
          ]);
        } else {
          const gate = gatedFlagReadPrecise(transfer, slot);
          if (gate === null) {
            consider([
              writeStep,
              step(TRANSFER_GATE, false, `no gate reading slot ${slot} on transfer ${transferName}`),
              step(SAME_SLOT_AND_BIT, false, `not evaluated: no gate on transfer ${transferName}`),
              step(REVERTING_JUMPI, false, `not evaluated: no gate on transfer ${transferName}`),
            ]);
            continue;
          }
          const revertOk = hasRevertingGateAfter(bytecode, code, gateMember, gate.cmpPc);
          consider([
            writeStep,
            step(TRANSFER_GATE, true, `beside-window gate on transfer ${transferName} reads slot ${slot}`),
            step(SAME_SLOT_AND_BIT, true, `gate reads slot ${slot}`),
            step(
              REVERTING_JUMPI,
              revertOk,
              revertOk
                ? "blocked side reverts after the compare via window"
                : "no reverting jump after the compare",
            ),
          ]);
        }
      }
    }
  }
  let best: StepChain | null = null;
  let bestProgress = -1;
  for (const chain of chains) {
    const progress = chainProgress([chain[0].ok, chain[1].ok, chain[2].ok, chain[3].ok]);
    if (progress > bestProgress) {
      best = chain;
      bestProgress = progress;
    }
  }
  if (best === null) {
    steps.push(
      step(PACKED_WRITE_PROOF, false, "no transfer or transferFrom region to pair a writer with"),
      ...blockedTail(PACKED_WRITE_PROOF, [TRANSFER_GATE, SAME_SLOT_AND_BIT, REVERTING_JUMPI]),
    );
    return done(steps);
  }
  steps.push(best[0], best[1], best[2], best[3]);
  return done(steps);
}

type CandidateWrite = {
  readonly selector: SelectorType;
  readonly writePc: number;
  readonly base: number;
  readonly via: "expr" | "window";
};

function explainBlacklist(bytecode: BytecodeType): ExtendedProof {
  const detector = blacklistDetectorPlugin.manifest.id;
  const done = (steps: readonly ExtendedProofStep[]): ExtendedProof =>
    Object.freeze({ detector, steps: Object.freeze(steps.slice()) });
  const opening = openExtended(bytecode);
  if (opening.kind === "blocked") {
    return done([
      ...opening.steps,
      ...blockedTail(opening.firstFailed, [
        CANDIDATE_BASES,
        PACKED_WRITE_PROOF,
        TRANSFER_GATE,
        SAME_BASE,
        REVERTING_JUMPI,
      ]),
    ]);
  }
  const { code, writers, attribution, view } = opening;
  const memberOf = (selector: SelectorType): ((pc: number) => boolean) => {
    return (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
  };
  const sstoreIndexAt = (pc: number): number =>
    code.findIndex((instruction) => instruction.pc === pc);
  const candidateWrites: CandidateWrite[] = [];
  for (const writer of writers) {
    const writerMember = memberOf(writer.region.selector);
    for (const store of writer.region.stores) {
      if (store.slot.kind !== "mapping") {
        continue;
      }
      const exprBase = exprMappingBase(writer.exprs.stores.get(store.pc)?.slot);
      const windowBase = mappingBaseNearAccess(code, writerMember, store.pc, writer.slotOf);
      const writeBase = exprBase ?? windowBase;
      if (writeBase === null || writeBase === undefined) {
        continue;
      }
      candidateWrites.push({
        selector: writer.region.selector,
        writePc: store.pc,
        base: writeBase,
        via: exprBase !== null && exprBase !== undefined ? "expr" : "window",
      });
    }
  }
  const steps: ExtendedProofStep[] = [...opening.steps];
  if (candidateWrites.length === 0) {
    steps.push(
      step(CANDIDATE_BASES, false, "no guarded mapping write with a proven base"),
      ...blockedTail(CANDIDATE_BASES, [PACKED_WRITE_PROOF, TRANSFER_GATE, SAME_BASE, REVERTING_JUMPI]),
    );
    return done(steps);
  }
  steps.push(
    step(
      CANDIDATE_BASES,
      true,
      `candidate writer bases: ${candidateWrites.map((write) => `base ${write.base} by ${write.selector as string} (via ${write.via})`).join(", ")}`,
    ),
  );
  const chains: StepChain[] = [];
  const consider = (chain: StepChain): void => {
    chains.push(chain);
  };
  for (const write of candidateWrites) {
    const writeName = write.selector as string;
    const writerMember = memberOf(write.selector);
    const writeIndex = sstoreIndexAt(write.writePc);
    const writePacked = writeIndex >= 0 && mappingRmwAt(code, writeIndex, writerMember);
    const writeStep = step(
      PACKED_WRITE_PROOF,
      true,
      writePacked
        ? `packed read-modify-write to base ${write.base} by ${writeName}`
        : `plain mapping store to base ${write.base} by ${writeName}`,
    );
    const orderedTransfers = [TRANSFER_SELECTOR, TRANSFER_FROM_SELECTOR]
      .filter((selector) => selector !== write.selector)
      .sort();
    for (const transferSelector of orderedTransfers) {
      const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
      if (transfer === undefined) {
        continue;
      }
      const transferName = transferSelector as string;
      const gateMember = memberOf(transferSelector);
      const gateSlots = interpretRegionSlots(bytecode, transferSelector);
      const gateSlotOf: SlotLookup = (pc) => gateSlots.get(pc);
      const gateExprs = interpretRegionExprs(bytecode, transferSelector);
      const precise = gatedMappingReadPrecise(transfer);
      const preciseBase =
        precise === null ? null : mappingBaseNearAccess(code, gateMember, precise.loadPc, gateSlotOf);
      const preciseRevert =
        precise !== null && hasRevertingGateAfter(bytecode, code, gateMember, precise.cmpPc);
      const preciseProves =
        precise !== null && preciseBase !== null && preciseBase === write.base && preciseRevert;
      const exprGate = preciseProves ? null : packedMappingGateExpr(gateExprs.jumpis, gateMember);
      const exprRevert =
        exprGate !== null && hasRevertingSide(bytecode, code, gateMember, exprGate.jumpiPc, "fall");
      const exprProves = exprGate !== null && exprGate.base === write.base && exprRevert;
      const packed = preciseProves || exprProves ? null : packedMappingGateShift(code, gateMember, gateSlotOf);
      const packedRevert =
        packed !== null && hasRevertingGateAfter(bytecode, code, gateMember, packed.cmpPc);
      const packedProves = packed !== null && packed.base === write.base && packedRevert;
      if (preciseProves && precise !== null && preciseBase !== null) {
        consider([
          writeStep,
          step(TRANSFER_GATE, true, `beside-window mapping gate on transfer ${transferName} reads base ${preciseBase} via window`),
          step(SAME_BASE, true, `gate base ${preciseBase} matches writer base ${write.base} via window`),
          step(REVERTING_JUMPI, true, "blocked side reverts after the compare via window"),
        ]);
      } else if (exprProves && exprGate !== null) {
        consider([
          writeStep,
          step(
            TRANSFER_GATE,
            true,
            `packed shift-and-mask gate on transfer ${transferName} reads base ${exprGate.base} (shift ${exprGate.shift} via expr)`,
          ),
          step(SAME_BASE, true, `gate base ${exprGate.base} matches writer base ${write.base} via expr`),
          step(REVERTING_JUMPI, true, "blocked side reverts after the compare via expr"),
        ]);
      } else if (packedProves && packed !== null) {
        consider([
          writeStep,
          step(
            TRANSFER_GATE,
            true,
            `packed shift-and-mask gate on transfer ${transferName} reads base ${packed.base} (shift ${packed.shift} via window)`,
          ),
          step(SAME_BASE, true, `gate base ${packed.base} matches writer base ${write.base} via window`),
          step(REVERTING_JUMPI, true, "blocked side reverts after the compare via window"),
        ]);
      } else if (precise !== null) {
        const pairOk = preciseBase !== null && preciseBase === write.base;
        consider([
          writeStep,
          step(
            TRANSFER_GATE,
            true,
            `beside-window mapping gate on transfer ${transferName} reads base ${preciseBase === null ? "unknown" : preciseBase}`,
          ),
          step(
            SAME_BASE,
            pairOk,
            pairOk
              ? `gate base ${preciseBase} matches writer base ${write.base}`
              : `gate base ${preciseBase === null ? "unknown" : preciseBase} differs from writer base ${write.base}`,
          ),
          step(
            REVERTING_JUMPI,
            pairOk && preciseRevert,
            pairOk
              ? preciseRevert
                ? "blocked side reverts after the compare"
                : "no reverting jump after the compare"
              : "not evaluated: bases differ",
          ),
        ]);
      } else if (packed !== null) {
        const pairOk = packed.base === write.base;
        consider([
          writeStep,
          step(
            TRANSFER_GATE,
            true,
            `packed shift-and-mask gate on transfer ${transferName} reads base ${packed.base} (shift ${packed.shift})`,
          ),
          step(
            SAME_BASE,
            pairOk,
            pairOk
              ? `gate base ${packed.base} matches writer base ${write.base}`
              : `gate base ${packed.base} differs from writer base ${write.base}`,
          ),
          step(
            REVERTING_JUMPI,
            pairOk && packedRevert,
            pairOk
              ? packedRevert
                ? "blocked side reverts after the compare"
                : "no reverting jump after the compare"
              : "not evaluated: bases differ",
          ),
        ]);
      } else {
        consider([
          writeStep,
          step(TRANSFER_GATE, false, `no mapping gate on transfer ${transferName}`),
          step(SAME_BASE, false, `not evaluated: no gate on transfer ${transferName}`),
          step(REVERTING_JUMPI, false, `not evaluated: no gate on transfer ${transferName}`),
        ]);
      }
    }
  }
  let best: StepChain | null = null;
  let bestProgress = -1;
  for (const chain of chains) {
    const progress = chainProgress([chain[0].ok, chain[1].ok, chain[2].ok, chain[3].ok]);
    if (progress > bestProgress) {
      best = chain;
      bestProgress = progress;
    }
  }
  if (best === null) {
    steps.push(
      step(PACKED_WRITE_PROOF, false, "no transfer or transferFrom region to pair a writer with"),
      ...blockedTail(PACKED_WRITE_PROOF, [TRANSFER_GATE, SAME_BASE, REVERTING_JUMPI]),
    );
    return done(steps);
  }
  steps.push(best[0], best[1], best[2], best[3]);
  return done(steps);
}

function explainFee(bytecode: BytecodeType): ExtendedProof {
  const detector = transferFeeDetectorPlugin.manifest.id;
  const done = (steps: readonly ExtendedProofStep[]): ExtendedProof =>
    Object.freeze({ detector, steps: Object.freeze(steps.slice()) });
  const opening = openExtended(bytecode);
  if (opening.kind === "blocked") {
    return done([
      ...opening.steps,
      ...blockedTail(opening.firstFailed, [CANDIDATE_SLOTS, TRANSFER_USE, SUBTRACTION]),
    ]);
  }
  const { writers, attribution, view } = opening;
  const ownerSlot = view.ownerSlot;
  const candidates = new Set<number>();
  for (const writer of writers) {
    for (const store of writer.region.stores) {
      // The owner seat holds an address, never a fee rate.
      if (store.slot.kind === "const" && store.slot.value === ownerSlot) {
        continue;
      }
      if (store.slot.kind === "const" && !store.valueIsZero && store.valueConst === null) {
        candidates.add(store.slot.value);
      }
    }
  }
  const steps: ExtendedProofStep[] = [...opening.steps];
  if (candidates.size === 0) {
    steps.push(
      step(CANDIDATE_SLOTS, false, "no guarded writer storing a computed rate slot"),
      ...blockedTail(CANDIDATE_SLOTS, [TRANSFER_USE, SUBTRACTION]),
    );
    return done(steps);
  }
  const orderedSlots = [...candidates].sort((left, right) => left - right);
  steps.push(step(CANDIDATE_SLOTS, true, `candidate rate slots: ${orderedSlots.join(", ")}`));
  type FeeChain = readonly [ExtendedProofStep, ExtendedProofStep];
  const chains: FeeChain[] = [];
  const consider = (chain: FeeChain): void => {
    chains.push(chain);
  };
  const memberOf = (selector: SelectorType): ((pc: number) => boolean) => {
    return (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
  };
  for (const slot of orderedSlots) {
    for (const writer of writers) {
      const writePc = writer.region.stores.find(
        (store) => store.slot.kind === "const" && store.slot.value === slot && !store.valueIsZero && store.valueConst === null,
      )?.pc;
      if (writePc === undefined) {
        continue;
      }
      const orderedTransfers = [TRANSFER_SELECTOR, TRANSFER_FROM_SELECTOR]
        .filter((selector) => selector !== writer.region.selector)
        .sort();
      for (const transferSelector of orderedTransfers) {
        const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
        if (transfer === undefined) {
          continue;
        }
        const transferName = transferSelector as string;
        const gateMember = memberOf(transferSelector);
        const windowProof = constSlotLoadNearFlavor(transfer, slot, ["mul", "div"], 64);
        let useDetail: string | null =
          windowProof === null
            ? null
            : `slot ${slot} used arithmetically beside the load on transfer ${transferName} via window`;
        let usePc: number | null = windowProof === null ? null : windowProof.loadPc;
        if (usePc === null) {
          const gateExprs = interpretRegionExprs(bytecode, transferSelector);
          for (const [pc, cond] of gateExprs.jumpis) {
            if (gateMember(pc) && condUsesSlotArithmetically(cond, slot)) {
              usePc = pc;
              useDetail = `slot ${slot} multiplied or divided in a transfer ${transferName} condition via expr`;
              break;
            }
          }
        }
        if (usePc === null || useDetail === null) {
          consider([
            step(TRANSFER_USE, false, `no MUL/DIV use of slot ${slot} on transfer ${transferName}`),
            step(SUBTRACTION, false, `not evaluated: no rate use on transfer ${transferName}`),
          ]);
          continue;
        }
        let capDetail = "no second guarded slot";
        for (const store of writer.region.stores) {
          if (store.slot.kind !== "const" || store.slot.value === slot || store.slot.value === ownerSlot) {
            continue;
          }
          if (constSlotLoadNearFlavor(transfer, store.slot.value, ["lt", "gt"], 64) !== null) {
            capDetail =
              capDetail === "no second guarded slot"
                ? `cap slot ${store.slot.value}`
                : `${capDetail}, ${store.slot.value}`;
          }
        }
        const useStep = step(TRANSFER_USE, true, `${useDetail} (${capDetail})`);
        if (!transfer.hasSub) {
          consider([
            useStep,
            step(SUBTRACTION, false, `no subtraction on transfer ${transferName}; the fee is never deducted`),
          ]);
          continue;
        }
        consider([
          useStep,
          step(SUBTRACTION, true, `transfer ${transferName} subtracts the fee from the amount`),
        ]);
      }
    }
  }
  let best: FeeChain | null = null;
  let bestProgress = -1;
  for (const chain of chains) {
    const progress = chainProgress([chain[0].ok, chain[1].ok]);
    if (progress > bestProgress) {
      best = chain;
      bestProgress = progress;
    }
  }
  if (best === null) {
    steps.push(
      step(TRANSFER_USE, false, "no transfer or transferFrom region to pair a writer with"),
      ...blockedTail(TRANSFER_USE, [SUBTRACTION]),
    );
    return done(steps);
  }
  steps.push(best[0], best[1]);
  return done(steps);
}

function explainLimits(bytecode: BytecodeType): ExtendedProof {
  const detector = transferLimitsDetectorPlugin.manifest.id;
  const done = (steps: readonly ExtendedProofStep[]): ExtendedProof =>
    Object.freeze({ detector, steps: Object.freeze(steps.slice()) });
  const opening = openExtended(bytecode);
  if (opening.kind === "blocked") {
    return done([
      ...opening.steps,
      ...blockedTail(opening.firstFailed, [CANDIDATE_SLOTS, TRANSFER_GATE, SAME_SLOT, REVERTING_JUMPI]),
    ]);
  }
  const { code, writers, attribution, view } = opening;
  const memberOf = (selector: SelectorType): ((pc: number) => boolean) => {
    return (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
  };
  const sstoreIndexAt = (pc: number): number => code.findIndex((instruction) => instruction.pc === pc);
  const isPackedBoolStore = (
    slot: number,
    pc: number,
    slotOf: SlotLookup,
    exprs: ReturnType<typeof interpretRegionExprs>,
  ): boolean => {
    if (packedBoolWriteExpr(slot, exprs.stores.get(pc)) !== null) {
      return true;
    }
    const index = sstoreIndexAt(pc);
    return index >= 0 && packedBoolWriteAt(code, index, slot, slotOf) !== null;
  };
  const candidates = new Set<number>();
  for (const writer of writers) {
    const slots = interpretRegionSlots(bytecode, writer.region.selector);
    const slotOf: SlotLookup = (pc) => slots.get(pc);
    const exprs = interpretRegionExprs(bytecode, writer.region.selector);
    for (const store of writer.region.stores) {
      if (store.slot.kind !== "const") {
        continue;
      }
      if (isPackedBoolStore(store.slot.value, store.pc, slotOf, exprs)) {
        continue;
      }
      if ((!store.valueIsZero && store.valueConst === null) || (store.valueConst !== null && store.valueConst > 1)) {
        candidates.add(store.slot.value);
      }
    }
  }
  const steps: ExtendedProofStep[] = [...opening.steps];
  if (candidates.size === 0) {
    steps.push(
      step(CANDIDATE_SLOTS, false, "no guarded writer storing a caller-chosen or large limit slot"),
      ...blockedTail(CANDIDATE_SLOTS, [TRANSFER_GATE, SAME_SLOT, REVERTING_JUMPI]),
    );
    return done(steps);
  }
  const orderedSlots = [...candidates].sort((left, right) => left - right);
  steps.push(step(CANDIDATE_SLOTS, true, `candidate limit slots: ${orderedSlots.join(", ")}`));
  type LimitsChain = readonly [ExtendedProofStep, ExtendedProofStep, ExtendedProofStep];
  const chains: LimitsChain[] = [];
  const consider = (chain: LimitsChain): void => {
    chains.push(chain);
  };
  for (const slot of orderedSlots) {
    for (const writer of writers) {
      const writerName = writer.region.selector as string;
      const orderedTransfers = [TRANSFER_SELECTOR, TRANSFER_FROM_SELECTOR]
        .filter((selector) => selector !== writer.region.selector)
        .sort();
      for (const transferSelector of orderedTransfers) {
        const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
        if (transfer === undefined) {
          continue;
        }
        const transferName = transferSelector as string;
        const gateMember = memberOf(transferSelector);
        if (transferUsesSlotArithmetically(bytecode, transferSelector, slot)) {
          consider([
            step(
              TRANSFER_GATE,
              false,
              `slot ${slot} prices a fee on transfer ${transferName}; a fee clamp never proves a limit`,
            ),
            step(SAME_SLOT, false, `not evaluated: slot ${slot} prices a fee`),
            step(REVERTING_JUMPI, false, `not evaluated: slot ${slot} prices a fee`),
          ]);
          continue;
        }
        const gateExprs = interpretRegionExprs(bytecode, transferSelector);
        const gate = limitTransferGate(bytecode, code, gateMember, gateExprs.jumpis, transfer, slot);
        if (gate === null) {
          consider([
            step(TRANSFER_GATE, false, `no reverting amount-or-balance compare loading slot ${slot} on transfer ${transferName}`),
            step(SAME_SLOT, false, `not evaluated: no gate on transfer ${transferName}`),
            step(REVERTING_JUMPI, false, `not evaluated: no gate on transfer ${transferName}`),
          ]);
          continue;
        }
        consider([
          step(
            TRANSFER_GATE,
            true,
            `reverting amount-or-balance compare loads slot ${slot} on transfer ${transferName}`,
          ),
          step(SAME_SLOT, true, `gate slot ${slot} matches the writer slot by ${writerName}`),
          step(REVERTING_JUMPI, true, "blocked side reverts after the compare"),
        ]);
      }
    }
  }
  let best: LimitsChain | null = null;
  let bestProgress = -1;
  for (const chain of chains) {
    const progress = chainProgress([chain[0].ok, chain[1].ok, chain[2].ok]);
    if (progress > bestProgress) {
      best = chain;
      bestProgress = progress;
    }
  }
  if (best === null) {
    steps.push(
      step(TRANSFER_GATE, false, "no transfer or transferFrom region to pair a writer with"),
      ...blockedTail(TRANSFER_GATE, [SAME_SLOT, REVERTING_JUMPI]),
    );
    return done(steps);
  }
  steps.push(best[0], best[1], best[2]);
  return done(steps);
}

type MintWriter = {
  readonly region: RegionFacts;
  readonly guardKind: string;
};

function explainMint(bytecode: BytecodeType): ExtendedProof {
  const detector = mintDetectorPlugin.manifest.id;
  const done = (steps: readonly ExtendedProofStep[]): ExtendedProof =>
    Object.freeze({ detector, steps: Object.freeze(steps.slice()) });
  const entries = extractSelectors(bytecode);
  if (entries.length === 0) {
    const firstFailed = SUPPLY_SLOT;
    return done([
      step(SUPPLY_SLOT, false, "no function selectors, so no supply slot is proven"),
      step(WRITER_REGIONS, false, `not evaluated: ${firstFailed} failed`),
      step(SUPPLY_WRITE, false, `not evaluated: ${firstFailed} failed`),
      step(BALANCE_CREDIT, false, `not evaluated: ${firstFailed} failed`),
      step(INCREASE_PROOF, false, `not evaluated: ${firstFailed} failed`),
    ]);
  }
  const attribution = attributeFunctions(bytecode, { mode: "v2" });
  const view = analyzeOwnerControl(bytecode, { reach: "v2" });
  const supply = supplySlotOf(view);
  if (supply === null) {
    const firstFailed = SUPPLY_SLOT;
    return done([
      step(SUPPLY_SLOT, false, "no totalSupply region loading a constant supply slot"),
      step(WRITER_REGIONS, false, `not evaluated: ${firstFailed} failed`),
      step(SUPPLY_WRITE, false, `not evaluated: ${firstFailed} failed`),
      step(BALANCE_CREDIT, false, `not evaluated: ${firstFailed} failed`),
      step(INCREASE_PROOF, false, `not evaluated: ${firstFailed} failed`),
    ]);
  }
  const code = disassemble(bytecode);
  const writers: MintWriter[] = [];
  for (const region of view.regions) {
    if (isStandardTokenWriter(region.selector)) {
      continue;
    }
    const memberOf = (pc: number): boolean => attribution.holdersOf(pc).includes(region.selector);
    const slots = interpretRegionSlots(bytecode, region.selector);
    const slotOf: SlotLookup = (pc) => slots.get(pc);
    const exprs = interpretRegionExprs(bytecode, region.selector);
    const guardKind = privilegedGuardKind(code, memberOf, view.ownerSlot, slotOf, exprs.jumpis, bytecode);
    if (guardKind === null) {
      continue;
    }
    writers.push({ region, guardKind });
  }
  const guardList = writers
    .map((writer) => `${writer.region.selector as string} (${writer.guardKind})`)
    .sort();
  const steps: ExtendedProofStep[] = [
    step(SUPPLY_SLOT, true, `supply slot ${supply} loaded by the totalSupply region`),
    step(
      WRITER_REGIONS,
      writers.length > 0,
      writers.length > 0
        ? `guarded writer regions: ${guardList.join(", ")}`
        : "no writer region with an owner, role-slot or auth-mapping guard",
    ),
  ];
  if (writers.length === 0) {
    return done([
      ...steps,
      ...blockedTail(WRITER_REGIONS, [SUPPLY_WRITE, BALANCE_CREDIT, INCREASE_PROOF]),
    ]);
  }
  type MintChain = readonly [ExtendedProofStep, ExtendedProofStep, ExtendedProofStep];
  const chains: MintChain[] = [];
  const consider = (chain: MintChain): void => {
    chains.push(chain);
  };
  for (const writer of writers) {
    const writerName = writer.region.selector as string;
    const memberOf = (pc: number): boolean => attribution.holdersOf(pc).includes(writer.region.selector);
    const slots = interpretRegionSlots(bytecode, writer.region.selector);
    const slotOf: SlotLookup = (pc) => slots.get(pc);
    const exprs = interpretRegionExprs(bytecode, writer.region.selector);
    const seeds: number[] = [];
    for (const instruction of code) {
      if (
        memberOf(instruction.pc) &&
        (instruction.opcode === 0x56 || instruction.opcode === 0x57)
      ) {
        seeds.push(instruction.pc);
      }
    }
    const body = new Set<number>(callGraphBodyPcs(code, writer.region.entryPc, seeds));
    for (const instruction of code) {
      if (memberOf(instruction.pc)) {
        body.add(instruction.pc);
      }
    }
    const { supplyStores, credits } = bodyStores(code, body, memberOf, slotOf, writer.region, supply);
    if (supplyStores.length === 0) {
      consider([
        step(SUPPLY_WRITE, false, `no store to supply slot ${supply} by ${writerName}`),
        step(BALANCE_CREDIT, false, `not evaluated: no supply store by ${writerName}`),
        step(INCREASE_PROOF, false, `not evaluated: no supply store by ${writerName}`),
      ]);
      continue;
    }
    const credit = credits[0];
    for (const store of supplyStores) {
      const writeStep = step(SUPPLY_WRITE, true, `supply store to slot ${supply} by ${writerName}`);
      if (credit === undefined) {
        consider([
          writeStep,
          step(BALANCE_CREDIT, false, `no balance mapping credit by ${writerName}`),
          step(INCREASE_PROOF, false, `not evaluated: no balance credit by ${writerName}`),
        ]);
        continue;
      }
      const recipient = creditRecipient(code, body, exprs.stores.get(credit.pc)?.slot, credit.pc);
      const creditStep = step(
        BALANCE_CREDIT,
        true,
        `balance mapping credit by ${writerName} to ${recipient === "argument" ? "an argument" : "a stored"} account`,
      );
      const value = exprs.stores.get(store.pc)?.value;
      if (!supplyIncrease(code, body, slotOf, value, store.pc, supply)) {
        consider([
          writeStep,
          creditStep,
          step(INCREASE_PROOF, false, `no addition growing supply slot ${supply} by ${writerName}`),
        ]);
        continue;
      }
      const capped = writerCapped(writer.region, exprs.jumpis, supply);
      consider([
        writeStep,
        creditStep,
        step(
          INCREASE_PROOF,
          true,
          `supply slot ${supply} grows by addition${capped ? " under a cap compare" : ""} by ${writerName}`,
        ),
      ]);
    }
  }
  let best: MintChain | null = null;
  let bestProgress = -1;
  for (const chain of chains) {
    const progress = chainProgress([chain[0].ok, chain[1].ok, chain[2].ok]);
    if (progress > bestProgress) {
      best = chain;
      bestProgress = progress;
    }
  }
  if (best === null) {
    steps.push(
      step(SUPPLY_WRITE, false, "no guarded writer to pair a supply store with"),
      ...blockedTail(SUPPLY_WRITE, [BALANCE_CREDIT, INCREASE_PROOF]),
    );
    return done(steps);
  }
  steps.push(best[0], best[1], best[2]);
  return done(steps);
}

// Proof diagnostics for the extended detectors, in detector order: pause
// first, blacklist second, then transfer-fee, transfer-limits and mint.
// Pure: the same bytecode always yields the same five reports, and a
// found fact always reports every step ok.
export function explainExtendedProof(bytecode: BytecodeType): readonly ExtendedProof[] {
  return Object.freeze([
    explainPause(bytecode),
    explainBlacklist(bytecode),
    explainFee(bytecode),
    explainLimits(bytecode),
    explainMint(bytecode),
  ]);
}
