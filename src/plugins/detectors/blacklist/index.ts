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
  callGraphBodyPcs,
  compoundPrivilegedGate,
  exprMappingBase,
  flavorBetween,
  gateSideOutcomes,
  hasRevertingSide,
  hasRevertingSideBounded,
  interpretRegionExprs,
  interpretRegionSlots,
  isStandardTokenWriter,
  mappingBaseNearAccess,
  mappingLoadNearFlavor,
  nearestFlavorPc,
  ownerCheckVia,
  packedMappingGateExpr,
  packedMappingGateShift,
  privilegedGuardKind,
  sideCanReachRevertUnpriced,
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
      // The gate jump itself must test the gated entry (SCAN-4): a
      // mapping read that only branches around a later check on another
      // value (a fee exemption skipping a trading-flag or limit check)
      // sits beside the same ISZERO shape, but no jump that reverts on
      // the entry ever tests it, so the pair proves no list.
      const precise = gatedMappingReadPrecise(transfer);
      if (precise === null) {
        continue;
      }
      const transferExprs = interpretRegionExprs(input.bytecode, transferSelector);
      if (
        revertingMappingGatePc(input.bytecode, code, gateMember, transferExprs.jumpis, precise.cmpPc, writeBase) ===
          null &&
        exprMappingGatePc(input.bytecode, code, gateMember, transferExprs.jumpis, writeBase, transferExprs.loads) === null
      ) {
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
    if (!hasRevertingSideBounded(bytecode, gateMember, candidate.pc, "fall")) {
      continue;
    }
    const cond = jumpis.get(candidate.pc);
    if (!condReferencesMappingBase(cond, base)) {
      continue;
    }
    // Polarity (SCAN-B): a list blocks while its entry reads set, so the
    // reverting fall side must be the side taken while the entry is set.
    // A gate that reverts while the entry reads clear (a `require` on
    // `exempt`) is an allowlist shape, never a list, and stays silent here.
    const truthy = cond === undefined ? null : mappingTruthySide(cond, base);
    if (truthy === null || truthy === "fall") {
      return candidate.pc;
    }
  }
  return null;
}

