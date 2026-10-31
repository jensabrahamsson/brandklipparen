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
import type { Selector } from "../../../src/domain/types.ts";
import { Asm } from "../../helpers/evmAsm.ts";

const TRANSFER = "0xa9059cbb";
const TRANSFER_FROM = "0x23b872dd";

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

// Seventeen JUMPDEST constants visible from one entry: sixteen dead
// targets plus the shared helper. The shared return stays unresolved past
// the per-jump cap of sixteen.
function cappedFixture(): { hex: string; entryPc: number; sharedJumpPc: number } {
  const asm = new Asm();
  asm.label("entry");
  const entryPc = asm.pc;
  asm.op(0x5b);
  const dead: string[] = [];
  for (let index = 1; index <= 16; index += 1) {
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
      const first = regionBySelector(v1, selector as Selector);
      const second = regionBySelector(v2, selector as Selector);
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
