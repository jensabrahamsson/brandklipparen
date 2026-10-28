// Lifter and CFG tests (S-078, K-037, K-521, D-02, D-03, M-43).
// Written first per A-21 (red): src/domain/evmLift.ts does not exist
// yet, so every test below fails until stages 1-2 land. Fixtures are
// hand-assembled dispatcher shapes with a tiny test-only assembler; no
// network happens here.
import { describe, expect, test } from "vitest";
import { Bytecode } from "../../../src/domain/types.ts";
import { canonicalSerialize } from "../../../src/domain/serialize.ts";
import type { CanonicalValue } from "../../../src/domain/serialize.ts";
import { extractSelectors } from "../../../src/domain/selectors.ts";
import { buildCfg, lift } from "../../../src/domain/evmLift.ts";
import type { Result } from "../../../src/domain/result.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Minimal test-only assembler: emits bytes with label fixups for PUSH2
// destinations, so fixtures carry proven jump targets without hand-counted
// PCs. Production code never assembles; this helper lives in the test
// tree only.
class Asm {
  private bytes: number[] = [];
  private labels = new Map<string, number>();
  private fixups: { pos: number; label: string }[] = [];

  get pc(): number {
    return this.bytes.length;
  }

  label(name: string): this {
    this.labels.set(name, this.bytes.length);
    return this;
  }

  op(...values: number[]): this {
    this.bytes.push(...values);
    return this;
  }

  push1(value: number): this {
    return this.op(0x60, value & 0xff);
  }

  push2(value: number): this {
    return this.op(0x61, (value >> 8) & 0xff, value & 0xff);
  }

  push4(hex: string): this {
    const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = [0x63];
    for (let index = 0; index < 8; index += 2) {
      out.push(parseInt(clean.slice(index, index + 2), 16));
    }
    return this.op(...out);
  }

  pushLabel2(label: string): this {
    this.fixups.push({ pos: this.bytes.length + 1, label });
    return this.op(0x61, 0x00, 0x00);
  }

