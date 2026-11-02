// Decompiler v2 tests: synthetic hand-assembled fixtures only.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { Bytecode } from "../../../src/domain/types.ts";
import { decompileContractV2, decompilePreferV2 } from "../../../src/domain/decompileV2.ts";
import { validatePseudoSolidity } from "../../../src/domain/evmSsa.ts";
import type { Result } from "../../../src/domain/result.ts";
import { Asm } from "../../helpers/evmAsm.ts";

function mustOk<T>(r: Result<T, { message: string }>): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function bc(hex: string) { return mustOk(Bytecode.parse(hex)); }
function dispatcher(asm: Asm, entries: readonly (readonly [string, string])[]): void {
  for (const [sel, label] of entries) { asm.op(0x80).push4(sel).op(0x14); asm.pushLabel2(label).op(0x57); }
  asm.op(0x00);
}
const MASK160 = Array.from({ length: 20 }, () => 0xff);
function pushMask160(asm: Asm): Asm { return asm.op(0x73, ...MASK160); }
function push256pow20(asm: Asm): Asm { return asm.op(0x74, 0x01, ...Array.from({ length: 20 }, () => 0)); }
function ownerGetter(asm: Asm, label: string): void {
  asm.label(label).op(0x5b); asm.push1(0x00).op(0x54); pushMask160(asm); asm.op(0x16);
  asm.push1(0x00).op(0x52); asm.push1(0x20).push1(0x00).op(0xf3);
}
function pausedGetter(asm: Asm, label: string): void {
  asm.label(label).op(0x5b); push256pow20(asm); asm.push1(0x00).op(0x54); asm.op(0x04);
  asm.push1(0xff).op(0x16); asm.push1(0x00).op(0x52); asm.push1(0x20).push1(0x00).op(0xf3);
}
function revertBlock(asm: Asm, label: string): void {
  asm.label(label).op(0x5b); asm.push1(0x00).push1(0x00).op(0xfd);
}

function fixturePackedPause(): string {
  const asm = new Asm();
  dispatcher(asm, [["8da5cb5b", "owner"], ["5c975abb", "paused"], ["8456cb59", "pause"]]);
  ownerGetter(asm, "owner");
  pausedGetter(asm, "paused");
  asm.label("pause").op(0x5b);
  // require(msg.sender == owner)
  asm.op(0x33); asm.push1(0x00).op(0x54); pushMask160(asm); asm.op(0x16, 0x14);
  asm.pushLabel2("ok1").op(0x57);
  revertBlock(asm, "rev1");
  asm.label("ok1").op(0x5b);
  // require(!paused)
  push256pow20(asm); asm.push1(0x00).op(0x54); asm.op(0x04); asm.push1(0xff).op(0x16, 0x15);
  asm.pushLabel2("ok2").op(0x57);
  revertBlock(asm, "rev2");
  asm.label("ok2").op(0x5b);
  // paused = true; emit topic; stop
  asm.push1(0x00).op(0x54); push256pow20(asm); asm.op(0x17); asm.push1(0x00).op(0x55);
  asm.op(0x7f, ...Array.from({ length: 32 }, (_, i) => i)); asm.push1(0x00).push1(0x00).op(0xa1);
  asm.op(0x00);
  return asm.build();
}

function fixtureInternalOwner(): string {
  const asm = new Asm();
  dispatcher(asm, [["8da5cb5b", "owner"], ["f2fde38b", "body"]]);
  ownerGetter(asm, "owner");
  asm.label("body").op(0x5b);
  // call _msgSender helper, then owner helper, compare
  asm.pushLabel2("afterSender"); asm.pushLabel2("msgSender").op(0x56);
  asm.label("afterSender").op(0x5b);
  asm.pushLabel2("afterOwner"); asm.pushLabel2("ownerHelper").op(0x56);
  asm.label("afterOwner").op(0x5b);
  asm.op(0x14); asm.pushLabel2("ok").op(0x57);
  revertBlock(asm, "rev");
  asm.label("ok").op(0x5b); asm.op(0x00);
  asm.label("msgSender").op(0x5b); asm.op(0x33, 0x90, 0x56);
  asm.label("ownerHelper").op(0x5b); asm.push1(0x00).op(0x54); pushMask160(asm); asm.op(0x16, 0x90, 0x56);
  return asm.build();
}

