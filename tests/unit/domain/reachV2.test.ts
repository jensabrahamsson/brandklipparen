// Reachability v2: return jumps and shared code (P-10 session 1).
// Hand-assembled solc-shaped fixture: `transfer` and `transferFrom` each
// push a return address, jump into a shared `_transfer` body that ends in a
// dynamic JUMP, and continue past the return with one gate each. v1 (the
// scored default) never follows the return, so the post-call gates belong
// to no function; v2 resolves the return per entry, so both entries hold
// the shared body plus their own gate. Synthetic selectors and bytecode
// only; no network happens here.
import { describe, expect, test } from "vitest";
import { Bytecode } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { disassemble } from "../../../src/domain/selectors.ts";
import { buildCfg, lift, resolveEntryReachV2 } from "../../../src/domain/evmLift.ts";
import { attributeFunctions, findFunctionEntries } from "../../../src/domain/evmFlow.ts";
import {
  analyzeOwnerControl,
  constSlotLoadNearFlavor,
  diagnoseReachability,
  regionBySelector,
} from "../../../src/domain/ownerControl.ts";
import { Selector } from "../../../src/domain/types.ts";
import { Asm } from "../../helpers/evmAsm.ts";

const TRANSFER = mustOk(Selector.parse("0xa9059cbb"));
const TRANSFER_FROM = mustOk(Selector.parse("0x23b872dd"));

function mustOk<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function bytecodeOf(hex: string) {
  return mustOk(Bytecode.parse(hex));
}

type SharedReturnFixture = {
  readonly hex: string;
  readonly fallbackPc: number;
  readonly sharedPc: number;
  readonly sharedJumpPc: number;
  readonly ret1GatePc: number;
  readonly ret2GatePc: number;
};

// Dispatcher (path A) with two paired entries; each entry pushes its own
// return address, then the shared helper address, and jumps. The helper
// ends in a dynamic JUMP (the internal return). A lone INVALID pads the
// structural fall-through of that jump and carries no PUSH2/PUSH3, so it
// can never pollute the v2 candidate set.
function sharedReturnFixture(): SharedReturnFixture {
  const asm = new Asm();
  asm.op(0x80).push4("a9059cbb").op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4("23b872dd").op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.label("fallback");
  const fallbackPc = asm.pc;
  asm.op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.pushLabel2("ret1");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("transferFromEntry").op(0x5b);
  asm.pushLabel2("ret2");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("shared");
  const sharedPc = asm.pc;
  asm.op(0x5b);
  asm.push1(0x01).push1(0x02).op(0x01);
  const sharedJumpPc = asm.pc;
  asm.op(0x56);
  asm.op(0xfe);
  asm.label("ret1").op(0x5b);
  asm.push1(0x01).push1(0x00);
  const ret1GatePc = asm.pc;
  asm.op(0x55, 0x00);
  asm.label("ret2").op(0x5b);
  asm.push1(0x02).push1(0x00);
  const ret2GatePc = asm.pc;
  asm.op(0x55, 0x00);
  return { hex: asm.build(), fallbackPc, sharedPc, sharedJumpPc, ret1GatePc, ret2GatePc };
}

// Seventeen JUMPDEST constants visible from one entry: seventeen dead
// targets plus the shared helper. The helper is a proven callee and
// stays out of the return candidate set, leaving seventeen candidates
// past the per-jump cap of sixteen, so the shared return stays
// unresolved.
function cappedFixture(): { hex: string; entryPc: number; sharedJumpPc: number } {
  const asm = new Asm();
  asm.label("entry");
  const entryPc = asm.pc;
  asm.op(0x5b);
  const dead: string[] = [];
  for (let index = 1; index <= 17; index += 1) {
    const name = `dead${index.toString().padStart(2, "0")}`;
    dead.push(name);
    asm.pushLabel2(name);
  }
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("shared");
  asm.op(0x5b);
  asm.push1(0x01).push1(0x02).op(0x01);
  const sharedJumpPc = asm.pc;
  asm.op(0x56);
  asm.op(0xfe);
  for (const name of dead) {
    asm.label(name).op(0x5b, 0x00);
  }
  return { hex: asm.build(), entryPc, sharedJumpPc };
}

