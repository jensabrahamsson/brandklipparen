// Bytecode-only owner-control analysis (S-115, K-009, K-010).
// Pure domain module: a small structural analysis over the linear
// disassembly and the dispatcher reachability walk. It groups the code
// into one region per paired selector entry (the reachability rule from
// evmFlow.ts: a region holds exactly the instructions the CFG walk from
// its entry block reaches, and instructions no unique entry reaches belong
// to no region) and records per-region facts the owner-control detectors
// prove their findings from: privileged caller guards, storage reads and
// writes with best-effort slot resolution, transfer-path markers and
// external calls.
// Slot resolution is deliberately conservative: a PUSH slot directly
// beside the access resolves to a constant slot, a KECCAK256 in the
// short window marks mapping-derived access, and anything else stays
// unknown. Where the proof is incomplete the detectors emit no positive
// finding rather than a guessed one.
import { attributeFunctions, findFunctionEntries } from "./evmFlow.ts";
import { buildCfg, lift, resolveEntryReachV2 } from "./evmLift.ts";
import { nameForSelector } from "./evmNames.ts";
import { disassemble, extractSelectors } from "./selectors.ts";
import type { Instruction, SelectorEntry } from "./selectors.ts";
import { Selector } from "./types.ts";
import type { Bytecode as BytecodeType, Selector as SelectorType } from "./types.ts";

// Hardcoded entry points parse through the Selector constructor; a failure
// here is a broken invariant, never a caller error.
function mustSelector(raw: string): SelectorType {
  const parsed = Selector.parse(raw);
  if (!parsed.ok) {
    throw new Error(`invalid hardcoded selector: ${raw}`);
  }
  return parsed.value;
}

// Public ERC-20 transfer entry points. Regions under these selectors are
// transfer paths by construction; anywhere else a region counts as a
// transfer path only when it reads and writes storage around calldata.
export const TRANSFER_SELECTOR: SelectorType = mustSelector("0xa9059cbb");
export const TRANSFER_FROM_SELECTOR: SelectorType = mustSelector("0x23b872dd");

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
  // Best-effort call-target source: msg.sender paid out directly, a
  // constant address pushed beside the call, an address loaded from
  // storage, an argument from calldata, or unknown when the window shows
  // none of these. A payout to msg.sender (a withdraw) is not a hook to
  // a stored or caller-chosen target.
  readonly target: "caller" | "constant" | "storage" | "argument" | "unknown";
};

export type RegionFacts = {
  readonly selector: SelectorType;
  readonly entryPc: number;
  readonly hasCaller: boolean;
  readonly callerPcs: readonly number[];
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
  // PC lists per arithmetic/compare opcode class (S-115 specificity):
  // the linear-scan positions of each operation, so detectors can prove
  // the operation works on the loaded slot value (best-effort dataflow:
  // the opcode must sit within a short window of the slot load) instead
  // of merely sharing the region. Sorted ascending by construction.
  readonly opPcs: Readonly<Record<FlavorOp, readonly number[]>>;
};

// Arithmetic/compare opcode classes a slot-linked proof can require.
export type FlavorOp = "add" | "sub" | "mul" | "div" | "lt" | "gt" | "eq" | "iszero";

// Best-effort dataflow window (S-115 specificity): an opcode within this
// many PCs of a slot load counts as operating on the loaded value.
// Stack-machine code keeps a load and its first use close; a distant
// opcode belongs to other logic in merged output and must not count.
export const SLOT_FLAVOR_WINDOW_PC = 16;

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

