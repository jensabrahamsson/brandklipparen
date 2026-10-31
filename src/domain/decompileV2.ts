// Decompiler v2: readable pseudo-Solidity on the v2 symbolic Expr
// engine. Walks each dispatcher entry over the CFG, simulates blocks
// with Expr values (constants folded), and prints statements:
// require guards for jumps to revert, bounded if/else for other
// branches, storage writes, external calls, emits and returns.
// Storage names come from public getters found in the same bytecode.
// Total, bounded and deterministic: hostile input yields partial
// output, never an exception.
import type { Bytecode as BytecodeType } from "./types.ts";
import { buildCfg, lift } from "./evmLift.ts";
import type { CfgBlock, ControlFlowGraph } from "./evmLift.ts";
import { dispatcherTopology, findFunctionEntries } from "./evmFlow.ts";
import type { FunctionEntry } from "./evmFlow.ts";
import { resolveFunctionNames } from "./evmNames.ts";
import type { Expr } from "./ownerControl.ts";
import { exprConstValue, interpretRegionExprs } from "./ownerControl.ts";
import type { Selector as SelectorType } from "./types.ts";
import { decompileContract } from "./evmSsa.ts";
import type { DecompiledContract, StructuredFunction, SsaStatement } from "./evmSsa.ts";

const MASK256 = (1n << 256n) - 1n;
const MASK160 = (1n << 160n) - 1n;
const UNKNOWN: Expr = Object.freeze({ kind: "unknown" }) as Expr;
const CALLER: Expr = Object.freeze({ kind: "caller" }) as Expr;
const CALLVALUE: Expr = Object.freeze({ kind: "callvalue" }) as Expr;
const MAX_LINES = 90;
const MAX_BLOCK_VISITS = 64;
const MAX_IF_DEPTH = 4;
const REQUIRE = "require";

function cst(value: bigint): Expr {
  return Object.freeze({ kind: "const", value: value & MASK256 }) as Expr;
}
function pushExpr(immediate: readonly number[]): Expr {
  let v = 0n;
  for (const b of immediate) v = (v * 256n + BigInt(b ?? 0)) & MASK256;
  return cst(v);
}
function eqExpr(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "const" && b.kind === "const") return a.value === b.value;
  if (a.kind === "op" && b.kind === "op")
    return a.name === b.name && a.args.length === b.args.length && a.args.every((x, i) => eqExpr(x, b.args[i] ?? UNKNOWN));
  if (a.kind === "calldata" && b.kind === "calldata") return eqExpr(a.offset, b.offset);
  if (a.kind === "sload" && b.kind === "sload") return eqExpr(a.slot, b.slot);
  if (a.kind === "keccak" && b.kind === "keccak")
    return a.words.length === b.words.length && a.words.every((x, i) => eqExpr(x, b.words[i] ?? UNKNOWN));
  return a.kind !== "unknown";
}
function fold(name: string, a: bigint, b: bigint): bigint | null {
  switch (name) {
    case "ADD": return (a + b) & MASK256;
    case "SUB": return (a - b) & MASK256;
    case "MUL": return (a * b) & MASK256;
    case "DIV": return b === 0n ? 0n : a / b;
    case "MOD": return b === 0n ? 0n : a % b;
    case "AND": return a & b;
    case "OR": return a | b;
    case "XOR": return a ^ b;
    case "EQ": return a === b ? 1n : 0n;
    case "LT": return a < b ? 1n : 0n;
    case "GT": return a > b ? 1n : 0n;
    case "SHL": return b >= 256n ? 0n : (a << b) & MASK256;
    case "SHR": return b >= 256n ? 0n : a >> b;
    case "EXP": {
      let r = 1n, p = a & MASK256, e = b;
      while (e > 0n) { if ((e & 1n) === 1n) r = (r * p) & MASK256; p = (p * p) & MASK256; e >>= 1n; }
      return r;
    }
    default: return null;
  }
}
function op(name: string, args: readonly Expr[]): Expr {
  const [x, y] = [args[0] ?? UNKNOWN, args[1] ?? UNKNOWN];
  if (name === "AND" && args.length === 2) {
    if (eqExpr(x, y)) return x;
    // Flatten nested ANDs and drop duplicate leaves (double masks).
    const leaves: Expr[] = [];
    const collect = (e: Expr): void => {
      if (e.kind === "op" && e.name === "AND") { collect(e.args[0] ?? UNKNOWN); collect(e.args[1] ?? UNKNOWN); }
      else leaves.push(e);
    };
    collect(x); collect(y);
    const uniq = leaves.filter((l, i) => !leaves.slice(0, i).some((k) => eqExpr(k, l)));
    if (uniq.length < leaves.length) {
      if (uniq.length === 1) return uniq[0] ?? UNKNOWN;
      let r = uniq[0] ?? UNKNOWN;
      for (const l of uniq.slice(1)) r = Object.freeze({ kind: "op", name: "AND", args: Object.freeze([r, l]) }) as Expr;
      return r;
    }
  }
  if (name === "DIV" && args.length === 2 && (exprConstValue(y) === 1n)) return x;
  if (name === "SUB" && args.length === 2) {
    const l = exprConstValue(x), r = exprConstValue(y);
    if ((l === 1n && r === (1n << 160n)) || (l === (1n << 160n) && r === 1n)) return cst(MASK160);
  }
  if (name === "AND" && args.length === 2) {
    if (exprConstValue(x) === MASK256) return y;
    if (exprConstValue(y) === MASK256) return x;
    if (exprConstValue(x) === 0n || exprConstValue(y) === 0n) return cst(0n);
  }
  if (name === "OR" && args.length === 2) {
    if (exprConstValue(x) === 0n) return y;
    if (exprConstValue(y) === 0n) return x;
  }
  if (name === "EQ" && args.length === 2) {
    if (exprConstValue(y) === 0n) return op("ISZERO", [x]);
    if (exprConstValue(x) === 0n) return op("ISZERO", [y]);
  }
  if (name === "ISZERO" && x.kind === "op" && x.name === "ISZERO") return x.args[0] ?? UNKNOWN;
  const cx = exprConstValue(x), cy = exprConstValue(y);
  if (args.length === 2 && cx !== null && cy !== null) { const f = fold(name, cx, cy); if (f !== null) return cst(f); }
  if (name === "ISZERO" && cx !== null) return cst(cx === 0n ? 1n : 0n);
  if (name === "NOT" && cx !== null) return cst(~cx & MASK256);
  return Object.freeze({ kind: "op", name, args: Object.freeze(args.slice()) }) as Expr;
}
function sloadExpr(slot: Expr): Expr { return Object.freeze({ kind: "sload", slot }) as Expr; }
function calldataExpr(offset: Expr): Expr { return Object.freeze({ kind: "calldata", offset }) as Expr; }
function keccakExpr(words: readonly Expr[]): Expr { return Object.freeze({ kind: "keccak", words: Object.freeze(words.slice()) }) as Expr; }

// ---- block simulation ----
type Effect =
  | { kind: "store"; slot: Expr; value: Expr; pc: number }
  | { kind: "log"; topics: readonly Expr[]; pc: number }
  | { kind: "call"; flavor: string; to: Expr; value: Expr; pc: number }
  | { kind: "selfdestruct"; pc: number };