  build(): string {
    const out = this.bytes.slice();
    for (const fixup of this.fixups) {
      const target = this.labels.get(fixup.label);
      if (target === undefined) {
        throw new Error(`unknown label ${fixup.label}`);
      }
      out[fixup.pos] = (target >> 8) & 0xff;
      out[fixup.pos + 1] = target & 0xff;
    }
    return `0x${out.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
}

function dispatcherFixture(): string {
  const asm = new Asm();
  asm.push1(0x80).push1(0x40).op(0x52); // MSTORE free pointer
  asm.op(0x34, 0x80, 0x15); // CALLVALUE DUP1 ISZERO
  asm.pushLabel2("ok").op(0x57); // JUMPI
  asm.push1(0x00).op(0x80, 0xfd); // PUSH1 0 DUP1 REVERT
  asm.label("ok").op(0x5b, 0x50); // JUMPDEST POP
  asm.op(0x80).push4("a9059cbb").op(0x14); // DUP1 PUSH4 transfer EQ
  asm.pushLabel2("t1").op(0x57); // JUMPI
  asm.op(0x80).push4("70a08231").op(0x14); // DUP1 PUSH4 balanceOf EQ
  asm.pushLabel2("t2").op(0x57); // JUMPI
  asm.label("fallback").op(0x5b).push1(0x00).op(0x80, 0xfd); // JUMPDEST PUSH1 0 DUP1 REVERT
  asm.label("t1").op(0x5b, 0x50).push1(0x01).push1(0x02).op(0x01, 0x00); // body + STOP
  asm.label("t2").op(0x5b, 0x50).push1(0x03).op(0x00); // body + STOP
  return asm.build();
}

function bytecodeOf(hex: string) {
  return mustOk(Bytecode.parse(hex));
}

describe("evm lifter and cfg", () => {
  test("k521_lift_partitions_blocks_with_validated_jump_targets", () => {
    const lifted = lift(bytecodeOf(dispatcherFixture()));
    expect(lifted.blocks.length).toBeGreaterThan(3);
    expect(Object.isFrozen(lifted.blocks)).toBe(true);
    const total = lifted.blocks.reduce((sum, block) => sum + block.instructions.length, 0);
    expect(total).toBe(lifted.instructionCount);
    for (const block of lifted.blocks) {
      expect(Object.isFrozen(block.instructions)).toBe(true);
    }
    const cfg = buildCfg(lifted);
    expect(cfg.entryBlock).toBe(0);
    expect(cfg.diagnoses).toEqual([]);
    expect(cfg.unresolvedJumps).toEqual([]);
    const conditionals = cfg.blocks.flatMap((block) =>
      block.successors.filter((edge) => edge.kind === "conditional"),
    );
    expect(conditionals.length).toBeGreaterThanOrEqual(2);
    // Equal bytecode gives bit-identical output (K-102).
    const again = buildCfg(lift(bytecodeOf(dispatcherFixture())));
    expect(canonicalSerialize(cfg as unknown as CanonicalValue)).toBe(
      canonicalSerialize(again as unknown as CanonicalValue),
    );
  });

  test("k521_jumpdest_jump_jumpi_rjump_rjumpi_rjumpv_coverage", () => {
    // JUMPDEST opens a block; JUMP with a proven constant links it.
    const jump = new Asm().pushLabel2("dst").op(0x56).label("dst").op(0x5b, 0x00).build();
    const jumpCfg = buildCfg(lift(bytecodeOf(jump)));
    expect(jumpCfg.diagnoses).toEqual([]);
    expect(jumpCfg.blocks[0]?.successors).toEqual([{ kind: "jump", to: 1 }]);

    // JUMPI with a proven constant links taken and fall-through.
    const jumpi = new Asm()
      .push1(0x01)
      .pushLabel2("dst")
      .op(0x57)
      .op(0x00)
      .label("dst")
      .op(0x5b, 0x00)
      .build();
    const jumpiCfg = buildCfg(lift(bytecodeOf(jumpi)));
    expect(jumpiCfg.diagnoses).toEqual([]);
    expect(jumpiCfg.blocks[0]?.successors).toEqual([{ kind: "conditional", to: 2, fallThrough: 1 }]);

    // Byte values 0x5c-0x5e decode through the landed Cancun table as
    // TLOAD, TSTORE and MCOPY (never as EOF RJUMP/RJUMPI/RJUMPV, which
    // this codebase does not implement): they carry no control edge.
    const transient = new Asm().op(0x5c, 0x5d, 0x5e, 0x00).build();
    const transientLifted = lift(bytecodeOf(transient));
    expect(transientLifted.blocks.map((block) => block.instructions.map((entry) => entry.name))).toEqual([
      ["TLOAD", "TSTORE", "MCOPY", "STOP"],
    ]);
    const transientCfg = buildCfg(transientLifted);
    expect(transientCfg.blocks[0]?.successors).toEqual([]);
  });

  test("k521_dispatch_coverage_on_erc20_fixture", () => {
    const code = bytecodeOf(dispatcherFixture());
    const entries = extractSelectors(code).filter((entry) => entry.kind === "paired");
    expect(entries.length).toBe(2);
    const cfg = buildCfg(lift(code));
    const takenTargets = new Set<number>();
    for (const block of cfg.blocks) {
      for (const edge of block.successors) {
        if (edge.kind === "conditional") {
          const targetBlock = cfg.blocks[edge.to];
          if (targetBlock !== undefined) {
            takenTargets.add(targetBlock.range.startPc);
          }
        }
      }
    }
    for (const entry of entries) {
      if (entry.kind !== "paired") {
        continue;
      }
      expect(takenTargets.has(entry.target as number)).toBe(true);
    }
  });

  test("k521_invalid_jumpdest_reports_diagnosis_not_edge", () => {
    // PUSH2 0x0001 lands mid-PUSH-data, not on a JUMPDEST.
    const hex = new Asm().push2(0x0001).op(0x56).op(0x5b, 0x00).build();
    const cfg = buildCfg(lift(bytecodeOf(hex)));
    expect(cfg.diagnoses).toEqual([{ kind: "invalid-jumpdest", atPc: 3, target: 1 }]);
    expect(cfg.unresolvedJumps).toEqual([{ atPc: 3, range: { startPc: 3, endPc: 4 } }]);
    expect(cfg.blocks[0]?.successors).toEqual([]);
  });

  test("k521_unterminated_block_and_overrun_diagnosed", () => {
    // Trailing ADD with no halting opcode leaves the block unterminated.
    const open = new Asm().op(0x5b, 0x01).build();
    const openCfg = buildCfg(lift(bytecodeOf(open)));
    expect(openCfg.diagnoses).toContainEqual({ kind: "unterminated-block", block: 0 });

    // PUSH2 0xffff jumps past the code end.
    const over = new Asm().push2(0xffff).op(0x56).build();
    const overCfg = buildCfg(lift(bytecodeOf(over)));
    expect(overCfg.diagnoses).toContainEqual({ kind: "block-overrun", atPc: 3, target: 65535 });
    expect(overCfg.unresolvedJumps).toEqual([{ atPc: 3, range: { startPc: 3, endPc: 4 } }]);
  });
});