function fixtureUsageGate(): string {
  const asm = new Asm();
  dispatcher(asm, [["0ecb93c0", "addBlackList"], ["a9059cbb", "transfer"]]);
  // addBlackList: mapping base 1 store, no getter anywhere.
  asm.label("addBlackList").op(0x5b);
  asm.push1(0x04).op(0x35); asm.push1(0x00).op(0x52);
  asm.push1(0x01); asm.push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20);
  asm.push1(0x01); asm.op(0x90, 0x55); asm.op(0x00);
  // transfer: require the base-1 entry is zero, then stop.
  asm.label("transfer").op(0x5b);
  asm.push1(0x04).op(0x35); asm.push1(0x00).op(0x52);
  asm.push1(0x01); asm.push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54, 0x15);
  asm.pushLabel2("tok").op(0x57);
  asm.label("trev").op(0x5b); asm.push1(0x00).push1(0x00).op(0xfd);
  asm.label("tok").op(0x5b); asm.op(0x00);
  return asm.build();
}

function fixtureMappingWrite(): string {
  const asm = new Asm();
  dispatcher(asm, [["70a08231", "balanceOf"], ["0ecb93c0", "addBlackList"]]);
  // balanceOf: return balances[arg0], mapping base slot 1
  asm.label("balanceOf").op(0x5b);
  asm.push1(0x04).op(0x35); asm.push1(0x00).op(0x52);
  asm.push1(0x01); asm.push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20, 0x54);
  asm.push1(0x00).op(0x52); asm.push1(0x20).push1(0x00).op(0xf3);
  // addBlackList: balances[arg0] = 1
  asm.label("addBlackList").op(0x5b);
  asm.push1(0x04).op(0x35); asm.push1(0x00).op(0x52);
  asm.push1(0x01); asm.push1(0x20).op(0x52);
  asm.push1(0x40).push1(0x00).op(0x20);
  asm.push1(0x01); asm.op(0x90, 0x55); asm.op(0x00);
  return asm.build();
}