type Term =
  | { kind: "halt"; action: "stop" | "return" | "revert"; value: Expr | null }
  | { kind: "jump"; dest: Expr }
  | { kind: "jumpi"; cond: Expr; dest: Expr }
  | { kind: "fall" }
  | { kind: "end" };
type Sim = { stack: Expr[]; mem: Map<bigint, Expr>; lastStore: Expr | null };
type BlockResult = { exit: Sim; effects: Effect[]; term: Term };

const BINOPS: Readonly<Record<number, string>> = {
  0x01: "ADD", 0x02: "MUL", 0x03: "SUB", 0x04: "DIV", 0x06: "MOD", 0x0a: "EXP",
  0x10: "LT", 0x11: "GT", 0x14: "EQ", 0x16: "AND", 0x17: "OR", 0x18: "XOR", 0x1b: "SHL", 0x1c: "SHR",
};
const ENV0: Readonly<Record<number, string>> = {
  0x30: "address(this)", 0x3a: "gasprice", 0x41: "block.coinbase",
  0x42: "block.timestamp", 0x43: "block.number", 0x44: "block.prevrandao", 0x45: "block.gaslimit",
  0x46: "block.chainid", 0x48: "block.basefee", 0x5a: "gasleft()",
};
function genericEffect(opcode: number): { pops: number; pushes: number } | null {
  if ([0x00, 0xf3, 0xfd, 0xfe, 0xff].includes(opcode)) return null;
  if (opcode >= 0xa0 && opcode <= 0xa4) return { pops: 2 + (opcode - 0xa0), pushes: 0 };
  if (opcode === 0xf1 || opcode === 0xf2) return { pops: 7, pushes: 1 };
  if (opcode === 0xf4 || opcode === 0xfa) return { pops: 6, pushes: 1 };
  if (opcode === 0xf0) return { pops: 3, pushes: 1 };
  if (opcode === 0xf5) return { pops: 4, pushes: 1 };
  if ([0x37, 0x39, 0x3e, 0x5e].includes(opcode)) return { pops: 3, pushes: 0 };
  if (opcode === 0x3c) return { pops: 4, pushes: 0 };
  if ([0x51, 0x35, 0x31, 0x3b, 0x3f, 0x40, 0x5c].includes(opcode)) return { pops: 1, pushes: 1 };
  if ([0x52, 0x53, 0x55, 0x5d].includes(opcode)) return { pops: 2, pushes: 0 };
  if ([0x08, 0x09].includes(opcode)) return { pops: 3, pushes: 1 };
  if (opcode === 0x15 || opcode === 0x19 || opcode === 0x1a) return { pops: 1, pushes: 1 };
  return { pops: 0, pushes: 0 };
}

function simulateBlock(block: CfgBlock, entry: Sim): BlockResult {
  const sim: Sim = { stack: [...entry.stack], mem: new Map(entry.mem), lastStore: entry.lastStore };
  const effects: Effect[] = [];
  const pop = (): Expr => sim.stack.pop() ?? UNKNOWN;
  const push = (e: Expr): void => { if (sim.stack.length >= 64) sim.stack.shift(); sim.stack.push(e); };
  for (const ins of block.instructions) {
    const oc = ins.opcode;
    if (oc === 0x5b) continue;
    if (oc === 0x5f) { push(cst(0n)); continue; }
    if (oc >= 0x60 && oc <= 0x7f) { push(pushExpr(ins.immediate)); continue; }
    if (oc >= 0x80 && oc <= 0x8f) { push(sim.stack[sim.stack.length - (oc - 0x7f)] ?? UNKNOWN); continue; }
    if (oc >= 0x90 && oc <= 0x9f) {
      const t = sim.stack.length - 1, o = t - (oc - 0x8f);
      if (t >= 0 && o >= 0) { const s = sim.stack[t] ?? UNKNOWN; sim.stack[t] = sim.stack[o] ?? UNKNOWN; sim.stack[o] = s; }
      continue;
    }
    if (oc === 0x50) { pop(); continue; }
    const bin = BINOPS[oc];
    if (bin !== undefined) {
      const top = pop(); const second = pop();
      // EVM order: the top of stack is the first operand for SUB, DIV,
      // LT, GT and EXP; for SHL and SHR the top is the shift amount.
      const args = bin === "SHL" || bin === "SHR" ? [second, top] : [top, second];
      push(op(bin, args)); continue;
    }
    if (oc === 0x15) { push(op("ISZERO", [pop()])); continue; }
    if (oc === 0x19) { push(op("NOT", [pop()])); continue; }
    if (oc === 0x33) { push(CALLER); continue; }
    if (oc === 0x34) { push(CALLVALUE); continue; }
    if (oc === 0x35) { push(calldataExpr(pop())); continue; }
    if (ENV0[oc] !== undefined) { push(Object.freeze({ kind: "op", name: ENV0[oc] ?? "", args: Object.freeze([]) }) as Expr); continue; }
    if (oc === 0x51) { const a = pop(); const k = exprConstValue(a); push(k !== null ? (sim.mem.get(k) ?? UNKNOWN) : UNKNOWN); continue; }
    if (oc === 0x52 || oc === 0x53) { const off = pop(); const val = pop(); const k = exprConstValue(off); if (oc === 0x52) { sim.lastStore = val; if (k !== null) sim.mem.set(k, val); } continue; }
    if (oc === 0x54) { const slot = pop(); push(sloadExpr(slot)); continue; }
    if (oc === 0x55) { const slot = pop(); const val = pop(); effects.push({ kind: "store", slot, value: val, pc: ins.pc }); continue; }
    if (oc === 0x20) {
      const off = pop(); const sz = pop();
      if (exprConstValue(off) === 0n && exprConstValue(sz) === 0x40n) push(keccakExpr([sim.mem.get(0n) ?? UNKNOWN, sim.mem.get(0x20n) ?? UNKNOWN]));
      else push(Object.freeze({ kind: "op", name: "keccak256", args: Object.freeze([]) }) as Expr);
      continue;
    }
    if (oc >= 0xa0 && oc <= 0xa4) {
      const n = oc - 0xa0; pop(); pop();
      const topics: Expr[] = []; for (let i = 0; i < n; i += 1) topics.unshift(pop());
      effects.push({ kind: "log", topics: Object.freeze(topics), pc: ins.pc }); continue;
    }
    if (oc === 0xf1 || oc === 0xf2 || oc === 0xf4 || oc === 0xfa) {
      // Stack top-down: gas, to, [value], inOff, inSize, outOff, outSize.
      pop(); const to = pop(); const val = oc === 0xf1 || oc === 0xf2 ? pop() : cst(0n);
      pop(); pop(); pop(); pop();
      effects.push({ kind: "call", flavor: oc === 0xf1 ? "call" : oc === 0xf4 ? "delegatecall" : oc === 0xfa ? "staticcall" : "callcode", to, value: val, pc: ins.pc });
      push(UNKNOWN); continue;
    }
    if (oc === 0x00) return { exit: sim, effects, term: { kind: "halt", action: "stop", value: null } };
    if (oc === 0xf3) { const off = pop(); const sz = pop(); const k = exprConstValue(off); const v = k !== null && exprConstValue(sz) === 0x20n ? (sim.mem.get(k) ?? null) : null; return { exit: sim, effects, term: { kind: "halt", action: "return", value: v } }; }
    if (oc === 0xfd || oc === 0xfe) return { exit: sim, effects, term: { kind: "halt", action: "revert", value: null } };
    if (oc === 0xff) { pop(); effects.push({ kind: "selfdestruct", pc: ins.pc }); return { exit: sim, effects, term: { kind: "halt", action: "stop", value: null } }; }
    if (oc === 0x56) { const dest = pop(); return { exit: sim, effects, term: { kind: "jump", dest } }; }
    if (oc === 0x57) { const dest = pop(); const cond = pop(); return { exit: sim, effects, term: { kind: "jumpi", cond, dest } }; }
    const g = genericEffect(oc);
    if (g === null) return { exit: sim, effects, term: { kind: "halt", action: "stop", value: null } };
    for (let i = 0; i < g.pops; i += 1) pop();
    for (let i = 0; i < g.pushes; i += 1) push(UNKNOWN);
  }
  if (block.terminal === "fall") return { exit: sim, effects, term: { kind: "fall" } };
  return { exit: sim, effects, term: { kind: "end" } };
}

