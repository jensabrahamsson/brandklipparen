// Blacklist detector plugin `dev.brandklipparen.blacklist` (S-115, P-12
// step 1, P-11 extended analysis). First-party detector behind the
// registry: proves an owner-controlled transfer gate from code paths. A
// finding needs both: a transfer path that reads a mapping entry beside
// an equality compare (or an ISZERO with no range compare between the
// load and the gate, so a plain balance check `balance >= amount` or an
// allowance check never counts) with a conditional jump that can revert,
// and a privileged region (a caller guard) that writes a mapping slot.
// The written mapping and the gated mapping must hash the same base
// slot, so a setter for one mapping beside a gate on another never
// counts. The two may share one merged function. A gated read with no privileged
// writer, or a privileged mapping write the transfer path never gates on,
// stays silent: the proof is incomplete, so no positive finding is
// reported. When the v1 proof finds nothing, the same proof re-runs on
// the v2 reachability view (a shared `_beforeTokenTransfer` helper joins
// every entry that reaches it) and emits a weight-0 `fact` finding with
// `proof: "extended"` that never converts to a signal. Pure and
// synchronous: this module imports solely the plugin API and domain types
// and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import {
  TRANSFER_FROM_SELECTOR,
  TRANSFER_SELECTOR,
  analyzeOwnerControl,
  compoundPrivilegedGate,
  exprMappingBase,
  flavorBetween,
  hasRevertingGateAfter,
  hasRevertingSide,
  interpretRegionExprs,
  interpretRegionSlots,
  isStandardTokenWriter,
  mappingBaseNearAccess,
  mappingLoadNearFlavor,
  ownerCheckVia,
  packedMappingGateExpr,
  packedMappingGateShift,
  privilegedGuardKind,
  sideCanReachRevert,
} from "../../../domain/ownerControl.ts";
import type { Expr, RegionFacts, SlotLookup } from "../../../domain/ownerControl.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import { disassemble, extractSelectors } from "../../../domain/selectors.ts";
import type { Selector as SelectorType } from "../../../domain/types.ts";
import { PcOffset } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.blacklist";

// Output schema descriptor for the finding list (ADR section 3.3): the
// draft-07 subset the registry documents. The contract suite checks the
// typed output and this descriptor against each other in both directions.
const OUTPUT_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 4,
  items: Object.freeze({
    type: "object",
    required: Object.freeze(["id", "pluginId", "title", "payload", "evidence"]),
    properties: Object.freeze({
      id: Object.freeze({ type: "string", minLength: 1 }),
      pluginId: Object.freeze({ const: PLUGIN_ID }),
      title: Object.freeze({ type: "string", minLength: 1 }),
      payload: Object.freeze({
        type: "object",
        required: Object.freeze([]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "blacklist" }),
          fact: Object.freeze({ const: "blacklist" }),
          proof: Object.freeze({ const: "extended" }),
        }),
        additionalProperties: false,
      }),
      evidence: Object.freeze({
        type: "array",
        minItems: 1,
        items: Object.freeze({
          type: "object",
          required: Object.freeze(["selector"]),
          properties: Object.freeze({
            selector: Object.freeze({ type: "string", minLength: 1 }),
            offset: Object.freeze({ type: Object.freeze(["integer", "null"]), minimum: 0 }),
          }),
          additionalProperties: false,
        }),
      }),
    }),
    additionalProperties: false,
  }),
});

