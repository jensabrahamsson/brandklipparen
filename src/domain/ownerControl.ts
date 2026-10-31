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
import type { CfgBlock } from "./evmLift.ts";
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

// Best-effort storage slot reference for one SLOAD or SSTORE. A mapping
// slot carries its hashed base slot when the v2 stack interpreter proves
// it (`base` is null when the base stays unknown); old consumers keep
// working by reading `kind` alone.
export type SlotRef =
  | { readonly kind: "const"; readonly value: number }
  | { readonly kind: "mapping"; readonly base: number | null }
  | { readonly kind: "unknown" };

// Lookup of the v2 interpreter slot per SLOAD/SSTORE pc: undefined when
// the interpreter holds no information for the pc.
export type SlotLookup = (pc: number) => SlotRef | undefined;

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
      return { kind: "mapping", base: null };
    }
  }
  return { kind: "unknown" };
}

// Prefer an interpreter slot over the legacy window proof: a known
// interpreter result (const through DUP/SWAP chains, mapping with a
// proven base) always wins, while an unknown or missing interpreter
// result keeps the legacy answer untouched, so v1 output never changes.
function pickSlot(interpreter: SlotRef | undefined, legacy: SlotRef): SlotRef {
  if (interpreter === undefined || interpreter.kind === "unknown") {
    return legacy;
  }
  return interpreter;
}

// Symbolic expression interpreter for v2 slot resolution (P-10d).
// Upgrades the P-10c slot-value walk to small symbolic expressions over
// the region's v2 blocks, including through resolved internal call/return
// jumps (bounded fixpoint; differing values merge to unknown):
// const(bigint) | caller | callvalue | calldata(offset) | sload(slot) |
// keccak(words) | op(name, args) | unknown, with constant folding for the
// arithmetic/compare ops via bigint masked to 256 bits, depth/size caps
// (unknown beyond), and a memory model for the 0x00/0x20 words backing
// keccak mapping slots. Old solc moves slots through PUSH/DUP/SWAP
// chains and builds shifts with EXP/SHL, which the adjacent-PUSH window
// proof never sees. Blocks walk in CFG order from the entry with a
// per-block entry state; joins merge differing values to unknown. Total
// and bounded: the visit cap, the stack depth cap and the expression
// caps hold on hostile input, and the interpreter never throws.
export type Expr =
  | { readonly kind: "const"; readonly value: bigint }
  | { readonly kind: "caller" }
  | { readonly kind: "callvalue" }
  | { readonly kind: "unknown" }
  | { readonly kind: "calldata"; readonly offset: Expr }
  | { readonly kind: "sload"; readonly slot: Expr }
  | { readonly kind: "keccak"; readonly words: readonly Expr[] }
  | { readonly kind: "op"; readonly name: string; readonly args: readonly Expr[] };

const EXPR_UNKNOWN: Expr = Object.freeze({ kind: "unknown" }) as Expr;
const EXPR_CALLER: Expr = Object.freeze({ kind: "caller" }) as Expr;
const EXPR_CALLVALUE: Expr = Object.freeze({ kind: "callvalue" }) as Expr;

const MASK256 = (1n << 256n) - 1n;
const MASK160 = (1n << 160n) - 1n;

// Total block-visit budget for one region walk: merging only ever moves
// values toward unknown, so the walk settles on its own; the cap is the
// backstop on hostile shapes.
export const V2_SLOT_MAX_VISITS = 4096;
const V2_SLOT_MAX_DEPTH = 64;
const EXPR_MAX_DEPTH = 12;
const EXPR_MAX_NODES = 64;

export type ExprStoreRecord = {
  readonly slot: Expr;
  readonly value: Expr;
};

export type RegionExprs = {
  readonly stores: ReadonlyMap<number, ExprStoreRecord>;
  readonly loads: ReadonlyMap<number, Expr>;
  readonly jumpis: ReadonlyMap<number, Expr>;
};

type V2State = {
  readonly stack: readonly Expr[];
  readonly mem0: Expr;
  readonly mem32: Expr;
};

function exprConstOf(value: bigint): Expr {
  return Object.freeze({ kind: "const", value: value & MASK256 }) as Expr;
}

function exprPushValue(immediate: readonly number[]): Expr {
  if (immediate.length === 0) {
    return exprConstOf(0n);
  }
  if (immediate.length > 32) {
    return EXPR_UNKNOWN;
  }
  let value = 0n;
  for (const byte of immediate) {
    value = (value * 256n + BigInt(byte ?? 0)) & MASK256;
  }
  return exprConstOf(value);
}

export function exprConstValue(expr: Expr | undefined): bigint | null {
  if (expr !== undefined && expr.kind === "const") {
    return expr.value;
  }
  return null;
}



function exprDepth(expr: Expr): number {
  if (expr.kind === "const" || expr.kind === "caller" || expr.kind === "callvalue" || expr.kind === "unknown") {
    return 0;
  }
  if (expr.kind === "calldata") {
    return 1 + exprDepth(expr.offset);
  }
  if (expr.kind === "sload") {
    return 1 + exprDepth(expr.slot);
  }
  if (expr.kind === "keccak") {
    let depth = 0;
    for (const word of expr.words) {
      const wordDepth = exprDepth(word);
      if (wordDepth > depth) {
        depth = wordDepth;
      }
    }
    return 1 + depth;
  }
  let depth = 0;
  for (const arg of expr.args) {
    const argDepth = exprDepth(arg);
    if (argDepth > depth) {
      depth = argDepth;
    }
  }
  return 1 + depth;
}

function exprNodeCount(expr: Expr): number {
  if (expr.kind === "const" || expr.kind === "caller" || expr.kind === "callvalue" || expr.kind === "unknown") {
    return 1;
  }
  if (expr.kind === "calldata") {
    return 1 + exprNodeCount(expr.offset);
  }
  if (expr.kind === "sload") {
    return 1 + exprNodeCount(expr.slot);
  }
  if (expr.kind === "keccak") {
    let total = 1;
    for (const word of expr.words) {
      total += exprNodeCount(word);
    }
    return total;
  }
  let total = 1;
  for (const arg of expr.args) {
    total += exprNodeCount(arg);
  }
  return total;
}

function exprOverCaps(depth: number, nodes: number): boolean {
  return depth > EXPR_MAX_DEPTH || nodes > EXPR_MAX_NODES;
}

function powMod(base: bigint, exp: bigint): bigint {
  if (exp < 0n) {
    return 0n;
  }
  let result = 1n;
  let power = base & MASK256;
  let shift = exp;
  while (shift > 0n) {
    if ((shift & 1n) === 1n) {
      result = (result * power) & MASK256;
    }
    power = (power * power) & MASK256;
    shift >>= 1n;
  }
  return result;
}