// ---- naming context ----
type Ctx = {
  argTypes: readonly string[];
  fieldNames: ReadonlyMap<string, string>; // "slot:byte" -> name
  fieldIsBool: ReadonlySet<string>;
  slotNames: ReadonlyMap<number, string>;
  mappingNames: ReadonlyMap<number, string>;
};
function fieldKey(slot: number, byte: number): string { return `${slot}:${byte}`; }

// Extract (slot, byteOffset) from a possibly shifted/masked sload chain.
function extractField(e: Expr): { slot: number; byte: number } | null {
  let shift = 0n; let cur = e;
  for (let depth = 0; depth < 8; depth += 1) {
    if (cur.kind === "sload") { const s = exprConstValue(cur.slot); return s !== null && s <= 0xffffffffn ? { slot: Number(s), byte: Number(shift / 8n) } : null; }
    if (cur.kind !== "op") return null;
    const [a, b] = [cur.args[0] ?? UNKNOWN, cur.args[1] ?? UNKNOWN];
    if (cur.name === "DIV") {
      const d = exprConstValue(b); const d2 = exprConstValue(a);
      if (d !== null && d > 1n) { let lg = 0n; let v = d; while (v > 1n && (v & 1n) === 0n) { v >>= 1n; lg += 1n; } if (v === 1n) { shift += lg; cur = a; continue; } }
      if (d2 === 1n) { cur = b; continue; }
      return null;
    }
    if (cur.name === "SHR") { const s = exprConstValue(b); if (s !== null) { shift += s; cur = a; continue; } return null; }
    if (cur.name === "AND") {
      const ma = exprConstValue(a), mb = exprConstValue(b);
      if (mb !== null && ma === null) {
        if (mb === MASK160) { cur = a; continue; }
        // Single-byte mask at a shift: 0xff << 8k, or plain 0xff.
        let m = mb; let extra = 0n;
        while (m > 0xffn && (m & 0xffn) === 0n) { m >>= 8n; extra += 8n; }
        if (m === 0xffn || m === 1n) { shift += extra; cur = a; continue; }
        cur = a; continue;
      }
      if (ma !== null && mb === null) { cur = b; continue; }
      return null;
    }
    return null;
  }
  return null;
}
function mappingBaseOf(slot: Expr): number | null {
  if (slot.kind === "keccak") {
    const inner = slot.words[1] ?? UNKNOWN;
    const direct = exprConstValue(inner);
    if (direct !== null && direct <= 0xffffffffn) return Number(direct);
    return mappingBaseOf(inner);
  }
  if (slot.kind === "op" && slot.name === "ADD") {
    return mappingBaseOf(slot.args[0] ?? UNKNOWN) ?? mappingBaseOf(slot.args[1] ?? UNKNOWN);
  }
  if (slot.kind === "sload") return null;
  return null;
}
function containsSload(e: Expr): boolean {
  if (e.kind === "sload") return true;
  if (e.kind === "calldata") return containsSload(e.offset);
  if (e.kind === "keccak") return e.words.some(containsSload);
  if (e.kind === "op") return e.args.some(containsSload);
  return false;
}
function findReturnSload(e: Expr): Extract<Expr, { kind: "sload" }> | null {
  if (e.kind === "sload") return e;
  if (e.kind === "op") { for (const a of e.args) { const f = findReturnSload(a); if (f !== null) return f; } }
  if (e.kind === "keccak") { for (const w of e.words) { const f = findReturnSload(w); if (f !== null) return f; } }
  return null;
}