function manifestOf(): DetectorPlugin["manifest"] {
  const parsed = PluginManifest.parse({
    id: PLUGIN_ID,
    version: "1.0.0",
    kind: "detector",
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Blacklist detector",
    description: "Reports a transfer gate on a mapping entry that a privileged caller can set.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`blacklist plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`blacklist plugin manifest carries kind ${parsed.value.kind}, expected detector`);
  }
  return parsed.value;
}

function toNonEmpty(items: EvidenceType[]): NonEmpty<EvidenceType> | null {
  const first = items[0];
  if (first === undefined) {
    return null;
  }
  return Object.freeze([first, ...items.slice(1)]) as NonEmpty<EvidenceType>;
}

function evidenceFor(
  bytecode: DetectorInput["bytecode"],
  selector: EvidenceType["selector"],
  pc: number,
): EvidenceType | null {
  const offset = PcOffset.of(pc, bytecode);
  if (!offset.ok) {
    return null;
  }
  const created = Evidence.create({ selector, offset: offset.value });
  return created.ok ? created.value : null;
}

// A transfer gate on a mapping entry: the mapping load sits beside an
// equality compare, or beside an ISZERO with no range compare between the
// load and the gate, plus a conditional jump that can revert. A balance
// check (`balances[from] >= amount`) or an allowance check compiles to a
// range compare closed by ISZERO, so ISZERO counts only when no LT or GT
// sits between the load and the gate. The mapping hash marks the read as
// an address-keyed lookup rather than a plain slot read.
function gatedMappingRead(region: RegionFacts): number | null {
  if (!region.hasKeccak || !region.hasJumpi || !region.hasRevert) {
    return null;
  }
  const eqProof = mappingLoadNearFlavor(region, ["eq"]);
  if (eqProof !== null) {
    return eqProof.loadPc;
  }
  const zeroProof = mappingLoadNearFlavor(region, ["iszero"]);
  if (zeroProof === null) {
    return null;
  }
  if (flavorBetween(region, ["lt", "gt"], zeroProof.loadPc, zeroProof.gatePc)) {
    return null;
  }
  return zeroProof.loadPc;
}

// Privileged mapping write proof over the frozen input. Total: arbitrary
// bytecode yields a finding list, never an exception. Deterministic:
// regions scan in selector order and the single finding names the first
// provable pair. Bytecode without selectors yields no findings, since a
// finding without selector evidence is unrepresentable. The written
// mapping and the gated mapping must hash the same base slot (unknown on
// either side stays silent), so a privileged setter for one mapping
// paired with a gate on another never proves a list.
function detectV1(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode);
  const view = analyzeOwnerControl(input.bytecode);
  const code = disassemble(input.bytecode);
  const privilegedSet = new Set(view.privileged);
  const transferSet = new Set(view.transfers);
  for (const region of view.regions) {
    if (!privilegedSet.has(region.selector)) {
      continue;
    }
    const write = region.stores.find((store) => store.slot.kind === "mapping");
    if (write === undefined) {
      continue;
    }
    const writeMember = (pc: number): boolean =>
      attribution.holdersOf(pc).includes(region.selector);
    const orderedTransfers = [...transferSet].sort();
    orderedTransfers.sort((left, right) => {
      const leftSame = left === region.selector ? 1 : 0;
      const rightSame = right === region.selector ? 1 : 0;
      if (leftSame !== rightSame) {
        return leftSame - rightSame;
      }
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    });
    for (const transferSelector of orderedTransfers) {
      const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
      if (transfer === undefined) {
        continue;
      }
      const gatePc = gatedMappingRead(transfer);
      if (gatePc === null) {
        continue;
      }
      const gateMember = (pc: number): boolean => attribution.holdersOf(pc).includes(transferSelector);
      const writeBase = mappingBaseNearAccess(code, writeMember, write.pc);
      const gateBase = mappingBaseNearAccess(code, gateMember, gatePc);
      if (writeBase === null || gateBase === null || writeBase !== gateBase) {
        continue;
      }
      const holder = attribution.holderOf(write.pc);
      const gateHolder = attribution.holderOf(gatePc);
      if (holder === null || gateHolder === null) {
        continue;
      }
      const evidence: EvidenceType[] = [];
      const written = evidenceFor(input.bytecode, holder, write.pc);
      if (written !== null) {
        evidence.push(written);
      }
      const gate = evidenceFor(input.bytecode, gateHolder, gatePc);
      if (gate !== null) {
        evidence.push(gate);
      }
      const nonEmpty = toNonEmpty(evidence);
      if (nonEmpty === null) {
        continue;
      }
      return Object.freeze([
        Object.freeze({
          id: `${PLUGIN_ID}:blacklist`,
          pluginId: MANIFEST.id,
          title: "Privileged caller can set a mapping entry that gates the transfer path",
          evidence: nonEmpty,
          payload: Object.freeze({ feature: "blacklist" }),
        }),
      ]);
    }
  }
  return Object.freeze([]);
}