describe("decompiler v2", () => {
  test("packed owner and paused shape renders readable pause", () => {
    const out = decompileContractV2(bc(fixturePackedPause()));
    const pauseFn = out.functions.find((f) => f.name === "pause");
    expect(pauseFn).toBeDefined();
    expect(out.text).toContain("function pause() /* selector 0x8456cb59 */ {");
    expect(out.text).toContain("require(msg.sender == owner);");
    expect(out.text).toContain("require(!paused);");
    expect(out.text).toContain("paused = true;");
    expect(out.text).toContain("emit 0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f();");
    expect(out.text).not.toContain("&&");
    expect(out.text).not.toContain("op_");
    expect(out.text).not.toContain("!(!");
    expect(validatePseudoSolidity(out.text)).toEqual({ ok: true });
  });

  test("internal calls inline to an owner guard", () => {
    const out = decompileContractV2(bc(fixtureInternalOwner()));
    expect(out.text).toContain("require(msg.sender == owner);");
  });

  test("mapping write uses the getter-derived mapping name", () => {
    const out = decompileContractV2(bc(fixtureMappingWrite()));
    expect(out.text).toContain("function addBlackList(address arg0) /* selector 0x0ecb93c0 */ {");
    expect(out.text).toContain("balances[arg0] = 1;");
    expect(out.text).toContain("return balances[arg0];");
  });

  test("unnamed mapping read in the transfer gate keeps its slot name with a gate note", () => {
    const out = decompileContractV2(bc(fixtureUsageGate()));
    // No getter names base 1, a single named writer stores it, and
    // transfer reads it: the slot name stays, annotated, never guessed.
    expect(out.text).toContain("mapping1[arg0] /* addBlackList gate */ = 1;");
    expect(out.text).toContain("require(mapping1[arg0] /* addBlackList gate */ == 0);");
    expect(out.text).not.toContain("isBlackListed");
  });

  test("bitwise and prints as & and masks become casts", () => {
    const asm = new Asm();
    dispatcher(asm, [["a9059cbb", "body"]]);
    asm.label("body").op(0x5b);
    asm.push1(0x04).op(0x35); asm.push1(0xff).op(0x16);
    asm.push1(0x00).op(0x52); asm.push1(0x20).push1(0x00).op(0xf3);
    const out = decompileContractV2(bc(asm.build()));
    expect(out.text).toContain("return uint8(arg0);");
    expect(out.text).not.toContain("&&");
  });

  test("deterministic and never throws on arbitrary bytes", () => {
    const hex = fixturePackedPause();
    expect(decompileContractV2(bc(hex)).text).toBe(decompileContractV2(bc(hex)).text);
    fc.assert(fc.property(fc.uint8Array({ maxLength: 256 }), (bytes) => {
      const h = `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
      const parsed = Bytecode.parse(h === "0x" ? "0x00" : h);
      if (!parsed.ok) return;
      const out = decompilePreferV2(parsed.value);
      expect(typeof out.text).toBe("string");
    }), { numRuns: 50 });
  });

  test("tiny hostile bytecode with shared-subexpression blowup stays bounded", () => {
    const asm = new Asm();
    dispatcher(asm, [["a9059cbb", "body"]]);
    asm.label("body").op(0x5b);
    asm.op(0x33);
    for (let index = 0; index < 40; index += 1) {
      asm.op(0x80, 0x01);
    }
    asm.op(0x80, 0x16);
    asm.push1(0x00).op(0x52);
    asm.push1(0x20).push1(0x00).op(0xf3);
    const started = Date.now();
    const out = decompileContractV2(bc(asm.build()));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.text).toContain("function transfer(address arg0, uint256 arg1) /* selector 0xa9059cbb */ {");
    expect(out.text).toContain("return unknown;");
    expect(out.text.length).toBeLessThan(20000);
  });

  test("shared keccak expressions stay bounded", () => {
    const asm = new Asm();
    dispatcher(asm, [["a9059cbb", "body"]]);
    asm.label("body").op(0x5b);
    asm.push1(0x04).op(0x35);
    // Store the same word at mem 0 and 32, hash, then repeat 40 times:
    // each round hashes the shared previous result twice over.
    for (let round = 0; round < 40; round += 1) {
      asm.op(0x80).push1(0x00).op(0x52);
      asm.op(0x80).push1(0x20).op(0x52);
      asm.push1(0x40).push1(0x00).op(0x20);
    }
    asm.push1(0x00).op(0x52);
    asm.push1(0x20).push1(0x00).op(0xf3);
    const started = Date.now();
    const out = decompileContractV2(bc(asm.build()));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.text).toContain("function transfer(address arg0, uint256 arg1) /* selector 0xa9059cbb */ {");
    expect(out.text.length).toBeLessThan(20000);
  });

  test("subtraction of 1 and 2^160 is not rendered as the address mask", () => {
    const asm = new Asm();
    dispatcher(asm, [["a9059cbb", "body"]]);
    asm.label("body").op(0x5b);
    push256pow20(asm);
    asm.push1(0x01).op(0x03);
    asm.push1(0x00).op(0x52);
    asm.push1(0x20).push1(0x00).op(0xf3);
    const out = decompileContractV2(bc(asm.build()));
    const expected = `0x${((1n - (1n << 160n)) & ((1n << 256n) - 1n)).toString(16)}`;
    expect(out.text).toContain(expected);
  });

  test("double iszero of a non-constant stays a boolean check", () => {
    const asm = new Asm();
    dispatcher(asm, [["a9059cbb", "body"]]);
    asm.label("body").op(0x5b);
    asm.push1(0x04).op(0x35).op(0x15, 0x15);
    asm.push1(0x00).op(0x52);
    asm.push1(0x20).push1(0x00).op(0xf3);
    const out = decompileContractV2(bc(asm.build()));
    expect(out.text).not.toContain("return arg0;");
    expect(out.text).toContain("!= 0");
  });
});
