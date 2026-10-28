// SSA and emission tests (S-081, K-037, K-521, D-04–D-06).
// Written first per A-21 (red): src/domain/evmSsa.ts does not exist yet.
// Three published-case fixtures render golden pseudo-Solidity, bodies
// stay bounded under the stopping rules, causes branch explicitly, and
// no disassembler vocabulary leaks into any emission.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Bytecode } from "../../../src/domain/types.ts";
import { decompileContract, validatePseudoSolidity } from "../../../src/domain/evmSsa.ts";
import type { Result } from "../../../src/domain/result.ts";
import { Asm } from "../../helpers/evmAsm.ts";

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function bytecodeOf(hex: string) {
  return mustOk(Bytecode.parse(hex));
}

// Fixture A (transfer-like): loads two calldata words, guards on the
// sender, reads a slot, then writes it back guarded.
function fixtureTransfer(): string {
  const asm = new Asm();
  asm.op(0x80).push4("a9059cbb").op(0x14);
  asm.pushLabel2("body").op(0x57);
  asm.label("body").op(0x5b);
  asm.push1(0x00).op(0x35); // calldata[0]
  asm.op(0x33, 0x14); // == msg.sender
  asm.pushLabel2("guarded").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd); // revert path
  asm.label("guarded").op(0x5b);
  asm.push1(0x01).op(0x54); // storage[1] load
  asm.push1(0x02).op(0x35); // calldata[2]
  asm.op(0x01); // add
  asm.push1(0x01).op(0x55); // storage[1] store
  asm.op(0x00); // STOP
  return asm.build();
}

// Fixture B (balanceOf-like getter): loads one calldata word, reads the
// slot, returns the word.
function fixtureBalanceOf(): string {
  const asm = new Asm();
  asm.op(0x80).push4("70a08231").op(0x14);
  asm.pushLabel2("body").op(0x57);
  asm.label("body").op(0x5b);
  asm.push1(0x00).op(0x35, 0x54); // storage[calldata[0]]
  asm.push1(0x00).op(0x52); // memory[0] = value
  asm.push1(0x20).push1(0x00).op(0xf3); // return
  return asm.build();
}

// Fixture C (approve-like): stores one calldata word, returns success.
function fixtureApprove(): string {
  const asm = new Asm();
  asm.op(0x80).push4("095ea7b3").op(0x14);
  asm.pushLabel2("body").op(0x57);
  asm.label("body").op(0x5b);
  asm.push1(0x04).op(0x35); // calldata[4]
  asm.push1(0x02).op(0x55); // storage[2] store
  asm.push1(0x01).push1(0x00).op(0x52); // memory[0] = 1
  asm.push1(0x20).push1(0x00).op(0xf3); // return
  return asm.build();
}

const FORBIDDEN_VOCABULARY = [
  "decompil",
  "extdecomp",
  "opcode",
  "mnemonic",
  "jumpdest",
  "basic block",
  "cfg ",
  "gosub",
];

const GOLDEN_TRANSFER = `function transfer(address arg0, uint256 arg1) /* selector 0xa9059cbb */ {
  // token-pattern: guarded-state-update
  require((calldata[0x00] == msg.sender));
  storage[0x01] = (storage[0x01] + calldata[0x02]);
  // cause: no-plain-return (body carries no plain return info)
}`;

const GOLDEN_BALANCE_OF = `function balanceOf(address arg0) /* selector 0x70a08231 */ {
  memory[0x00] = storage[calldata[0x00]];
  return memory[0x00 : +0x20];
}`;

const GOLDEN_APPROVE = `function approve(address arg0, uint256 arg1) /* selector 0x095ea7b3 */ {
  storage[0x02] = calldata[0x04];
  memory[0x00] = 0x01;
  return memory[0x00 : +0x20];
}`;