describe("reachability v2 return jumps", () => {
  test("p10_v2_resolves_shared_return_for_both_entries", () => {
    const fixture = sharedReturnFixture();
    const code = bytecodeOf(fixture.hex);
    const cfg = buildCfg(lift(code));
    // v1 records the helper return exactly once and diagnoses nothing.
    expect(cfg.diagnoses).toEqual([]);
    expect(cfg.unresolvedJumps.length).toBe(1);
    expect(cfg.unresolvedJumps[0]?.atPc).toBe(fixture.sharedJumpPc);

    // The resolver clears both entries: one resolved return each, none left.
    const entries = findFunctionEntries(code, cfg);
    const transfer = entries.find((entry) => entry.selector === TRANSFER);
    const transferFrom = entries.find((entry) => entry.selector === TRANSFER_FROM);
    if (transfer === undefined || transferFrom === undefined) {
      throw new Error("expected both entries to resolve");
    }
    for (const entry of [transfer, transferFrom]) {
      const reach = resolveEntryReachV2(cfg, entry.entryBlock);
      expect(reach.resolvedJumpAtPc).toEqual([fixture.sharedJumpPc]);
      expect(reach.unresolvedJumpAtPc).toEqual([]);
    }

    // v2 regions of both entries contain the shared body; each entry alone
    // holds its own post-call gate, and the single holder stays empty for
    // the shared body.
    const v2 = attributeFunctions(code, { mode: "v2" });
    expect(v2.holdersOf(fixture.sharedPc)).toEqual([TRANSFER_FROM, TRANSFER]);
    expect(v2.holderOf(fixture.sharedPc)).toBe(null);
    expect(v2.holdersOf(fixture.ret1GatePc)).toEqual([TRANSFER]);
    expect(v2.holdersOf(fixture.ret2GatePc)).toEqual([TRANSFER_FROM]);
    expect(v2.holdersOf(fixture.fallbackPc)).toEqual([]);
  });

  test("p10_v1_stays_default_and_byte_identical", () => {
    const fixture = sharedReturnFixture();
    const code = bytecodeOf(fixture.hex);
    const fallback = attributeFunctions(code);
    const explicit = attributeFunctions(code, { mode: "v1" });
    const pcs = disassemble(code).map((instruction) => instruction.pc);
    expect(pcs.length).toBeGreaterThan(0);
    // The default call and the explicit v1 call agree everywhere, and v1
    // holders mirror the single holder: gates and the shared body belong
    // to no function.
    for (const pc of pcs) {
      expect(explicit.holderOf(pc)).toBe(fallback.holderOf(pc));
      expect(explicit.holdersOf(pc)).toEqual(fallback.holdersOf(pc));
      const single = fallback.holderOf(pc);
      expect(fallback.holdersOf(pc)).toEqual(single === null ? [] : [single]);
    }
    expect(fallback.holderOf(fixture.ret1GatePc)).toBe(null);
    expect(fallback.holderOf(fixture.ret2GatePc)).toBe(null);
    expect(fallback.holderOf(fixture.sharedPc)).toBe(null);
    expect(fallback.holdersOf(fixture.ret1GatePc)).toEqual([]);
    // v2 is a strict superset of v1: every v1 holder stays a v2 holder.
    const v2 = attributeFunctions(code, { mode: "v2" });
    for (const pc of pcs) {
      const single = fallback.holderOf(pc);
      if (single !== null) {
        expect(v2.holdersOf(pc)).toContain(single);
      }
    }
  });

  test("p10_v2_cap_leaves_overflow_unresolved", () => {
    const fixture = cappedFixture();
    const code = bytecodeOf(fixture.hex);
    const cfg = buildCfg(lift(code));
    const entryBlock = cfg.blocks.find((block) => block.range.startPc === fixture.entryPc);
    if (entryBlock === undefined) {
      throw new Error("expected an entry block");
    }
    const reach = resolveEntryReachV2(cfg, entryBlock.index);
    expect(reach.resolvedJumpAtPc).toEqual([]);
    expect(reach.unresolvedJumpAtPc).toEqual([fixture.sharedJumpPc]);
    expect(reach.cappedJumpAtPc).toEqual([]);
  });
});

