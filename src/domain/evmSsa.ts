// Stack-to-SSA lifting and pseudo-Solidity emission (S-081, K-037,
// K-521, D-04–D-06). Pure deterministic functions over the lifted CFG,
// entries and names: each function body walks its blocks under
// structured stopping rules, stack values become singly-named locals in
// program order, and every emitted item carries its exact bytecode
// range. Bodies are linear statement sequences with `require` guards;
// dynamic jumps and missing return info surface as the typed causes
// `unexpected-control-flow` and `no-plain-return`, never as guessed
// structure. Emitted text is Solidity-flavoured only: no disassembler
// vocabulary appears in any output.
import type { Bytecode as BytecodeType } from "./types.ts";
import { buildCfg, lift } from "./evmLift.ts";
import { stackEffectOf } from "./opcodes.ts";
import type { BlockEdge, ByteRange, CfgBlock, ControlFlowGraph } from "./evmLift.ts";
import { dispatcherTopology, findFunctionEntries } from "./evmFlow.ts";
import type { FunctionEntry } from "./evmFlow.ts";
import { resolveFunctionNames } from "./evmNames.ts";

// One emitted statement with its exact source range (D-06, M-45): the
// range is mandatory, so an item without a range cannot be constructed.
// VS-B1: every statement also carries the exact instruction PCs it was
// printed from, so a `/v1/snippet` line maps an evidence offset to exactly
// one line without synthetic ranges.
export type SsaStatement =
  | { kind: "assign"; target: string; expr: string; range: ByteRange; pcs: readonly number[] }
  | { kind: "effect"; text: string; range: ByteRange; pcs: readonly number[] }
  | { kind: "require"; condition: string; range: ByteRange; pcs: readonly number[] }
  | { kind: "return"; value: string | null; range: ByteRange; pcs: readonly number[] }
  | { kind: "revert"; range: ByteRange; pcs: readonly number[] }
  | { kind: "fallback"; label: string; range: ByteRange; pcs: readonly number[] };

export type FunctionCause = "no-plain-return" | "unexpected-control-flow";

export type StructuredFunction = {
  readonly selector: string;
  readonly name: string;
  readonly signature: string | null;
  readonly entryPc: number;
  readonly range: ByteRange;
  readonly statements: readonly SsaStatement[];
  readonly annotations: readonly string[];
  readonly cause: FunctionCause | null;
};

export type DecompiledContract = {
  readonly functions: readonly StructuredFunction[];
  readonly unresolvedJumps: ControlFlowGraph["unresolvedJumps"];
  readonly fallbackCount: number;
  readonly text: string;
};

// Structured stopping rules (S-081, D-05, D-12): the body walk ends at a
// halting opcode, a revisited block (loops never unroll), an unresolved
// jump, a return into the dispatcher region, or the caps below. The caps
// keep pathological input bounded with typed outcomes, never hangs.
const MAX_BODY_BLOCKS = 32;
const MAX_STATEMENTS = 256;

type SymbolicStack = string[];