describe("evm ssa and emission", () => {
  test("k524_three_published_case_fixtures_render_expected_pseudo_solidity_and_docs_snippet", () => {
    const transfer = decompileContract(bytecodeOf(fixtureTransfer()));
    expect(transfer.functions.length).toBe(1);
    expect(transfer.functions[0]?.name).toBe("transfer");
    expect(transfer.text).toBe(GOLDEN_TRANSFER);
    expect(validatePseudoSolidity(transfer.text)).toEqual({ ok: true });

    const balanceOf = decompileContract(bytecodeOf(fixtureBalanceOf()));
    expect(balanceOf.functions.length).toBe(1);
    expect(balanceOf.functions[0]?.name).toBe("balanceOf");
    expect(balanceOf.text).toBe(GOLDEN_BALANCE_OF);
    expect(validatePseudoSolidity(balanceOf.text)).toEqual({ ok: true });

    const approve = decompileContract(bytecodeOf(fixtureApprove()));
    expect(approve.functions.length).toBe(1);
    expect(approve.functions[0]?.name).toBe("approve");
    expect(approve.text).toBe(GOLDEN_APPROVE);
    expect(validatePseudoSolidity(approve.text)).toEqual({ ok: true });

    // Every emitted item carries its exact range (D-06, M-45).
    for (const contract of [transfer, balanceOf, approve]) {
      for (const fn of contract.functions) {
        expect(fn.range.endPc).toBeGreaterThan(fn.range.startPc);
        for (const statement of fn.statements) {
          const range = (statement as { range: { startPc: number; endPc: number } }).range;
          expect(range.endPc).toBeGreaterThan(range.startPc);
        }
      }
    }

    // The docs snippet carries the transfer emission byte for byte.
    const docsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "evm-decompiler.md");
    const docs = readFileSync(docsPath, "utf8");
    expect(docs).toContain(transfer.text);
  });

  test("k524_store_and_return_operands_follow_pop_order", () => {
    // Regression: MSTORE/SSTORE/RETURN pop the offset/key first, then
    // the value/size. Swapped operands render plausible but wrong
    // assignments, so the goldens above plus these pins lock the order.
    const balanceOf = decompileContract(bytecodeOf(fixtureBalanceOf()));
    expect(balanceOf.text).toContain("memory[0x00] = storage[calldata[0x00]];");
    expect(balanceOf.text).toContain("return memory[0x00 : +0x20];");
    const approve = decompileContract(bytecodeOf(fixtureApprove()));
    expect(approve.text).toContain("storage[0x02] = calldata[0x04];");
    const transfer = decompileContract(bytecodeOf(fixtureTransfer()));
    expect(transfer.text).toContain("storage[0x01] = (storage[0x01] + calldata[0x02]);");
  });

  test("k524_emission_carries_no_decompiler_vocabulary", () => {
    const contracts = [fixtureTransfer(), fixtureBalanceOf(), fixtureApprove()].map((hex) =>
      decompileContract(bytecodeOf(hex)),
    );
    for (const contract of contracts) {
      const lowered = contract.text.toLowerCase();
      for (const word of FORBIDDEN_VOCABULARY) {
        expect(lowered).not.toContain(word);
      }
    }
  });

  test("k524_bodies_bounded_by_structured_stopping_rules", () => {
    // A block jumping back to its own header never unrolls.
    const loop = new Asm();
    loop.op(0x80).push4("a9059cbb").op(0x14);
    loop.pushLabel2("body").op(0x57);
    loop.label("body").op(0x5b).push1(0x01).op(0x01);
    loop.pushLabel2("body").op(0x56);
    const looped = decompileContract(bytecodeOf(loop.build()));
    expect(looped.functions.length).toBe(1);
    expect(looped.functions[0]?.statements.length ?? 999).toBeLessThanOrEqual(256);

    // A long straight chain stays bounded too.
    const chain = new Asm();
    chain.op(0x80).push4("70a08231").op(0x14);
    chain.pushLabel2("body").op(0x57);
    chain.label("body").op(0x5b);
    for (let index = 0; index < 400; index += 1) {
      chain.push1(index & 0xff).op(0x50);
    }
    chain.op(0x00);
    const chained = decompileContract(bytecodeOf(chain.build()));
    expect(chained.functions[0]?.statements.length ?? 999).toBeLessThanOrEqual(256);
  });

  test("k524_no_plain_return_and_unexpected_control_flow_causes", () => {
    // A STOP-only body carries no plain return info.
    const plain = new Asm();
    plain.op(0x80).push4("a9059cbb").op(0x14);
    plain.pushLabel2("body").op(0x57);
    plain.label("body").op(0x5b, 0x00);
    const stopped = decompileContract(bytecodeOf(plain.build()));
    expect(stopped.functions[0]?.cause).toBe("no-plain-return");

    // A body jumping on a stack-held target leaves a labelled region.
    const dynamic = new Asm();
    dynamic.op(0x80).push4("70a08231").op(0x14);
    dynamic.pushLabel2("body").op(0x57);
    dynamic.label("body").op(0x5b, 0x80, 0x56, 0x00);
    const jumped = decompileContract(bytecodeOf(dynamic.build()));
    expect(jumped.functions[0]?.cause).toBe("unexpected-control-flow");
    expect(jumped.fallbackCount).toBeGreaterThan(0);
  });
});