type SharedGateFixture = {
  readonly hex: string;
  readonly loadPc: number;
  readonly storePc: number;
  readonly sharedJumpPc: number;
};

// Owner-control shape over the session 1 return pattern: both entries
// carry an onlyOwner guard over slot 0, then call a shared `_transfer`
// that holds a slot-7 gate (SLOAD beside ADD, SSTORE of the same slot)
// and returns through a dynamic JUMP. Return continuations are bare
// halts, so the only slot-7 facts live in the shared body.
function sharedGateFixture(): SharedGateFixture {
  const asm = new Asm();
  asm.op(0x80).push4("a9059cbb").op(0x14);
  asm.pushLabel2("transferEntry").op(0x57);
  asm.op(0x80).push4("23b872dd").op(0x14);
  asm.pushLabel2("transferFromEntry").op(0x57);
  asm.label("fallback");
  asm.op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("transferEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("transferOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("transferOk").op(0x5b);
  asm.pushLabel2("ret1");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("transferFromEntry").op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("transferFromOk").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("transferFromOk").op(0x5b);
  asm.pushLabel2("ret2");
  asm.pushLabel2("shared");
  asm.op(0x56);
  asm.label("shared");
  asm.op(0x5b);
  asm.push1(0x07);
  const loadPc = asm.pc;
  asm.op(0x54);
  asm.push1(0x01).op(0x01);
  asm.push1(0x01).push1(0x07);
  const storePc = asm.pc;
  asm.op(0x55);
  const sharedJumpPc = asm.pc;
  asm.op(0x56);
  asm.op(0xfe);
  asm.label("ret1").op(0x5b, 0x00);
  asm.label("ret2").op(0x5b, 0x00);
  return { hex: asm.build(), loadPc, storePc, sharedJumpPc };
}

// Two sequential internal calls through one helper (F-17): entry calls f
// and continues at ret1, ret1 calls f again and continues at ret2, and
// only ret2 holds the gate. The resolver must keep adding late return
// continuations for the already-resolved return jump, so ret2 and its
// gate stay reachable from the entry. Synthetic bytecode only.
function secondCallFixture(): {
  readonly hex: string;
  readonly entryPc: number;
  readonly ret2Pc: number;
  readonly okPc: number;
  readonly sharedJumpPc: number;
  readonly storePc: number;
} {
  const asm = new Asm();
  asm.op(0x80).push4("12345678").op(0x14);
  asm.pushLabel2("entry").op(0x57);
  asm.label("fallback");
  asm.op(0x5b).push1(0x00).op(0x80, 0xfd);
  asm.label("entry");
  const entryPc = asm.pc;
  asm.op(0x5b);
  asm.pushLabel2("ret1");
  asm.pushLabel2("f");
  asm.op(0x56);
  asm.label("ret1");
  asm.op(0x5b);
  asm.pushLabel2("ret2");
  asm.pushLabel2("f");
  asm.op(0x56);
  asm.label("ret2");
  const ret2Pc = asm.pc;
  asm.op(0x5b);
  asm.op(0x33).push1(0x00).op(0x54, 0x14);
  asm.pushLabel2("ok").op(0x57);
  asm.push1(0x00).op(0x80, 0xfd);
  asm.label("ok");
  const okPc = asm.pc;
  asm.op(0x5b);
  asm.push1(0x01).push1(0x02);
  const storePc = asm.pc;
  asm.op(0x55, 0x00);
  asm.label("f");
  asm.op(0x5b);
  asm.push1(0x01).op(0x50);
  const sharedJumpPc = asm.pc;
  asm.op(0x56);
  asm.op(0xfe);
  return { hex: asm.build(), entryPc, ret2Pc, okPc, sharedJumpPc, storePc };
}

describe("reachability v2 late continuations", () => {
  test("c18_second_call_to_same_helper_reaches_continuation", () => {
    const fixture = secondCallFixture();
    const code = bytecodeOf(fixture.hex);
    const cfg = buildCfg(lift(code));
    const entryBlock = cfg.blocks.find((block) => block.range.startPc === fixture.entryPc);
    if (entryBlock === undefined) {
      throw new Error("expected an entry block");
    }
    const blockIndexOf = (pc: number): number => {
      const found = cfg.blocks.find((block) => block.range.startPc === pc);
      if (found === undefined) {
        throw new Error(`expected a block at pc ${pc}`);
      }
      return found.index;
    };
    const reach = resolveEntryReachV2(cfg, entryBlock.index);
    expect(reach.resolvedJumpAtPc).toEqual([fixture.sharedJumpPc]);
    expect(reach.unresolvedJumpAtPc).toEqual([]);
    expect(reach.reachedBlocks.has(blockIndexOf(fixture.ret2Pc))).toBe(true);
    expect(reach.reachedBlocks.has(blockIndexOf(fixture.okPc))).toBe(true);
    const selector = mustOk(Selector.parse("0x12345678"));
    const v2 = attributeFunctions(code, { mode: "v2" });
    expect(v2.holdersOf(fixture.storePc)).toContain(selector);
  });
});

describe("reachability v2 in owner control", () => {
  test("p10_v2_ownerControl_finds_shared_gate", () => {
    const fixture = sharedGateFixture();
    const code = bytecodeOf(fixture.hex);
    const v1 = analyzeOwnerControl(code);
    const v2 = analyzeOwnerControl(code, { reach: "v2" });

    // The entry guards prove identically in both modes: slot 0 owns both
    // entries and both entries stay privileged.
    for (const view of [v1, v2]) {
      expect(view.ownerSlot).toBe(0);
      expect([...view.privileged].sort()).toEqual([TRANSFER, TRANSFER_FROM].sort());
      expect([...view.transfers].sort()).toEqual([TRANSFER, TRANSFER_FROM].sort());
    }

    for (const selector of [TRANSFER, TRANSFER_FROM]) {
      const first = regionBySelector(v1, selector);
      const second = regionBySelector(v2, selector);
      if (first === undefined || second === undefined) {
        throw new Error(`expected a region for ${selector}`);
      }
      // v1 never follows the shared return: no slot-7 facts, no proof.
      expect(first.stores).toEqual([]);
      expect(first.loads.every((load) => load.slot.kind !== "const" || load.slot.value !== 7)).toBe(true);
      expect(constSlotLoadNearFlavor(first, 7, ["add"])).toBe(null);
      // v2 attributes the shared body to both entries: the gate proves.
      expect(second.stores.map((store) => store.pc)).toContain(fixture.storePc);
      const sharedStore = second.stores.find((store) => store.pc === fixture.storePc);
      expect(sharedStore?.slot).toEqual({ kind: "const", value: 7 });
      expect(second.loads.map((load) => load.pc)).toContain(fixture.loadPc);
      const proof = constSlotLoadNearFlavor(second, 7, ["add"]);
      expect(proof).not.toBe(null);
      expect(proof?.loadPc).toBe(fixture.loadPc);
    }

    // Diagnostics for later display: one unresolved return in v1, none
    // left after the v2 resolver settles both entries.
    expect(diagnoseReachability(code)).toEqual({ entries: 2, v1UnresolvedJumps: 1, v2UnresolvedJumps: 0 });
    const cfg = buildCfg(lift(code));
    expect(cfg.unresolvedJumps.map((jump) => jump.atPc)).toEqual([fixture.sharedJumpPc]);
  });

  test("p10_v1_ownerControl_default_byte_identical", () => {
    const fixture = sharedGateFixture();
    const code = bytecodeOf(fixture.hex);
    // The default call and the explicit v1 call agree bit for bit, so the
    // scored detector path is untouched by the v2 wiring.
    expect(analyzeOwnerControl(code)).toEqual(analyzeOwnerControl(code, { reach: "v1" }));
    expect(analyzeOwnerControl(code)).toEqual(analyzeOwnerControl(code, {}));
  });
});

describe("reachability v2 callee-entry exclusion (SCAN-R)", () => {
  test("scanr_return_never_lands_on_a_callee_entry", () => {
    // One entry calls a shared helper that returns through a dynamic
    // JUMP; the helper also carries a stray push naming a second
    // function that another entry calls as a proven internal callee.
    // A return can only continue at a caller-pushed return address,
    // never at a callee entry, so the callee block stays out of the
    // first entry's reach while its own continuation joins it.
    const asm = new Asm();
    asm.op(0x80).push4("a9059cbb").op(0x14);
    asm.pushLabel2("transferEntry").op(0x57);
    asm.op(0x80).push4("23b872dd").op(0x14);
    asm.pushLabel2("transferFromEntry").op(0x57);
    asm.op(0x80).push4("11111111").op(0x14);
    asm.pushLabel2("calleeEntry").op(0x57);
    asm.label("fallback");
    asm.op(0x5b).push1(0x00).op(0x80, 0xfd);
    asm.label("transferEntry").op(0x5b);
    asm.pushLabel2("ret1");
    asm.pushLabel2("shared");
    asm.op(0x56);
    asm.label("ret1");
    const ret1Pc = asm.pc;
    asm.op(0x5b, 0x00);
    asm.label("transferFromEntry").op(0x5b);
    asm.pushLabel2("ret2");
    asm.pushLabel2("calleeEntry");
    asm.op(0x56);
    asm.label("ret2");
    asm.op(0x5b, 0x00);
    asm.label("calleeEntry");
    const calleePc = asm.pc;
    asm.op(0x5b, 0x00);
    asm.label("shared");
    asm.op(0x5b);
    asm.pushLabel2("calleeEntry");
    asm.op(0x50);
    const sharedJumpPc = asm.pc;
    asm.op(0x56);
    asm.op(0xfe);
    const code = bytecodeOf(asm.build());
    const cfg = buildCfg(lift(code));
    const entries = findFunctionEntries(code, cfg);
    const transfer = entries.find((entry) => entry.selector === TRANSFER);
    if (transfer === undefined) {
      throw new Error("expected the transfer entry to resolve");
    }
    const blockIndexOf = (pc: number): number => {
      const block = cfg.blocks.find((candidate) => candidate.range.startPc === pc);
      if (block === undefined) {
        throw new Error(`expected a block starting at ${pc}`);
      }
      return block.index;
    };
    const reach = resolveEntryReachV2(cfg, transfer.entryBlock);
    expect(reach.resolvedJumpAtPc).toEqual([sharedJumpPc]);
    expect(reach.reachedBlocks.has(blockIndexOf(ret1Pc))).toBe(true);
    expect(reach.reachedBlocks.has(blockIndexOf(calleePc))).toBe(false);
  });

  test("unreachable callee triple cannot hide a real return destination", () => {
    const asm = new Asm();
    asm.op(0x80).push4("a9059cbb").op(0x14);
    asm.pushLabel2("transferEntry").op(0x57);
    asm.label("fallback");
    asm.op(0x5b).push1(0x00).op(0x80, 0xfd);
    asm.label("transferEntry").op(0x5b);
    asm.pushLabel2("ret1");
    asm.pushLabel2("shared");
    asm.op(0x56);
    asm.label("ret1");
    const ret1Pc = asm.pc;
    asm.op(0x5b, 0x00);
    asm.label("shared");
    asm.op(0x5b);
    asm.push1(0x01).op(0x50);
    const sharedJumpPc = asm.pc;
    asm.op(0x56);
    asm.op(0xfe);
    // Unreachable: PUSH 0, PUSH ret1, JUMP names ret1 as a callee.
    asm.label("dead").op(0x5b);
    asm.push1(0x00);
    asm.pushLabel2("ret1");
    asm.op(0x56);
    const code = bytecodeOf(asm.build());
    const cfg = buildCfg(lift(code));
    const entries = findFunctionEntries(code, cfg);
    const transfer = entries.find((entry) => entry.selector === TRANSFER);
    if (transfer === undefined) throw new Error("expected transfer entry");
    const blockIndexOf = (pc: number): number => {
      const block = cfg.blocks.find((candidate) => candidate.range.startPc === pc);
      if (block === undefined) throw new Error(`expected block at ${pc}`);
      return block.index;
    };
    const reach = resolveEntryReachV2(cfg, transfer.entryBlock);
    expect(reach.resolvedJumpAtPc).toEqual([sharedJumpPc]);
    expect(reach.reachedBlocks.has(blockIndexOf(ret1Pc))).toBe(true);
  });
});
