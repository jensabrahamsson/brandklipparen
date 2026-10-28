// Bytecode-only owner-control analysis (S-115, K-009, K-010).
// Pure domain module: a small structural analysis over the linear
// disassembly and the landed dispatcher scan. It partitions the code into
// one region per paired selector entry (the containing-selector rule from
// selectors.ts: a region runs from its entry PC to the next entry PC) and
// records per-region facts the owner-control detectors prove their
// findings from: privileged caller guards, storage reads and writes with
// best-effort slot resolution, transfer-path markers and external calls.
// Slot resolution is deliberately conservative: a direct PUSH slot with no
// KECCAK256 between the PUSH and the access resolves to a constant slot,
// a KECCAK256 in between marks mapping-derived access, and anything else
// stays unknown. Where the proof is incomplete the detectors emit no
// positive finding rather than a guessed one.
import { disassemble, extractSelectors } from "./selectors.ts";
import type { Instruction, SelectorEntry } from "./selectors.ts";
import type { Bytecode as BytecodeType, Selector as SelectorType } from "./types.ts";

// Public ERC-20 transfer entry points. Regions under these selectors are
// transfer paths by construction; anywhere else a region counts as a
// transfer path only when it reads and writes storage around calldata.
export const TRANSFER_SELECTOR = "0xa9059cbb";
export const TRANSFER_FROM_SELECTOR = "0x23b872dd";

// Best-effort storage slot reference for one SLOAD or SSTORE.
export type SlotRef =
  | { readonly kind: "const"; readonly value: number }
  | { readonly kind: "mapping" }
  | { readonly kind: "unknown" };

export type StoreOp = {
  readonly pc: number;
  readonly slot: SlotRef;
  // The pushed value beside the slot key for SSTORE of the shape PUSH
  // value, PUSH key, SSTORE: zero exactly when that PUSH is PUSH0 or
  // PUSH1 zero, constant when it is any other short PUSH, null when the
  // shape is not recognised.
  readonly valueIsZero: boolean;
  readonly valueConst: number | null;
};

export type LoadOp = {
  readonly pc: number;
  readonly slot: SlotRef;
};

export type ExternalCallOp = {
  readonly pc: number;
  readonly kind: "call" | "staticcall" | "delegatecall";
  // Best-effort call-target source: a constant address pushed beside the
  // call, an address loaded from storage, an argument from calldata, or
  // unknown when the window shows none of these.
  readonly target: "constant" | "storage" | "argument" | "unknown";
};

export type RegionFacts = {
  readonly selector: SelectorType;
  readonly entryPc: number;
  readonly hasCaller: boolean;
  readonly hasCalldataLoad: boolean;
  readonly hasEq: boolean;
  readonly hasIsZero: boolean;
  readonly hasJumpi: boolean;
  readonly hasRevert: boolean;
  readonly hasKeccak: boolean;
  readonly hasAdd: boolean;
  readonly hasSub: boolean;
  readonly hasMul: boolean;
  readonly hasDiv: boolean;
  readonly hasLt: boolean;
  readonly hasGt: boolean;
  readonly stores: readonly StoreOp[];
  readonly loads: readonly LoadOp[];
  readonly calls: readonly ExternalCallOp[];
};

export type OwnerControlView = {
  readonly regions: readonly RegionFacts[];
  // Constant slot compared against CALLER with EQ in at least one
  // region (the onlyOwner shape), or null when no region proves one.
  readonly ownerSlot: number | null;
  // Selectors whose region carries a caller guard: CALLER compared with
  // EQ beside a revert or a conditional jump, or a write to the owner
  // slot. Sorted canonically.
  readonly privileged: readonly SelectorType[];
  // Transfer-path selectors: the ERC-20 transfer entries when present,
  // otherwise regions that read and write storage around calldata.
  // Sorted canonically.
  readonly transfers: readonly SelectorType[];
};

const MAX_SLOT_PUSH_BYTES = 4;
const LOOKBACK = 12;

function pushNumber(immediate: Uint8Array): number | null {
  if (immediate.length === 0 || immediate.length > MAX_SLOT_PUSH_BYTES) {
    return null;
  }
  let value = 0;
  for (let i = 0; i < immediate.length; i += 1) {
    value = value * 256 + (immediate[i] ?? 0);
  }
  return value;
}