// Extended gate proof (P-11 session 1 follow-up): the mapping read beside
// a compare, with the compare PC so the caller can prove the blocked side
// reverts. Kept beside `gatedMappingRead` (which the scored path owns)
// so the v1 proof never changes. Exported for the extended-proof
// diagnostics beside the detectors, which re-run the same search to
// explain a missing fact.
export function gatedMappingReadPrecise(region: RegionFacts): { readonly loadPc: number; readonly cmpPc: number } | null {
  if (!region.hasKeccak || !region.hasJumpi || !region.hasRevert) {
    return null;
  }
  const eqProof = mappingLoadNearFlavor(region, ["eq"]);
  if (eqProof !== null) {
    return Object.freeze({ loadPc: eqProof.loadPc, cmpPc: eqProof.gatePc });
  }
  const zeroProof = mappingLoadNearFlavor(region, ["iszero"]);
  if (zeroProof === null) {
    return null;
  }
  if (flavorBetween(region, ["lt", "gt"], zeroProof.loadPc, zeroProof.gatePc)) {
    return null;
  }
  return Object.freeze({ loadPc: zeroProof.loadPc, cmpPc: zeroProof.gatePc });
}

// Whether a jump condition reads a mapping entry on the given base:
// the condition subtree holds an SLOAD whose slot hashes that base. A
// fee-exempt read branches around another check (a limit or a trading
// flag), so the reverting jump there tests that other value, never the
// exempt entry: only a reverting jump whose own condition reads the
// written entry proves the entry blocks the transfer.
function condReferencesMappingBase(cond: Expr | undefined, base: number): boolean {
  if (cond === undefined || cond.kind === "unknown") {
    return false;
  }
  if (cond.kind === "sload") {
    return exprMappingBase(cond.slot) === base || condReferencesMappingBase(cond.slot, base);
  }
  if (cond.kind === "keccak") {
    return cond.words.some((word) => condReferencesMappingBase(word, base));
  }
  if (cond.kind === "calldata") {
    return condReferencesMappingBase(cond.offset, base);
  }
  if (cond.kind === "op") {
    return cond.args.some((arg) => condReferencesMappingBase(arg, base));
  }
  return false;
}

// First member JUMPI past `afterPc` whose fall side reverts and whose
// own condition reads a mapping entry on `base`, or null. Mirrors the
// legacy gate scan, tightened so a nearby revert on another value (a
// limit compare or a trading flag past an exemption branch) never
// proves a blacklist gate.
function revertingMappingGatePc(
  bytecode: DetectorInput["bytecode"],
  code: ReturnType<typeof disassemble>,
  gateMember: (pc: number) => boolean,
  jumpis: ReadonlyMap<number, Expr>,
  afterPc: number,
  base: number,
): number | null {
  for (const candidate of code) {
    if (!gateMember(candidate.pc) || candidate.opcode !== 0x57) {
      continue;
    }
    if (candidate.pc <= afterPc || candidate.pc > afterPc + 64) {
      continue;
    }
    if (!hasRevertingSide(bytecode, code, gateMember, candidate.pc, "fall")) {
      continue;
    }
    if (condReferencesMappingBase(jumpis.get(candidate.pc), base)) {
      return candidate.pc;
    }
  }
  return null;
}

