// Pause detector plugin `dev.brandklipparen.pause` (S-115, P-12 step 1,
// P-11 extended analysis). First-party detector behind the registry:
// proves a privileged pause or trading toggle from code paths. A finding
// needs a privileged writer (a caller guard) storing a flag slot, and a
// transfer path that loads the same slot beside an equality compare (or
// an ISZERO with no range compare between the load and the gate, so a
// balance check `balance >= amount` never counts) with a conditional jump
// that can revert. The writer and the gate may live in the same function
// when solc merges code. The mode is `trading-toggle` when no store to
// the slot ever writes zero and some store writes a nonzero constant (a
// one-way enable), `pause` when a zero write exists (the flag flips both
// ways), and `unknown` otherwise. An ungated flag, a gate with no
// privileged writer, or an amount comparison stays silent. When the v1
// proof finds nothing, the same proof re-runs on the v2 reachability
// view (shared helpers included, packed-bool writes resolved) and emits
// a weight-0 `fact` finding with `proof: "extended"` that never converts
// to a signal. Pure and synchronous: this module imports solely the
// plugin API and domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import {
  SLOT_FLAVOR_WINDOW_PC,
  TRANSFER_FROM_SELECTOR,
  TRANSFER_SELECTOR,
  analyzeOwnerControl,
  compoundPrivilegedGate,
  constSlotLoadNearFlavor,
  flavorBetween,
  hasRevertingGateAfter,
  hasRevertingSide,
  interpretRegionExprs,
  interpretRegionSlots,
  isStandardTokenWriter,
  ownerCheckVia,
  packedBoolWriteAt,
  packedBoolWriteExpr,
  packedGateReadExpr,
  packedGateShift,
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

const PLUGIN_ID = "dev.brandklipparen.pause";

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
        required: Object.freeze(["slot", "mode"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "pause" }),
          fact: Object.freeze({ const: "pause" }),
          proof: Object.freeze({ const: "extended" }),
          slot: Object.freeze({ type: "integer", minimum: 0 }),
          mode: Object.freeze({ enum: Object.freeze(["pause", "trading-toggle", "unknown"]) }),
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
    displayName: "Pause detector",
    description: "Reports a boolean flag set by a privileged caller that gates the transfer path.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`pause plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`pause plugin manifest carries kind ${parsed.value.kind}, expected detector`);
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

// A transfer gate on a constant flag slot: the slot loads beside an
// equality compare, or beside an ISZERO with no range compare between the
// load and the gate, plus a conditional jump that can revert. A bounded
// amount check in the same region keeps its own LT or GT, but the veto is
// positional: only a compare between this load and this gate disqualifies
// the boolean reading, so an unrelated bound elsewhere never vetoes it.
function gatedFlagRead(region: RegionFacts, slot: number): number | null {
  if (!region.hasJumpi || !region.hasRevert) {
    return null;
  }
  const eqProof = constSlotLoadNearFlavor(region, slot, ["eq"]);
  if (eqProof !== null) {
    // F-10e: an access check is not a pause gate. An equality beside
    // CALLER checks the sender's authority (onlyOwner), while a pause
    // gate discriminates on the stored flag.
    if (region.callerPcs.some((pc) => Math.abs(pc - eqProof.gatePc) <= SLOT_FLAVOR_WINDOW_PC)) {
      return null;
    }
    return eqProof.loadPc;
  }
  const zeroProof = constSlotLoadNearFlavor(region, slot, ["iszero"]);
  if (zeroProof === null) {
    return null;
  }
  if (flavorBetween(region, ["lt", "gt"], zeroProof.loadPc, zeroProof.gatePc)) {
    return null;
  }
  if (region.callerPcs.some((pc) => Math.abs(pc - zeroProof.gatePc) <= SLOT_FLAVOR_WINDOW_PC)) {
    return null;
  }
  return zeroProof.loadPc;
}

function toggleMode(regions: readonly RegionFacts[], slot: number): "pause" | "trading-toggle" | "unknown" {
  let zeroWrite = false;
  let nonzeroWrite = false;
  for (const region of regions) {
    for (const store of region.stores) {
      if (store.slot.kind !== "const" || store.slot.value !== slot) {
        continue;
      }
      if (store.valueIsZero) {
        zeroWrite = true;
      } else if (store.valueConst !== null && store.valueConst !== 0) {
        nonzeroWrite = true;
      }
    }
  }
  if (zeroWrite) {
    return "pause";
  }
  if (nonzeroWrite) {
    return "trading-toggle";
  }
  return "unknown";
}