function resolveSlot(insns: readonly Instruction[], index: number): SlotRef {
  let sawKeccak = false;
  let steps = 0;
  for (let back = index - 1; back >= 0 && steps < LOOKBACK; back -= 1, steps += 1) {
    const candidate = insns[back];
    if (candidate === undefined) {
      break;
    }
    if (candidate.opcode === 0x20) {
      sawKeccak = true;
    }
    if (candidate.opcode === 0x5f) {
      return sawKeccak ? { kind: "mapping" } : { kind: "const", value: 0 };
    }
    if (candidate.opcode >= 0x60 && candidate.opcode <= 0x7f) {
      if (sawKeccak) {
        return { kind: "mapping" };
      }
      const value = pushNumber(candidate.immediate);
      return value === null ? { kind: "unknown" } : { kind: "const", value };
    }
  }
  return { kind: "unknown" };
}

// The pushed SSTORE value beside the slot key: only an adjacent value
// PUSH directly before the slot PUSH counts, matching the compiled shape
// PUSH value, PUSH slot, SSTORE. PUSH0 or all-zero PUSH1 means a zero
// write; any other short adjacent PUSH is a constant write; anything else
// (a computed stack value) stays unrecognised rather than guessed from a
// distant PUSH that belongs to other code.
function resolveStoreValue(insns: readonly Instruction[], index: number): {
  readonly valueIsZero: boolean;
  readonly valueConst: number | null;
} {
  const slotPush = insns[index - 1];
  if (
    slotPush === undefined ||
    (slotPush.opcode !== 0x5f && !(slotPush.opcode >= 0x60 && slotPush.opcode <= 0x7f))
  ) {
    return { valueIsZero: false, valueConst: null };
  }
  const valuePush = insns[index - 2];
  if (valuePush === undefined) {
    return { valueIsZero: false, valueConst: null };
  }
  if (valuePush.opcode === 0x5f) {
    return { valueIsZero: true, valueConst: 0 };
  }
  if (valuePush.opcode >= 0x60 && valuePush.opcode <= 0x7f) {
    const allZero = valuePush.immediate.every((byte) => byte === 0);
    if (allZero) {
      return { valueIsZero: true, valueConst: 0 };
    }
    return { valueIsZero: false, valueConst: pushNumber(valuePush.immediate) };
  }
  return { valueIsZero: false, valueConst: null };
}

function callTarget(insns: readonly Instruction[], index: number): ExternalCallOp["target"] {
  let sawSload = false;
  let sawCalldata = false;
  let sawPushAddress = false;
  let steps = 0;
  for (let back = index - 1; back >= 0 && steps < LOOKBACK; back -= 1, steps += 1) {
    const candidate = insns[back];
    if (candidate === undefined) {
      break;
    }
    if (candidate.opcode === 0x54) {
      sawSload = true;
    }
    if (candidate.opcode === 0x35) {
      sawCalldata = true;
    }
    if (
      candidate.opcode >= 0x60 &&
      candidate.opcode <= 0x7f &&
      candidate.immediate.length === 20
    ) {
      sawPushAddress = true;
    }
  }
  if (sawSload) {
    return "storage";
  }
  if (sawPushAddress) {
    return "constant";
  }
  if (sawCalldata) {
    return "argument";
  }
  return "unknown";
}

function regionOf(
  selector: SelectorType,
  entryPc: number,
  insns: readonly Instruction[],
): RegionFacts {
  let hasCaller = false;
  let hasCalldataLoad = false;
  let hasEq = false;
  let hasIsZero = false;
  let hasJumpi = false;
  let hasRevert = false;
  let hasKeccak = false;
  let hasAdd = false;
  let hasSub = false;
  let hasMul = false;
  let hasDiv = false;
  let hasLt = false;
  let hasGt = false;
  const stores: StoreOp[] = [];
  const loads: LoadOp[] = [];
  const calls: ExternalCallOp[] = [];
  for (let index = 0; index < insns.length; index += 1) {
    const instruction = insns[index];
    if (instruction === undefined) {
      continue;
    }
    switch (instruction.opcode) {
      case 0x33:
        hasCaller = true;
        break;
      case 0x35:
        hasCalldataLoad = true;
        break;
      case 0x14:
        hasEq = true;
        break;
      case 0x15:
        hasIsZero = true;
        break;
      case 0x57:
        hasJumpi = true;
        break;
      case 0xfd:
        hasRevert = true;
        break;
      case 0x20:
        hasKeccak = true;
        break;
      case 0x01:
        hasAdd = true;
        break;
      case 0x03:
        hasSub = true;
        break;
      case 0x02:
        hasMul = true;
        break;
      case 0x04:
        hasDiv = true;
        break;
      case 0x10:
        hasLt = true;
        break;
      case 0x11:
        hasGt = true;
        break;
      case 0x55: {
        const slot = resolveSlot(insns, index);
        const value = resolveStoreValue(insns, index);
        stores.push({ pc: instruction.pc, slot, valueIsZero: value.valueIsZero, valueConst: value.valueConst });
        break;
      }
      case 0x54:
        loads.push({ pc: instruction.pc, slot: resolveSlot(insns, index) });
        break;
      case 0xf1:
      case 0xfa:
      case 0xf4: {
        const kind = instruction.opcode === 0xf1 ? "call" : instruction.opcode === 0xfa ? "staticcall" : "delegatecall";
        calls.push({ pc: instruction.pc, kind, target: callTarget(insns, index) });
        break;
      }
      default:
        break;
    }
  }
  return {
    selector,
    entryPc,
    hasCaller,
    hasCalldataLoad,
    hasEq,
    hasIsZero,
    hasJumpi,
    hasRevert,
    hasKeccak,
    hasAdd,
    hasSub,
    hasMul,
    hasDiv,
    hasLt,
    hasGt,
    stores: Object.freeze(stores),
    loads: Object.freeze(loads),
    calls: Object.freeze(calls),
  };
}