// Writer guard for extended analysis (SCAN-2): the proven owner check,
// a role-slot or auth-mapping guard, or a compound owner-or-role gate.
// Writers behind a shared check helper never reduce to one beside-window
// caller compare, so all three proofs get their chance.
function writerGuarded(
  code: ReturnType<typeof disassemble>,
  member: (pc: number) => boolean,
  ownerSlot: number | null,
  slotOf: SlotLookup,
  jumpis: ReadonlyMap<number, Expr>,
  bytecode: DetectorInput["bytecode"],
): boolean {
  if (ownerSlot !== null && ownerCheckVia(code, member, ownerSlot, slotOf, jumpis, bytecode) !== null) {
    return true;
  }
  if (privilegedGuardKind(code, member, ownerSlot, slotOf, jumpis, bytecode) !== null) {
    return true;
  }
  return compoundPrivilegedGate(code, member, ownerSlot, jumpis, bytecode);
}

// Whether a jump condition bool-gates on a mapping entry of `base`: a
// load of that base read as a boolean (under ISZERO, AND, OR, NOT or an
// equality), never priced through an amount compare or arithmetic. A
// balance or fee value flowing through LT, GT, MUL, ADD or SUB is a
// comparison over amounts, not a list gate.
function condBoolGatesOnBase(cond: Expr | undefined, base: number): boolean {
  if (cond === undefined || cond.kind === "unknown") {
    return false;
  }
  const priced = (expr: Expr): boolean => {
    if (expr.kind === "op" && ["LT", "GT", "SLT", "SGT", "MUL", "ADD", "SUB", "MOD"].includes(expr.name)) {
      return expr.args.some((arg) => condReferencesMappingBase(arg, base) || priced(arg));
    }
    if (expr.kind === "calldata") {
      return priced(expr.offset);
    }
    if (expr.kind === "sload") {
      return priced(expr.slot);
    }
    if (expr.kind === "keccak") {
      return expr.words.some((word) => priced(word));
    }
    if (expr.kind === "op") {
      return expr.args.some((arg) => priced(arg));
    }
    return false;
  };
  if (priced(cond)) {
    return false;
  }
  return condReferencesMappingBase(cond, base);
}

