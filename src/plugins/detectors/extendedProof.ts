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
  exprMappingBase,
  hasRevertingJumpiAfter,
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
} from "../../domain/ownerControl.ts";
import type {
  OwnerControlView,
  RegionFacts,
  RegionExprs,
  SlotLookup,
} from "../../domain/ownerControl.ts";
import { flagWriter, gatedFlagReadPrecise, pauseDetectorPlugin } from "./pause/index.ts";
import { blacklistDetectorPlugin, gatedMappingReadPrecise } from "./blacklist/index.ts";

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
const REVERTING_JUMPI = "reverting-jumpi";

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
    const via = ownerCheckVia(code, member, ownerSlot, slotOf, exprs.jumpis);
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
          const revertOk = pairOk && hasRevertingJumpiAfter(code, gateMember, gate.cmpPc);
          consider([
            writeStep,
            gateStep,
            pairStep,
            step(
              REVERTING_JUMPI,
              revertOk,
              revertOk
                ? "blocked side reverts after the compare"
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
          const revertOk = hasRevertingJumpiAfter(code, gateMember, gate.cmpPc);
          consider([
            writeStep,
            step(TRANSFER_GATE, true, `beside-window gate on transfer ${transferName} reads slot ${slot}`),
            step(SAME_SLOT_AND_BIT, true, `gate reads slot ${slot}`),
            step(
              REVERTING_JUMPI,
              revertOk,
              revertOk ? "blocked side reverts after the compare" : "no reverting jump after the compare",
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
        precise !== null && hasRevertingJumpiAfter(code, gateMember, precise.cmpPc);
      const preciseProves =
        precise !== null && preciseBase !== null && preciseBase === write.base && preciseRevert;
      const exprGate = preciseProves ? null : packedMappingGateExpr(gateExprs.jumpis, gateMember);
      const exprRevert =
        exprGate !== null && hasRevertingJumpiAfter(code, gateMember, exprGate.jumpiPc - 1);
      const exprProves = exprGate !== null && exprGate.base === write.base && exprRevert;
      const packed = preciseProves || exprProves ? null : packedMappingGateShift(code, gateMember, gateSlotOf);
      const packedRevert =
        packed !== null && hasRevertingJumpiAfter(code, gateMember, packed.cmpPc);
      const packedProves = packed !== null && packed.base === write.base && packedRevert;
      if (preciseProves && precise !== null && preciseBase !== null) {
        consider([
          writeStep,
          step(TRANSFER_GATE, true, `beside-window mapping gate on transfer ${transferName} reads base ${preciseBase} via window`),
          step(SAME_BASE, true, `gate base ${preciseBase} matches writer base ${write.base} via window`),
          step(REVERTING_JUMPI, true, "blocked side reverts after the compare"),
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
          step(REVERTING_JUMPI, true, "blocked side reverts after the compare"),
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
          step(REVERTING_JUMPI, true, "blocked side reverts after the compare"),
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

// Proof diagnostics for the extended detectors, in detector order: pause
// first, blacklist second. Pure: the same bytecode always yields the same
// two reports, and a found fact always reports every step ok.
export function explainExtendedProof(bytecode: BytecodeType): readonly ExtendedProof[] {
  return Object.freeze([explainPause(bytecode), explainBlacklist(bytecode)]);
}