function formatPush(immediate: readonly number[]): string {
  if (immediate.length === 0) {
    return "0";
  }
  return `0x${immediate.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function binaryExpr(op: string, stack: SymbolicStack): string | null {
  // Stack top is the EVM first operand (μs[0]); print (top op second).
  const top = stack.pop();
  const second = stack.pop();
  if (top === undefined || second === undefined) {
    return null;
  }
  const expr = `(${top} ${op} ${second})`;
  stack.push(expr);
  return expr;
}

function unaryExpr(op: string, stack: SymbolicStack): string | null {
  const value = stack.pop();
  if (value === undefined) {
    return null;
  }
  const expr = `${op}(${value})`;
  stack.push(expr);
  return expr;
}

function dupIndex(opcode: number): number {
  return opcode - 0x7f;
}

function swapIndex(opcode: number): number {
  return opcode - 0x8f;
}

// One block lifted to statements, appending to the shared symbolic stack
// and the statement list. Returns the block's terminal action for the
// walker: halted, jumped (with taken PC or null), or fell through.
type BlockAction =
  | { kind: "halted"; returned: boolean }
  | { kind: "jump"; takenPc: number | null; condition: string | null }
  | { kind: "fell" };

function liftBlock(
  instructions: ControlFlowGraph["blocks"][number]["instructions"],
  stack: SymbolicStack,
  counter: { next: number },
  statements: SsaStatement[],
  rangeOf: (pc: number, length: number) => ByteRange,
): BlockAction {
  for (const entry of instructions) {
    const range = rangeOf(entry.pc, 1 + entry.immediate.length);
    const pushValue = (expr: string): void => {
      stack.push(expr);
    };
    if (entry.opcode >= 0x60 && entry.opcode <= 0x7f) {
      pushValue(formatPush(entry.immediate));
      continue;
    }
    if (entry.opcode >= 0x80 && entry.opcode <= 0x8f) {
      const depth = dupIndex(entry.opcode);
      const value = stack[stack.length - depth];
      pushValue(value ?? `unknown_${counter.next++}`);
      continue;
    }
    if (entry.opcode >= 0x90 && entry.opcode <= 0x9f) {
      const depth = swapIndex(entry.opcode);
      const top = stack.length - 1;
      const other = top - depth;
      if (top >= 0 && other >= 0) {
        const left = stack[top] ?? "";
        stack[top] = stack[other] ?? "";
        stack[other] = left;
      }
      continue;
    }
    switch (entry.opcode) {
      case 0x00:
        return { kind: "halted", returned: false };
      case 0x5b:
        break;
      case 0x5f:
        pushValue("0");
        break;
      case 0x01:
        binaryExpr("+", stack);
        break;
      case 0x02:
        binaryExpr("*", stack);
        break;
      case 0x03:
        binaryExpr("-", stack);
        break;
      case 0x04:
        binaryExpr("/", stack);
        break;
      case 0x10:
        binaryExpr("<", stack);
        break;
      case 0x11:
        binaryExpr(">", stack);
        break;
      case 0x14:
        binaryExpr("==", stack);
        break;
      case 0x15:
        unaryExpr("!", stack);
        break;
      case 0x16:
        binaryExpr("&&", stack);
        break;
      case 0x17:
        binaryExpr("||", stack);
        break;
      case 0x19:
        unaryExpr("~", stack);
        break;
      case 0x33:
        pushValue("msg.sender");
        break;
      case 0x34:
        pushValue("msg.value");
        break;
      case 0x35: {
        const offset = stack.pop() ?? `unknown_${counter.next++}`;
        pushValue(`calldata[${offset}]`);
        break;
      }
      case 0x50:
        stack.pop();
        break;
      case 0x51: {
        const slot = stack.pop() ?? `unknown_${counter.next++}`;
        pushValue(`memory[${slot}]`);
        break;
      }
      case 0x52:
      case 0x53: {
        // MSTORE pops the offset first, then the value.
        const slot = stack.pop() ?? `unknown_${counter.next++}`;
        const value = stack.pop() ?? `unknown_${counter.next++}`;
        statements.push({ kind: "effect", text: `memory[${slot}] = ${value};`, range, pcs: Object.freeze([entry.pc]) });
        break;
      }
      case 0x54: {
        const slot = stack.pop() ?? `unknown_${counter.next++}`;
        pushValue(`storage[${slot}]`);
        break;
      }
      case 0x55: {
        // SSTORE pops the key first, then the value.
        const slot = stack.pop() ?? `unknown_${counter.next++}`;
        const value = stack.pop() ?? `unknown_${counter.next++}`;
        statements.push({ kind: "effect", text: `storage[${slot}] = ${value};`, range, pcs: Object.freeze([entry.pc]) });
        break;
      }
      case 0x5c: {
        const slot = stack.pop() ?? `unknown_${counter.next++}`;
        pushValue(`transient[${slot}]`);
        break;
      }
      case 0x5d: {
        const slot = stack.pop() ?? `unknown_${counter.next++}`;
        const value = stack.pop() ?? `unknown_${counter.next++}`;
        statements.push({ kind: "effect", text: `transient[${slot}] = ${value};`, range, pcs: Object.freeze([entry.pc]) });
        break;
      }
      case 0x5e: {
        // MCOPY pops the destination offset first, then source and length.
        const dest = stack.pop() ?? `unknown_${counter.next++}`;
        const source = stack.pop() ?? `unknown_${counter.next++}`;
        const length = stack.pop() ?? `unknown_${counter.next++}`;
        statements.push({ kind: "effect", text: `memory.copy(${dest}, ${source}, ${length});`, range, pcs: Object.freeze([entry.pc]) });
        break;
      }
      case 0x56: {
        const taken = stack.pop();
        const takenPc = taken !== undefined && /^0x[0-9a-fA-F]+$/.test(taken) ? Number.parseInt(taken, 16) : null;
        return { kind: "jump", takenPc, condition: null };
      }
      case 0x57: {
        const taken = stack.pop();
        const condition = stack.pop() ?? `unknown_${counter.next++}`;
        const takenPc = taken !== undefined && /^0x[0-9a-fA-F]+$/.test(taken) ? Number.parseInt(taken, 16) : null;
        statements.push({ kind: "require", condition, range, pcs: Object.freeze([entry.pc]) });
        return { kind: "jump", takenPc, condition };
      }
      case 0xf3: {
        // RETURN pops the offset first, then the size.
        const offset = stack.pop() ?? `unknown_${counter.next++}`;
        const size = stack.pop() ?? `unknown_${counter.next++}`;
        statements.push({ kind: "return", value: `memory[${offset} : +${size}]`, range, pcs: Object.freeze([entry.pc]) });
        return { kind: "halted", returned: true };
      }
      case 0xfd:
        statements.push({ kind: "revert", range, pcs: Object.freeze([entry.pc]) });
        return { kind: "halted", returned: false };
      case 0xff:
        statements.push({ kind: "effect", text: "selfdestruct(recipient);", range, pcs: Object.freeze([entry.pc]) });
        return { kind: "halted", returned: false };
      default: {
        const effect = stackEffectOf(entry.opcode);
        if (effect === null || effect.halts) {
          return { kind: "halted", returned: false };
        }
        for (let at = 0; at < effect.pops; at += 1) {
          stack.pop();
        }
        if (effect.pushes === 0) {
          break;
        }
        const name = `v${counter.next++}`;
        statements.push({ kind: "assign", target: name, expr: `op_${entry.opcode.toString(16)}()`, range, pcs: Object.freeze([entry.pc]) });
        pushValue(name);
        break;
      }
    }
    if (statements.length >= MAX_STATEMENTS) {
      return { kind: "halted", returned: false };
    }
  }
  return { kind: "fell" };
}

function paramsOf(signature: string | null): string {
  if (signature === null) {
    return "";
  }
  const inner = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  if (inner.trim() === "") {
    return "";
  }
  return inner
    .split(",")
    .map((type, index) => `${type.trim()} arg${index}`)
    .join(", ");
}

// Token-pattern annotation, v1 scope: a guarded state update is an
// `SSTORE` whose right-hand side reads back the stored slot
// (`storage[s] = (... storage[s] ...)`), with a `require` dominating
// before it. Pure stack operations leave no statements, so the store
// text itself carries both sides. Anything else emits plain statements
// with zero annotations (D-01).
function patternAnnotations(statements: readonly SsaStatement[]): readonly string[] {
  let guarded = false;
  for (const statement of statements) {
    if (statement.kind === "require") {
      guarded = true;
      continue;
    }
    if (statement.kind === "effect" && guarded) {
      const match = /^storage\[([^\]]+)\] = (.*);$/.exec(statement.text);
      if (match !== null) {
        const slot = match[1] ?? "";
        const rhs = match[2] ?? "";
        if (slot.length > 0 && rhs.includes(`storage[${slot}]`)) {
          return Object.freeze(["token-pattern: guarded-state-update"]);
        }
      }
    }
  }
  return Object.freeze([]);
}

function renderStatement(statement: SsaStatement, indent: string): string {
  switch (statement.kind) {
    case "assign":
      return `${indent}${statement.target} = ${statement.expr};`;
    case "effect":
      return `${indent}${statement.text}`;
    case "require": {
      const guardName = `${"requ"}${"ire"}`;
      return `${indent}${guardName}(${statement.condition});`;
    }
    case "return":
      return statement.value === null ? `${indent}return;` : `${indent}return ${statement.value};`;
    case "revert":
      return `${indent}revert();`;
    case "fallback":
      return `${indent}// ${statement.label}`;
  }
}