// ---- expression printer ----
function constStr(v: bigint): string {
  if (v === 0n) return "0";
  if (v === 1n) return "1";
  if (v < 0n) return `0x${(v & MASK256).toString(16)}`;
  if (v <= 255n) return `0x${v.toString(16).padStart(2, "0")}`;
  return `0x${v.toString(16)}`;
}
function isAddressLike(e: Expr, ctx: Ctx): boolean {
  if (e.kind === "caller") return true;
  if (e.kind === "calldata") { const idx = argIndex(e); return idx !== null && (ctx.argTypes.length === 0 || (ctx.argTypes[idx] ?? "") === "address"); }
  const f = extractField(e);
  if (f !== null && ctx.fieldNames.get(fieldKey(f.slot, f.byte)) !== undefined) {
    const n = ctx.fieldNames.get(fieldKey(f.slot, f.byte)) ?? "";
    return n === "owner" || !ctx.fieldIsBool.has(fieldKey(f.slot, f.byte));
  }
  return false;
}
function argIndex(e: Expr): number | null {
  if (e.kind !== "calldata") return null;
  const off = exprConstValue(e.offset);
  if (off === null) return null;
  if (off >= 4n && (off - 4n) % 32n === 0n) return Number((off - 4n) / 32n);
  // Newer compilers load argument words at 32-byte offsets relative to
  // the argument area (0, 0x20, 0x40, ...).
  if (off % 32n === 0n && off <= 0x200n) return Number(off / 32n);
  return null;
}
function mappingAccess(slot: Expr, ctx: Ctx): string | null {
  if (slot.kind !== "keccak") return null;
  const key = slot.words[0] ?? UNKNOWN;
  const inner = slot.words[1] ?? UNKNOWN;
  const base = exprConstValue(inner);
  if (base !== null && base <= 0xffffffffn) {
    const name = ctx.mappingNames.get(Number(base)) ?? `mapping${Number(base)}`;
    return `${name}[${printValue(key, ctx, 0)}]`;
  }
  if (inner.kind === "keccak") {
    const nested = mappingAccess(inner, ctx);
    if (nested !== null) return `${nested}[${printValue(key, ctx, 0)}]`;
  }
  return null;
}
function slotTarget(slot: Expr, ctx: Ctx): string {
  const m = mappingAccess(slot, ctx);
  if (m !== null) return m;
  const c = exprConstValue(slot);
  if (c !== null && c <= 0xffffffffn) {
    const n = Number(c);
    const name = ctx.slotNames.get(n) ?? ctx.fieldNames.get(fieldKey(n, 0));
    return name ?? `slot${n}`;
  }
  return `storage[${printValue(slot, ctx, 0)}]`;
}
const PREC: Readonly<Record<string, number>> = { OR: 1, XOR: 2, AND: 3, EQ: 6, LT: 6, GT: 6, ADD: 7, SUB: 7, MUL: 8, DIV: 8, MOD: 8 };
const SYM: Readonly<Record<string, string>> = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", MOD: "%", AND: "&", OR: "|", XOR: "^", EQ: "==", LT: "<", GT: ">", SHL: "<<", SHR: ">>" };
function printValue(e: Expr, ctx: Ctx, parentPrec: number): string {
  if (e.kind === "const") return constStr(e.value);
  if (e.kind === "caller") return "msg.sender";
  if (e.kind === "callvalue") return "msg.value";
  if (e.kind === "unknown") return "unknown";
  if (e.kind === "calldata") {
    const idx = argIndex(e);
    if (idx !== null) return `arg${idx}`;
    const off = exprConstValue(e.offset);
    return off !== null ? `calldata[${constStr(off)}]` : `calldata[${printValue(e.offset, ctx, 0)}]`;
  }
  if (e.kind === "keccak") return `keccak256(${e.words.map((w) => printValue(w, ctx, 0)).join(", ")})`;
  if (e.kind === "sload") {
    const m = mappingAccess(e.slot, ctx);
    if (m !== null) return m;
    const f = extractField(e);
    if (f !== null) {
      const name = ctx.fieldNames.get(fieldKey(f.slot, f.byte)) ?? ctx.slotNames.get(f.slot);
      if (name !== undefined) return name;
      return `slot${f.slot}_b${f.byte}`;
    }
    return slotTarget(e.slot, ctx);
  }
  // op
  const name = e.name;
  const [a, b] = [e.args[0] ?? UNKNOWN, e.args[1] ?? UNKNOWN];
  if (name === "ISZERO") return printNot(a, ctx);
  if (name === "NOT") return `~${printValue(a, ctx, 9)}`;
  if (name === "AND" && e.args.length === 2) {
    const ma = exprConstValue(a), mb = exprConstValue(b);
    const mask = ma !== null && mb === null ? ma : mb !== null && ma === null ? mb : null;
    const inner = mask === ma ? b : a;
    if (mask !== null) {
      const f = extractField(e);
      if (f !== null) {
        const fname = ctx.fieldNames.get(fieldKey(f.slot, f.byte));
        if (fname !== undefined) return fname;
        if (mask === 0xffn) return `uint8(${printValue(inner, ctx, 0)})`;
        return `slot${f.slot}_b${f.byte}`;
      }
      if (mask === MASK160) return isAddressLike(inner, ctx) ? printValue(inner, ctx, parentPrec) : `address(${printValue(inner, ctx, 0)})`;
      if (mask === 0xffn) return `uint8(${printValue(inner, ctx, 0)})`;
    }
  }
  const f2 = extractField(e);
  if (f2 !== null && (name === "DIV" || name === "SHR" || name === "AND")) {
    const fname = ctx.fieldNames.get(fieldKey(f2.slot, f2.byte));
    if (fname !== undefined) return fname;
    return `slot${f2.slot}_b${f2.byte}`;
  }
  if (ENV0_NAME(name)) return name;
  const prec = PREC[name] ?? 5;
  const sym = SYM[name];
  if (sym !== undefined && e.args.length === 2) {
    // Readable equality order: msg.sender on the left.
    const [l, r] = name === "EQ" && b.kind === "caller" && a.kind !== "caller" ? [b, a] : [a, b];
    const s = `${printValue(l, ctx, prec)} ${sym} ${printValue(r, ctx, prec + (name === "SUB" || name === "DIV" ? 1 : 0))}`;
    return prec < parentPrec ? `(${s})` : s;
  }
  if (name === "keccak256") return "keccak256(...)";
  if (e.args.length === 0) return name;
  return `${name.toLowerCase()}(${e.args.map((x) => printValue(x, ctx, 0)).join(", ")})`;
}
function ENV0_NAME(name: string): boolean { return Object.values(ENV0).includes(name); }
function isBoolLike(e: Expr, ctx: Ctx): boolean {
  if (e.kind === "const") return true;
  if (e.kind === "op" && ["ISZERO", "EQ", "LT", "GT"].includes(e.name)) return true;
  const f = extractField(e);
  return f !== null && ctx.fieldIsBool.has(fieldKey(f.slot, f.byte));
}
function printNot(e: Expr, ctx: Ctx): string {
  if (e.kind === "op" && e.name === "ISZERO") return printBool(e.args[0] ?? UNKNOWN, ctx);
  if (e.kind === "op" && e.name === "EQ") return `${printValue(e.args[0] ?? UNKNOWN, ctx, 6)} != ${printValue(e.args[1] ?? UNKNOWN, ctx, 7)}`;
  if (e.kind === "op" && e.name === "LT") return `${printValue(e.args[0] ?? UNKNOWN, ctx, 6)} >= ${printValue(e.args[1] ?? UNKNOWN, ctx, 7)}`;
  if (e.kind === "op" && e.name === "GT") return `${printValue(e.args[0] ?? UNKNOWN, ctx, 6)} <= ${printValue(e.args[1] ?? UNKNOWN, ctx, 7)}`;
  if (isBoolLike(e, ctx)) return `!${printValue(e, ctx, 0)}`;
  return `${printValue(e, ctx, 0)} == 0`;
}
function printBool(e: Expr, ctx: Ctx): string {
  if (e.kind === "const") return e.value === 0n ? "false" : "true";
  if (e.kind === "op" && e.name === "ISZERO") {
    const inner = e.args[0] ?? UNKNOWN;
    return isBoolLike(inner, ctx) ? printNot(inner, ctx) : `${printValue(inner, ctx, 0)} == 0`;
  }
  if (e.kind === "op" && e.name === "EQ" && eqExpr(e.args[0] ?? UNKNOWN, e.args[1] ?? UNKNOWN)) return "true";
  if (isBoolLike(e, ctx)) return printValue(e, ctx, 0);
  return `${printValue(e, ctx, 0)} != 0`;
}
function negatedBool(e: Expr, ctx: Ctx): string {
  if (e.kind === "op" && e.name === "ISZERO") return printBool(e.args[0] ?? UNKNOWN, ctx);
  return printNot(e, ctx);
}