// Straight-line window for the packed-bool read-modify-write scan: the
// bit set/clear sits directly beside its slot load and store.
const PACKED_BOOL_LOOKBACK = 64;

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
  // Conservative slot proof: a constant slot counts only when the slot
  // push sits directly beside the access (PUSH0 or PUSH slot, SLOAD or
  // SSTORE). A distant PUSH belongs to other code in merged solc output
  // and must not be guessed. Mapping access still needs a KECCAK256 in
  // the short window, since hashed lookups never sit adjacent.
  const adjacent = insns[index - 1];
  if (adjacent !== undefined) {
    if (adjacent.opcode === 0x5f) {
      return { kind: "const", value: 0 };
    }
    if (adjacent.opcode >= 0x60 && adjacent.opcode <= 0x7f) {
      const value = pushNumber(adjacent.immediate);
      return value === null ? { kind: "unknown" } : { kind: "const", value };
    }
  }
  let steps = 0;
  for (let back = index - 1; back >= 0 && steps < LOOKBACK; back -= 1, steps += 1) {
    const candidate = insns[back];
    if (candidate === undefined) {
      break;
    }
    if (candidate.opcode === 0x20) {
      return { kind: "mapping" };
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

// Best-effort call-target source for one CALL-family instruction: the
// window behind the call names msg.sender (CALLER) first, since a payout
// to msg.sender beside balance bookkeeping still pays out rather than
// calling a stored hook. Shared with the capability sweep, so a
// send-to-caller CALL never proves an outside-contract power or a hook.
export function callTargetOfInstruction(
  insns: readonly Instruction[],
  index: number,
): ExternalCallOp["target"] {
  let sawCaller = false;
  let sawSload = false;
  let sawCalldata = false;
  let sawPushAddress = false;
  let steps = 0;
  for (let back = index - 1; back >= 0 && steps < LOOKBACK; back -= 1, steps += 1) {
    const candidate = insns[back];
    if (candidate === undefined) {
      break;
    }
    if (candidate.opcode === 0x33) {
      sawCaller = true;
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
  if (sawCaller) {
    return "caller";
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



// Packed-bool write proof (P-11): OpenZeppelin 1.x/2.x Pausable packs
// `paused` with `owner` in slot 0, so no plain PUSH value ever sits
// beside the SSTORE. The compiled read-modify-write is straight-line
// code: `SLOAD s` with the slot pushed beside it, a `0`/`1` bit shifted
// by `PUSH 0x0100^k MUL`, by `SHL`, or (old solc) by `PUSH 0x02 PUSH k
// EXP` (2**k), then the store back to `s`. A pure shifted-OR set with no
// NOT proves bit 1; a shifted AND with NOT and no OR proves the clear to
// bit 0. Anything else (both, neither, no shift, a jump between the load
// and the store) stays unrecognised and keeps its null value, so an
// ambiguous write never doubles as a flag write. The scan reads the
// linear stream, so the no-jump requirement doubles as a linearity
// guard: a threshold crossed between functions belongs to other code and
// must not prove a packed write.
export type PackedBoolProof = {
  // The proven bit value, with the bit position when the shift constant
  // names it (null when the shift is proven but its position is not, as
  // with a bare SHL beside an unrelated nonzero PUSH).
  readonly value: 0 | 1;
  readonly shift: number | null;
};

export function packedBoolWriteAt(
  insns: readonly Instruction[],
  index: number,
  slot: number,
): PackedBoolProof | null {
  let loadIndex = -1;
  for (let back = index - 1, steps = 0; back >= 0 && steps < PACKED_BOOL_LOOKBACK; back -= 1, steps += 1) {
    const candidate = insns[back];
    if (candidate === undefined) {
      break;
    }
    if (candidate.opcode !== 0x54) {
      continue;
    }
    const slotPush = insns[back - 1];
    if (
      slotPush === undefined ||
      !((slotPush.opcode === 0x5f && slot === 0) ||
        (slotPush.opcode >= 0x60 &&
          slotPush.opcode <= 0x7f &&
          pushNumber(slotPush.immediate) === slot))
    ) {
      continue;
    }
    loadIndex = back;
    break;
  }
  if (loadIndex < 0) {
    return null;
  }
  let hasOr = false;
  let hasAnd = false;
  let hasNot = false;
  let hasMulShift = false;
  let hasShlShift = false;
  let hasExpShift = false;
  const shlAt: number[] = [];
  const expAt: number[] = [];
  for (let at = loadIndex + 1; at < index; at += 1) {
    const opcode = insns[at]?.opcode;
    if (opcode === undefined) {
      return null;
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
      return null;
    }
    if (opcode === 0x17) {
      hasOr = true;
    } else if (opcode === 0x16) {
      hasAnd = true;
    } else if (opcode === 0x19) {
      hasNot = true;
    } else if (opcode === 0x02) {
      hasMulShift = true;
    } else if (opcode === 0x1b) {
      hasShlShift = true;
      shlAt.push(at);
    } else if (opcode === 0x0a) {
      hasExpShift = true;
      expAt.push(at);
    }
  }
  // The shift position, when the constant names it: a PUSH beside SHL,
  // a 0x0100^k beside MUL, or a {0x02, k} pair beside EXP in either
  // order. The boolean `shift` below keeps the older leniency (any
  // nonzero PUSH beside an SHL), so the stored value proof never
  // narrows; only the position may stay null.
  let shiftPosition: number | null = null;
  for (const at of shlAt) {
    const before = insns[at - 1];
    if (before !== undefined && before.opcode >= 0x60 && before.opcode <= 0x7f) {
      const value = pushNumber(before.immediate);
      if (value !== null && value > 0) {
        shiftPosition = value;
        break;
      }
    }
  }
  let shift = false;
  if (hasShlShift) {
    for (let at = loadIndex + 1; at < index; at += 1) {
      const push = insns[at];
      if (
        push !== undefined &&
        push.opcode >= 0x60 &&
        push.opcode <= 0x7f &&
        (pushNumber(push.immediate) ?? 0) > 0
      ) {
        shift = true;
        break;
      }
    }
  }
  if (hasMulShift && !shift) {
    for (let at = loadIndex + 1; at < index; at += 1) {
      const push = insns[at];
      if (push === undefined || push.opcode < 0x60 || push.opcode > 0x7f) {
        continue;
      }
      const value = pushNumber(push.immediate);
      if (value === 0x100 || value === 0x10000 || value === 0x1000000) {
        if (shiftPosition === null) {
          shiftPosition = value === 0x100 ? 8 : value === 0x10000 ? 16 : 24;
        }
        shift = true;
        break;
      }
    }
  }
  if (hasExpShift && !shift) {
    for (const at of expAt) {
      const first = insns[at - 1];
      const second = insns[at - 2];
      if (
        first === undefined ||
        second === undefined ||
        first.opcode < 0x60 ||
        first.opcode > 0x7f ||
        second.opcode < 0x60 ||
        second.opcode > 0x7f
      ) {
        continue;
      }
      const firstValue = pushNumber(first.immediate);
      const secondValue = pushNumber(second.immediate);
      if (firstValue === null || secondValue === null) {
        continue;
      }
      if (firstValue === 0x02 && secondValue > 0) {
        shiftPosition = secondValue;
        shift = true;
        break;
      }
      if (secondValue === 0x02 && firstValue > 0) {
        shiftPosition = firstValue;
        shift = true;
        break;
      }
    }
  }
  if (!shift) {
    return null;
  }
  if (hasOr && !hasNot) {
    return Object.freeze({ value: 1 as const, shift: shiftPosition });
  }
  if (hasAnd && hasNot && !hasOr) {
    return Object.freeze({ value: 0 as const, shift: shiftPosition });
  }
  return null;
}

function resolvePackedBoolWrite(
  insns: readonly Instruction[],
  index: number,
  slot: number,
): number | null {
  return packedBoolWriteAt(insns, index, slot)?.value ?? null;
}

// Region facts read the full instruction stream at each index, but only
// member instructions contribute facts: adjacency and window scans keep
// their code-order meaning even when the region skips shared or dead
// instructions between two of its own.
function regionOf(
  selector: SelectorType,
  entryPc: number,
  insns: readonly Instruction[],
  isMember: (pc: number) => boolean,
  packedBools: boolean,
): RegionFacts {
  let hasCaller = false;
  const callerPcs: number[] = [];
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
  const opPcs: Record<FlavorOp, number[]> = {
    add: [],
    sub: [],
    mul: [],
    div: [],
    lt: [],
    gt: [],
    eq: [],
    iszero: [],
  };
  const stores: StoreOp[] = [];
  const loads: LoadOp[] = [];
  const calls: ExternalCallOp[] = [];
  for (let index = 0; index < insns.length; index += 1) {
    const instruction = insns[index];
    if (instruction === undefined || !isMember(instruction.pc)) {
      continue;
    }
    switch (instruction.opcode) {
      case 0x33:
        hasCaller = true;
        callerPcs.push(instruction.pc);
        break;
      case 0x35:
        hasCalldataLoad = true;
        break;
      case 0x14:
        hasEq = true;
        opPcs["eq"].push(instruction.pc);
        break;
      case 0x15:
        hasIsZero = true;
        opPcs["iszero"].push(instruction.pc);
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
        opPcs["add"].push(instruction.pc);
        break;
      case 0x03:
        hasSub = true;
        opPcs["sub"].push(instruction.pc);
        break;
      case 0x02:
        hasMul = true;
        opPcs["mul"].push(instruction.pc);
        break;
      case 0x04:
        hasDiv = true;
        opPcs["div"].push(instruction.pc);
        break;
      case 0x10:
        hasLt = true;
        opPcs["lt"].push(instruction.pc);
        break;
      case 0x11:
        hasGt = true;
        opPcs["gt"].push(instruction.pc);
        break;
      case 0x55: {
        const slot = resolveSlot(insns, index);
        const value = resolveStoreValue(insns, index);
        // Packed-bool writes resolve only in v2 views (P-11): the v1
        // scored path never sees them, so existing feature findings and
        // the score stay bit-identical while extended analysis reads the
        // packed bit as the stored value.
        const packed =
          packedBools &&
          !value.valueIsZero &&
          value.valueConst === null &&
          slot.kind === "const"
            ? resolvePackedBoolWrite(insns, index, slot.value)
            : null;
        stores.push({
          pc: instruction.pc,
          slot,
          valueIsZero: value.valueIsZero || packed === 0,
          valueConst: packed ?? value.valueConst,
        });
        break;
      }
      case 0x54:
        loads.push({ pc: instruction.pc, slot: resolveSlot(insns, index) });
        break;
      case 0xf1:
      case 0xfa:
      case 0xf4: {
        const kind = instruction.opcode === 0xf1 ? "call" : instruction.opcode === 0xfa ? "staticcall" : "delegatecall";
        calls.push({ pc: instruction.pc, kind, target: callTargetOfInstruction(insns, index) });
        break;
      }
      default:
        break;
    }
  }
  const frozenOpPcs = {
    add: Object.freeze(opPcs["add"].slice()),
    sub: Object.freeze(opPcs["sub"].slice()),
    mul: Object.freeze(opPcs["mul"].slice()),
    div: Object.freeze(opPcs["div"].slice()),
    lt: Object.freeze(opPcs["lt"].slice()),
    gt: Object.freeze(opPcs["gt"].slice()),
    eq: Object.freeze(opPcs["eq"].slice()),
    iszero: Object.freeze(opPcs["iszero"].slice()),
  };
  return {
    selector,
    entryPc,
    hasCaller,
    callerPcs: Object.freeze(callerPcs.slice()),
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
    opPcs: Object.freeze(frozenOpPcs),
  };
}

// Slot-linked flavor proof (S-115 specificity): the load of a constant
// slot beside one of the given opcode classes, or null when no load of
// the slot sits near such an opcode. Loads scan in ascending PC order and
// the gate is the nearest flavor PC, so equal inputs always name the same
// pair. A region presence check alone would credit unrelated merged
// logic; the window keeps the proof on the value the slot actually
// loaded.
export type SlotFlavorProof = {
  readonly loadPc: number;
  readonly gatePc: number;
  readonly flavor: FlavorOp;
};

export function constSlotLoadNearFlavor(
  region: RegionFacts,
  slot: number,
  flavors: readonly FlavorOp[],
  windowPc: number = SLOT_FLAVOR_WINDOW_PC,
): SlotFlavorProof | null {
  for (const load of region.loads) {
    if (load.slot.kind !== "const" || load.slot.value !== slot) {
      continue;
    }
    const gate = nearestFlavorPc(region, flavors, load.pc, windowPc);
    if (gate !== null) {
      return Object.freeze({ loadPc: load.pc, gatePc: gate.pc, flavor: gate.flavor });
    }
  }
  return null;
}

// Slot-linked flavor proof for mapping reads (blacklist gates): the load
// of a mapping entry beside one of the given opcode classes, or null when
// no mapping load sits near such an opcode.
export function mappingLoadNearFlavor(
  region: RegionFacts,
  flavors: readonly FlavorOp[],
  windowPc: number = SLOT_FLAVOR_WINDOW_PC,
): SlotFlavorProof | null {
  for (const load of region.loads) {
    if (load.slot.kind !== "mapping") {
      continue;
    }
    const gate = nearestFlavorPc(region, flavors, load.pc, windowPc);
    if (gate !== null) {
      return Object.freeze({ loadPc: load.pc, gatePc: gate.pc, flavor: gate.flavor });
    }
  }
  return null;
}

// Nearest opcode of the given classes to a PC within the window, or null
// when none sits near. Ties break toward the smaller PC, so equal inputs
// always name the same gate.
export function nearestFlavorPc(
  region: RegionFacts,
  flavors: readonly FlavorOp[],
  nearPc: number,
  windowPc: number = SLOT_FLAVOR_WINDOW_PC,
): { readonly pc: number; readonly flavor: FlavorOp } | null {
  let best: { pc: number; flavor: FlavorOp } | null = null;
  for (const flavor of flavors) {
    for (const pc of region.opPcs[flavor] ?? []) {
      const distance = Math.abs(pc - nearPc);
      if (distance > windowPc) {
        continue;
      }
      if (best === null || distance < Math.abs(best.pc - nearPc) || (distance === Math.abs(best.pc - nearPc) && pc < best.pc)) {
        best = { pc, flavor };
      }
    }
  }
  return best === null ? null : Object.freeze(best);
}

// Ordered veto for boolean gates (S-115 specificity): true when one of the
// given opcode classes fires strictly between the load and the gate. A
// balance or allowance check (`balance >= amount`) compiles to a range
// compare closed by ISZERO, so ISZERO counts as a boolean gate only when
// no LT or GT sits between the load and the gate.
export function flavorBetween(
  region: RegionFacts,
  flavors: readonly FlavorOp[],
  fromPc: number,
  toPc: number,
): boolean {
  const low = Math.min(fromPc, toPc);
  const high = Math.max(fromPc, toPc);
  for (const flavor of flavors) {
    for (const pc of region.opPcs[flavor] ?? []) {
      if (pc > low && pc < high) {
        return true;
      }
    }
  }
  return false;
}

// Standard token entry points that can never prove a privileged writer
// (P-11 session 1 follow-up): transfer, transferFrom, approve,
// increaseAllowance, decreaseAllowance, permit, deposit and withdraw are
// reachable by anyone, so a mapping or flag write inside one proves no
// owner power even when the region happens to carry a caller compare.
// The names resolve through the versioned selector table in
// `./evmNames.ts`; unknown selectors keep their raw form and never match.
const STANDARD_TOKEN_WRITER_NAMES: ReadonlySet<string> = new Set([
  "transfer",
  "transferFrom",
  "approve",
  "increaseAllowance",
  "decreaseAllowance",
  "permit",
  "deposit",
  "withdraw",
]);

export function isStandardTokenWriter(selector: SelectorType): boolean {
  const named = nameForSelector(selector as string, { isFallback: false });
  return STANDARD_TOKEN_WRITER_NAMES.has(named.name);
}

// Privileged-writer proof for extended analysis (P-11 session 1
// follow-up): the writing region must carry a caller check against the
// proven owner slot — CALLER, then an SLOAD of the owner slot, then an
// EQ or ISZERO compare, then a JUMPI that jumps over a REVERT run to a
// later JUMPDEST (the revert-free path). This is the ownership proof the
// scored path uses, evaluated instruction by instruction instead of by
// region flags, so a function reachable by anyone never counts.
export function hasOwnerCallerCheck(
  insns: readonly Instruction[],
  isMember: (pc: number) => boolean,
  ownerSlot: number,
): boolean {
  const isSlotPush = (candidate: Instruction | undefined): boolean => {
    if (candidate === undefined) {
      return false;
    }
    if (candidate.opcode === 0x5f) {
      return ownerSlot === 0;
    }
    return (
      candidate.opcode >= 0x60 &&
      candidate.opcode <= 0x7f &&
      pushNumber(candidate.immediate) === ownerSlot
    );
  };
  // Position lists keep the nested proof linear: each stage scans only
  // its own opcode hits inside the window instead of the whole stream.
  const callers: number[] = [];
  const loads: number[] = [];
  const compares: number[] = [];
  const jumps: number[] = [];
  const reverts: number[] = [];
  const dests: number[] = [];
  for (let at = 0; at < insns.length; at += 1) {
    const candidate = insns[at];
    if (candidate === undefined || !isMember(candidate.pc)) {
      continue;
    }
    if (candidate.opcode === 0x33) {
      callers.push(at);
    } else if (candidate.opcode === 0x54 && isSlotPush(insns[at - 1])) {
      loads.push(at);
    } else if (candidate.opcode === 0x14 || candidate.opcode === 0x15) {
      compares.push(at);
    } else if (candidate.opcode === 0x57) {
      jumps.push(at);
    } else if (candidate.opcode === 0xfd) {
      reverts.push(at);
    } else if (candidate.opcode === 0x5b) {
      dests.push(at);
    }
  }
  const after = (sorted: readonly number[], low: number, high: number): number[] =>
    sorted.filter((at) => at > low && at <= high);
  for (const caller of callers) {
    for (const load of after(loads, caller, caller + 64)) {
      for (const cmp of after(compares, load, load + SLOT_FLAVOR_WINDOW_PC)) {
        for (const jump of after(jumps, cmp, cmp + 64)) {
          for (const revert of after(reverts, jump, jump + 32)) {
            if (after(dests, revert, revert + 64).length > 0) {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

// Mapping base-slot proof (P-11 session 1 follow-up): the keccak
// `keccak(key . baseSlot)` pattern compiles to an MSTORE of the key at
// memory 0x00, an MSTORE of the constant base at memory 0x20, and a
// KECCAK256 over 0x00/0x40. Returns the base constant beside the 0x20
// store, or null when the pattern is absent, so a writer and a gate that
// hash different mappings never pair.
const MAPPING_BASE_LOOKBACK = 40;

function mappingBaseAt(insns: readonly Instruction[], keccakIndex: number): number | null {
  let keyStore = false;
  let base: number | null = null;
  for (
    let at = keccakIndex - 1, steps = 0;
    at >= 0 && steps < MAPPING_BASE_LOOKBACK;
    at -= 1, steps += 1
  ) {
    const candidate = insns[at];
    if (candidate === undefined) {
      break;
    }
    if (candidate.opcode !== 0x52) {
      continue;
    }
    const address = insns[at - 1];
    const value = insns[at - 2];
    if (address === undefined || value === undefined) {
      continue;
    }
    if (
      address.opcode === 0x5f ||
      (address.opcode >= 0x60 && address.opcode <= 0x7f && pushNumber(address.immediate) === 0)
    ) {
      // The hashed key normally arrives from calldata, so the stored
      // value may be any stack item; the constant 0x00 destination is
      // what proves the `keccak(key . baseSlot)` layout.
      keyStore = true;
    }
    if (
      base === null &&
      address.opcode >= 0x60 &&
      address.opcode <= 0x7f &&
      pushNumber(address.immediate) === 0x20 &&
      value.opcode >= 0x60 &&
      value.opcode <= 0x7f
    ) {
      // Nearest first: the scan runs backward from the hash, so the
      // first constant base wins over earlier unrelated stores.
      base = pushNumber(value.immediate);
    }
  }
  return keyStore ? base : null;
}

// Base slot of the mapping access at `accessPc` (an SLOAD or SSTORE whose
// KECCAK256 sits within the slot window behind it), or null when the
// base cannot be determined. Every pattern instruction must belong to the
// region, so adjacent code from another function never proves the base.
export function mappingBaseNearAccess(
  insns: readonly Instruction[],
  isMember: (pc: number) => boolean,
  accessPc: number,
): number | null {
  let accessIndex = -1;
  for (let at = 0; at < insns.length; at += 1) {
    if (insns[at]?.pc === accessPc) {
      accessIndex = at;
      break;
    }
  }
  if (accessIndex < 0) {
    return null;
  }
  let steps = 0;
  for (let back = accessIndex - 1; back >= 0 && steps < LOOKBACK; back -= 1, steps += 1) {
    const candidate = insns[back];
    if (candidate === undefined) {
      break;
    }
    if (candidate.opcode !== 0x20 || !isMember(candidate.pc)) {
      continue;
    }
    const base = mappingBaseAt(insns, back);
    if (base === null) {
      return null;
    }
    return base;
  }
  return null;
}

// Gate-on-the-blocked-side proof (P-11 session 1 follow-up): a member
// JUMPI shortly after `afterPc` (the gate compare) whose fall-through
// reaches a member REVERT before any member JUMPDEST. A compare that
// jumps away while the fall-through continues normally never counts.
export function hasRevertingJumpiAfter(
  insns: readonly Instruction[],
  isMember: (pc: number) => boolean,
  afterPc: number,
): boolean {
  const jumpPcs: number[] = [];
  const revertPcs: number[] = [];
  const destPcs: number[] = [];
  for (const candidate of insns) {
    if (!isMember(candidate.pc)) {
      continue;
    }
    if (candidate.opcode === 0x57) {
      jumpPcs.push(candidate.pc);
    } else if (candidate.opcode === 0xfd) {
      revertPcs.push(candidate.pc);
    } else if (candidate.opcode === 0x5b) {
      destPcs.push(candidate.pc);
    }
  }
  for (const jumpPc of jumpPcs) {
    if (jumpPc <= afterPc || jumpPc > afterPc + 64) {
      continue;
    }
    for (const revertPc of revertPcs) {
      if (revertPc <= jumpPc || revertPc > jumpPc + 32) {
        continue;
      }
      let blocked = true;
      for (const destPc of destPcs) {
        if (destPc > jumpPc && destPc < revertPc) {
          blocked = false;
          break;
        }
      }
      if (blocked) {
        return true;
      }
    }
  }
  return false;
}

// Packed-bool gate proof (P-11 session 1 follow-up): the transfer path
// reads the same slot and bit — SLOAD s, then a shift by the writer's
// amount (DIV by 2**k with the old-solc EXP-built constant, DIV by a
// pushed power of two, or SHR by k), then AND with 0xff, then an EQ or
// ISZERO compare. Returns the load and compare PCs with the proven
// shift, or null.
export function packedGateShift(
  insns: readonly Instruction[],
  isMember: (pc: number) => boolean,
  slot: number,
): { readonly loadPc: number; readonly cmpPc: number; readonly shift: number } | null {
  const isSlotPush = (candidate: Instruction | undefined): boolean => {
    if (candidate === undefined) {
      return false;
    }
    if (candidate.opcode === 0x5f) {
      return slot === 0;
    }
    return (
      candidate.opcode >= 0x60 &&
      candidate.opcode <= 0x7f &&
      pushNumber(candidate.immediate) === slot
    );
  };
  const divisorShift = (divIndex: number): number | null => {
    for (let back = divIndex - 1, steps = 0; back >= 0 && steps < 8; back -= 1, steps += 1) {
      const candidate = insns[back];
      if (candidate === undefined) {
        break;
      }
      if (candidate.opcode === 0x0a) {
        const first = insns[back - 1];
        const second = insns[back - 2];
        if (
          first === undefined ||
          second === undefined ||
          first.opcode < 0x60 ||
          first.opcode > 0x7f ||
          second.opcode < 0x60 ||
          second.opcode > 0x7f
        ) {
          continue;
        }
        const firstValue = pushNumber(first.immediate);
        const secondValue = pushNumber(second.immediate);
        if (firstValue === 0x02 && secondValue !== null && secondValue > 0) {
          return secondValue;
        }
        if (secondValue === 0x02 && firstValue !== null && firstValue > 0) {
          return firstValue;
        }
      }
    }
    const adjacent = insns[divIndex - 1];
    if (adjacent !== undefined && adjacent.opcode >= 0x60 && adjacent.opcode <= 0x7f) {
      const value = pushNumber(adjacent.immediate);
      if (value !== null && value > 1 && (value & (value - 1)) === 0) {
        return Math.log2(value);
      }
    }
    return null;
  };
  for (let load = 0; load < insns.length; load += 1) {
    const loadInsn = insns[load];
    if (loadInsn === undefined || loadInsn.opcode !== 0x54 || !isMember(loadInsn.pc)) {
      continue;
    }
    if (!isSlotPush(insns[load - 1])) {
      continue;
    }
    let shift: number | null = null;
    let masked = false;
    for (let at = load + 1, steps = 0; at < insns.length && steps < 48; at += 1, steps += 1) {
      const candidate = insns[at];
      if (candidate === undefined) {
        break;
      }
      if (
        candidate.opcode === 0x56 ||
        candidate.opcode === 0x57 ||
        candidate.opcode === 0x5b ||
        candidate.opcode === 0x00 ||
        candidate.opcode === 0xfd ||
        candidate.opcode === 0xf3 ||
        candidate.opcode === 0xfe
      ) {
        break;
      }
      if (!isMember(candidate.pc)) {
        continue;
      }
      if (shift === null && candidate.opcode === 0x04) {
        const proven = divisorShift(at);
        if (proven !== null) {
          shift = proven;
        }
        continue;
      }
      if (shift === null && candidate.opcode === 0x1c) {
        const amount = insns[at - 1];
        if (amount !== undefined && amount.opcode >= 0x60 && amount.opcode <= 0x7f) {
          const value = pushNumber(amount.immediate);
          if (value !== null && value > 0) {
            shift = value;
          }
        }
        continue;
      }
      if (shift !== null && !masked && candidate.opcode === 0x16) {
        const mask = insns[at - 1];
        if (
          mask !== undefined &&
          mask.opcode >= 0x60 &&
          mask.opcode <= 0x7f &&
          pushNumber(mask.immediate) === 0xff
        ) {
          masked = true;
        }
        continue;
      }
      if (masked && (candidate.opcode === 0x15 || candidate.opcode === 0x14)) {
        return Object.freeze({ loadPc: loadInsn.pc, cmpPc: candidate.pc, shift: shift ?? 0 });
      }
    }
  }
  return null;
}

// Reachability mode for region membership (P-10). `v1` is the scored
// default: a region holds exactly the instructions one entry uniquely
// reaches, so shared helpers belong to no region. `v2` reruns reachability
// per entry through the return-jump resolver, so a shared helper reached
// through a dynamic return belongs to every entry that reaches it. The
// scored detector path always uses `v1`; `v2` is display-only until P-11
// re-measures the plugins.
export type ReachMode = "v1" | "v2";

export type OwnerControlOptions = {
  readonly reach?: ReachMode;
};

// Structural owner-control view over frozen bytecode. Total: any bytecode
// maps to a view, possibly with no regions, no owner slot and no transfer
// paths, and the detectors below turn an empty proof into no findings
// rather than a guess.
export function analyzeOwnerControl(bytecode: BytecodeType, options?: OwnerControlOptions): OwnerControlView {
  const reach = options?.reach ?? "v1";
  const code = disassemble(bytecode);
  const entries = extractSelectors(bytecode).filter(
    (entry): entry is Extract<SelectorEntry, { kind: "paired" }> => entry.kind === "paired",
  );
  const byTarget = entries.slice().sort((left, right) => (left.target as number) - (right.target as number));
  // One reachability lookup per instruction: a region holds exactly the
  // instructions its entry reaches, so shared tails and dead code belong
  // to no region instead of the neighbouring entry. In v2 the lookup
  // reads every holder, so shared blocks reached through a resolved
  // return join each entry that reaches them.
  const attribution = attributeFunctions(bytecode, { mode: reach });
  const holderByPc = new Map<number, string>();
  const holdersByPc = new Map<number, readonly SelectorType[]>();
  for (const instruction of code) {
    const holder = attribution.holderOf(instruction.pc);
    holderByPc.set(instruction.pc, holder === null ? "" : (holder as string));
    holdersByPc.set(instruction.pc, attribution.holdersOf(instruction.pc));
  }
  const regions: RegionFacts[] = [];
  for (const entry of byTarget) {
    const start = entry.target as number;
    const wanted = entry.selector;
    if (reach === "v2") {
      regions.push(
        regionOf(entry.selector, start, code, (pc) => holdersByPc.get(pc)?.includes(wanted) ?? false, true),
      );
    } else {
      const expected = wanted as string;
      regions.push(regionOf(entry.selector, start, code, (pc) => holderByPc.get(pc) === expected, false));
    }
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

// Reachability diagnostics for later display (P-10, display-only): the
// unresolved dynamic-jump count under v1 against the count left after the
// v2 return-jump resolver. A v1 jump counts as resolved in v2 when at
// least one function entry resolves it, so the v2 count never exceeds the
// v1 count. Frozen and total like every other view in this module.
export type ReachDiagnostics = {
  readonly entries: number;
  readonly v1UnresolvedJumps: number;
  readonly v2UnresolvedJumps: number;
};

export function diagnoseReachability(bytecode: BytecodeType): ReachDiagnostics {
  const cfg = buildCfg(lift(bytecode));
  const found = findFunctionEntries(bytecode, cfg);
  const resolved = new Set<number>();
  for (const entry of found) {
    for (const atPc of resolveEntryReachV2(cfg, entry.entryBlock).resolvedJumpAtPc) {
      resolved.add(atPc);
    }
  }
  let v2Unresolved = 0;
  for (const jump of cfg.unresolvedJumps) {
    if (!resolved.has(jump.atPc)) {
      v2Unresolved += 1;
    }
  }
  return Object.freeze({
    entries: found.length,
    v1UnresolvedJumps: cfg.unresolvedJumps.length,
    v2UnresolvedJumps: v2Unresolved,
  });
}

// Regions of the view keyed by selector for one lookup per detector.