// Whether any region stores a proven zero to `slot` through the
// expression view (SCAN-3): a clear write carried into a shared
// internal helper leaves no constant beside its SSTORE for the legacy
// store scan, while the expression store still proves the value. Such
// a write flips the flag back, so a one-way classification must not
// stand on the legacy scan alone.
function exprProvesZeroWrite(
  bytecode: DetectorInput["bytecode"],
  regions: readonly RegionFacts[],
  slot: number,
): boolean {
  for (const region of regions) {
    const exprs = interpretRegionExprs(bytecode, region.selector);
    for (const [, record] of exprs.stores) {
      if (
        record.slot.kind === "const" &&
        record.slot.value === BigInt(slot) &&
        record.value.kind === "const" &&
        record.value.value === 0n
      ) {
        return true;
      }
    }
  }
  return false;
}

// Privileged flag proof over the frozen input. Total: arbitrary bytecode
// yields a finding list, never an exception. Deterministic: candidate
// slots scan ascending and the lowest provable slot wins. Bytecode without
// selectors yields no findings, since a finding without selector evidence
// is unrepresentable.
// A flag write: the writer stores zero (disabling) or a small boolean
// constant (enabling), never a computed amount or a large constant. A
// computed or large store is a rate or a limit, not a boolean flag, so a
// fee or limits setter never doubles as a pause setter. In v2 views the
// packed-bool read resolves the shifted bit into `valueConst`, so the
// same check also proves a packed `owner|paused` slot-0 write; v1 views
// never carry packed values, so the scored finding set stays unchanged.
// Exported for the extended-proof diagnostics beside the detectors, which
// re-run the same search to explain a missing fact.
export function flagWriter(region: RegionFacts, slot: number): number | null {
  const store = region.stores.find(
    (candidate) => candidate.slot.kind === "const" && candidate.slot.value === slot,
  );
  if (store === undefined) {
    return null;
  }
  if (store.valueIsZero) {
    return store.pc;
  }
  if (store.valueConst !== null && store.valueConst <= 1) {
    return store.pc;
  }
  return null;
}

function detectV1(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode);
  const view = analyzeOwnerControl(input.bytecode);
  const privilegedSet = new Set(view.privileged);
  const transferSet = new Set(view.transfers);
  const candidates = new Set<number>();
  const ownerSlot = view.ownerSlot;
  for (const region of view.regions) {
    if (!privilegedSet.has(region.selector)) {
      continue;
    }
    for (const store of region.stores) {
      if (store.slot.kind !== "const") {
        continue;
      }
      // F-10e: the owner seat holds an address, never a pause flag. A
      // renounce (a zero write to the owner slot) is not a pause setter.
      if (ownerSlot !== null && store.slot.value === ownerSlot) {
        continue;
      }
      if (store.valueIsZero || (store.valueConst !== null && store.valueConst <= 1)) {
        candidates.add(store.slot.value);
      }
    }
  }
  const orderedSlots = [...candidates].sort((left, right) => left - right);
  for (const slot of orderedSlots) {
    for (const region of view.regions) {
      if (!privilegedSet.has(region.selector)) {
        continue;
      }
      const writePc = flagWriter(region, slot);
      if (writePc === null) {
        continue;
      }
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
        const gatePc = gatedFlagRead(transfer, slot);
        if (gatePc === null) {
          continue;
        }
        const holder = attribution.holderOf(writePc);
        const gateHolder = attribution.holderOf(gatePc);
        if (holder === null || gateHolder === null) {
          continue;
        }
        const evidence: EvidenceType[] = [];
        const written = evidenceFor(input.bytecode, holder, writePc);
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
            id: `${PLUGIN_ID}:pause`,
            pluginId: MANIFEST.id,
            title: "Privileged caller sets a flag that gates the transfer path",
            evidence: nonEmpty,
            payload: Object.freeze({
              feature: "pause",
              slot,
              mode: toggleMode(view.regions, slot),
            }),
          }),
        ]);
      }
    }
  }
  return Object.freeze([]);
}