// The side of a gate jump taken while the gated entry reads set: the
// ISZERO parity on the path to the entry load names it (an odd count
// jumps while the entry reads clear, so the set side falls through).
function mappingTruthySide(cond: Expr, base: number): "jump" | "fall" | null {
  const search = (expr: Expr, parity: number): number | null => {
    if (expr.kind === "sload") {
      return exprMappingBase(expr.slot) === base ? parity : null;
    }
    const childParity = expr.kind === "op" && expr.name === "ISZERO" ? parity + 1 : parity;
    if (expr.kind === "calldata") {
      return search(expr.offset, childParity);
    }
    if (expr.kind === "keccak") {
      for (const word of expr.words) {
        const found = search(word, childParity);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    if (expr.kind === "op") {
      for (const arg of expr.args) {
        const found = search(arg, childParity);
        if (found !== null) {
          return found;
        }
      }
    }
    return null;
  };
  const parity = search(cond, 0);
  if (parity === null) {
    return null;
  }
  return parity % 2 === 1 ? "fall" : "jump";
}

// Mapping base from an adjacent scratch word pair beside a gate hash
// (SCAN-2, extended only): the hash may sit on any constant scratch
// pair, not only the usual 0x00/0x20 layout. The second word of the
// pair must be a constant push, and every pattern instruction must
// belong to the gate region. Exported for the extended-proof
// diagnostics, which mirror this proof.
export function scratchPairBase(
  code: ReturnType<typeof disassemble>,
  isMember: (pc: number) => boolean,
  loadPc: number,
): number | null {
  const pushConst = (insn: { opcode: number; immediate?: Uint8Array }): number | null => {
    if (insn.opcode === 0x5f) {
      return 0;
    }
    if (insn.opcode < 0x60 || insn.opcode > 0x7f || insn.immediate === undefined) {
      return null;
    }
    let value = 0;
    for (const byte of insn.immediate) {
      value = value * 256 + byte;
    }
    return value;
  };
  let loadIndex = -1;
  for (let at = 0; at < code.length; at += 1) {
    if (code[at]?.pc === loadPc) {
      loadIndex = at;
      break;
    }
  }
  if (loadIndex < 0) {
    return null;
  }
  let keccakIndex = -1;
  for (let back = loadIndex - 1, steps = 0; back >= 0 && steps < 40; back -= 1, steps += 1) {
    const candidate = code[back];
    if (candidate !== undefined && candidate.opcode === 0x20 && isMember(candidate.pc)) {
      keccakIndex = back;
      break;
    }
  }
  if (keccakIndex < 0) {
    return null;
  }
  const stores = new Map<number, number | null>();
  for (let at = keccakIndex - 1, steps = 0; at >= 0 && steps < 40; at -= 1, steps += 1) {
    const candidate = code[at];
    if (candidate === undefined || candidate.opcode !== 0x52 || !isMember(candidate.pc)) {
      continue;
    }
    // The destination and value pushes may be separated from the
    // MSTORE by stack shuffles (PUSH 0x00, SWAP1, DUP2, MSTORE stores
    // the key at scratch 0): collect constant pushes backward over
    // DUP and SWAP only, nearest push first. The nearest collected
    // push is the store destination, the next one its value.
    const collected: number[] = [];
    for (let back = at - 1, inner = 0; back >= 0 && inner < 6; back -= 1, inner += 1) {
      const item = code[back];
      if (item === undefined) {
        break;
      }
      if (item.opcode >= 0x80 && item.opcode <= 0x9f) {
        continue;
      }
      const constant = pushConst(item);
      if (constant === null) {
        break;
      }
      collected.push(constant);
      if (collected.length >= 2) {
        break;
      }
    }
    const dest = collected[0];
    if (dest !== undefined && !stores.has(dest)) {
      stores.set(dest, collected[1] ?? null);
    }
  }
  for (const dest of stores.keys()) {
    const second = stores.get(dest + 0x20);
    if (second !== undefined && second !== null) {
      return second;
    }
  }
  return null;
}

// First member JUMPI whose condition bool-gates on `base` with a
// reverting side, or null (SCAN-2): the enforce-style gate jumps
// straight to its revert block while the entry reads set, with no
// ISZERO beside the load for the beside-window proof to pair with.
// A short-circuit gate reverts only down one continuation of the set
// side, so that side may instead prove by reaching a revert.
export function exprMappingGatePc(
  bytecode: DetectorInput["bytecode"],
  code: ReturnType<typeof disassemble>,
  gateMember: (pc: number) => boolean,
  jumpis: ReadonlyMap<number, Expr>,
  base: number,
): number | null {
  const ordered = [...jumpis.entries()].sort((left, right) => left[0] - right[0]);
  for (const [pc, cond] of ordered) {
    if (!gateMember(pc) || !condBoolGatesOnBase(cond, base)) {
      continue;
    }
    if (
      hasRevertingSide(bytecode, code, gateMember, pc, "fall") ||
      hasRevertingSide(bytecode, code, gateMember, pc, "jump")
    ) {
      return pc;
    }
    const truthySide = mappingTruthySide(cond, base);
    if (truthySide !== null && sideCanReachRevert(bytecode, pc, truthySide)) {
      return pc;
    }
  }
  return null;
}

// Extended analysis (P-11, weight-0 fact): the mapping-gate proof over
// the v2 reachability view, where a shared `_beforeTokenTransfer` helper
// joins every entry that reaches it, tightened so plain token mechanics
// never prove a list. The writer must carry a caller check against the
// proven owner slot (never a standard token entry, never an unguarded
// function), the writer mapping and the gate mapping must hash the same
// base slot (unknown on either side stays silent), and the gate must sit
// on a transfer/transferFrom path whose blocked side reverts. It runs
// only when the v1 proof found nothing, so a scored finding always wins
// and the extended finding never shadows it. The payload carries `fact`
// (never `feature`) with `proof: "extended"`, so the finding never
// converts to a signal and stays at weight 0. The title mirrors the
// 1.1.0 origin sentence for blacklist (see `ORIGIN_SENTENCE` in
// src/domain/explain.ts) with the not-in-score marker; it names no
// account, so no changer is claimed without the P-2 ownership proof.
function detectExtended(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode, { mode: "v2" });
  const view = analyzeOwnerControl(input.bytecode, { reach: "v2" });
  const ownerSlot = view.ownerSlot;
  const code = disassemble(input.bytecode);
  const memberOf = (selector: SelectorType): ((pc: number) => boolean) => {
    return (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
  };
  for (const region of view.regions) {
    if (isStandardTokenWriter(region.selector)) {
      continue;
    }
    const writerMember = memberOf(region.selector);
    // The v2 interpreter proves the writer slot through DUP/SWAP chains
    // and expression matching, preferring its mapping base over the
    // window scan with the window as the fallback.
    const writerSlots = interpretRegionSlots(input.bytecode, region.selector);
    const writerSlotOf: SlotLookup = (pc) => writerSlots.get(pc);
    const writerExprs = interpretRegionExprs(input.bytecode, region.selector);
    if (!writerGuarded(code, writerMember, ownerSlot, writerSlotOf, writerExprs.jumpis, input.bytecode)) {
      continue;
    }
    for (const write of region.stores) {
      if (write.slot.kind !== "mapping") {
        continue;
      }
      const exprBase = exprMappingBase(writerExprs.stores.get(write.pc)?.slot);
      const windowBase = mappingBaseNearAccess(code, writerMember, write.pc, writerSlotOf);
      const writeBase = exprBase ?? windowBase;
      if (writeBase === null || writeBase === undefined) {
        continue;
      }
      const transferSelectors = [TRANSFER_SELECTOR, TRANSFER_FROM_SELECTOR]
        .filter((selector) => selector !== region.selector)
        .sort();
      for (const transferSelector of transferSelectors) {
        const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
        if (transfer === undefined) {
          continue;
        }
        const gateMember = memberOf(transferSelector);
        const gateSlots = interpretRegionSlots(input.bytecode, transferSelector);
        const gateSlotOf: SlotLookup = (pc) => gateSlots.get(pc);
        const transferExprs = interpretRegionExprs(input.bytecode, transferSelector);
        // The beside-window gate first, so every pair the scored-adjacent
        // proof already proves keeps its load and compare PCs bit for bit.
        // The reverting jump must test the gated entry itself: a mapping
        // read that only exempts the holder from a later check (fees,
        // limits, a trading flag) branches around a revert on another
        // value, which never proves the entry blocks a transfer.
        let gateEvidencePc: number | null = null;
        const gate = gatedMappingReadPrecise(transfer);
        if (gate !== null) {
          const gateBase = mappingBaseNearAccess(code, gateMember, gate.loadPc, gateSlotOf);
          if (
            gateBase !== null &&
            gateBase === writeBase &&
            revertingMappingGatePc(
              input.bytecode,
              code,
              gateMember,
              transferExprs.jumpis,
              gate.cmpPc,
              writeBase,
            ) !== null
          ) {
            gateEvidencePc = gate.loadPc;
          }
        }
        if (gateEvidencePc === null && gate !== null) {
          // Window base pairing (SCAN-2): the beside gate bool-tests a
          // mapping entry whose hash the window pattern names on the
          // written base, even when the interpreter leaves the gate
          // slot unresolved (a scratch-offset hash, a merged walk).
          // The gate's own jump must still revert on its blocked side.
          const gateBase =
            mappingBaseNearAccess(code, gateMember, gate.loadPc, gateSlotOf) ??
            scratchPairBase(code, gateMember, gate.loadPc);
          const gateJumpi = code.find(
            (insn) =>
              insn.opcode === 0x57 &&
              gateMember(insn.pc) &&
              insn.pc > gate.cmpPc &&
              insn.pc <= gate.cmpPc + 64,
          );
          if (
            gateBase !== null &&
            gateBase === writeBase &&
            gateJumpi !== undefined &&
            hasRevertingSide(input.bytecode, code, gateMember, gateJumpi.pc, "fall")
          ) {
            gateEvidencePc = gate.loadPc;
          }
        }
        if (gateEvidencePc === null) {
          // Packed bool-in-mapping gate fallback: the expression matcher
          // runs first with the window matcher as the fallback. Real
          // packed reads span more than the beside window, so a gate the
          // window cannot see still proves when it reads the written
          // entry (same base) through a shift-and-mask read whose blocked
          // side reverts.
          const exprGate = packedMappingGateExpr(transferExprs.jumpis, gateMember);
          if (
            exprGate !== null &&
            exprGate.base === writeBase &&
            hasRevertingSide(input.bytecode, code, gateMember, exprGate.jumpiPc, "fall")
          ) {
            gateEvidencePc = exprGate.jumpiPc;
          }
        }
        if (gateEvidencePc === null) {
          // Window packed shift-and-mask fallback (P-11 follow-up).
          const packedGate = packedMappingGateShift(code, gateMember, gateSlotOf);
          if (
            packedGate !== null &&
            packedGate.base === writeBase &&
            hasRevertingGateAfter(input.bytecode, code, gateMember, packedGate.cmpPc)
          ) {
            gateEvidencePc = packedGate.loadPc;
          }
        }
        if (gateEvidencePc === null) {
          // Enforce-style expression gate (SCAN-2): a transfer jump whose
          // own condition bool-gates on the written base, reverting on
          // whichever side the blocked entry takes it to.
          gateEvidencePc = exprMappingGatePc(
            input.bytecode,
            code,
            gateMember,
            transferExprs.jumpis,
            writeBase,
          );
        }
        if (gateEvidencePc === null) {
          continue;
        }
        // Shared code belongs to every entry that reaches it, so the
        // single holder stays null there: fall back to the sorted holders
        // and prefer the transfer entry under proof.
        const holdersOfWrite = [...attribution.holdersOf(write.pc)].sort();
        const firstWriteHolder = holdersOfWrite[0] === undefined ? null : holdersOfWrite[0];
        const holder =
          attribution.holderOf(write.pc) ??
          (holdersOfWrite.includes(transferSelector) ? transferSelector : firstWriteHolder);
        const holdersOfGate = [...attribution.holdersOf(gateEvidencePc)].sort();
        const firstGateHolder = holdersOfGate[0] === undefined ? null : holdersOfGate[0];
        const gateHolder =
          attribution.holderOf(gateEvidencePc) ??
          (holdersOfGate.includes(transferSelector) ? transferSelector : firstGateHolder);
        if (holder === null || gateHolder === null) {
          continue;
        }
        const evidence: EvidenceType[] = [];
        const written = evidenceFor(input.bytecode, holder, write.pc);
        if (written !== null) {
          evidence.push(written);
        }
        const gateEvidence = evidenceFor(input.bytecode, gateHolder, gateEvidencePc);
        if (gateEvidence !== null) {
          evidence.push(gateEvidence);
        }
        const nonEmpty = toNonEmpty(evidence);
        if (nonEmpty === null) {
          continue;
        }
        return Object.freeze([
          Object.freeze({
            id: `${PLUGIN_ID}:blacklist-extended`,
            pluginId: MANIFEST.id,
            title:
              "The owner can stop chosen wallets from sending tokens. Found by extended analysis; not counted in the score.",
            evidence: nonEmpty,
            payload: Object.freeze({ fact: "blacklist", proof: "extended" }),
          }),
        ]);
      }
    }
  }
  return Object.freeze([]);
}

function detect(input: DetectorInput): readonly PluginFinding[] {
  const v1 = detectV1(input);
  if (v1.length > 0) {
    return v1;
  }
  return detectExtended(input);
}

const MANIFEST = manifestOf();

export const blacklistDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