// ---- store / effect printing ----
function packedWrite(slot: Expr, value: Expr, ctx: Ctx): string | null {
  const sc = exprConstValue(slot);
  if (sc === null) return null;
  const slotNum = Number(sc);
  // Collect a constant bit pattern OR-ed in, and whether base reuses sload.
  const findOrConst = (e: Expr): bigint | null => {
    if (e.kind !== "op") return null;
    if (e.name === "OR") {
      const ca = exprConstValue(e.args[0] ?? UNKNOWN), cb = exprConstValue(e.args[1] ?? UNKNOWN);
      if (cb !== null && cb !== 0n) return cb;
      if (ca !== null && ca !== 0n) return ca;
      return findOrConst(e.args[0] ?? UNKNOWN) ?? findOrConst(e.args[1] ?? UNKNOWN);
    }
    if (e.name === "AND") return findOrConst(e.args[0] ?? UNKNOWN) ?? findOrConst(e.args[1] ?? UNKNOWN);
    return null;
  };
  const orConst = findOrConst(value);
  if (orConst !== null && containsSloadSlot(value, slotNum)) {
    // Single bit at byte k set to 1.
    let v = orConst; let byte = 0;
    while (v > 1n && (v & 1n) === 0n) { v >>= 1n; }
    if (v === 1n) {
      let bits = 0n; let t = orConst; while (t > 1n) { t >>= 1n; bits += 1n; }
      byte = Number(bits / 8n);
      const name = ctx.fieldNames.get(fieldKey(slotNum, byte));
      if (name !== undefined) return `${name} = true;`;
      return `slot${slotNum}_b${byte} = true;`;
    }
  }
  if (value.kind === "op" && value.name === "AND" && containsSloadSlot(value, slotNum)) {
    // Clear: AND(sload, NOT(1<<8k)) or AND(sload, mask-with-byte-cleared).
    const ca = exprConstValue(value.args[0] ?? UNKNOWN), cb = exprConstValue(value.args[1] ?? UNKNOWN);
    const mask = ca !== null && cb === null ? ca : cb;
    if (mask !== null) {
      for (let byte = 0; byte < 32; byte += 1) {
        const bit = 1n << BigInt(byte * 8);
        if ((mask & bit) === 0n && (mask | bit) === MASK256) {
          const name = ctx.fieldNames.get(fieldKey(slotNum, byte));
          return name !== undefined ? `${name} = false;` : `slot${slotNum}_b${byte} = false;`;
        }
        const byteMask = 0xffn << BigInt(byte * 8);
        if ((mask & byteMask) === 0n && (mask | byteMask) === MASK256) {
          const name = ctx.fieldNames.get(fieldKey(slotNum, byte));
          return name !== undefined ? `${name} = false;` : `slot${slotNum}_b${byte} = false;`;
        }
      }
    }
    // NOT argument form folds to a const mask above; also handle NOT op child.
    const notArg = [value.args[0], value.args[1]].find((x) => x?.kind === "op" && x.name === "NOT");
    if (notArg?.kind === "op") {
      const inner = exprConstValue(notArg.args[0] ?? UNKNOWN);
      if (inner !== null) {
        let v = inner; let bits = 0n; while (v > 1n) { v >>= 1n; bits += 1n; }
        const byte = Number(bits / 8n);
        const name = ctx.fieldNames.get(fieldKey(slotNum, byte));
        return name !== undefined ? `${name} = false;` : `slot${slotNum}_b${byte} = false;`;
      }
    }
  }
  return null;
}
function containsSloadSlot(e: Expr, slotNum: number): boolean {
  if (e.kind === "sload") return exprConstValue(e.slot) === BigInt(slotNum);
  if (e.kind === "op") return e.args.some((a) => containsSloadSlot(a, slotNum));
  if (e.kind === "keccak") return e.words.some((w) => containsSloadSlot(w, slotNum));
  if (e.kind === "calldata") return containsSloadSlot(e.offset, slotNum);
  return false;
}
function containsSloadEqual(e: Expr, slot: Expr): boolean {
  if (e.kind === "sload") return eqExpr(e.slot, slot);
  if (e.kind === "op") return e.args.some((a) => containsSloadEqual(a, slot));
  if (e.kind === "keccak") return e.words.some((w) => containsSloadEqual(w, slot));
  if (e.kind === "calldata") return containsSloadEqual(e.offset, slot);
  return false;
}
function storeLine(slot: Expr, value: Expr, ctx: Ctx): string {
  const packed = packedWrite(slot, value, ctx);
  if (packed !== null) return packed;
  // Packed-field write through a mask: OR(AND(sload(slot), mask), x)
  // clears one byte of the slot and inserts x there.
  const sc = exprConstValue(slot);
  if (sc !== null && value.kind === "op" && value.name === "OR") {
    for (const [andArg, other] of [[value.args[0], value.args[1]], [value.args[1], value.args[0]]] as const) {
      if (andArg?.kind !== "op" || andArg.name !== "AND" || other === undefined) continue;
      const maskArg = andArg.args.find((a) => exprConstValue(a) !== null);
      const mask = maskArg !== undefined ? exprConstValue(maskArg) : null;
      if (mask === null || !containsSloadSlot(andArg, Number(sc))) continue;
      const cleared = (~mask) & MASK256;
      if (cleared === MASK160) {
        const name = ctx.fieldNames.get(fieldKey(Number(sc), 0)) ?? `slot${Number(sc)}_b0`;
        return `${name} = ${printValue(other, ctx, 0)};`;
      }
      for (let byte = 0; byte < 32; byte += 1) {
        if (cleared === (0xffn << BigInt(byte * 8)) || cleared === (1n << BigInt(byte * 8))) {
          const name = ctx.fieldNames.get(fieldKey(Number(sc), byte)) ?? `slot${Number(sc)}_b${byte}`;
          const rhs = other.kind === "op" && other.name === "ISZERO" ? printBool(other, ctx) : printValue(other, ctx, 0);
          return `${name} = ${rhs};`;
        }
      }
    }
  }
  if (mappingAccess(slot, ctx) !== null && value.kind === "op" && value.name === "OR") {
    const ca = exprConstValue(value.args[0] ?? UNKNOWN), cb = exprConstValue(value.args[1] ?? UNKNOWN);
    if (ca === 1n || cb === 1n) return `${slotTarget(slot, ctx)} = true;`;
    // OR(AND(same mapping load, mask), x) writes the bool x. Unknown
    // leaves count as wildcards: the region interpreter may leave the
    // decoded key unknown inside the read-back load.
    const matches = (a: Expr, b: Expr): boolean => {
      if (a.kind === "unknown" || b.kind === "unknown") return true;
      if (a.kind !== b.kind) return false;
      if (a.kind === "sload" && b.kind === "sload") return matches(a.slot, b.slot);
      if (a.kind === "op" && b.kind === "op") return a.name === b.name && a.args.every((x, i) => matches(x, b.args[i] ?? UNKNOWN));
      return eqExpr(a, b);
    };
    const containsMatch = (a: Expr): boolean => {
      if (a.kind === "sload") return matches(a.slot, slot);
      if (a.kind === "op") return a.args.some(containsMatch);
      if (a.kind === "keccak") return a.words.some(containsMatch);
      return false;
    };
    const other = (value.args[0] !== undefined && containsMatch(value.args[0])) ? value.args[1] : value.args[0];
    if (other !== undefined && !containsMatch(other)) return `${slotTarget(slot, ctx)} = ${printBool(other, ctx)};`;
  }
  if (mappingAccess(slot, ctx) !== null && containsSloadEqual(value, slot) && value.kind === "op") {
    if (value.name === "OR") {
      const ca = exprConstValue(value.args[0] ?? UNKNOWN), cb = exprConstValue(value.args[1] ?? UNKNOWN);
      if (ca === 1n || cb === 1n) return `${slotTarget(slot, ctx)} = true;`;
    }
    if (value.name === "AND") return `${slotTarget(slot, ctx)} = false;`;
  }
  return `${slotTarget(slot, ctx)} = ${printValue(value, ctx, 0)};`;
}