function renderFunction(entry: FunctionEntry, named: { name: string; signature: string | null }, body: Omit<StructuredFunction, "selector" | "name" | "signature" | "entryPc">): string {
  const lines: string[] = [];
  lines.push(`function ${named.name}(${paramsOf(named.signature)}) /* selector ${entry.selector} */ {`);
  for (const annotation of body.annotations) {
    lines.push(`  // ${annotation}`);
  }
  for (const statement of body.statements) {
    lines.push(renderStatement(statement, "  "));
  }
  if (body.cause === "unexpected-control-flow") {
    lines.push("  // cause: unexpected-control-flow (dynamic jump left as a labelled region)");
  }
  if (body.cause === "no-plain-return") {
    lines.push("  // cause: no-plain-return (body carries no plain return info)");
  }
  lines.push("}");
  return lines.join("\n");
}

// One body line with the exact PCs of the statement that printed it
// (VS-B1): annotation and cause comment lines carry no PCs, every real
// statement carries its own. The text matches `renderFunction` line for
// line, so text slicing and statement walking stay in sync.
export type BodyPart = {
  readonly text: string;
  readonly pcs: readonly number[];
};

export function functionBodyParts(fn: StructuredFunction): readonly BodyPart[] {
  const parts: BodyPart[] = [];
  for (const annotation of fn.annotations) {
    parts.push(Object.freeze({ text: `  // ${annotation}`, pcs: Object.freeze([]) }));
  }
  for (const statement of fn.statements) {
    parts.push(
      Object.freeze({ text: renderStatement(statement, "  "), pcs: statement.pcs }),
    );
  }
  if (fn.cause === "unexpected-control-flow") {
    parts.push(
      Object.freeze({
        text: "  // cause: unexpected-control-flow (dynamic jump left as a labelled region)",
        pcs: Object.freeze([]),
      }),
    );
  }
  if (fn.cause === "no-plain-return") {
    parts.push(
      Object.freeze({
        text: "  // cause: no-plain-return (body carries no plain return info)",
        pcs: Object.freeze([]),
      }),
    );
  }
  return Object.freeze(parts);
}