// Extended gate proof (P-11 session 1 follow-up): the flag read beside a
// compare, with the compare PC so the caller can prove the blocked side
// reverts. Kept beside `gatedFlagRead` (which the scored path owns) so
// the v1 proof never changes. Exported for the extended-proof diagnostics
// beside the detectors, which re-run the same search to explain a missing
// fact.
export function gatedFlagReadPrecise(
  region: RegionFacts,
  slot: number,
): { readonly loadPc: number; readonly cmpPc: number } | null {
  if (!region.hasJumpi || !region.hasRevert) {
    return null;
  }
  const eqProof = constSlotLoadNearFlavor(region, slot, ["eq"]);
  if (eqProof !== null) {
    // F-10e: an access check is not a pause gate (see gatedFlagRead).
    if (region.callerPcs.some((pc) => Math.abs(pc - eqProof.gatePc) <= SLOT_FLAVOR_WINDOW_PC)) {
      return null;
    }
    return Object.freeze({ loadPc: eqProof.loadPc, cmpPc: eqProof.gatePc });
  }
  const zeroProof = constSlotLoadNearFlavor(region, slot, ["iszero"]);
  if (zeroProof === null) {
    return null;
  }
  if (flavorBetween(region, ["lt", "gt"], zeroProof.loadPc, zeroProof.gatePc)) {
    return null;
  }
  if (region.callerPcs.some((pc) => Math.abs(pc - zeroProof.gatePc) <= SLOT_FLAVOR_WINDOW_PC)) {
    return null;
  }
  return Object.freeze({ loadPc: zeroProof.loadPc, cmpPc: zeroProof.gatePc });
}

// Extended analysis (P-11, weight-0 fact): the flag proof over the v2
// reachability view, where shared helpers join every entry that reaches
// them and packed-bool writes resolve to their bit, tightened so plain
// token mechanics never prove a pause. The writer must carry a caller
// check against the proven owner slot (never a standard token entry),
// the gate must sit on a transfer/transferFrom path whose blocked side
// reverts, and a packed writer must write the same slot and bit the gate
// reads (old-solc EXP-built shifts included). It runs only when the v1
// proof found nothing, so a scored finding always wins and the extended
// finding never shadows it. The payload carries `fact` (never `feature`)
// with `proof: "extended"`, so the finding never converts to a signal
// and stays at weight 0. The title mirrors the 1.1.0 origin sentence for
// pause (see `ORIGIN_SENTENCE` in src/domain/explain.ts) with the
// not-in-score marker; it names no account, so no changer is claimed
// without the P-2 ownership proof.
// Writer guard for extended analysis (SCAN-2): the proven owner check,
// a role-slot or auth-mapping guard, or a compound owner-or-role gate.
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

// Whether a jump condition bool-gates on flag slot `slot`: the slot load
// read as a boolean (under ISZERO, AND, OR, NOT, an equality or a packed
// shift-and-mask), never priced through an amount compare or arithmetic
// and never as one side of a caller equality (an access check).
function condBoolGatesOnSlot(cond: Expr | undefined, slot: number): boolean {
  if (cond === undefined || cond.kind === "unknown") {
    return false;
  }
  let found = false;
  let veto = false;
  const walk = (expr: Expr, priced: boolean): void => {
    if (expr.kind === "sload" && expr.slot.kind === "const" && expr.slot.value === BigInt(slot)) {
      if (!priced) {
        found = true;
      }
      return;
    }
    if (expr.kind === "op" && expr.name === "EQ" && expr.args.length === 2) {
      const left = expr.args[0];
      const right = expr.args[1];
      const isCaller = (candidate: Expr | undefined): boolean => candidate?.kind === "caller";
      const isSlotLoad = (candidate: Expr | undefined): boolean =>
        candidate?.kind === "sload" &&
        candidate.slot.kind === "const" &&
        candidate.slot.value === BigInt(slot);
      if ((isCaller(left) && isSlotLoad(right)) || (isCaller(right) && isSlotLoad(left))) {
        veto = true;
        return;
      }
    }
    const childPriced =
      priced ||
      (expr.kind === "op" && ["LT", "GT", "SLT", "SGT", "MUL", "ADD", "SUB", "MOD"].includes(expr.name));
    if (expr.kind === "calldata") {
      walk(expr.offset, childPriced);
      return;
    }
    if (expr.kind === "sload") {
      walk(expr.slot, childPriced);
      return;
    }
    if (expr.kind === "keccak") {
      for (const word of expr.words) {
        walk(word, childPriced);
      }
      return;
    }
    if (expr.kind === "op") {
      for (const arg of expr.args) {
        walk(arg, childPriced);
      }
    }
  };
  walk(cond, false);
  return found && !veto;
}