// Second-chance synthesis for bodies the block walk cannot reach
// (shared ABI-decoder helpers whose return jump stays unproven):
// statements come from the v2 region interpreter's proven per-PC
// guard conditions and storage writes, in PC order. Decoded argument
// values the interpreter leaves unknown are named arg0, arg1, ... in
// order of first use.
function containsUnknown(e: Expr): boolean {
  if (e.kind === "unknown") return true;
  if (e.kind === "calldata") return containsUnknown(e.offset);
  if (e.kind === "sload") return containsUnknown(e.slot);
  if (e.kind === "keccak") return e.words.some(containsUnknown);
  if (e.kind === "op") return e.args.some(containsUnknown);
  return false;
}
function substituteUnknowns(e: Expr, counter: { next: number }): Expr {
  if (e.kind === "unknown") { const idx = counter.next; counter.next += 1; return calldataExpr(cst(BigInt(4 + idx * 32))); }
  if (e.kind === "calldata") return calldataExpr(substituteUnknowns(e.offset, counter));
  if (e.kind === "sload") return sloadExpr(substituteUnknowns(e.slot, counter));
  if (e.kind === "keccak") return keccakExpr(e.words.map((w) => substituteUnknowns(w, counter)));
  if (e.kind === "op") return Object.freeze({ kind: "op", name: e.name, args: Object.freeze(e.args.map((a) => substituteUnknowns(a, counter))) }) as Expr;
  return e;
}
function isValidationCond(cond: Expr): boolean {
  // ABI argument validation: EQ(mask160(x), x) or EQ(!!x, x) proves the
  // decoded word already fits its type; high-level code has no such guard.
  if (cond.kind !== "op" || cond.name !== "EQ") return false;
  const strip = (e: Expr): Expr => {
    if (e.kind === "op" && e.name === "AND" && e.args.length === 2) {
      const [a, b] = [e.args[0] ?? UNKNOWN, e.args[1] ?? UNKNOWN];
      if (exprConstValue(a) === MASK160) return b;
      if (exprConstValue(b) === MASK160) return a;
    }
    if (e.kind === "op" && e.name === "ISZERO" && (e.args[0]?.kind === "op" && (e.args[0] as { name?: string }).name === "ISZERO")) {
      return (e.args[0] as { args: readonly Expr[] }).args[0] ?? UNKNOWN;
    }
    return e;
  };
  const [a, b] = [cond.args[0] ?? UNKNOWN, cond.args[1] ?? UNKNOWN];
  return eqExpr(strip(a), b) || eqExpr(a, strip(b)) || eqExpr(strip(a), strip(b));
}
function substituteStoreValue(e: Expr, counter: { next: number }): Expr {
  // A read-back load inside the stored value re-derives the same slot:
  // its unknown key leaves name the same first arguments, without
  // consuming new argument positions.
  if (e.kind === "sload") { const local = { next: 0 }; return sloadExpr(substituteUnknowns(e.slot, local)); }
  if (e.kind === "unknown") { const idx = counter.next; counter.next += 1; return calldataExpr(cst(BigInt(4 + idx * 32))); }
  if (e.kind === "calldata") return calldataExpr(substituteStoreValue(e.offset, counter));
  if (e.kind === "keccak") return keccakExpr(e.words.map((w) => substituteStoreValue(w, counter)));
  if (e.kind === "op") return Object.freeze({ kind: "op", name: e.name, args: Object.freeze(e.args.map((a) => substituteStoreValue(a, counter))) }) as Expr;
  return e;
}
function synthesizeFromRegion(bytecode: BytecodeType, selector: string, ctx: Ctx): string[] {
  const exprs = interpretRegionExprs(bytecode, selector as SelectorType);
  const lines: string[] = [];
  const jumpis = [...exprs.jumpis.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, cond] of jumpis) {
    if (containsUnknown(cond)) continue;
    if (isValidationCond(cond)) continue;
    const text = printBool(cond, ctx);
    if (text === "true" || text === "false" || text.includes("unknown")) continue;
    if (/^(.+) == \1$/.test(text)) continue;
    lines.push(`  ${REQUIRE}(${text});`);
  }
  const counter = { next: 0 };
  const stores = [...exprs.stores.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, record] of stores) {
    const slot = substituteUnknowns(record.slot, counter);
    const value = substituteStoreValue(record.value, counter);
    lines.push(`  ${storeLine(slot, value, ctx)}`);
  }
  return lines.slice(0, MAX_LINES);
}
function effectLine(eff: Effect, ctx: Ctx): string | null {
  if (eff.kind === "store") return storeLine(eff.slot, eff.value, ctx);
  if (eff.kind === "log") {
    const t0 = eff.topics[0];
    const tv = t0 !== undefined ? exprConstValue(t0) : null;
    if (tv !== null) return `emit 0x${tv.toString(16).padStart(64, "0")}();`;
    return "emit log();";
  }
  if (eff.kind === "call") {
    const to = printValue(eff.to, ctx, 0);
    const val = exprConstValue(eff.value);
    if (val === 0n) return `${to}.${eff.flavor}();`;
    return `${to}.${eff.flavor}(${printValue(eff.value, ctx, 0)});`;
  }
  return "selfdestruct();";
}

// ---- collection pass for naming ----
function findFieldIn(e: Expr): { slot: number; byte: number } | null {
  const direct = extractField(e);
  if (direct !== null && containsSload(e)) return direct;
  if (e.kind === "op") { for (const a of e.args) { const f = findFieldIn(a); if (f !== null) return f; } }
  if (e.kind === "keccak") { for (const w of e.words) { const f = findFieldIn(w); if (f !== null) return f; } }
  if (e.kind === "calldata") return findFieldIn(e.offset);
  return null;
}
function collectFunction(cfg: ControlFlowGraph, entryBlock: number): { stores: Effect[]; returns: (Expr | null)[]; hasStore: boolean; candidates: Expr[] } {
  const stores: Effect[] = []; const returns: (Expr | null)[] = []; const candidates: Expr[] = [];
  const seen = new Set<number>(); const queue: { idx: number; state: Sim }[] = [{ idx: entryBlock, state: { stack: [], mem: new Map(), lastStore: null } }];
  let visits = 0;
  while (queue.length > 0 && visits < MAX_BLOCK_VISITS) {
    const item = queue.shift(); if (item === undefined) break;
    if (seen.has(item.idx)) continue; seen.add(item.idx); visits += 1;
    const block = cfg.blocks[item.idx]; if (block === undefined) continue;
    const r = simulateBlock(block, item.state);
    candidates.push(...r.exit.stack, ...r.exit.mem.values(), ...(r.exit.lastStore !== null ? [r.exit.lastStore] : []));
    for (const e of r.effects) { if (e.kind === "store") { stores.push(e); candidates.push(e.value, e.slot); } }
    if (r.term.kind === "halt" && r.term.action === "return") returns.push(r.term.value ?? r.exit.lastStore);
    const targets: number[] = [];
    for (const edge of block.successors) { targets.push(edge.to); if (edge.kind === "conditional") targets.push(edge.fallThrough); }
    if (r.term.kind === "jump") { const d = exprConstValue(r.term.dest); if (d !== null) { const t = cfg.blocks.find((b) => b.range.startPc === Number(d)); if (t !== undefined) targets.push(t.index); } }
    for (const t of targets) if (!seen.has(t)) queue.push({ idx: t, state: r.exit });
  }
  return { stores, returns, hasStore: stores.length > 0, candidates };
}