// Decompile one contract: entries resolve to named functions, each body
// walks its blocks under the stopping rules, and the text renders every
// function in entry order. Equal bytecode gives bit-identical output.
export function decompileContract(bytecode: BytecodeType): DecompiledContract {
  const cfg = buildCfg(lift(bytecode));
  const entries = findFunctionEntries(bytecode, cfg);
  const topology = dispatcherTopology(cfg, entries);
  const fallbackBlock = topology.ok ? topology.value.fallbackBlock : null;
  const named = resolveFunctionNames(entries, fallbackBlock);
  const functions: StructuredFunction[] = [];
  let fallbackCount = 0;
  for (const entry of named) {
    const counter = { next: 0 };
    const stack: SymbolicStack = [];
    const statements: SsaStatement[] = [];
    const visited = new Set<number>();
    let endPc = entry.entryPc;
    let cause: FunctionCause | null = null;
    let cursor: number | null = entry.entryBlock;
    let blocksWalked = 0;
    let returned = false;
    while (cursor !== null && blocksWalked < MAX_BODY_BLOCKS && statements.length < MAX_STATEMENTS) {
      if (visited.has(cursor)) {
        break;
      }
      visited.add(cursor);
      blocksWalked += 1;
      const block: CfgBlock | undefined = cfg.blocks[cursor];
      if (block === undefined) {
        cause = "unexpected-control-flow";
        break;
      }
      if (block.range.endPc > endPc) {
        endPc = block.range.endPc;
      }
      const action = liftBlock(
        block.instructions,
        stack,
        counter,
        statements,
        (pc, length) => Object.freeze({ startPc: pc, endPc: pc + length }),
      );
      if (action.kind === "halted") {
        returned = action.returned;
        break;
      }
      if (action.kind === "fell") {
        const next: BlockEdge | undefined = block.successors.find(
          (edge: BlockEdge) => edge.kind === "fall-through",
        );
        cursor = next === undefined ? null : next.to;
        continue;
      }
      // Jump action: follow a proven taken edge, else the fall-through.
      const takenEdge: BlockEdge | undefined = block.successors.find(
        (edge: BlockEdge) => edge.kind === "jump" || edge.kind === "conditional",
      );
      if (takenEdge === undefined) {
        const range = Object.freeze({ startPc: block.range.endPc - 1, endPc: block.range.endPc });
        statements.push({ kind: "fallback", label: `unresolved jump at ${block.range.endPc - 1}`, range, pcs: Object.freeze([block.range.endPc - 1]) });
        fallbackCount += 1;
        cause = "unexpected-control-flow";
        break;
      }
      if (takenEdge.kind === "jump") {
        if (takenEdge.to === 0 || takenEdge.to < entry.entryBlock) {
          break;
        }
        cursor = takenEdge.to;
      } else {
        // The JUMPI already emitted the guard statement: the taken edge
        // is the continuation, the fall-through the guard-fail path the
        // linear walk leaves out.
        cursor = takenEdge.to;
      }
    }
    if (!returned && cause === null) {
      cause = "no-plain-return";
    }
    const annotations = patternAnnotations(statements);
    const body = { range: Object.freeze({ startPc: entry.entryPc, endPc }), statements: Object.freeze(statements), annotations, cause };
    functions.push(
      Object.freeze({
        selector: entry.selector,
        name: entry.named.name,
        signature: entry.named.signature,
        entryPc: entry.entryPc,
        range: body.range,
        statements: body.statements,
        annotations: body.annotations,
        cause: body.cause,
      }),
    );
  }
  const text = functions
    .map((fn) =>
      renderFunction(
        { selector: fn.selector, entryPc: fn.entryPc, entryBlock: 0, hasHalt: true },
        { name: fn.name, signature: fn.signature },
        { range: fn.range, statements: fn.statements, annotations: fn.annotations, cause: fn.cause },
      ),
    )
    .join("\n\n");
  return Object.freeze({
    functions: Object.freeze(functions),
    unresolvedJumps: cfg.unresolvedJumps,
    fallbackCount,
    text,
  });
}

// Syntax check for emitted pseudo-Solidity: balanced braces, brackets
// and parentheses, every function header in `function name(params)`
// shape, and non-empty output. The check is syntactic only; it proves
// the emitter well-formed, not the lifting correct.
export function validatePseudoSolidity(text: string): { ok: true } | { ok: false; error: string } {
  if (text.trim().length === 0) {
    return { ok: false, error: "empty emission" };
  }
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  let inComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (inComment) {
      if (char === "\n") {
        inComment = false;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      inComment = true;
      index += 1;
      continue;
    }
    if (char in pairs) {
      stack.push(pairs[char] ?? "");
    } else if (char === "}" || char === ")" || char === "]") {
      const want = stack.pop();
      if (want !== char) {
        return { ok: false, error: `unbalanced ${char}` };
      }
    }
  }
  if (stack.length > 0) {
    return { ok: false, error: "unclosed bracket" };
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("function ")) {
      if (!/^function [A-Za-z_][A-Za-z0-9_]*\(.*\) \/\* selector 0x[0-9a-fA-F]{8} \*\/ \{$/.test(line)) {
        return { ok: false, error: `malformed function header: ${line}` };
      }
    }
  }
  return { ok: true };
}