// Writer guard for extended analysis (SCAN-2): the proven owner check,
// a role-slot or auth-mapping guard, or a compound owner-or-role gate.
// Writers behind a shared check helper never reduce to one beside-window
// caller compare, so all three proofs get their chance. A subtraction-
// form owner guard alone does not prove a list writer here (fee and
// pair setters share that shape); the extended caller accepts it only
// together with a listed-side gate proof (see `listedSideBlocks`).
function writerGuarded(
  code: ReturnType<typeof disassemble>,
  member: (pc: number) => boolean,
  ownerSlot: number | null,
  slotOf: SlotLookup,
  jumpis: ReadonlyMap<number, Expr>,
  bytecode: DetectorInput["bytecode"],
): boolean {
  if (
    ownerSlot !== null &&
    ownerCheckVia(code, member, ownerSlot, slotOf, jumpis, bytecode, false) !== null
  ) {
    return true;
  }
  const kind = privilegedGuardKind(code, member, ownerSlot, slotOf, jumpis, bytecode);
  if (kind === "role-slot" || kind === "role-mapping") {
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
// negation parity on the path to the entry load names it (an odd count
// jumps while the entry reads clear, so the set side falls through).
// Negation is semantic, not opcode-shaped: ISZERO flips a boolean
// entry, as does XOR with the constant 1 and an equality against the
// constant 0, so every spelling names the same side.
function mappingTruthySide(cond: Expr, base: number): "jump" | "fall" | null {
  const search = (expr: Expr, parity: number): number | null => {
    if (expr.kind === "sload") {
      return exprMappingBase(expr.slot) === base ? parity : null;
    }
    let childParity = parity;
    if (expr.kind === "op" && expr.name === "ISZERO") {
      childParity = parity + 1;
    } else if (
      expr.kind === "op" &&
      expr.name === "XOR" &&
      expr.args.some((arg) => arg.kind === "const" && arg.value === 1n)
    ) {
      childParity = parity + 1;
    } else if (
      expr.kind === "op" &&
      expr.name === "EQ" &&
      expr.args.some((arg) => arg.kind === "const" && arg.value === 0n)
    ) {
      childParity = parity + 1;
    }
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

// Whether the listed (set) side of a transfer gate is the blocking
// side: it reaches a revert, while an exemption's set side proceeds.
function listedSideBlocks(
  bytecode: DetectorInput["bytecode"],
  code: ReturnType<typeof disassemble>,
  gateMember: (pc: number) => boolean,
  jumpis: ReadonlyMap<number, Expr>,
  base: number,
): boolean {
  for (const [pc, cond] of [...jumpis.entries()].sort((a, b) => a[0] - b[0])) {
    if (!gateMember(pc) || !condBoolGatesOnBase(cond, base)) continue;
    const truthy = mappingTruthySide(cond, base);
    if (truthy === null) continue;
    if (
      hasRevertingSide(bytecode, code, gateMember, pc, truthy) ||
      sideCanReachRevertUnpriced(bytecode, pc, truthy, jumpis)
    ) {
      return true;
    }
  }
  return false;
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

// Whether the fall side of a gate jump is the side taken while the
// gated entry reads set (SCAN-B): from the jump condition when the
// interpreter proves it, else from the ISZERO parity between the
// nearest preceding load and the jump. Null stays undecided.
function fallIsTruthySide(
  code: ReturnType<typeof disassemble>,
  jumpis: ReadonlyMap<number, Expr>,
  jumpiPc: number,
  base: number,
  member?: (pc: number) => boolean,
): boolean | null {
  const cond = jumpis.get(jumpiPc);
  if (cond !== undefined && cond.kind !== "unknown") {
    if (!condReferencesMappingBase(cond, base)) {
      return false;
    }
    const truthy = mappingTruthySide(cond, base);
    return truthy === null ? null : truthy === "fall";
  }
  const jumpiIndex = code.findIndex((insn) => insn.pc === jumpiPc);
  if (jumpiIndex < 0) {
    return null;
  }
  let iszero = 0;
  for (let back = jumpiIndex - 1, steps = 0; back >= 0 && steps < 40; back -= 1, steps += 1) {
    const cand = code[back];
    if (cand === undefined) {
      return null;
    }
    if (cand.opcode === 0x15) {
      iszero += 1;
      continue;
    }
    if (cand.opcode === 0x14) {
      return null;
    }
    if (cand.opcode === 0x54) {
      // The parity only names the gate when the load hashes the
      // written base; a constant-slot load beside the jump (a trading
      // flag past an exemption branch) is a different power.
      if (member !== undefined) {
        const loadBase =
          mappingBaseNearAccess(code, member, cand.pc) ?? scratchPairBase(code, member, cand.pc);
        if (loadBase !== null && loadBase !== base) {
          return false;
        }
      }
      return iszero % 2 === 1;
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
  loads?: ReadonlyMap<number, Expr>,
): number | null {
  const indexAt = new Map<number, number>();
  for (let at = 0; at < code.length; at += 1) {
    const insn = code[at];
    if (insn !== undefined) {
      indexAt.set(insn.pc, at);
    }
  }
  const ordered = [...jumpis.entries()].sort((left, right) => left[0] - right[0]);
  for (const [pc, cond] of ordered) {
    if (!gateMember(pc) || !condBoolGatesOnBase(cond, base)) {
      continue;
    }
    // Polarity (SCAN-B): only the side taken while the entry reads set
    // may block. A jump that reverts on either side proves nothing: an
    // allowlist gate (a `require` on `exempt[from] && exempt[to]`)
    // reverts while its entry reads clear, which is the opposite power.
    const truthySide = mappingTruthySide(cond, base);
    if (truthySide === null) {
      continue;
    }
    if (hasRevertingSide(bytecode, code, gateMember, pc, truthySide)) {
      return pc;
    }
    // A merely reachable revert down the set side is not enough
    // (SCAN-R): a fee-exemption branch also reaches reverts further
    // down (a trading-flag or wallet-limit check past the exemption),
    // while the entry itself never blocks the transfer. The set side
    // must instead prove like a gate: it reaches a revert without
    // crossing a priced gate or a state write (a short-circuit list
    // gate `listed && !exempt` reverts through one more boolean
    // gate), or it halts before any store while the other side
    // still stores (an early-return block).
    const otherSide = truthySide === "jump" ? "fall" : "jump";
    // The clear side must stay open: if it reverts on every path the
    // entry is an allowlist requirement, not a list (SCAN-B).
    if (
      truthyReachesRevertSoon(code, indexAt, pc, truthySide, base, gateMember, undefined, false, loads) &&
      !hasRevertingSideBounded(bytecode, gateMember, pc, otherSide)
    ) {
      return pc;
    }
    // Silent no-op gate: the set side halts soon while the clear side
    // still stores (SCAN-B, bounded like the helper-body proof).
    const otherOutcomes = gateSideOutcomes(bytecode, pc, otherSide);
    if (
      truthyReachesRevertSoon(code, indexAt, pc, truthySide, base, gateMember, undefined, true, loads) &&
      otherOutcomes.canStore
    ) {
      return pc;
    }
  }
  return null;
}

// Bounded set-side revert reach (SCAN-B): from one side of a gate jump,
// a REVERT or INVALID within a short instruction walk that crosses at
// most one further conditional jump and no priced opcode (an amount
// compare or arithmetic), no store and no call. A short-circuit list
// gate (`listed && !exempt`) reaches its revert through exactly one
// more boolean gate; an allowlist pass side continues into the priced
// transfer body, whose reverts sit past priced compares and stores.
function truthyReachesRevertSoon(
  code: ReturnType<typeof disassemble>,
  indexAt: ReadonlyMap<number, number>,
  jumpiPc: number,
  side: "jump" | "fall",
  base?: number,
  member?: (pc: number) => boolean,
  slotOf?: SlotLookup,
  halt = false,
  loads?: ReadonlyMap<number, Expr>,
): boolean {
  const startIndex = indexAt.get(jumpiPc);
  if (startIndex === undefined) {
    return false;
  }
  const destOf = (at: number): number | null => {
    for (let back = at - 1, steps = 0; back >= 0 && steps < 4; back -= 1, steps += 1) {
      const cand = code[back];
      if (cand === undefined) {
        return null;
      }
      if (cand.opcode >= 0x60 && cand.opcode <= 0x63 && cand.immediate !== undefined) {
        let value = 0;
        for (const byte of cand.immediate) {
          value = value * 256 + byte;
        }
        return value;
      }
      if (cand.opcode !== 0x80 && cand.opcode !== 0x90) {
        return null;
      }
    }
    return null;
  };
  // Amount compares and scaling only: ADD and SUB also build revert
  // messages and memory pointers, so they never price a gate here.
  const priced = new Set([0x10, 0x11, 0x12, 0x13, 0x02, 0x04, 0x05, 0x06]);
  type Frame = {
    readonly at: number;
    readonly crossed: number;
    readonly steps: number;
    readonly seenBase: number | null;
  };
  const seen = new Set<string>();
  const queue: Frame[] = [];
  if (side === "fall") {
    queue.push(Object.freeze({ at: startIndex + 1, crossed: 0, steps: 0, seenBase: null }));
  } else {
    const dest = destOf(startIndex);
    const destIndex = dest === null ? undefined : indexAt.get(dest);
    if (destIndex !== undefined) {
      queue.push(Object.freeze({ at: destIndex, crossed: 0, steps: 0, seenBase: null }));
    }
  }
  while (queue.length > 0) {
    const frame = queue.shift();
    if (frame === undefined || frame.steps > 96) {
      continue;
    }
    const key = `${frame.at}:${frame.crossed}:${frame.seenBase ?? -1}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    let at = frame.at;
    let crossed = frame.crossed;
    let steps = frame.steps;
    let seenBase = frame.seenBase;
    while (at < code.length && steps <= 96) {
      const insn = code[at];
      if (insn === undefined) {
        break;
      }
      steps += 1;
      if (insn.opcode === 0xfd || insn.opcode === 0xfe) {
        return !halt;
      }
      if (halt && (insn.opcode === 0x00 || insn.opcode === 0xf3)) {
        return true;
      }
      if (insn.opcode === 0x55 || insn.opcode === 0xf1 || insn.opcode === 0xf2 || insn.opcode === 0xf4 || insn.opcode === 0xfa) {
        break;
      }
      if (priced.has(insn.opcode)) {
        break;
      }
      if (insn.opcode === 0x57) {
        if (crossed >= 1) {
          break;
        }
        // Cross only a boolean gate on another entry (SCAN-B): a
        // second test of the same mapping (a `require` on
        // `exempt[from] && exempt[to]`) can still revert on the other
        // party, so the
        // first entry alone never blocks there. A second test whose
        // entry was loaded before the gate (a stack-cached exemption)
        // loads nothing on this walk, so it still crosses.
        if (base !== undefined && seenBase === base) {
          break;
        }
        // The crossed test must negate a boolean entry (SCAN-B): a
        // short-circuit list gate tests `!exempt` on its second jump,
        // which carries an ISZERO just before it. A bare stack bool
        // from an amount compare (`amount <= max` cached on the stack)
        // carries none, and its revert is a limit, not a list.
        let negated = false;
        for (let back = at - 1, steps = 0; back >= 0 && steps < 5; back -= 1, steps += 1) {
          const cand = code[back];
          if (cand === undefined || cand.opcode === 0x5b) {
            break;
          }
          if (cand.opcode === 0x15) {
            negated = true;
            break;
          }
        }
        if (!negated) {
          break;
        }
        crossed += 1;
        const dest = destOf(at);
        const destIndex = dest === null ? undefined : indexAt.get(dest);
        if (destIndex !== undefined) {
          queue.push(Object.freeze({ at: destIndex, crossed, steps, seenBase }));
        }
        at += 1;
        continue;
      }
      if (insn.opcode === 0x54 && base !== undefined && member !== undefined) {
        seenBase =
          exprMappingBase(loads?.get(insn.pc)) ??
          mappingBaseNearAccess(code, member, insn.pc, slotOf) ??
          mappingBaseNearAccess(code, () => true, insn.pc, slotOf);
      }
      if (insn.opcode === 0x56) {
        const dest = destOf(at);
        const destIndex = dest === null ? undefined : indexAt.get(dest);
        if (destIndex === undefined) {
          break;
        }
        at = destIndex;
        continue;
      }
      if (insn.opcode === 0x00 || insn.opcode === 0xf3 || insn.opcode === 0xff) {
        break;
      }
      at += 1;
    }
  }
  return false;
}

// Helper-body mapping gate (SCAN-B): the gate load sits in an internal
// helper two or more jumps below the transfer entry (a guard helper
// called from the transfer update hook), so neither the entry region
// nor its expression walk ever names the load. The transfer entry's
// internal-call body still contains it: a load there that hashes the
// written base, followed by a first jump whose set side blocks (a
// revert on every set-side path, a revert reachable from the set side
// without crossing a priced gate or a store while the clear side
// stays open, or a silent halt while the clear side still stores),
// proves the same list gate. Polarity is required throughout: a jump
// that reverts while the entry reads clear is an allowlist shape.
function bodyMappingGatePc(
  bytecode: DetectorInput["bytecode"],
  code: ReturnType<typeof disassemble>,
  entryPc: number,
  gateSlotOf: SlotLookup,
  jumpis: ReadonlyMap<number, Expr>,
  loads: ReadonlyMap<number, Expr>,
  base: number,
): number | null {
  const body = callGraphBodyPcs(code, entryPc);
  if (body.size === 0) {
    return null;
  }
  const inBody = (pc: number): boolean => body.has(pc);
  const indexAt = new Map<number, number>();
  for (let at = 0; at < code.length; at += 1) {
    const insn = code[at];
    if (insn !== undefined) {
      indexAt.set(insn.pc, at);
    }
  }
  for (const insn of code) {
    if (insn.opcode !== 0x54 || !inBody(insn.pc)) {
      continue;
    }
    // A load the interpreter proves constant (a flag or seat slot) is
    // never a mapping entry, however near a mapping hash sits (SCAN-B).
    const loadExpr = loads.get(insn.pc);
    if (loadExpr !== undefined && loadExpr.kind === "sload" && loadExpr.slot.kind === "const") {
      continue;
    }
    const interpretedSlot = gateSlotOf(insn.pc);
    if (interpretedSlot !== undefined && interpretedSlot.kind === "const") {
      continue;
    }
    const loadBase =
      exprMappingBase(loads.get(insn.pc)) ??
      mappingBaseNearAccess(code, inBody, insn.pc, gateSlotOf) ??
      scratchPairBase(code, inBody, insn.pc);
    if (loadBase === null || loadBase === undefined || loadBase !== base) {
      continue;
    }
    const loadIndex = indexAt.get(insn.pc);
    if (loadIndex === undefined) {
      continue;
    }
    for (let at = loadIndex + 1; at < code.length; at += 1) {
      const cand = code[at];
      if (cand === undefined || cand.pc > insn.pc + 192) {
        break;
      }
      if (!inBody(cand.pc)) {
        continue;
      }
      if (cand.opcode === 0x54 || cand.opcode === 0x55) {
        break;
      }
      if (cand.opcode !== 0x57) {
        continue;
      }
      const cond = jumpis.get(cand.pc);
      let truthy: "jump" | "fall" | null = null;
      if (
        cond !== undefined &&
        cond.kind !== "unknown" &&
        condReferencesMappingBase(cond, base) &&
        condBoolGatesOnBase(cond, base)
      ) {
        truthy = mappingTruthySide(cond, base);
      } else {
        let iszero = 0;
        let clean = true;
        for (let back = loadIndex + 1; back < at; back += 1) {
          const between = code[back];
          if (between === undefined) {
            clean = false;
            break;
          }
          if (between.opcode === 0x15) {
            iszero += 1;
          } else if (
            between.opcode === 0x20 ||
            between.opcode === 0x52 ||
            between.opcode === 0x51 ||
            // A priced compare or arithmetic between the load and the
            // jump (`balance >= amount`, a cooldown, a limit) is an
            // amount gate, never a boolean list gate (SCAN-B).
            [0x10, 0x11, 0x12, 0x13, 0x02, 0x04, 0x05, 0x03, 0x01, 0x06].includes(between.opcode)
          ) {
            clean = false;
            break;
          }
        }
        if (!clean) {
          break;
        }
        truthy = iszero % 2 === 1 ? "fall" : "jump";
      }
      if (truthy === null) {
        break;
      }
      const other = truthy === "jump" ? "fall" : "jump";
      if (
        truthyReachesRevertSoon(code, indexAt, cand.pc, truthy, base, inBody, gateSlotOf, false, loads) &&
        !hasRevertingSideBounded(bytecode, inBody, cand.pc, other)
      ) {
        return insn.pc;
      }
      // Silent no-op gate: the set side halts soon (a return with no
      // store, no priced gate and at most one further boolean gate)
      // while the clear side still reaches the transfer stores.
      const otherOutcomes = gateSideOutcomes(bytecode, cand.pc, other);
      if (
        truthyReachesRevertSoon(code, indexAt, cand.pc, truthy, base, inBody, gateSlotOf, true, loads) &&
        otherOutcomes.canStore
      ) {
        return insn.pc;
      }
      break;
    }
  }
  return null;
}

// Constant slots equality-compared just after their load anywhere in
// the code (SCAN-B): the seats a caller guard may read, whether or not
// any single region walk proves one. A token may guard different
// writers by different address seats (an owner seat beside a fee-wallet
// seat), so every such slot gets its chance as a writer guard. The
// caller itself may sit in a sender helper far away in code order, so
// its proximity is not required here; the guard proof proper, which
// does require the caller, runs on each candidate.
function callerGuardSlots(code: ReturnType<typeof disassemble>): readonly number[] {
  const slots = new Set<number>();
  for (let at = 0; at < code.length; at += 1) {
    const insn = code[at];
    if (insn === undefined || insn.opcode !== 0x54) {
      continue;
    }
    let slot: number | null = null;
    for (let back = at - 1, steps = 0; back >= 0 && steps < 4; back -= 1, steps += 1) {
      const cand = code[back];
      if (cand === undefined) {
        break;
      }
      if (cand.opcode === 0x5f) {
        slot = 0;
        break;
      }
      if (cand.opcode >= 0x60 && cand.opcode <= 0x63 && cand.immediate !== undefined) {
        let value = 0;
        for (const byte of cand.immediate) {
          value = value * 256 + byte;
        }
        slot = value;
        break;
      }
      if (cand.opcode !== 0x80 && cand.opcode !== 0x90 && cand.opcode !== 0x91) {
        break;
      }
    }
    if (slot === null || slot > 4096) {
      continue;
    }
    for (let near = at + 1; near < Math.min(code.length, at + 25); near += 1) {
      const cand = code[near];
      if (cand !== undefined && cand.opcode === 0x14) {
        slots.add(slot);
        break;
      }
    }
  }
  return Object.freeze([...slots].sort((a, b) => a - b).slice(0, 16));
}

// Raw caller guard over an entry's internal-call body (SCAN-B): the
// body holds a caller opcode, a revert, and a constant-seat load of
// one of the candidate slots with an equality test just after it.
// Some list writers' region walks never reach their modifier at all,
// so the expression and window proofs stay silent there; the body
// still contains every piece of the guard.
function rawBodyGuard(
  code: ReturnType<typeof disassemble>,
  body: ReadonlySet<number>,
  slots: readonly number[],
  slotOf: SlotLookup,
): boolean {
  let hasCaller = false;
  let hasRevert = false;
  for (const insn of code) {
    if (!body.has(insn.pc)) {
      continue;
    }
    if (insn.opcode === 0x33) {
      hasCaller = true;
    }
    if (insn.opcode === 0xfd) {
      hasRevert = true;
    }
  }
  if (!hasCaller || !hasRevert) {
    return false;
  }
  const indexAt = new Map<number, number>();
  for (let at = 0; at < code.length; at += 1) {
    const insn = code[at];
    if (insn !== undefined) {
      indexAt.set(insn.pc, at);
    }
  }
  for (const insn of code) {
    if (insn.opcode !== 0x54 || !body.has(insn.pc)) {
      continue;
    }
    const interpreted = slotOf(insn.pc);
    let slot: number | null =
      interpreted !== undefined && interpreted.kind === "const" ? interpreted.value : null;
    if (slot === null) {
      const at = indexAt.get(insn.pc);
      if (at === undefined) {
        continue;
      }
      for (let back = at - 1, steps = 0; back >= 0 && steps < 4; back -= 1, steps += 1) {
        const cand = code[back];
        if (cand === undefined) {
          break;
        }
        if (cand.opcode === 0x5f) {
          slot = 0;
          break;
        }
        if (cand.opcode >= 0x60 && cand.opcode <= 0x63 && cand.immediate !== undefined) {
          let value = 0;
          for (const byte of cand.immediate) {
            value = value * 256 + byte;
          }
          slot = value;
          break;
        }
        if (cand.opcode !== 0x80 && cand.opcode !== 0x90 && cand.opcode !== 0x91) {
          break;
        }
      }
    }
    if (slot === null || !slots.includes(slot)) {
      continue;
    }
    const at = indexAt.get(insn.pc);
    if (at === undefined) {
      continue;
    }
    for (let near = at + 1; near < Math.min(code.length, at + 25); near += 1) {
      const cand = code[near];
      if (cand !== undefined && cand.opcode === 0x14 && body.has(cand.pc)) {
        return true;
      }
    }
  }
  return false;
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
  // Some tokens prove their owner seat only on the v1 walk (a two-step
  // ownership seat beside a caller guard): fall back to that seat for
  // the writer guard so a role- or owner-guarded list writer on such a
  // token still gets its chance (SCAN-B).
  const ownerSlot = view.ownerSlot ?? analyzeOwnerControl(input.bytecode).ownerSlot;
  const code = disassemble(input.bytecode);
  const guardSlotCandidates = callerGuardSlots(code);
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
    // The caller guard may sit in a shared modifier helper the
    // attribution never names for this entry (SCAN-B): retry the same
    // guard proofs over the entry's internal-call body and over every
    // candidate caller-guard seat, not only the proven owner slot.
    const writerGuardBody = callGraphBodyPcs(code, region.entryPc);
    const writerBodyMember = (pc: number): boolean => writerGuardBody.has(pc);
    const guardSlots: (number | null)[] = [ownerSlot];
    for (const slot of guardSlotCandidates) {
      if (slot !== ownerSlot) {
        guardSlots.push(slot);
      }
    }
    const guarded =
      guardSlots.some(
        (slot) =>
          writerGuarded(code, writerMember, slot, writerSlotOf, writerExprs.jumpis, input.bytecode) ||
          writerGuarded(code, writerBodyMember, slot, writerSlotOf, writerExprs.jumpis, input.bytecode),
      ) ||
      rawBodyGuard(
        code,
        writerGuardBody,
        guardSlots.filter((slot): slot is number => slot !== null),
        writerSlotOf,
      );
    // Subtraction-form owner guard (main): accepted only when a
    // transfer gate for one of this writer's bases blocks on the
    // listed side, which distinguishes a list from a fee/pair
    // exemption at the gate (see `listedSideBlocks` below).
    const subGuarded =
      !guarded &&
      ownerSlot !== null &&
      ownerCheckVia(code, writerMember, ownerSlot, writerSlotOf, writerExprs.jumpis, input.bytecode, true) !== null;
    if (!guarded && !subGuarded) {
      continue;
    }
    // Writer stores: the region stores first, then any mapping store
    // in the writer entry's internal-call body (SCAN-B). A list writer
    // that loops over an array or delegates to a helper keeps its
    // SSTORE out of the entry region, so the region alone misses it;
    // the body scan names the same store with its hash base.
    const writes: { readonly pc: number; readonly base: number; readonly body: boolean }[] = [];
    for (const write of region.stores) {
      if (write.slot.kind !== "mapping") {
        continue;
      }
      const exprBase = exprMappingBase(writerExprs.stores.get(write.pc)?.slot);
      const windowBase = mappingBaseNearAccess(code, writerMember, write.pc, writerSlotOf);
      // The hash may sit on any constant scratch pair (a loop writer
      // hashing array elements lays memory out the same way), so the
      // scratch-pair pattern gets its chance beside the usual pair.
      const writeBase = exprBase ?? windowBase ?? scratchPairBase(code, writerMember, write.pc);
      if (writeBase === null || writeBase === undefined) {
        continue;
      }
      writes.push(Object.freeze({ pc: write.pc, base: writeBase, body: false }));
    }
    const writerBody = callGraphBodyPcs(code, region.entryPc);
    for (const insn of code) {
      if (insn.opcode !== 0x55 || !writerBody.has(insn.pc)) {
        continue;
      }
      if (writes.some((seen) => seen.pc === insn.pc)) {
        continue;
      }
      const bodyBase =
        mappingBaseNearAccess(code, (pc) => writerBody.has(pc), insn.pc, writerSlotOf) ??
        scratchPairBase(code, (pc) => writerBody.has(pc), insn.pc);
      if (bodyBase !== null) {
        writes.push(Object.freeze({ pc: insn.pc, base: bodyBase, body: true }));
      }
    }
    for (const write of writes) {
      const writeBase = write.base;
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
            hasRevertingSideBounded(input.bytecode, gateMember, gateJumpi.pc, "fall") &&
            // Polarity (SCAN-B): the fall revert must be the side taken
            // while the entry reads set; a clear-side revert belongs to
            // an allowlist shape, never to a list.
            fallIsTruthySide(code, transferExprs.jumpis, gateJumpi.pc, writeBase) !== false
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
          const exprGateCond = exprGate === null ? undefined : transferExprs.jumpis.get(exprGate.jumpiPc);
          const exprGateTruthy =
            exprGateCond === undefined || exprGateCond.kind === "unknown"
              ? null
              : mappingTruthySide(exprGateCond, writeBase);
          if (
            exprGate !== null &&
            exprGate.base === writeBase &&
            exprGateTruthy !== "jump" &&
            hasRevertingSideBounded(input.bytecode, gateMember, exprGate.jumpiPc, "fall") &&
            // A blocked side that still reaches a store is not blocked
            // (SCAN-R): a fee-exemption read branches the same way, but
            // its set side flows on into the balance writes, while a
            // list gate's set side reverts before any store.
            !gateSideOutcomes(input.bytecode, exprGate.jumpiPc, "fall").canStore
          ) {
            gateEvidencePc = exprGate.jumpiPc;
          }
        }
        if (gateEvidencePc === null && !write.body) {
          // Window packed shift-and-mask fallback (P-11 follow-up).
          const packedGate = packedMappingGateShift(code, gateMember, gateSlotOf);
          if (packedGate !== null && packedGate.base === writeBase) {
            const packedJumpi = code.find(
              (insn) =>
                insn.opcode === 0x57 &&
                gateMember(insn.pc) &&
                insn.pc > packedGate.cmpPc &&
                insn.pc <= packedGate.cmpPc + 64 &&
                hasRevertingSide(input.bytecode, code, gateMember, insn.pc, "fall") &&
                fallIsTruthySide(code, transferExprs.jumpis, insn.pc, writeBase) !== false,
            );
            if (packedJumpi !== undefined) {
              gateEvidencePc = packedGate.loadPc;
            }
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
            transferExprs.loads,
          );
        }
        // Subtraction-form writers (main) may not use this loosest
        // gate proof: beside an unrelated reverting jump it reads
        // pause-style gates as lists.
        if (gateEvidencePc === null && !write.body && !subGuarded) {
          // Getter-helper gate (SCAN-4): the entry load sits in an
          // internal getter that returns it on the stack, so no compare
          // sits beside the load and the gate jump in the caller tests
          // the returned word instead of a load the interpreter can
          // name. The load proves the gate when it hashes the written
          // base, no equality or ISZERO sits beside it (a beside compare
          // is the exemption shape the proofs above already weighed),
          // and some member jump on the transfer path reverts on one
          // side.
          const v1Transfer = analyzeOwnerControl(input.bytecode).regions.find(
            (candidate) => candidate.selector === transferSelector,
          );
          const helperLoads = [
            ...transfer.loads,
            ...((v1Transfer?.loads ?? []).filter(
              (load) => !transfer.loads.some((seen) => seen.pc === load.pc),
            ) as typeof transfer.loads),
          ];
          for (const load of helperLoads) {
            if (load.slot.kind !== "mapping") {
              continue;
            }
            if (mappingBaseNearAccess(code, gateMember, load.pc, gateSlotOf) !== writeBase) {
              continue;
            }
            if (nearestFlavorPc(transfer, ["eq", "iszero"], load.pc) !== null) {
              continue;
            }
            const reverting = code.some((insn) => {
              if (insn.opcode !== 0x57 || !gateMember(insn.pc)) {
                return false;
              }
              const cond = transferExprs.jumpis.get(insn.pc);
              // Polarity (SCAN-B): when the jump condition is known and
              // tests this entry, only its set side may revert. A known
              // condition on another entry proves nothing here.
              if (cond !== undefined && cond.kind !== "unknown") {
                if (!condReferencesMappingBase(cond, writeBase)) {
                  return false;
                }
                const truthy = mappingTruthySide(cond, writeBase);
                if (truthy === null) {
                  return false;
                }
                const indexAt = new Map<number, number>();
                for (let at = 0; at < code.length; at += 1) {
                  const item = code[at];
                  if (item !== undefined) {
                    indexAt.set(item.pc, at);
                  }
                }
                return truthyReachesRevertSoon(
                  code,
                  indexAt,
                  insn.pc,
                  truthy,
                  writeBase,
                  gateMember,
                  gateSlotOf,
                  false,
                  transferExprs.loads,
                );
              }
              // Unknown condition (SCAN-B): the caller jump sits just
              // past the getter return and tests the returned word, so
              // its ISZERO parity names the set side; only a soon
              // revert on that side proves the gate.
              if (Math.abs(insn.pc - load.pc) > 256) {
                return false;
              }
              const indexAt = new Map<number, number>();
              for (let at = 0; at < code.length; at += 1) {
                const item = code[at];
                if (item !== undefined) {
                  indexAt.set(item.pc, at);
                }
              }
              const jumpiIndex = indexAt.get(insn.pc);
              if (jumpiIndex === undefined) {
                return false;
              }
              let iszero = 0;
              for (let back = jumpiIndex - 1, steps = 0; back >= 0 && steps < 6; back -= 1, steps += 1) {
                const cand = code[back];
                if (cand === undefined || cand.opcode === 0x5b || cand.opcode === 0x56) {
                  break;
                }
                if (cand.opcode === 0x15) {
                  iszero += 1;
                }
              }
              const truthy = iszero % 2 === 1 ? "fall" : "jump";
              return truthyReachesRevertSoon(
                code,
                indexAt,
                insn.pc,
                truthy,
                writeBase,
                gateMember,
                gateSlotOf,
                false,
                transferExprs.loads,
              );
            });
            if (reverting) {
              gateEvidencePc = load.pc;
              break;
            }
          }
        }
        if (gateEvidencePc === null) {
          // Helper-body gate (SCAN-B): the gate sits in a guard helper
          // below the transfer update hook, outside every entry-scoped
          // walk above. The internal-call body of the transfer entry
          // still contains the load and its blocking jump.
          gateEvidencePc = bodyMappingGatePc(
            input.bytecode,
            code,
            transfer.entryPc,
            gateSlotOf,
            transferExprs.jumpis,
            transferExprs.loads,
            writeBase,
          );
        }
        if (gateEvidencePc === null) {
          continue;
        }
        // Subtraction-form writers (main) prove a list only when the
        // listed side of the gate is the blocking side.
        if (subGuarded && !listedSideBlocks(input.bytecode, code, gateMember, transferExprs.jumpis, writeBase)) {
          continue;
        }
        // Shared code belongs to every entry that reaches it, so the
        // single holder stays null there: fall back to the sorted holders
        // and prefer the transfer entry under proof.
        const holdersOfWrite = [...attribution.holdersOf(write.pc)].sort();
        const firstWriteHolder = holdersOfWrite[0] === undefined ? null : holdersOfWrite[0];
        const holder =
          attribution.holderOf(write.pc) ??
          (holdersOfWrite.includes(transferSelector) ? transferSelector : firstWriteHolder) ??
          region.selector;
        const holdersOfGate = [...attribution.holdersOf(gateEvidencePc)].sort();
        const firstGateHolder = holdersOfGate[0] === undefined ? null : holdersOfGate[0];
        const gateHolder =
          attribution.holderOf(gateEvidencePc) ??
          (holdersOfGate.includes(transferSelector) ? transferSelector : firstGateHolder) ??
          transferSelector;
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