function sigTypes(signature: string | null): string[] {
  if (signature === null) return [];
  const inner = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")")).trim();
  return inner === "" ? [] : inner.split(",").map((s) => s.trim());
}
function paramsOf(signature: string | null): string {
  return sigTypes(signature).map((t, i) => `${t} arg${i}`).join(", ");
}
const MAPPING_VAR: Readonly<Record<string, string>> = { balanceOf: "balances", allowance: "allowances" };

export function decompileContractV2(bytecode: BytecodeType): DecompiledContract {
  try { return decompileV2Inner(bytecode); } catch { return Object.freeze({ functions: Object.freeze([]), unresolvedJumps: Object.freeze([]), fallbackCount: 0, text: "" }); }
}

function decompileV2Inner(bytecode: BytecodeType): DecompiledContract {
  const cfg = buildCfg(lift(bytecode));
  const entries = findFunctionEntries(bytecode, cfg);
  const topology = dispatcherTopology(cfg, entries);
  const fallbackBlock = topology.ok ? topology.value.fallbackBlock : null;
  const named = resolveFunctionNames(entries, fallbackBlock);
  // Naming pass.
  const fieldNames = new Map<string, string>(); const fieldIsBool = new Set<string>();
  const slotNames = new Map<number, string>(); const mappingNames = new Map<number, string>();
  // Known bool-typed getters: a no-arg getter whose name suggests a flag.
  for (const entry of named) {
    const types = sigTypes(entry.named.signature);
    const info = collectFunction(cfg, entry.entryBlock);
    const usableName = !entry.named.name.startsWith("function_") && entry.named.name !== "fallback" ? entry.named.name : null;
    if (usableName === null) continue;
    if (types.length === 0 && !info.hasStore) {
      const exprs = [...info.returns.filter((r): r is Expr => r !== null), ...info.candidates];
      for (const ret of exprs) {
        const sl = findReturnSload(ret);
        if (sl === null) continue;
        if (mappingBaseOf(sl.slot) !== null) continue;
        const f = findFieldIn(ret);
        if (f !== null) {
          if (!fieldNames.has(fieldKey(f.slot, f.byte))) {
            fieldNames.set(fieldKey(f.slot, f.byte), usableName);
            if (usableName === "paused") fieldIsBool.add(fieldKey(f.slot, f.byte));
          }
        } else {
          const sc = exprConstValue(sl.slot);
          if (sc !== null && sc <= 0xffffffffn && !slotNames.has(Number(sc))) slotNames.set(Number(sc), usableName);
        }
      }
      // A plain slot load with no extraction names the whole slot.
      for (const ret of exprs) {
        const sl = findReturnSload(ret);
        if (sl === null || mappingBaseOf(sl.slot) !== null) continue;
        const sc = exprConstValue(sl.slot);
        if (sc !== null && sc <= 0xffffffffn && findFieldIn(ret) === null && !slotNames.has(Number(sc))) slotNames.set(Number(sc), usableName);
      }
    }
    if (types.length >= 1) {
      // A mapping is named only through the value a getter actually
      // returns, never through candidate loads in storing functions.
      const exprs = info.returns.filter((r): r is Expr => r !== null);
      for (const ret of exprs) {
        const sl = findReturnSload(ret);
        if (sl === null) continue;
        const base = mappingBaseOf(sl.slot);
        if (base !== null && !mappingNames.has(base)) mappingNames.set(base, MAPPING_VAR[usableName] ?? usableName);
      }
    }
  }
  // Per-function fallback: an empty v2 body keeps the v1 lines for that
  // selector so no function ever renders worse than v1.
  const v1Text = decompileContract(bytecode).text;
  const v1LinesFor = (selector: string): string[] => {
    const all = v1Text.split("\n");
    const start = all.findIndex((l) => l.includes(`/* selector ${selector} */`));
    if (start === -1) return [];
    const body: string[] = [];
    for (let i = start + 1; i < all.length && all[i] !== "}"; i += 1) body.push(all[i] ?? "");
    return body.filter((l) => l.trim().length > 0);
  };
  const functions: StructuredFunction[] = [];
  for (const entry of named) {
    const ctx: Ctx = { argTypes: sigTypes(entry.named.signature), fieldNames, fieldIsBool, slotNames, mappingNames };
    const emitted = emitFunction(cfg, entry, ctx);
    let lines = emitted.lines;
    if (lines.length === 0) lines = synthesizeFromRegion(bytecode, entry.selector, ctx);
    if (lines.length === 0) lines = v1LinesFor(entry.selector);
    const hasReturn = lines.some((l) => l.trim().startsWith("return"));
    const statements: SsaStatement[] = lines.map((line, i) => {
      const range = Object.freeze({ startPc: entry.entryPc + i, endPc: entry.entryPc + i + 1 });
      const t = line.trim();
      if (t.startsWith(REQUIRE) && t.slice(REQUIRE.length).startsWith("(")) return Object.freeze({ kind: "require", condition: t.slice(REQUIRE.length + 1, -2), range }) as SsaStatement;
      if (t.startsWith("return")) return Object.freeze({ kind: "return", value: t === "return;" ? null : t.slice(7, -1), range }) as SsaStatement;
      return Object.freeze({ kind: "effect", text: t, range }) as SsaStatement;
    });
    functions.push(Object.freeze({
      selector: entry.selector, name: entry.named.name, signature: entry.named.signature, entryPc: entry.entryPc,
      range: Object.freeze({ startPc: entry.entryPc, endPc: Math.max(emitted.endPc, entry.entryPc + 1) }),
      statements: Object.freeze(statements), annotations: Object.freeze([]),
      cause: hasReturn ? null : ("no-plain-return" as const),
    }));
  }
  const text = functions.map((fn, i) => {
    const entry = named[i];
    const header = `function ${fn.name}(${paramsOf(fn.signature)}) /* selector ${fn.selector} */ {`;
    const body = (fn.statements as readonly SsaStatement[]).map((s) => renderStmt(s)).join("\n");
    void entry;
    return body.length > 0 ? `${header}\n${body}\n}` : `${header}\n}`;
  }).join("\n\n");
  return Object.freeze({ functions: Object.freeze(functions), unresolvedJumps: cfg.unresolvedJumps, fallbackCount: 0, text });
}
function renderStmt(s: SsaStatement): string {
  // Statements already hold rendered text for v2; re-render by kind.
  if (s.kind === "require") return `  ${REQUIRE}(${s.condition});`;
  if (s.kind === "return") return s.value === null ? "  return;" : `  return ${s.value};`;
  if (s.kind === "effect") return s.text.startsWith("  ") ? s.text : `  ${s.text}`;
  if (s.kind === "assign") return `  ${s.target} = ${s.expr};`;
  if (s.kind === "revert") return "  revert();";
  return `  // ${s.label}`;
}