function foldConstOp(name: string, args: readonly bigint[]): bigint | null {
  const at = (index: number): bigint => args[index] ?? 0n;
  switch (name) {
    case "ADD":
      return (at(0) + at(1)) & MASK256;
    case "SUB":
      return (at(0) - at(1)) & MASK256;
    case "MUL":
      return (at(0) * at(1)) & MASK256;
    case "EXP": {
      // Lenient like the legacy window proof: a {2,k} or {0x0100,k}
      // pair in either order names the shift 2**k or 256**k, so the
      // old-solc PUSH 20 PUSH 0x0100 EXP order still folds to 256**20.
      const left = at(0);
      const right = at(1);
      const two = 2n;
      const base256 = 0x100n;
      if (left === two && right >= 0n && right < 256n) {
        return powMod(two, right);
      }
      if (right === two && left >= 0n && left < 256n) {
        return powMod(two, left);
      }
      if (left === base256 && right >= 0n && right < 256n) {
        return powMod(base256, right);
      }
      if (right === base256 && left >= 0n && left < 256n) {
        return powMod(base256, left);
      }
      if (right < 0n || right > MASK256) {
        return 0n;
      }
      return powMod(left, right);
    }
    case "DIV":
      return at(1) === 0n ? 0n : at(0) / at(1);
    case "AND":
      return at(0) & at(1);
    case "OR":
      return at(0) | at(1);
    case "NOT":
      return (~at(0)) & MASK256;
    case "ISZERO":
      return at(0) === 0n ? 1n : 0n;
    case "EQ":
      return at(0) === at(1) ? 1n : 0n;
    case "LT":
      return at(0) < at(1) ? 1n : 0n;
    case "GT":
      return at(0) > at(1) ? 1n : 0n;
    case "SHL": {
      // Args are [value, shift] (second stack item, then top).
      const value = at(0);
      const shift = at(1);
      if (shift < 0n || shift >= 256n) {
        return 0n;
      }
      return (value << shift) & MASK256;
    }
    case "SHR": {
      const value = at(0);
      const shift = at(1);
      if (shift < 0n || shift >= 256n) {
        return 0n;
      }
      return value >> shift;
    }
    default:
      return null;
  }
}

const FOLDABLE_OPS: ReadonlySet<string> = new Set([
  "ADD",
  "SUB",
  "MUL",
  "EXP",
  "DIV",
  "AND",
  "OR",
  "NOT",
  "ISZERO",
  "EQ",
  "LT",
  "GT",
  "SHL",
  "SHR",
]);

function exprMakeOp(name: string, args: readonly Expr[]): Expr {
  const frozenArgs = Object.freeze(args.slice());
  let depth = 1;
  let nodes = 1;
  for (const arg of frozenArgs) {
    const argDepth = exprDepth(arg);
    if (argDepth + 1 > depth) {
      depth = argDepth + 1;
    }
    nodes += exprNodeCount(arg);
  }
  if (exprOverCaps(depth, nodes)) {
    return EXPR_UNKNOWN;
  }
  if (FOLDABLE_OPS.has(name)) {
    const values: bigint[] = [];
    for (const arg of frozenArgs) {
      if (arg.kind !== "const") {
        values.length = 0;
        break;
      }
      values.push(arg.value);
    }
    if (values.length === frozenArgs.length) {
      const folded = foldConstOp(name, values);
      if (folded !== null) {
        return exprConstOf(folded);
      }
    }
  }
  return Object.freeze({ kind: "op", name, args: frozenArgs }) as Expr;
}

function exprMakeCalldata(offset: Expr): Expr {
  const depth = 1 + exprDepth(offset);
  const nodes = 1 + exprNodeCount(offset);
  if (exprOverCaps(depth, nodes)) {
    return EXPR_UNKNOWN;
  }
  return Object.freeze({ kind: "calldata", offset }) as Expr;
}

function exprMakeSload(slot: Expr): Expr {
  const depth = 1 + exprDepth(slot);
  const nodes = 1 + exprNodeCount(slot);
  if (exprOverCaps(depth, nodes)) {
    return EXPR_UNKNOWN;
  }
  return Object.freeze({ kind: "sload", slot }) as Expr;
}

function exprMakeKeccak(words: readonly Expr[]): Expr {
  const frozen = Object.freeze(words.slice());
  let depth = 1;
  let nodes = 1;
  for (const word of frozen) {
    const wordDepth = exprDepth(word);
    if (wordDepth + 1 > depth) {
      depth = wordDepth + 1;
    }
    nodes += exprNodeCount(word);
  }
  if (exprOverCaps(depth, nodes)) {
    return EXPR_UNKNOWN;
  }
  return Object.freeze({ kind: "keccak", words: frozen }) as Expr;
}