// Bit position a jump condition reads from packed slot `slot`, or null
// when the read is not a single bool bit (SCAN-2): the load may sit
// under a shift, a divide, a single-bit or byte mask, in either order.
function packedGateBit(cond: Expr, slot: number): number | null {
  const constOf = (expr: Expr | undefined): bigint | null =>
    expr !== undefined && expr.kind === "const" ? expr.value : null;
  const findPath = (expr: Expr, trail: Expr[]): Expr[] | null => {
    if (expr.kind === "sload" && expr.slot.kind === "const" && expr.slot.value === BigInt(slot)) {
      return trail;
    }
    const next = [...trail, expr];
    if (expr.kind === "calldata") {
      return findPath(expr.offset, next);
    }
    if (expr.kind === "sload") {
      return findPath(expr.slot, next);
    }
    if (expr.kind === "keccak") {
      for (const word of expr.words) {
        const found = findPath(word, next);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    if (expr.kind === "op") {
      for (const arg of expr.args) {
        const found = findPath(arg, next);
        if (found !== null) {
          return found;
        }
      }
    }
    return null;
  };
  const trail = findPath(cond, []);
  if (trail === null) {
    return null;
  }
  let bit = 0;
  for (let index = trail.length - 1; index >= 0; index -= 1) {
    const node = trail[index];
    if (node === undefined || node.kind !== "op") {
      continue;
    }
    if (node.name === "SHR" || node.name === "DIV") {
      const shift = node.args.map(constOf).find((value) => value !== null && value > 0n);
      if (shift === undefined || shift === null) {
        return null;
      }
      const amount =
        node.name === "SHR" ? Number(shift) : shift.toString(2).length - 1;
      if (node.name === "DIV" && (1n << BigInt(amount)) !== shift) {
        return null;
      }
      bit += amount;
      continue;
    }
    if (node.name === "AND") {
      const mask = node.args.map(constOf).find((value) => value !== null);
      if (mask === undefined || mask === null) {
        continue;
      }
      if (mask === 1n || mask === 255n) {
        continue;
      }
      if ((mask & (mask - 1n)) === 0n) {
        return bit + (mask.toString(2).length - 1);
      }
      if ((mask & 255n) === 0n && (mask >> 8n) === 255n) {
        return bit + 8;
      }
      const lowByte = mask & ((1n << BigInt(bit + 8)) - 1n);
      if (lowByte === (255n << BigInt(bit))) {
        return bit;
      }
      return null;
    }
    if (["ISZERO", "EQ", "OR", "NOT"].includes(node.name)) {
      continue;
    }
    if (["LT", "GT", "SLT", "SGT", "MUL", "ADD", "SUB", "MOD", "SHL"].includes(node.name)) {
      return null;
    }
  }
  return bit;
}

// The side of a gate jump taken while the flag reads set: the ISZERO
// parity on the path to the flag load names it (an odd count jumps
// while the flag reads clear, so the set side falls through).
function flagTruthySide(cond: Expr, slot: number): "jump" | "fall" | null {
  const search = (expr: Expr, parity: number): number | null => {
    if (expr.kind === "sload") {
      return expr.slot.kind === "const" && expr.slot.value === BigInt(slot) ? parity : null;
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

// Whether a gate jump blocks transfers: every path on a side reverts
// (the universal proof), or the set side can reach a revert down one
// continuation (a short-circuit gate, mirroring the blacklist proof).
function gateBlocksTransfer(
  bytecode: DetectorInput["bytecode"],
  code: ReturnType<typeof disassemble>,
  gateMember: (pc: number) => boolean,
  pc: number,
  cond: Expr,
  slot: number,
): boolean {
  if (
    hasRevertingSide(bytecode, code, gateMember, pc, "fall") ||
    hasRevertingSide(bytecode, code, gateMember, pc, "jump")
  ) {
    return true;
  }
  const truthySide = flagTruthySide(cond, slot);
  return truthySide !== null && sideCanReachRevert(bytecode, pc, truthySide);
}

// First member JUMPI whose condition reads packed bit `bit` of `slot`
// with a reverting side, or null (SCAN-2): the packed gate fallback
// when the shift matchers stay silent but the condition itself names
// the same bit the writer sets.
export function exprPackedFlagGatePc(
  bytecode: DetectorInput["bytecode"],
  code: ReturnType<typeof disassemble>,
  gateMember: (pc: number) => boolean,
  jumpis: ReadonlyMap<number, Expr>,
  slot: number,
  bit: number,
): number | null {
  const ordered = [...jumpis.entries()].sort((left, right) => left[0] - right[0]);
  for (const [pc, cond] of ordered) {
    if (!gateMember(pc) || packedGateBit(cond, slot) !== bit) {
      continue;
    }
    if (gateBlocksTransfer(bytecode, code, gateMember, pc, cond, slot)) {
      return pc;
    }
  }
  return null;
}

// First member JUMPI whose condition bool-gates on `slot` with a
// reverting side, or null (SCAN-2): the enforce-style gate jumps
// straight to its revert block while the flag reads set.
function exprFlagGatePc(
  bytecode: DetectorInput["bytecode"],
  code: ReturnType<typeof disassemble>,
  gateMember: (pc: number) => boolean,
  jumpis: ReadonlyMap<number, Expr>,
  slot: number,
): number | null {
  const ordered = [...jumpis.entries()].sort((left, right) => left[0] - right[0]);
  for (const [pc, cond] of ordered) {
    if (!gateMember(pc) || !condBoolGatesOnSlot(cond, slot)) {
      continue;
    }
    if (gateBlocksTransfer(bytecode, code, gateMember, pc, cond, slot)) {
      return pc;
    }
  }
  return null;
}

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
  const sstoreIndexAt = (pc: number): number => code.findIndex((instruction) => instruction.pc === pc);
  const candidates = new Set<number>();
  for (const region of view.regions) {
    if (isStandardTokenWriter(region.selector)) {
      continue;
    }
    // The v2 interpreter proves the writer guard through DUP/SWAP chains
    // and expression matching; the window matcher stays as the fallback.
    const candidateSlots = interpretRegionSlots(input.bytecode, region.selector);
    const candidateSlotOf: SlotLookup = (pc) => candidateSlots.get(pc);
    const candidateExprs = interpretRegionExprs(input.bytecode, region.selector);
    if (
      !writerGuarded(code, memberOf(region.selector), ownerSlot, candidateSlotOf, candidateExprs.jumpis, input.bytecode)
    ) {
      continue;
    }
    for (const store of region.stores) {
      if (store.slot.kind !== "const") {
        continue;
      }
      if (store.valueIsZero || (store.valueConst !== null && store.valueConst <= 1)) {
        // F-10e: the owner seat holds an address, never a boolean
        // flag. A renounce (a zero write to the owner slot) is not a
        // pause setter; a packed bit write to the same slot still
        // proves its bit below.
        if (store.slot.value !== ownerSlot) {
          candidates.add(store.slot.value);
        } else {
          const seatWriteIndex = sstoreIndexAt(store.pc);
          const seatLegacyPacked =
            seatWriteIndex >= 0 ? packedBoolWriteAt(code, seatWriteIndex, store.slot.value, candidateSlotOf) : null;
          const seatExprPacked = packedBoolWriteExpr(store.slot.value, candidateExprs.stores.get(store.pc));
          if (seatLegacyPacked !== null || seatExprPacked !== null) {
            candidates.add(store.slot.value);
          }
        }
        continue;
      }
      // A masked packed-bool write stores a computed word
      // (`(SLOAD s & ~mask) | (1 << k)`), so no constant sits beside the
      // store and the value filter above never sees the slot. Prove the
      // packed write at this SSTORE directly, trying the expression
      // matcher first with the window matcher as the fallback.
      const writeIndex = sstoreIndexAt(store.pc);
      const legacyPacked =
        writeIndex >= 0 ? packedBoolWriteAt(code, writeIndex, store.slot.value, candidateSlotOf) : null;
      const exprPacked = packedBoolWriteExpr(store.slot.value, candidateExprs.stores.get(store.pc));
      if (legacyPacked !== null || exprPacked !== null) {
        candidates.add(store.slot.value);
        continue;
      }
      // A plain flag write through a shared internal helper (SCAN-3):
      // the constant travels on the stack from the entry, so no
      // constant sits beside the SSTORE for the legacy scan, while the
      // expression store still proves the written value is a boolean.
      const exprValue = candidateExprs.stores.get(store.pc)?.value;
      if (exprValue !== undefined && exprValue.kind === "const" && exprValue.value <= 1n) {
        candidates.add(store.slot.value);
      }
    }
  }
  const orderedSlots = [...candidates].sort((left, right) => left - right);
  for (const slot of orderedSlots) {
    for (const region of view.regions) {
      if (isStandardTokenWriter(region.selector)) {
        continue;
      }
      const writerMember = memberOf(region.selector);
      const writerSlots = interpretRegionSlots(input.bytecode, region.selector);
      const writerSlotOf: SlotLookup = (pc) => writerSlots.get(pc);
      const writerExprs = interpretRegionExprs(input.bytecode, region.selector);
      if (!writerGuarded(code, writerMember, ownerSlot, writerSlotOf, writerExprs.jumpis, input.bytecode)) {
        continue;
      }
      // F-10e: a plain write to the owner seat never proves a flag
      // writer (a renounce writes zero there); a packed bit write to
      // the same slot still can, through the same writer pc or the
      // expression fallback below.
      const legacyWritePc = flagWriter(region, slot);
      let writePc = legacyWritePc;
      if (writePc !== null && slot === ownerSlot) {
        const ownerWriteIndex = sstoreIndexAt(writePc);
        const ownerLegacyPacked =
          ownerWriteIndex >= 0 ? packedBoolWriteAt(code, ownerWriteIndex, slot, writerSlotOf) : null;
        const ownerExprPacked = packedBoolWriteExpr(slot, writerExprs.stores.get(writePc));
        if (ownerLegacyPacked === null && ownerExprPacked === null) {
          writePc = null;
        }
      }
      // Expression-packed writes carry no constant beside the store, so
      // the legacy writer lookup stays silent for them: fall back to the
      // lowest member store the expression matcher proves.
      if (writePc === null) {
        const exprStores = [...writerExprs.stores.entries()]
          .filter(([, record]) => packedBoolWriteExpr(slot, record) !== null)
          .map(([pc]) => pc)
          .sort((left, right) => left - right);
        const first = exprStores[0];
        if (first !== undefined) {
          writePc = first;
        }
      }
      // Plain flag writes through a shared internal helper (SCAN-3):
      // the legacy lookup needs a constant beside the SSTORE, while the
      // expression store proves the boolean the entry carried in.
      if (writePc === null) {
        const exprStores = [...writerExprs.stores.entries()]
          .filter(
            ([, record]) =>
              record.slot.kind === "const" &&
              record.slot.value === BigInt(slot) &&
              record.value.kind === "const" &&
              record.value.value <= 1n,
          )
          .map(([pc]) => pc)
          .sort((left, right) => left - right);
        const first = exprStores[0];
        if (first === undefined) {
          continue;
        }
        writePc = first;
      }
      // A packed writer proves a bit position that the gate must read
      // back: same slot and same shift, or the pair never proves one
      // flag. A plain (non-packed) writer carries no position, so only
      // the slot must match. The expression matcher runs first with the
      // window matcher as the fallback.
      const writeIndex = sstoreIndexAt(writePc);
      const legacyPacked =
        writeIndex >= 0 ? (packedBoolWriteAt(code, writeIndex, slot, writerSlotOf) ?? null) : null;
      const exprPacked = packedBoolWriteExpr(slot, writerExprs.stores.get(writePc));
      const packedWrite =
        exprPacked !== null
          ? { value: 1 as const, shift: exprPacked.bit }
          : legacyPacked;
      const orderedTransfers = [TRANSFER_SELECTOR, TRANSFER_FROM_SELECTOR]
        .filter((selector) => selector !== region.selector)
        .sort();
      for (const transferSelector of orderedTransfers) {
        const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
        if (transfer === undefined) {
          continue;
        }
        const gateMember = memberOf(transferSelector);
        let gateEvidencePc: number | null = null;
        if (packedWrite !== null && packedWrite.shift !== null) {
          const transferExprs = interpretRegionExprs(input.bytecode, transferSelector);
          const exprGate = packedGateReadExpr(transferExprs.jumpis, gateMember, slot);
          if (exprGate !== null && exprGate.shift === packedWrite.shift) {
            if (hasRevertingSide(input.bytecode, code, gateMember, exprGate.jumpiPc, "fall")) {
              gateEvidencePc = exprGate.jumpiPc;
            }
          } else {
            const transferSlots = interpretRegionSlots(input.bytecode, transferSelector);
            const transferSlotOf: SlotLookup = (pc) => transferSlots.get(pc);
            const gate = packedGateShift(code, gateMember, slot, transferSlotOf);
            if (
              gate !== null &&
              gate.shift === packedWrite.shift &&
              hasRevertingGateAfter(input.bytecode, code, gateMember, gate.cmpPc)
            ) {
              gateEvidencePc = gate.loadPc;
            }
          }
          if (gateEvidencePc === null) {
            // Bit-matched expression fallback (SCAN-2): the condition
            // itself names the writer bit when the shift matchers stay
            // silent, with a revert on either side.
            gateEvidencePc = exprPackedFlagGatePc(
              input.bytecode,
              code,
              gateMember,
              transferExprs.jumpis,
              slot,
              packedWrite.shift,
            );
          }
          if (gateEvidencePc === null) {
            continue;
          }
        } else {
          const gate = gatedFlagReadPrecise(transfer, slot);
          if (gate !== null && hasRevertingGateAfter(input.bytecode, code, gateMember, gate.cmpPc)) {
            gateEvidencePc = gate.loadPc;
          }
          if (gateEvidencePc === null) {
            // Enforce-style expression gate (SCAN-2): a transfer jump
            // whose own condition bool-gates on the flag, reverting on
            // whichever side the set flag takes it to.
            const transferExprs = interpretRegionExprs(input.bytecode, transferSelector);
            gateEvidencePc = exprFlagGatePc(input.bytecode, code, gateMember, transferExprs.jumpis, slot);
          }
          if (gateEvidencePc === null) {
            continue;
          }
        }
        // Shared code belongs to every entry that reaches it, so the
        // single holder stays null there: fall back to the sorted holders
        // and prefer the transfer entry under proof.
        const holdersOfWrite = [...attribution.holdersOf(writePc)].sort();
        const firstWriteHolder = holdersOfWrite[0] === undefined ? null : holdersOfWrite[0];
        const holder =
          attribution.holderOf(writePc) ??
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
        const written = evidenceFor(input.bytecode, holder, writePc);
        if (written !== null) {
          evidence.push(written);
        }
        const gate = evidenceFor(input.bytecode, gateHolder, gateEvidencePc);
        if (gate !== null) {
          evidence.push(gate);
        }
        const nonEmpty = toNonEmpty(evidence);
        if (nonEmpty === null) {
          continue;
        }
        // A proven one-way enable (only a nonzero write, never a zero
        // write) is a launch gate, not a freeze: trading can open but
        // can never be frozen again, so no pause fact is proven for
        // it. A computed packed write proves neither direction, so its
        // mode stays unknown and the fact still stands. A zero write
        // proven only through the expression view (a clear carried
        // into a shared helper) still proves the flag flips back.
        let mode = toggleMode(view.regions, slot);
        if (mode === "trading-toggle" && exprProvesZeroWrite(input.bytecode, view.regions, slot)) {
          mode = "pause";
        }
        if (mode === "trading-toggle") {
          continue;
        }
        return Object.freeze([
          Object.freeze({
            id: `${PLUGIN_ID}:pause-extended`,
            pluginId: MANIFEST.id,
            title: "The owner can freeze all transfers. Found by extended analysis; not counted in the score.",
            evidence: nonEmpty,
            payload: Object.freeze({
              fact: "pause",
              slot,
              mode,
              proof: "extended",
            }),
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

export const pauseDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