function blockAtPc(cfg: ControlFlowGraph, pc: number): number {
  const b = cfg.blocks.find((x) => x.range.startPc === pc);
  return b === undefined ? -1 : b.index;
}
function isRevertBlock(cfg: ControlFlowGraph, idx: number, state: Sim, depth: number): boolean {
  if (depth > 2) return false;
  const block = cfg.blocks[idx]; if (block === undefined) return false;
  const r = simulateBlock(block, state);
  if (r.effects.length > 0) return false;
  if (r.term.kind === "halt") return r.term.action === "revert";
  if (r.term.kind === "jump") { const d = exprConstValue(r.term.dest); if (d !== null) { const t = blockAtPc(cfg, Number(d)); return t >= 0 && isRevertBlock(cfg, t, r.exit, depth + 1); } return false; }
  if (r.term.kind === "fall") { const e = block.successors.find((x) => x.kind === "fall-through"); return e !== undefined && isRevertBlock(cfg, e.to, r.exit, depth + 1); }
  return false;
}

function emitFunction(cfg: ControlFlowGraph, entry: FunctionEntry & { named: { name: string; signature: string | null } }, ctx: Ctx): { lines: string[]; endPc: number } {
  const out: string[] = [];
  let visits = 0;
  let endPc = entry.entryPc;
  const emitBlock = (idx: number, state: Sim, visited: ReadonlySet<number>, depth: number, indent: string, retStack: readonly number[] = []): void => {
    if (out.length >= MAX_LINES || visits >= MAX_BLOCK_VISITS) return;
    if (visited.has(idx)) return;
    const block = cfg.blocks[idx]; if (block === undefined) return;
    visits += 1;
    if (block.range.endPc > endPc) endPc = block.range.endPc;
    const seen = new Set(visited); seen.add(idx);
    const r = simulateBlock(block, state);
    for (const eff of r.effects) { const line = effectLine(eff, ctx); if (line !== null && out.length < MAX_LINES) out.push(`${indent}${line}`); }
    if (r.term.kind === "halt") {
      if (r.term.action === "return") {
        let v = r.term.value;
        if (v === null) {
          const pool = [...(r.exit.lastStore !== null ? [r.exit.lastStore] : []), ...r.exit.mem.values(), ...[...r.exit.stack].reverse()];
          v = pool.find((e) => containsSload(e) || e.kind === "calldata" || (e.kind === "op" && e.args.length > 0)) ?? null;
        }
        out.push(v !== null ? `${indent}return ${printValue(v, ctx, 0)};` : `${indent}return;`);
      }
      else if (r.term.action === "revert") out.push(`${indent}revert();`);
      return;
    }
    if (r.term.kind === "fall" || r.term.kind === "end") {
      const e = block.successors.find((x) => x.kind === "fall-through");
      if (e !== undefined) emitBlock(e.to, r.exit, seen, depth, indent, retStack);
      return;
    }
    if (r.term.kind === "jump") {
      const edge = block.successors.find((x) => x.kind === "jump");
      if (edge !== undefined) {
        // A static jump into a helper carries caller-pushed return
        // addresses on the stack below the target: remember every
        // proven block address there so the helper's dynamic return
        // jump can resume at the caller's continuation.
        const returns: number[] = [];
        for (const item of r.exit.stack) {
          const v = exprConstValue(item);
          if (v === null) continue;
          const t = blockAtPc(cfg, Number(v));
          if (t >= 0 && t !== edge.to && !returns.includes(t)) returns.push(t);
        }
        emitBlock(edge.to, r.exit, seen, depth, indent, returns.length > 0 ? [...retStack, ...returns] : retStack);
        return;
      }
      const d = exprConstValue(r.term.dest);
      if (d !== null) { const t = blockAtPc(cfg, Number(d)); if (t >= 0) { emitBlock(t, r.exit, seen, depth, indent, retStack); return; } }
      // Dynamic return jump with an unproven destination: resume at
      // the nearest caller-pushed continuation, if any.
      const back = retStack[retStack.length - 1];
      if (back !== undefined) emitBlock(back, r.exit, seen, depth, indent, retStack.slice(0, -1));
      return;
    }
    // jumpi
    const edge = block.successors.find((x) => x.kind === "conditional");
    if (edge === undefined || edge.kind !== "conditional") return;
    const taken = edge.to, fall = edge.fallThrough;
    const takenReverts = isRevertBlock(cfg, taken, r.exit, 0);
    const fallReverts = isRevertBlock(cfg, fall, r.exit, 0);
    const pushRequire = (cond: string): void => {
      if (cond === "false" || cond === "true") return;
      if (/^(.+) == address\(\1\)$/.test(cond)) return;
      if (/^(.+) == \1$/.test(cond)) return;
      if (/^(.+) != \1$/.test(cond)) return;
      out.push(`${indent}${REQUIRE}(${cond});`);
    };
    if (takenReverts && !fallReverts) { pushRequire(negatedBool(r.term.cond, ctx)); emitBlock(fall, r.exit, seen, depth, indent, retStack); return; }
    if (fallReverts && !takenReverts) { pushRequire(printBool(r.term.cond, ctx)); emitBlock(taken, r.exit, seen, depth, indent, retStack); return; }
    if (depth >= MAX_IF_DEPTH) { out.push(`${indent}if (${printBool(r.term.cond, ctx)}) { /* ... */ }`); return; }
    out.push(`${indent}if (${printBool(r.term.cond, ctx)}) {`);
    const before = out.length;
    emitBlock(taken, r.exit, seen, depth + 1, `${indent}  `, retStack);
    if (out.length === before) out.push(`${indent}  // ...`);
    out.push(`${indent}} else {`);
    const before2 = out.length;
    emitBlock(fall, r.exit, seen, depth + 1, `${indent}  `, retStack);
    if (out.length === before2) out.push(`${indent}  // ...`);
    out.push(`${indent}}`);
  };
  emitBlock(entry.entryBlock, { stack: [], mem: new Map(), lastStore: null }, new Set(), 0, "  ");
  return { lines: out.slice(0, MAX_LINES), endPc };
}

// Prefer v2 output; fall back to v1 when v2 yields no functions.
export function decompilePreferV2(bytecode: BytecodeType): DecompiledContract {
  const v2 = decompileContractV2(bytecode);
  if (v2.functions.length > 0 && v2.text.trim().length > 0) return v2;
  return decompileContract(bytecode);
}