// Structural owner-control view over frozen bytecode. Total: any bytecode
// maps to a view, possibly with no regions, no owner slot and no transfer
// paths, and the detectors below turn an empty proof into no findings
// rather than a guess.
export function analyzeOwnerControl(bytecode: BytecodeType): OwnerControlView {
  const code = disassemble(bytecode);
  const entries = extractSelectors(bytecode).filter(
    (entry): entry is Extract<SelectorEntry, { kind: "paired" }> => entry.kind === "paired",
  );
  const byTarget = entries.slice().sort((left, right) => (left.target as number) - (right.target as number));
  const regions: RegionFacts[] = [];
  for (let order = 0; order < byTarget.length; order += 1) {
    const entry = byTarget[order];
    if (entry === undefined) {
      continue;
    }
    const start = entry.target as number;
    const next = byTarget[order + 1];
    const end = next === undefined ? Number.MAX_SAFE_INTEGER : (next.target as number);
    const slice = code.filter((instruction) => instruction.pc >= start && instruction.pc < end);
    regions.push(regionOf(entry.selector, start, slice));
  }

  // Owner slot: a constant slot loaded in a region that also compares
  // with CALLER through EQ. The lowest such slot wins; storage slot
  // zero is the conventional owner seat but nothing here assumes it.
  let ownerSlot: number | null = null;
  for (const region of regions) {
    if (!region.hasCaller || !region.hasEq) {
      continue;
    }
    for (const load of region.loads) {
      if (load.slot.kind === "const" && (ownerSlot === null || load.slot.value < ownerSlot)) {
        ownerSlot = load.slot.value;
      }
    }
  }

  const privilegedSet = new Set<SelectorType>();
  for (const region of regions) {
    const guarded = region.hasCaller && region.hasEq && (region.hasRevert || region.hasJumpi);
    const writesOwner =
      ownerSlot !== null &&
      region.stores.some((store) => store.slot.kind === "const" && store.slot.value === ownerSlot);
    if (guarded || writesOwner) {
      privilegedSet.add(region.selector);
    }
  }

  const transfers = transferPaths(regions);
  const privileged = [...privilegedSet].sort();
  return Object.freeze({
    regions: Object.freeze(regions),
    ownerSlot,
    privileged: Object.freeze(privileged),
    transfers: Object.freeze(transfers),
  });
}

function transferPaths(regions: readonly RegionFacts[]): readonly SelectorType[] {
  // Union of the ERC-20 transfer entries and heuristic transfer-shaped
  // regions (storage read plus storage write around calldata): hooked
  // tokens route value through other functions too, so a named transfer
  // entry never hides the heuristic paths.
  const out = new Set<SelectorType>();
  for (const region of regions) {
    if (region.selector === TRANSFER_SELECTOR || region.selector === TRANSFER_FROM_SELECTOR) {
      out.add(region.selector);
    } else if (
      region.loads.length > 0 &&
      region.stores.length > 0 &&
      region.hasCalldataLoad
    ) {
      out.add(region.selector);
    }
  }
  return Object.freeze([...out].sort());
}

// Regions of the view keyed by selector for one lookup per detector.
export function regionBySelector(view: OwnerControlView, selector: SelectorType): RegionFacts | undefined {
  return view.regions.find((region) => region.selector === selector);
}

// Regions of the view keyed by selector for one lookup per detector.
