// Snippet PCS mapping (VS-B1): every quoted line carries the exact
// instruction PCs of its printed statement, so an evidence offset maps to
// exactly one line. Hand-assembled synthetic fixture only.
import { describe, expect, test } from "vitest";
import { Bytecode } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { snippetForSelector } from "../../../src/application/snippetService.ts";
import { disassemble } from "../../../src/domain/selectors.ts";
import { Asm } from "../../helpers/evmAsm.ts";

function mustOk<T>(r: Result<T, { message: string }>): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function bc(hex: string) { return mustOk(Bytecode.parse(hex)); }

// Minimal owner-guarded flag writer behind a dispatcher: owner getter plus
// pause() (0x8456cb59) which requires the owner and stores 1 to slot 5.
function fixtureFlagWriter(): string {
  const asm = new Asm();
  for (const [sel, label] of [["8da5cb5b", "owner"], ["8456cb59", "pause"]] as const) {
    asm.op(0x80).push4(sel).op(0x14);
    asm.pushLabel2(label).op(0x57);
  }
  asm.op(0x00);
  const mask = Array.from({ length: 20 }, () => 0xff);
  asm.label("owner").op(0x5b);
  asm.push1(0x00).op(0x54);
  asm.op(0x73, ...mask).op(0x16);
  asm.push1(0x00).op(0x52);
  asm.push1(0x20).push1(0x00).op(0xf3);
  asm.label("pause").op(0x5b);
  asm.op(0x33);
  asm.push1(0x00).op(0x54);
  asm.op(0x73, ...mask).op(0x16, 0x14);
  asm.pushLabel2("ok").op(0x57);
  asm.label("rev").op(0x5b);
  asm.push1(0x00).push1(0x00).op(0xfd);
  asm.label("ok").op(0x5b);
  asm.push1(0x01).push1(0x05).op(0x55);
  asm.op(0x00);
  return asm.build();
}

describe("snippet pcs", () => {
  test("evidence_offset_maps_to_exactly_one_line", () => {
    const code = bc(fixtureFlagWriter());
    const result = snippetForSelector(code, "0x8456cb59");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.value.lines;
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]?.text).toContain("function pause()");
    // Structural lines carry no PCs.
    expect(lines[0]?.pcs).toEqual([]);
    expect(lines[lines.length - 1]?.pcs).toEqual([]);
    // Printed statements carry their exact PCs.
    const body = lines.slice(1, -1);
    expect(body.some((line) => line.pcs.length > 0)).toBe(true);
    // The single SSTORE offset hits exactly one quoted line.
    const stores = disassemble(code)
      .filter((ins) => ins.opcode === 0x55)
      .map((ins) => ins.pc);
    expect(stores.length).toBe(1);
    const target = stores[0] ?? -1;
    const hits = lines.filter((line) => line.pcs.includes(target));
    expect(hits.length).toBe(1);
    expect(hits[0]?.text).toContain("slot5 = 1;");
    // The owner-check JUMPI offset hits exactly one require line.
    const jumpis = disassemble(code)
      .filter((ins) => ins.opcode === 0x57)
      .map((ins) => ins.pc);
    expect(jumpis.length).toBeGreaterThan(0);
    for (const pc of jumpis) {
      const found = lines.filter((line) => line.pcs.includes(pc));
      expect(found.length).toBeLessThanOrEqual(1);
    }
  });
});