export function exprEqual(left: Expr, right: Expr): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "const" && right.kind === "const") {
    return left.value === right.value;
  }
  if (left.kind === "caller" || left.kind === "callvalue" || left.kind === "unknown") {
    return true;
  }
  if (left.kind === "calldata" && right.kind === "calldata") {
    return exprEqual(left.offset, right.offset);
  }
  if (left.kind === "sload" && right.kind === "sload") {
    return exprEqual(left.slot, right.slot);
  }
  if (left.kind === "keccak" && right.kind === "keccak") {
    if (left.words.length !== right.words.length) {
      return false;
    }
    for (let index = 0; index < left.words.length; index += 1) {
      if (!exprEqual(left.words[index] ?? EXPR_UNKNOWN, right.words[index] ?? EXPR_UNKNOWN)) {
        return false;
      }
    }
    return true;
  }
  if (left.kind === "op" && right.kind === "op") {
    if (left.name !== right.name || left.args.length !== right.args.length) {
      return false;
    }
    for (let index = 0; index < left.args.length; index += 1) {
      if (!exprEqual(left.args[index] ?? EXPR_UNKNOWN, right.args[index] ?? EXPR_UNKNOWN)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function exprMergeValue(left: Expr, right: Expr): Expr {
  return exprEqual(left, right) ? left : EXPR_UNKNOWN;
}

// Mapping info for a slot expression: undefined when not a mapping slot,
// null base when the hash proves mapping-shaped but the base stays
// unknown, otherwise the constant base number.
function exprMappingInfo(slot: Expr): { readonly mapping: false } | { readonly mapping: true; readonly base: number | null } {
  const baseOf = (word: Expr): number | null | undefined => {
    const value = exprConstValue(word);
    if (value === null) {
      return null;
    }
    if (value > 0xffffffffn) {
      return null;
    }
    return Number(value);
  };
  if (slot.kind === "keccak") {
    if (slot.words.length !== 2) {
      return { mapping: true, base: null };
    }
    const base = baseOf(slot.words[1] ?? EXPR_UNKNOWN);
    if (base === undefined) {
      return { mapping: true, base: null };
    }
    return { mapping: true, base };
  }
  if (slot.kind === "op" && slot.name === "ADD" && slot.args.length === 2) {
    const left = slot.args[0] ?? EXPR_UNKNOWN;
    const right = slot.args[1] ?? EXPR_UNKNOWN;
    const leftInfo = exprMappingInfo(left);
    const rightInfo = exprMappingInfo(right);
    if (leftInfo.mapping && exprConstValue(right) !== null) {
      return leftInfo;
    }
    if (rightInfo.mapping && exprConstValue(left) !== null) {
      return rightInfo;
    }
  }
  return { mapping: false };
}

export function exprMappingBase(slot: Expr | undefined): number | null | undefined {
  if (slot === undefined) {
    return undefined;
  }
  const info = exprMappingInfo(slot);
  if (!info.mapping) {
    return undefined;
  }
  return info.base;
}

function exprSlotOf(key: Expr): SlotRef {
  const constant = exprConstValue(key);
  if (constant !== null) {
    if (constant <= 0xffffffffn) {
      return { kind: "const", value: Number(constant) };
    }
    return { kind: "unknown" };
  }
  const info = exprMappingInfo(key);
  if (info.mapping) {
    return { kind: "mapping", base: info.base };
  }
  return { kind: "unknown" };
}

function exprMergeSlot(left: SlotRef, right: SlotRef): SlotRef {
  if (left.kind === "const" && right.kind === "const" && left.value === right.value) {
    return left;
  }
  if (left.kind === "mapping" && right.kind === "mapping" && left.base === right.base) {
    return left;
  }
  if (left.kind === "unknown" && right.kind === "unknown") {
    return left;
  }
  return { kind: "unknown" };
}

// Generic stack effect (pops, pushes) for opcodes the interpreter does
// not model precisely; null ends the block (halting opcodes). Counts
// mirror the stack-depth table in `./evmFlow.ts`; results are always
// unknown, so drift here only costs precision, never soundness of a
// proven slot.
function v2EffectOf(opcode: number): { readonly pops: number; readonly pushes: number } | null {
  switch (opcode) {
    case 0x00:
    case 0xfe:
    case 0xff:
    case 0xf3:
    case 0xfd:
      return null;
    case 0x01:
    case 0x02:
    case 0x03:
    case 0x04:
    case 0x05:
    case 0x06:
    case 0x07:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x10:
    case 0x11:
    case 0x12:
    case 0x13:
    case 0x14:
    case 0x16:
    case 0x17:
    case 0x18:
    case 0x1a:
    case 0x1b:
    case 0x1c:
    case 0x1d:
      return { pops: 2, pushes: 1 };
    case 0x08:
    case 0x09:
      return { pops: 3, pushes: 1 };
    case 0x0a:
      return { pops: 2, pushes: 1 };
    case 0x15:
    case 0x19:
      return { pops: 1, pushes: 1 };
    case 0x31:
    case 0x35:
    case 0x3b:
    case 0x3f:
    case 0x40:
    case 0x42:
    case 0x49:
    case 0x5c:
      return { pops: 1, pushes: 1 };
    case 0x30:
    case 0x32:
    case 0x33:
    case 0x34:
    case 0x36:
    case 0x38:
    case 0x3a:
    case 0x3d:
    case 0x41:
    case 0x43:
    case 0x44:
    case 0x45:
    case 0x46:
    case 0x47:
    case 0x48:
    case 0x4a:
    case 0x58:
    case 0x59:
    case 0x5a:
      return { pops: 0, pushes: 1 };
    case 0x37:
    case 0x39:
    case 0x3e:
    case 0x5e:
      return { pops: 3, pushes: 0 };
    case 0x3c:
      return { pops: 4, pushes: 0 };
    case 0x5d:
      return { pops: 2, pushes: 0 };
    case 0xa0:
    case 0xa1:
    case 0xa2:
    case 0xa3:
    case 0xa4:
      return { pops: 2 + (opcode - 0xa0), pushes: 0 };
    case 0xf0:
      return { pops: 3, pushes: 1 };
    case 0xf1:
    case 0xf2:
      return { pops: 7, pushes: 1 };
    case 0xf4:
    case 0xfa:
      return { pops: 6, pushes: 1 };
    case 0xf5:
      return { pops: 4, pushes: 1 };
    default:
      return { pops: 0, pushes: 0 };
  }
}

type V2Sim = {
  stack: Expr[];
  mem0: Expr;
  mem32: Expr;
};

function v2Pop(sim: V2Sim): Expr {
  return sim.stack.pop() ?? EXPR_UNKNOWN;
}

function v2Push(sim: V2Sim, value: Expr): void {
  if (sim.stack.length >= V2_SLOT_MAX_DEPTH) {
    sim.stack.shift();
  }
  sim.stack.push(value);
}

function v2Pop2(sim: V2Sim): { readonly second: Expr; readonly top: Expr } {
  const top = v2Pop(sim);
  const second = v2Pop(sim);
  return { second, top };
}

// Simulate one member block from its entry state, recording per SSTORE
// (slot, value), per SLOAD (slot) and per JUMPI (condition) expressions
// for member PCs (conflicts merge to unknown). Stops at the first
// halting opcode; JUMP/JUMPI end the block after popping their inputs.
type V2BlockResult = {
  readonly sim: V2Sim;
  readonly dest: Expr | null;
};

function v2SimulateBlock(
  block: CfgBlock,
  entry: V2State,
  isMember: (pc: number) => boolean,
  stores: Map<number, ExprStoreRecord>,
  loads: Map<number, Expr>,
  jumpis: Map<number, Expr>,
): V2BlockResult {
  const sim: V2Sim = { stack: [...entry.stack], mem0: entry.mem0, mem32: entry.mem32 };
  const recordSlot = (map: Map<number, Expr>, pc: number, slot: Expr): void => {
    const known = map.get(pc);
    map.set(pc, known === undefined ? slot : exprMergeValue(known, slot));
  };
  const recordStore = (pc: number, slot: Expr, value: Expr): void => {
    const known = stores.get(pc);
    if (known === undefined) {
      stores.set(pc, Object.freeze({ slot, value }));
      return;
    }
    stores.set(
      pc,
      Object.freeze({ slot: exprMergeValue(known.slot, slot), value: exprMergeValue(known.value, value) }),
    );
  };
  for (const instruction of block.instructions) {
    const opcode = instruction.opcode;
    if (opcode === 0x5b) {
      continue;
    }
    if (opcode === 0x5f) {
      v2Push(sim, exprConstOf(0n));
      continue;
    }
    if (opcode >= 0x60 && opcode <= 0x7f) {
      v2Push(sim, exprPushValue(instruction.immediate));
      continue;
    }
    if (opcode >= 0x80 && opcode <= 0x8f) {
      const depth = opcode - 0x7f;
      v2Push(sim, sim.stack[sim.stack.length - depth] ?? EXPR_UNKNOWN);
      continue;
    }
    if (opcode >= 0x90 && opcode <= 0x9f) {
      const depth = opcode - 0x8f;
      const top = sim.stack.length - 1;
      const other = top - depth;
      if (top >= 0 && other >= 0) {
        const saved = sim.stack[top] ?? EXPR_UNKNOWN;
        sim.stack[top] = sim.stack[other] ?? EXPR_UNKNOWN;
        sim.stack[other] = saved;
      } else {
        v2Push(sim, EXPR_UNKNOWN);
      }
      continue;
    }
    if (opcode === 0x50) {
      v2Pop(sim);
      continue;
    }
    if (
      opcode === 0x01 ||
      opcode === 0x02 ||
      opcode === 0x03 ||
      opcode === 0x04 ||
      opcode === 0x0a ||
      opcode === 0x10 ||
      opcode === 0x11 ||
      opcode === 0x14 ||
      opcode === 0x16 ||
      opcode === 0x17 ||
      opcode === 0x1b ||
      opcode === 0x1c
    ) {
      const { second, top } = v2Pop2(sim);
      const name =
        opcode === 0x01
          ? "ADD"
          : opcode === 0x02
            ? "MUL"
            : opcode === 0x03
              ? "SUB"
              : opcode === 0x04
                ? "DIV"
                : opcode === 0x0a
                  ? "EXP"
                  : opcode === 0x10
                    ? "LT"
                    : opcode === 0x11
                      ? "GT"
                      : opcode === 0x14
                        ? "EQ"
                        : opcode === 0x16
                          ? "AND"
                          : opcode === 0x17
                            ? "OR"
                            : opcode === 0x1b
                              ? "SHL"
                              : "SHR";
      v2Push(sim, exprMakeOp(name, [second, top]));
      continue;
    }
    if (opcode === 0x15 || opcode === 0x19) {
      const value = v2Pop(sim);
      v2Push(sim, exprMakeOp(opcode === 0x15 ? "ISZERO" : "NOT", [value]));
      continue;
    }
    if (opcode === 0x33) {
      v2Push(sim, EXPR_CALLER);
      continue;
    }
    if (opcode === 0x34) {
      v2Push(sim, EXPR_CALLVALUE);
      continue;
    }
    if (opcode === 0x35) {
      const offset = v2Pop(sim);
      v2Push(sim, exprMakeCalldata(offset));
      continue;
    }
    if (opcode === 0x52) {
      const offset = v2Pop(sim);
      const value = v2Pop(sim);
      const offsetValue = exprConstValue(offset);
      if (offsetValue === 0n) {
        sim.mem0 = value;
      } else if (offsetValue === 0x20n) {
        sim.mem32 = value;
      }
      continue;
    }
    if (opcode === 0x51) {
      const address = v2Pop(sim);
      const addressValue = exprConstValue(address);
      if (addressValue === 0n) {
        v2Push(sim, sim.mem0);
      } else if (addressValue === 0x20n) {
        v2Push(sim, sim.mem32);
      } else {
        v2Push(sim, EXPR_UNKNOWN);
      }
      continue;
    }
    if (opcode === 0x20) {
      const offset = v2Pop(sim);
      const size = v2Pop(sim);
      if (exprConstValue(offset) === 0n && exprConstValue(size) === 0x40n) {
        v2Push(sim, exprMakeKeccak([sim.mem0, sim.mem32]));
      } else {
        v2Push(sim, EXPR_UNKNOWN);
      }
      continue;
    }
    if (opcode === 0x54) {
      const key = sim.stack[sim.stack.length - 1] ?? EXPR_UNKNOWN;
      if (isMember(instruction.pc)) {
        recordSlot(loads, instruction.pc, key);
      }
      v2Pop(sim);
      v2Push(sim, exprMakeSload(key));
      continue;
    }
    if (opcode === 0x55) {
      const key = sim.stack[sim.stack.length - 1] ?? EXPR_UNKNOWN;
      const value = sim.stack[sim.stack.length - 2] ?? EXPR_UNKNOWN;
      if (isMember(instruction.pc)) {
        recordStore(instruction.pc, key, value);
      }
      v2Pop(sim);
      v2Pop(sim);
      continue;
    }
    if (opcode === 0x53) {
      v2Pop(sim);
      v2Pop(sim);
      continue;
    }
    if (opcode === 0x56) {
      const dest = v2Pop(sim);
      return { sim, dest };
    }
    if (opcode === 0x57) {
      v2Pop(sim);
      const condition = v2Pop(sim);
      if (isMember(instruction.pc)) {
        const known = jumpis.get(instruction.pc);
        jumpis.set(instruction.pc, known === undefined ? condition : exprMergeValue(known, condition));
      }
      return { sim, dest: null };
    }
    const effect = v2EffectOf(opcode);
    if (effect === null) {
      return { sim, dest: null };
    }
    for (let at = 0; at < effect.pops; at += 1) {
      v2Pop(sim);
    }
    for (let at = 0; at < effect.pushes; at += 1) {
      v2Push(sim, EXPR_UNKNOWN);
    }
  }
  return { sim, dest: null };
}

// A dynamic JUMP block: ends in JUMP with no proven jump edge, so v1
// records it as unresolved (mirrors the helper in `./evmLift.ts` without
// importing it).
function v2IsDynamicJump(block: CfgBlock): boolean {
  const last = block.instructions[block.instructions.length - 1];
  return (
    block.terminal === "jump" &&
    last !== undefined &&
    last.opcode === 0x56 &&
    !block.successors.some((edge) => edge.kind === "jump")
  );
}

function v2MergeState(known: V2State | undefined, incoming: V2State): { readonly state: V2State; readonly changed: boolean } {
  if (known === undefined) {
    return { state: incoming, changed: true };
  }
  const length = Math.min(known.stack.length, incoming.stack.length);
  const stack: Expr[] = [];
  for (let at = 0; at < length; at += 1) {
    stack.push(exprMergeValue(known.stack[at] ?? EXPR_UNKNOWN, incoming.stack[at] ?? EXPR_UNKNOWN));
  }
  const state: V2State = Object.freeze({
    stack: Object.freeze(stack),
    mem0: exprMergeValue(known.mem0, incoming.mem0),
    mem32: exprMergeValue(known.mem32, incoming.mem32),
  });
  // Changed only when the merged content differs from the known entry:
  // truncation to the shorter stack counts, but an incoming state that
  // merges back to exactly what is known re-queues nothing, so loops
  // settle instead of burning the visit budget.
  let changed = known.stack.length !== length;
  if (!changed) {
    for (let at = 0; at < length; at += 1) {
      if (!exprEqual(known.stack[at] ?? EXPR_UNKNOWN, stack[at] ?? EXPR_UNKNOWN)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed && (!exprEqual(known.mem0, state.mem0) || !exprEqual(known.mem32, state.mem32))) {
    changed = true;
  }
  return { state, changed };
}

// Resolve every member SLOAD/SSTORE/JUMPI of one v2 region through the
// symbolic expression interpreter: const slots surface through DUP/SWAP
// chains and mapping slots carry their proven base (null when the base
// stays unknown), with per-store values and per-jump conditions.
// Total: hostile bytecode yields partial maps, never an exception.
export function interpretRegionExprs(bytecode: BytecodeType, selector: SelectorType): RegionExprs {
  const stores = new Map<number, ExprStoreRecord>();
  const loads = new Map<number, Expr>();
  const jumpis = new Map<number, Expr>();
  try {
    const cfg = buildCfg(lift(bytecode));
    let entryTarget: number | null = null;
    for (const candidate of extractSelectors(bytecode)) {
      if (candidate.kind === "paired" && candidate.selector === (selector as string)) {
        entryTarget = candidate.target as number;
        break;
      }
    }
    if (entryTarget === null) {
      return { stores, loads, jumpis };
    }
    let entryBlock = -1;
    for (const block of cfg.blocks) {
      if (block.range.startPc === entryTarget) {
        entryBlock = block.index;
        break;
      }
    }
    if (entryBlock < 0 || entryBlock >= cfg.blocks.length) {
      return { stores, loads, jumpis };
    }
    const attribution = attributeFunctions(bytecode, { mode: "v2" });
    const isMember = (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
    const reached = resolveEntryReachV2(cfg, entryBlock).reachedBlocks;
    const isWalkable = (index: number): boolean => {
      if (!reached.has(index)) {
        return false;
      }
      const block = cfg.blocks[index];
      return block !== undefined && block.instructions.some((instruction) => isMember(instruction.pc));
    };
    // Return candidates mirror the v2 return-jump resolver: a dynamic
    // jump reached from this entry may continue at any reached member
    // block opening with JUMPDEST.
    const returnBlocks: number[] = [];
    for (const block of cfg.blocks) {
      if (
        reached.has(block.index) &&
        block.instructions[0]?.opcode === 0x5b &&
        block.instructions.some((instruction) => isMember(instruction.pc))
      ) {
        returnBlocks.push(block.index);
      }
    }
    const entries = new Map<number, V2State>();
    const empty: V2State = Object.freeze({
      stack: Object.freeze([]),
      mem0: EXPR_UNKNOWN,
      mem32: EXPR_UNKNOWN,
    });
    entries.set(entryBlock, empty);
    const queue: number[] = [entryBlock];
    let visits = 0;
    while (queue.length > 0 && visits < V2_SLOT_MAX_VISITS) {
      const index = queue.pop() ?? -1;
      const block = cfg.blocks[index];
      const entry = entries.get(index);
      if (block === undefined || entry === undefined) {
        continue;
      }
      visits += 1;
      const simulated = v2SimulateBlock(block, entry, isMember, stores, loads, jumpis);
      const exit: V2State = Object.freeze({
        stack: Object.freeze(simulated.sim.stack),
        mem0: simulated.sim.mem0,
        mem32: simulated.sim.mem32,
      });
      const targets: number[] = [];
      for (const edge of block.successors) {
        if (edge.kind === "conditional") {
          targets.push(edge.to, edge.fallThrough);
        } else {
          targets.push(edge.to);
        }
      }
      // A resolved dynamic return continues at its pushed return
      // address when the stack proves it (internal call/return through
      // the v2 blocks); an unknown destination falls back to every
      // reached member JUMPDEST, mirroring the v2 return-jump resolver.
      if (v2IsDynamicJump(block)) {
        const destValue = exprConstValue(simulated.dest ?? EXPR_UNKNOWN);
        let precise = -1;
        if (destValue !== null) {
          for (const candidate of returnBlocks) {
            if (cfg.blocks[candidate]?.range.startPc === Number(destValue)) {
              precise = candidate;
              break;
            }
          }
        }
        if (precise >= 0) {
          targets.push(precise);
        } else {
          targets.push(...returnBlocks);
        }
      }
      for (const target of targets) {
        if (target < 0 || target >= cfg.blocks.length || !isWalkable(target)) {
          continue;
        }
        const merged = v2MergeState(entries.get(target), exit);
        if (merged.changed) {
          entries.set(target, merged.state);
          queue.push(target);
        }
      }
    }
  } catch {
    // Bounded by construction; partial maps still beat no maps.
  }
  return { stores, loads, jumpis };
}

// Slot lookup derived from the expression walk, so the legacy SlotRef
// consumers keep working while the detectors read the richer maps. A
// known expression result always wins; unknown keeps the legacy unknown.
export function interpretRegionSlots(bytecode: BytecodeType, selector: SelectorType): ReadonlyMap<number, SlotRef> {
  const found = new Map<number, SlotRef>();
  try {
    const exprs = interpretRegionExprs(bytecode, selector);
    for (const [pc, slot] of exprs.loads) {
      found.set(pc, exprSlotOf(slot));
    }
    for (const [pc, record] of exprs.stores) {
      const slot = exprSlotOf(record.slot);
      const known = found.get(pc);
      found.set(pc, known === undefined ? slot : exprMergeSlot(known, slot));
    }
  } catch {
    // Bounded by construction; a partial map still beats no map.
  }
  return found;
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
// bit 0. Old solc with neighbouring packed fields masks first, so a
// masked read-modify-write (`OR(AND(cur, NOT(mask)), 1 << k)` setting
// bit k, `AND(OR(cur, mask), NOT(1 << k))` clearing it) proves the bit
// the trailing combining op decides: a trailing OR sets it, a trailing
// AND with NOT clears it. Anything else (no shift, a lone NOT-masked OR
// with no AND, a jump between the load and the store) stays unrecognised
// and keeps its null value, so an ambiguous write never doubles as a
// flag write. The scan reads the linear stream, so the no-jump
// requirement doubles as a linearity guard: a threshold crossed between
// functions belongs to other code and must not prove a packed write.
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
  slotOf?: SlotLookup,
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
    const adjacent =
      slotPush !== undefined &&
      ((slotPush.opcode === 0x5f && slot === 0) ||
        (slotPush.opcode >= 0x60 &&
          slotPush.opcode <= 0x7f &&
          pushNumber(slotPush.immediate) === slot));
    // In v2 the slot may arrive through DUP/SWAP chains instead of an
    // adjacent PUSH; the interpreter names it. Without a lookup the
    // legacy adjacent proof stands alone.
    const interpreted = slotOf?.(candidate.pc);
    if (!adjacent && (interpreted === undefined || interpreted.kind !== "const" || interpreted.value !== slot)) {
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
  let lastCombine: "or" | "and" | null = null;
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
      lastCombine = "or";
    } else if (opcode === 0x16) {
      hasAnd = true;
      lastCombine = "and";
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
  if (hasOr && hasAnd && hasNot) {
    if (lastCombine === "or") {
      return Object.freeze({ value: 1 as const, shift: shiftPosition });
    }
    if (lastCombine === "and") {
      return Object.freeze({ value: 0 as const, shift: shiftPosition });
    }
  }
  return null;
}

function resolvePackedBoolWrite(
  insns: readonly Instruction[],
  index: number,
  slot: number,
  slotOf?: SlotLookup,
): number | null {
  return packedBoolWriteAt(insns, index, slot, slotOf)?.value ?? null;
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
  slotOf?: SlotLookup,
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
        // In v2 the interpreter resolves slots through DUP/SWAP chains;
        // v1 keeps the legacy window proof untouched.
        const slot = pickSlot(slotOf?.(instruction.pc), resolveSlot(insns, index));
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
            ? resolvePackedBoolWrite(insns, index, slot.value, slotOf)
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
        loads.push({ pc: instruction.pc, slot: pickSlot(slotOf?.(instruction.pc), resolveSlot(insns, index)) });
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

// One proven owner-slot load: the adjacent slot PUSH (legacy proof) or,
// in v2, the interpreter resolving the load to the owner slot through
// DUP/SWAP chains. Shared with the packed-bool gate proof below.
function isProvenOwnerLoad(
  insns: readonly Instruction[],
  at: number,
  slotOf: SlotLookup | undefined,
  ownerSlot: number,
  isSlotPush: (candidate: Instruction | undefined) => boolean,
): boolean {
  if (isSlotPush(insns[at - 1])) {
    return true;
  }
  const loadPc = insns[at]?.pc;
  if (loadPc === undefined) {
    return false;
  }
  const interpreted = slotOf?.(loadPc);
  return interpreted !== undefined && interpreted.kind === "const" && interpreted.value === ownerSlot;
}

export function hasOwnerCallerCheck(
  insns: readonly Instruction[],
  isMember: (pc: number) => boolean,
  ownerSlot: number,
  slotOf?: SlotLookup,
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
    } else if (candidate.opcode === 0x54 && isProvenOwnerLoad(insns, at, slotOf, ownerSlot, isSlotPush)) {
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
  slotOf?: SlotLookup,
): number | null {
  // The v2 interpreter base wins when proven: the stack carries the
  // hash from its MSTORE pattern even across gaps the window scan
  // cannot cross. Otherwise the legacy pattern proof stands.
  const interpreted = slotOf?.(accessPc);
  if (interpreted !== undefined && interpreted.kind === "mapping" && interpreted.base !== null) {
    return interpreted.base;
  }
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
  slotOf?: SlotLookup,
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
    if (!isProvenOwnerLoad(insns, load, slotOf, slot, isSlotPush)) {
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

// Packed-bool gate proof for bool-in-mapping entries (P-11 follow-up):
// the transfer path reads a hashed entry and a packed field inside it —
// SLOAD of the mapping entry, then a shift by the field position (DIV by
// 2**k with the old-solc EXP-built constant, DIV by a pushed power of
// two, or SHR by k), then AND with 0xff, then an EQ or ISZERO compare.
// Real packed reads span more than the near-flavor window (a multi-field
// entry reads every field before combining them), so this scan walks up
// to 48 PCs past the load like the const-slot packed gate proof instead
// of the 16-PC beside window the scored path owns. Returns the load and
// compare PCs with the proven shift and the entry mapping base, or null.
// A null base stays silent: an unknown mapping never proves a pair.
export type PackedMappingGate = {
  readonly loadPc: number;
  readonly cmpPc: number;
  readonly shift: number;
  readonly base: number;
};

export function packedMappingGateShift(
  insns: readonly Instruction[],
  isMember: (pc: number) => boolean,
  slotOf?: SlotLookup,
): PackedMappingGate | null {
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
    const base = mappingBaseNearAccess(insns, isMember, loadInsn.pc, slotOf);
    if (base === null) {
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
        return Object.freeze({ loadPc: loadInsn.pc, cmpPc: candidate.pc, shift: shift ?? 0, base });
      }
    }
  }
  return null;
}

// Expression matchers for v2 only (P-10d). Each tries the symbolic
// interpreter result first; the legacy instruction-window matcher stays as
// the fallback, so a proof the expressions cannot name still proves the
// old way. The `Via` helpers name which matcher proved a step for the
// extended-proof diagnostics.
function exprStripIszero(expr: Expr): { readonly inner: Expr; readonly count: number } {
  let inner = expr;
  let count = 0;
  while (inner.kind === "op" && inner.name === "ISZERO" && inner.args.length === 1) {
    inner = inner.args[0] ?? EXPR_UNKNOWN;
    count += 1;
  }
  return { inner, count };
}

function exprIsCallerSide(expr: Expr): boolean {
  if (expr.kind === "caller") {
    return true;
  }
  if (expr.kind === "op" && expr.name === "AND" && expr.args.length === 2) {
    const left = expr.args[0] ?? EXPR_UNKNOWN;
    const right = expr.args[1] ?? EXPR_UNKNOWN;
    const maskOf = (candidate: Expr): boolean => exprConstValue(candidate) === MASK160;
    if (left.kind === "caller" && maskOf(right)) {
      return true;
    }
    if (right.kind === "caller" && maskOf(left)) {
      return true;
    }
  }
  return false;
}

function exprIsOwnerLoadSide(expr: Expr, ownerSlot: number): boolean {
  const wanted = BigInt(ownerSlot);
  if (expr.kind === "sload" && exprConstValue(expr.slot) === wanted) {
    return true;
  }
  if (expr.kind === "op" && expr.name === "AND" && expr.args.length === 2) {
    const left = expr.args[0] ?? EXPR_UNKNOWN;
    const right = expr.args[1] ?? EXPR_UNKNOWN;
    const maskOf = (candidate: Expr): boolean => exprConstValue(candidate) === MASK160;
    const loadOf = (candidate: Expr): boolean =>
      candidate.kind === "sload" && exprConstValue(candidate.slot) === wanted;
    if (loadOf(left) && maskOf(right)) {
      return true;
    }
    if (loadOf(right) && maskOf(left)) {
      return true;
    }
  }
  return false;
}

function exprIsOwnerEq(expr: Expr, ownerSlot: number): boolean {
  if (expr.kind !== "op" || expr.name !== "EQ" || expr.args.length !== 2) {
    return false;
  }
  const left = expr.args[0] ?? EXPR_UNKNOWN;
  const right = expr.args[1] ?? EXPR_UNKNOWN;
  return (
    (exprIsOwnerLoadSide(left, ownerSlot) && exprIsCallerSide(right)) ||
    (exprIsOwnerLoadSide(right, ownerSlot) && exprIsCallerSide(left))
  );
}

// Owner caller check through expressions: a member JUMPI whose condition
// (through ISZERO chains) is EQ of the owner load and caller (each
// masked or not), with a revert on the failing side. Returns the proving
// jump pc or null.
export function ownerCheckExpr(
  code: readonly Instruction[],
  isMember: (pc: number) => boolean,
  ownerSlot: number,
  jumpis: ReadonlyMap<number, Expr>,
): number | null {
  for (const [pc, cond] of jumpis) {
    if (!isMember(pc)) {
      continue;
    }
    if (cond.kind === "unknown") {
      continue;
    }
    const { inner } = exprStripIszero(cond);
    if (!exprIsOwnerEq(inner, ownerSlot)) {
      continue;
    }
    if (hasRevertingJumpiAfter(code, isMember, pc - 1)) {
      return pc;
    }
  }
  return null;
}

export function ownerCheckVia(
  code: readonly Instruction[],
  isMember: (pc: number) => boolean,
  ownerSlot: number,
  slotOf?: SlotLookup,
  jumpis?: ReadonlyMap<number, Expr>,
): "expr" | "window" | null {
  if (jumpis !== undefined && ownerCheckExpr(code, isMember, ownerSlot, jumpis) !== null) {
    return "expr";
  }
  if (hasOwnerCallerCheck(code, isMember, ownerSlot, slotOf)) {
    return "window";
  }
  return null;
}

function exprLog2(value: bigint): number | null {
  if (value <= 0n) {
    return null;
  }
  if ((value & (value - 1n)) !== 0n) {
    return null;
  }
  let bit = 0;
  let rest = value;
  while (rest > 1n) {
    rest >>= 1n;
    bit += 1;
  }
  return bit;
}

function exprShiftBit(expr: Expr): number | null {
  const direct = exprConstValue(expr);
  if (direct !== null) {
    return exprLog2(direct);
  }
  if (expr.kind === "op" && expr.name === "EXP" && expr.args.length === 2) {
    const left = exprConstValue(expr.args[0] ?? EXPR_UNKNOWN);
    const right = exprConstValue(expr.args[1] ?? EXPR_UNKNOWN);
    if (left === 2n && right !== null && right > 0n && right < 256n) {
      return Number(right);
    }
    if (right === 2n && left !== null && left > 0n && left < 256n) {
      return Number(left);
    }
    if (left === 0x100n && right !== null && right > 0n && right < 256n) {
      return Number(right) * 8;
    }
    if (right === 0x100n && left !== null && left > 0n && left < 256n) {
      return Number(left) * 8;
    }
    return null;
  }
  if (expr.kind === "op" && expr.name === "SHL" && expr.args.length === 2) {
    const value = exprConstValue(expr.args[0] ?? EXPR_UNKNOWN);
    const shift = exprConstValue(expr.args[1] ?? EXPR_UNKNOWN);
    if (value === 1n && shift !== null && shift >= 0n && shift < 256n) {
      return Number(shift);
    }
  }
  return null;
}

function exprMaskBit(mask: Expr): number | null {
  const direct = exprConstValue(mask);
  if (direct !== null) {
    const single = exprLog2(direct);
    if (single !== null) {
      return single;
    }
    if (direct % 0xffn === 0n) {
      const shift = direct / 0xffn;
      const bit = exprLog2(shift);
      if (bit !== null && shift * 0xffn === direct) {
        return bit;
      }
    }
    return null;
  }
  if (mask.kind === "op" && mask.name === "MUL" && mask.args.length === 2) {
    const left = mask.args[0] ?? EXPR_UNKNOWN;
    const right = mask.args[1] ?? EXPR_UNKNOWN;
    if (exprConstValue(left) === 0xffn) {
      return exprShiftBit(right);
    }
    if (exprConstValue(right) === 0xffn) {
      return exprShiftBit(left);
    }
  }
  return exprShiftBit(mask);
}

function exprContainsCalldata(expr: Expr): boolean {
  if (expr.kind === "calldata") {
    return true;
  }
  if (expr.kind === "sload") {
    return exprContainsCalldata(expr.slot);
  }
  if (expr.kind === "keccak") {
    return expr.words.some((word) => exprContainsCalldata(word));
  }
  if (expr.kind === "op") {
    return expr.args.some((arg) => exprContainsCalldata(arg));
  }
  return false;
}

function exprIsBoolish(expr: Expr): boolean {
  const direct = exprConstValue(expr);
  if (direct === 0n || direct === 1n) {
    return true;
  }
  if (expr.kind === "op" && expr.name === "ISZERO" && expr.args.length === 1) {
    const inner = expr.args[0] ?? EXPR_UNKNOWN;
    if (inner.kind === "op" && inner.name === "ISZERO") {
      return true;
    }
  }
  if (expr.kind === "op" && expr.name === "AND" && expr.args.length === 2) {
    const left = expr.args[0] ?? EXPR_UNKNOWN;
    const right = expr.args[1] ?? EXPR_UNKNOWN;
    const masked =
      (exprConstValue(left) === 0xffn && exprContainsCalldata(right)) ||
      (exprConstValue(right) === 0xffn && exprContainsCalldata(left));
    if (masked) {
      return true;
    }
  }
  return false;
}

function exprContainsSloadOf(expr: Expr, slot: number): boolean {
  const wanted = BigInt(slot);
  if (expr.kind === "sload" && exprConstValue(expr.slot) === wanted) {
    return true;
  }
  if (expr.kind === "sload") {
    return exprContainsSloadOf(expr.slot, slot);
  }
  if (expr.kind === "calldata") {
    return exprContainsSloadOf(expr.offset, slot);
  }
  if (expr.kind === "keccak") {
    return expr.words.some((word) => exprContainsSloadOf(word, slot));
  }
  if (expr.kind === "op") {
    return expr.args.some((arg) => exprContainsSloadOf(arg, slot));
  }
  return false;
}

function exprIsShiftedBoolish(expr: Expr, bit: number): boolean {
  const direct = exprConstValue(expr);
  if (direct !== null) {
    if (direct === 0n) {
      return true;
    }
    const shiftBit = exprLog2(direct);
    return shiftBit !== null && shiftBit === bit;
  }
  if (expr.kind === "op" && expr.name === "MUL" && expr.args.length === 2) {
    const left = expr.args[0] ?? EXPR_UNKNOWN;
    const right = expr.args[1] ?? EXPR_UNKNOWN;
    const leftBit = exprShiftBit(left);
    const rightBit = exprShiftBit(right);
    if (exprIsBoolish(left) && rightBit !== null && rightBit === bit) {
      return true;
    }
    if (exprIsBoolish(right) && leftBit !== null && leftBit === bit) {
      return true;
    }
    return false;
  }
  if (expr.kind === "op" && expr.name === "SHL" && expr.args.length === 2) {
    const value = expr.args[0] ?? EXPR_UNKNOWN;
    const shift = exprConstValue(expr.args[1] ?? EXPR_UNKNOWN);
    if (exprIsBoolish(value) && shift !== null && Number(shift) === bit) {
      return true;
    }
  }
  if (exprIsBoolish(expr) && bit === 0) {
    return true;
  }
  return false;
}

function opArgs2(expr: Expr, name: "AND" | "OR"): readonly [Expr, Expr] | null {
  if (expr.kind !== "op" || expr.name !== name || expr.args.length !== 2) {
    return null;
  }
  return [expr.args[0] ?? EXPR_UNKNOWN, expr.args[1] ?? EXPR_UNKNOWN];
}

function notArg(expr: Expr): Expr | null {
  if (expr.kind === "op" && expr.name === "NOT" && expr.args.length === 1) {
    return expr.args[0] ?? EXPR_UNKNOWN;
  }
  return null;
}

// Packed bool write through expressions: SSTORE(slot, OR(AND(sload,
// NOT(mask)), shiftedBool)) and its set/clear variants. The shift is any
// power of two (from folded EXP/SHL/const), the mask the same bit or the
// 0xff byte field over it, and the boolish side ISZERO(ISZERO(x)), a 0/1
// const, or calldata masked to 0xff.
export function packedBoolWriteExpr(slot: number, store: ExprStoreRecord | undefined): { readonly bit: number } | null {
  if (store === undefined || exprConstValue(store.slot) !== BigInt(slot)) {
    return null;
  }
  const value = store.value;
  if (value.kind === "unknown") {
    return null;
  }
  const orPair = opArgs2(value, "OR");
  if (orPair !== null) {
    const orders: readonly (readonly [Expr, Expr])[] = [orPair, [orPair[1], orPair[0]]];
    for (const [andPart, shiftedPart] of orders) {
      const andPair = opArgs2(andPart, "AND");
      if (andPair === null) {
        continue;
      }
      const andOrders: readonly (readonly [Expr, Expr])[] = [andPair, [andPair[1], andPair[0]]];
      for (const [curPart, notPart] of andOrders) {
        const mask = notArg(notPart);
        if (mask === null) {
          continue;
        }
        const maskBit = exprMaskBit(mask);
        if (maskBit === null || !exprContainsSloadOf(curPart, slot)) {
          continue;
        }
        if (exprIsShiftedBoolish(shiftedPart, maskBit)) {
          return Object.freeze({ bit: maskBit });
        }
      }
    }
    for (const [curPart, shiftPart] of orPair !== null ? [[orPair[0], orPair[1]] as const, [orPair[1], orPair[0]] as const] : []) {
      if (exprContainsSloadOf(curPart, slot)) {
        const bit = exprShiftBit(shiftPart);
        if (bit !== null) {
          return Object.freeze({ bit });
        }
      }
    }
  }
  if (value.kind === "op" && value.name === "AND" && value.args.length === 2) {
    const left = value.args[0] ?? EXPR_UNKNOWN;
    const right = value.args[1] ?? EXPR_UNKNOWN;
    const orders: readonly (readonly [Expr, Expr])[] = [
      [left, right],
      [right, left],
    ];
    for (const [first, second] of orders) {
      const orPairInner = opArgs2(first, "OR");
      const shiftedMask = notArg(second);
      if (orPairInner !== null && shiftedMask !== null) {
        const innerOrders: readonly (readonly [Expr, Expr])[] = [
          [orPairInner[0], orPairInner[1]],
          [orPairInner[1], orPairInner[0]],
        ];
        for (const [curPart, maskPart] of innerOrders) {
          const maskBit = exprMaskBit(maskPart);
          if (maskBit === null || !exprContainsSloadOf(curPart, slot)) {
            continue;
          }
          if (exprIsShiftedBoolish(shiftedMask, maskBit)) {
            return Object.freeze({ bit: maskBit });
          }
        }
        continue;
      }
      const shiftMask = notArg(second);
      if (shiftMask !== null && exprContainsSloadOf(first, slot)) {
        const bit = exprShiftBit(shiftMask) ?? exprMaskBit(shiftMask);
        if (bit !== null) {
          return Object.freeze({ bit });
        }
      }
    }
  }
  return null;
}

export function packedBoolWriteVia(
  slot: number,
  store: ExprStoreRecord | undefined,
  legacy: { readonly shift: number | null } | null,
): "expr" | "window" | null {
  if (store !== undefined && packedBoolWriteExpr(slot, store) !== null) {
    return "expr";
  }
  if (legacy !== null) {
    return "window";
  }
  return null;
}

type GateHit = { readonly shift: number };

function gateDivShift(side: Expr): { readonly shift: number; readonly inner: Expr } | null {
  if (side.kind !== "op") {
    return null;
  }
  if (side.name === "DIV" && side.args.length === 2) {
    const left = side.args[0] ?? EXPR_UNKNOWN;
    const right = side.args[1] ?? EXPR_UNKNOWN;
    const leftBit = exprShiftBit(left);
    const rightBit = exprShiftBit(right);
    if (rightBit !== null) {
      return { shift: rightBit, inner: left };
    }
    if (leftBit !== null) {
      return { shift: leftBit, inner: right };
    }
    return null;
  }
  if (side.name === "SHR" && side.args.length === 2) {
    const left = side.args[0] ?? EXPR_UNKNOWN;
    const right = side.args[1] ?? EXPR_UNKNOWN;
    const leftConst = exprConstValue(left);
    const rightConst = exprConstValue(right);
    if (rightConst !== null && rightConst >= 0n && rightConst < 256n) {
      return { shift: Number(rightConst), inner: left };
    }
    if (leftConst !== null && leftConst >= 0n && leftConst < 256n) {
      return { shift: Number(leftConst), inner: right };
    }
  }
  return null;
}

function gateMaskedShift(expr: Expr): GateHit | null {
  if (expr.kind === "op" && expr.name === "AND" && expr.args.length === 2) {
    const left = expr.args[0] ?? EXPR_UNKNOWN;
    const right = expr.args[1] ?? EXPR_UNKNOWN;
    const orders: readonly (readonly [Expr, Expr])[] = [
      [left, right],
      [right, left],
    ];
    for (const [maybeMask, maybeDiv] of orders) {
      if (exprConstValue(maybeMask) !== 0xffn) {
        continue;
      }
      const div = gateDivShift(maybeDiv);
      if (div !== null) {
        return { shift: div.shift };
      }
    }
  }
  return null;
}

function findGateShift(expr: Expr): GateHit | null {
  const direct = gateMaskedShift(expr);
  if (direct !== null) {
    return direct;
  }
  if (expr.kind === "sload") {
    return findGateShift(expr.slot);
  }
  if (expr.kind === "calldata") {
    return findGateShift(expr.offset);
  }
  if (expr.kind === "keccak") {
    for (const word of expr.words) {
      const hit = findGateShift(word);
      if (hit !== null) {
        return hit;
      }
    }
    return null;
  }
  if (expr.kind === "op") {
    for (const arg of expr.args) {
      const hit = findGateShift(arg);
      if (hit !== null) {
        return hit;
      }
    }
  }
  return null;
}

function gateInnerHasConstSload(inner: Expr, slot: number): boolean {
  return exprContainsSloadOf(inner, slot);
}

function gateInnerMappingBase(inner: Expr): number | null {
  let found: number | null | undefined;
  const visit = (expr: Expr): void => {
    if (expr.kind === "sload") {
      const base = exprMappingBase(expr.slot);
      if (base !== undefined && base !== null && found === undefined) {
        found = base;
      }
      visit(expr.slot);
      return;
    }
    if (expr.kind === "calldata") {
      visit(expr.offset);
      return;
    }
    if (expr.kind === "keccak") {
      for (const word of expr.words) {
        visit(word);
      }
      return;
    }
    if (expr.kind === "op") {
      for (const arg of expr.args) {
        visit(arg);
      }
    }
  };
  visit(inner);
  return found ?? null;
}

// Packed gate read through expressions: AND(DIV/SHR(sload, shift),
// 0xff) feeding EQ/ISZERO into the JUMPI condition.
export function packedGateExpr(cond: Expr, slot: number): { readonly shift: number } | null {
  const visit = (expr: Expr): { readonly shift: number } | null => {
    const masked = gateMaskedShift(expr);
    if (masked !== null) {
      return masked;
    }
    if (expr.kind === "sload") {
      return visit(expr.slot);
    }
    if (expr.kind === "calldata") {
      return visit(expr.offset);
    }
    if (expr.kind === "keccak") {
      for (const word of expr.words) {
        const hit = visit(word);
        if (hit !== null) {
          return hit;
        }
      }
      return null;
    }
    if (expr.kind === "op") {
      for (const arg of expr.args) {
        const hit = visit(arg);
        if (hit !== null) {
          if (arg.kind === "op" || expr.name === "EQ" || expr.name === "ISZERO") {
            return hit;
          }
          return hit;
        }
      }
    }
    return null;
  };
  const hit = visit(cond);
  if (hit === null) {
    return null;
  }
  return gateInnerHasConstSload(cond, slot) ? hit : null;
}

export function packedGateReadExpr(
  jumpis: ReadonlyMap<number, Expr>,
  isMember: (pc: number) => boolean,
  slot: number,
): { readonly jumpiPc: number; readonly shift: number } | null {
  for (const [pc, cond] of jumpis) {
    if (!isMember(pc) || cond.kind === "unknown") {
      continue;
    }
    const hit = packedGateExpr(cond, slot);
    if (hit !== null) {
      return { jumpiPc: pc, shift: hit.shift };
    }
  }
  return null;
}

export function packedMappingGateExpr(
  jumpis: ReadonlyMap<number, Expr>,
  isMember: (pc: number) => boolean,
): { readonly jumpiPc: number; readonly shift: number; readonly base: number } | null {
  for (const [pc, cond] of jumpis) {
    if (!isMember(pc) || cond.kind === "unknown") {
      continue;
    }
    const hit = findGateShift(cond);
    if (hit === null) {
      continue;
    }
    const base = gateInnerMappingBase(cond);
    if (base === null) {
      continue;
    }
    return { jumpiPc: pc, shift: hit.shift, base };
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
      // The v2 stack interpreter resolves slots through DUP/SWAP
      // chains and proves mapping bases; the scored v1 path below never
      // sees it.
      const interpreted = interpretRegionSlots(bytecode, entry.selector);
      const slotOf: SlotLookup = (pc) => interpreted.get(pc);
      regions.push(
        regionOf(entry.selector, start, code, (pc) => holdersByPc.get(pc)?.includes(wanted) ?? false, true, slotOf),
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
