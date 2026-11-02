// Transfer-limits detector plugin `dev.brandklipparen.transfer-limits`
// (S-115, P-12 step 1). First-party detector behind the registry: proves
// owner-changeable max-tx and max-wallet limits from code paths. A finding
// needs a privileged writer storing a caller-chosen limit (a computed
// value) or a large constant to a limit slot, and a transfer path that
// loads the same slot beside a less than or greater than compare. A flag
// constant (0 or 1) is a pause toggle, never a limit. The writer and the
// reader may share one merged function. The kind is `max-wallet` when the
// transfer path also reads a mapping entry (a balance lookup),
// `max-tx` when it compares a calldata value with no mapping read, and
// `unknown` otherwise. A compare with no privileged writer, or a
// privileged write the transfer path never compares against, stays
// silent. Pure and synchronous: this module imports solely the plugin API
// and domain types and pure functions (P-03). When the v1 proof finds
// nothing, the same proof re-runs on the v2 reachability view and emits
// a weight-0 `fact` finding with `proof: "extended"` that never converts
// to a signal.
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import {
  SLOT_FLAVOR_WINDOW_PC,
  TRANSFER_FROM_SELECTOR,
  TRANSFER_SELECTOR,
  analyzeOwnerControl,
  compoundPrivilegedGate,
  constSlotLoadNearFlavor,
  hasRevertingSide,
  interpretRegionExprs,
  interpretRegionSlots,
  isStandardTokenWriter,
  ownerCheckVia,
  packedBoolWriteAt,
  packedBoolWriteExpr,
  privilegedGuardKind,
} from "../../../domain/ownerControl.ts";
import type { Expr, RegionFacts, SlotLookup } from "../../../domain/ownerControl.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import { disassemble, extractSelectors } from "../../../domain/selectors.ts";
import type { Instruction } from "../../../domain/selectors.ts";
import type { Selector as SelectorType } from "../../../domain/types.ts";
import { PcOffset } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.transfer-limits";

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
        required: Object.freeze(["slot", "limitKind"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "transfer-limits" }),
          fact: Object.freeze({ const: "transfer-limits" }),
          proof: Object.freeze({ const: "extended" }),
          slot: Object.freeze({ type: "integer", minimum: 0 }),
          limitKind: Object.freeze({ enum: Object.freeze(["max-tx", "max-wallet", "unknown"]) }),
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
    displayName: "Transfer-limits detector",
    description: "Reports max-tx and max-wallet slots compared in the transfer path and set by a privileged caller.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`transfer-limits plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`transfer-limits plugin manifest carries kind ${parsed.value.kind}, expected detector`);
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

// A limit compare in the transfer path: the slot loads beside LT or GT.
// The proof returns the read and compare PCs. A compare that reads a
// chain-context value (TIMESTAMP or BLOCKNUMBER) beside the load pits
// the slot against the chain, never against an amount or a balance, so
// it proves no transfer limit (SCAN-3).
const CHAIN_CONTEXT_OPCODES: ReadonlySet<number> = new Set([0x42, 0x43]);

function limitCompare(
  region: RegionFacts,
  slot: number,
  code: readonly Instruction[],
): { readonly loadPc: number; readonly gatePc: number } | null {
  const proof = constSlotLoadNearFlavor(region, slot, ["lt", "gt"]);
  if (proof === null) {
    return null;
  }
  const low = Math.min(proof.loadPc, proof.gatePc);
  const high = Math.max(proof.loadPc, proof.gatePc);
  for (let index = 0; index < code.length; index += 1) {
    const instruction = code[index];
    if (
      instruction !== undefined &&
      instruction.pc >= low - SLOT_FLAVOR_WINDOW_PC &&
      instruction.pc <= high &&
      CHAIN_CONTEXT_OPCODES.has(instruction.opcode)
    ) {
      // A chain-context value that is immediately popped never feeds
      // the compare: an unrelated `TIMESTAMP; POP` beside a genuine
      // amount-versus-limit compare proves no chain comparison.
      if (code[index + 1]?.opcode === 0x50) {
        continue;
      }
      return null;
    }
  }
  return Object.freeze({ loadPc: proof.loadPc, gatePc: proof.gatePc });
}

// A limit write: the writer stores a caller-chosen (computed) value or a
// large constant. A zero write or a boolean constant is a pause toggle,
// never an amount limit, so a pause setter never doubles as a limit
// setter.
function limitWriter(region: RegionFacts, slot: number): number | null {
  const store = region.stores.find(
    (candidate) => candidate.slot.kind === "const" && candidate.slot.value === slot,
  );
  if (store === undefined) {
    return null;
  }
  if (!store.valueIsZero && store.valueConst === null) {
    return store.pc;
  }
  if (store.valueConst !== null && store.valueConst > 1) {
    return store.pc;
  }
  return null;
}

function kindOf(region: RegionFacts): "max-tx" | "max-wallet" | "unknown" {
  const mappingRead = region.loads.some((load) => load.slot.kind === "mapping");
  if (mappingRead) {
    return "max-wallet";
  }
  if (region.hasCalldataLoad) {
    return "max-tx";
  }
  return "unknown";
}

// Privileged limit proof over the frozen input. Total: arbitrary bytecode
// yields a finding list, never an exception. Deterministic: candidate
// slots scan ascending and the lowest provable slot wins. Bytecode without
// selectors yields no findings, since a finding without selector evidence
// is unrepresentable.
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
  const candidates = new Set<number>();
  for (const region of view.regions) {
    if (!privilegedSet.has(region.selector)) {
      continue;
    }
    for (const store of region.stores) {
      if (store.slot.kind !== "const") {
        continue;
      }
      if ((!store.valueIsZero && store.valueConst === null) || (store.valueConst !== null && store.valueConst > 1)) {
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
      const writePc = limitWriter(region, slot);
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
        const compare = limitCompare(transfer, slot, code);
        if (compare === null) {
          continue;
        }
        const readPc = compare.loadPc;
        const holder = attribution.holderOf(writePc);
        const readerHolder = attribution.holderOf(readPc);
        if (holder === null || readerHolder === null) {
          continue;
        }
        const evidence: EvidenceType[] = [];
        const written = evidenceFor(input.bytecode, holder, writePc);
        if (written !== null) {
          evidence.push(written);
        }
        const read = evidenceFor(input.bytecode, readerHolder, readPc);
        if (read !== null) {
          evidence.push(read);
        }
        const nonEmpty = toNonEmpty(evidence);
        if (nonEmpty === null) {
          continue;
        }
        return Object.freeze([
          Object.freeze({
            id: `${PLUGIN_ID}:transfer-limits`,
            pluginId: MANIFEST.id,
            title: "Privileged caller sets a limit compared in the transfer path",
            evidence: nonEmpty,
            payload: Object.freeze({ feature: "transfer-limits", slot, limitKind: kindOf(transfer) }),
          }),
        ]);
      }
    }
  }
  return Object.freeze([]);
}

// Extended analysis (weight-0 fact): the limit proof over the v2
// reachability view. The writer must carry a caller check against the
// proven owner slot (never a standard token entry), write a limit slot
// with a caller-chosen or large value, and a transfer path must load the
// same slot beside an LT or GT compare whose blocked side reverts. Real
// compiler output interleaves a helper call between the load and the
// compare, so the extended compare window is wider than the scored
// beside window. It runs only when the v1 proof found nothing, so a
// scored finding always wins. The payload carries `fact` (never
// `feature`) with `proof: "extended"`, so the finding never converts to
// a signal and stays at weight 0.
const EXTENDED_LIMIT_WINDOW_PC = 64;

// Strip a leading ISZERO chain. Local copy: the domain helper stays
// private and the scored path never changes.
function stripIszero(expr: Expr): { readonly inner: Expr; readonly count: number } {
  let inner: Expr = expr;
  let count = 0;
  while (inner.kind === "op" && inner.name === "ISZERO" && inner.args.length === 1) {
    const next = inner.args[0];
    if (next === undefined) {
      break;
    }
    inner = next;
    count += 1;
  }
  return { inner, count };
}

// Whether an expression subtree loads the given constant slot.
function exprLoadsSlot(expr: Expr | undefined, slot: number): boolean {
  if (expr === undefined) {
    return false;
  }
  if (expr.kind === "sload" && expr.slot.kind === "const" && expr.slot.value === BigInt(slot)) {
    return true;
  }
  if (expr.kind === "calldata") {
    return exprLoadsSlot(expr.offset, slot);
  }
  if (expr.kind === "sload") {
    return exprLoadsSlot(expr.slot, slot);
  }
  if (expr.kind === "keccak") {
    return expr.words.some((word) => exprLoadsSlot(word, slot));
  }
  if (expr.kind === "op") {
    return expr.args.some((arg) => exprLoadsSlot(arg, slot));
  }
  return false;
}

// Whether an expression subtree holds calldata or a stored load: the
// transferred amount or a resulting balance.
function exprLoadsAmountOrBalance(expr: Expr | undefined): boolean {
  if (expr === undefined) {
    return false;
  }
  if (expr.kind === "calldata" || expr.kind === "sload") {
    return true;
  }
  if (expr.kind === "keccak") {
    return expr.words.some((word) => exprLoadsAmountOrBalance(word));
  }
  if (expr.kind === "op") {
    return expr.args.some((arg) => exprLoadsAmountOrBalance(arg));
  }
  return false;
}

// Whether an expression subtree multiplies or divides: fee arithmetic,
// never a limit compare side.
function exprHoldsMulDiv(expr: Expr | undefined): boolean {
  if (expr === undefined) {
    return false;
  }
  if (expr.kind === "op" && (expr.name === "MUL" || expr.name === "DIV")) {
    return true;
  }
  if (expr.kind === "calldata") {
    return exprHoldsMulDiv(expr.offset);
  }
  if (expr.kind === "sload") {
    return exprHoldsMulDiv(expr.slot);
  }
  if (expr.kind === "keccak") {
    return expr.words.some((word) => exprHoldsMulDiv(word));
  }
  if (expr.kind === "op") {
    return expr.args.some((arg) => exprHoldsMulDiv(arg));
  }
  return false;
}

// Whether a transfer jump condition multiplies or divides the loaded
// slot: the slot prices a fee, so it can never prove a limit.
function condUsesSlotArithmetically(cond: Expr | undefined, slot: number): boolean {
  if (cond === undefined || cond.kind === "unknown") {
    return false;
  }
  if (
    cond.kind === "op" &&
    (cond.name === "MUL" || cond.name === "DIV") &&
    cond.args.some((arg) => exprLoadsSlot(arg, slot))
  ) {
    return true;
  }
  if (cond.kind === "calldata") {
    return condUsesSlotArithmetically(cond.offset, slot);
  }
  if (cond.kind === "sload") {
    return condUsesSlotArithmetically(cond.slot, slot);
  }
  if (cond.kind === "keccak") {
    return cond.words.some((word) => condUsesSlotArithmetically(word, slot));
  }
  if (cond.kind === "op") {
    return cond.args.some((arg) => condUsesSlotArithmetically(arg, slot));
  }
  return false;
}

// Whether the transfer path prices the slot as a fee rate: any member
// jump condition multiplying or dividing the loaded slot. A fee-cap
// clamp over the computed fee then proves no limit for that slot.
// Exported for the extended-proof diagnostics.
export function transferUsesSlotArithmetically(
  bytecode: DetectorInput["bytecode"],
  transferSelector: SelectorType,
  slot: number,
): boolean {
  const gateExprs = interpretRegionExprs(bytecode, transferSelector);
  for (const [, cond] of gateExprs.jumpis) {
    if (condUsesSlotArithmetically(cond, slot)) {
      return true;
    }
  }
  return false;
}

// Whether a paired reverting jump proves a limit on the slot
// (precision, P-11 follow-up): a limits fact needs a compare between
// the transferred amount or a resulting balance and the guarded slot
// value whose failing side reverts. An unresolved condition keeps the
// legacy proof; a resolved one must test the slot, and a less-than or
// greater-than must pit the amount or balance against the slot with no
// MUL/DIV arithmetic on the other side. A slot only used in arithmetic
// (fee equals amount times rate over 10000, clamped at a max) never
// proves a limit.
function gateProvesLimit(cond: Expr | undefined, slot: number): boolean {
  if (cond === undefined || cond.kind === "unknown") {
    return true;
  }
  if (!exprLoadsSlot(cond, slot)) {
    return false;
  }
  const { inner } = stripIszero(cond);
  if (inner.kind !== "op" || (inner.name !== "LT" && inner.name !== "GT")) {
    return true;
  }
  const left = inner.args[0];
  const right = inner.args[1];
  const slotLeft = exprLoadsSlot(left, slot);
  const slotRight = exprLoadsSlot(right, slot);
  const other = slotLeft ? right : slotRight ? left : undefined;
  if (other === undefined) {
    return false;
  }
  return exprLoadsAmountOrBalance(other) && !exprHoldsMulDiv(other);
}

// First member JUMPI past the compare whose failing fall-through side
// reverts and whose condition proves a limit on the slot. Every JUMPI
// in the window gets its chance, mirroring the legacy gate search, so
// split gates keep proving while fee-clamp and unrelated reverts drop
// out through the condition proof.
function revertingLimitGatePc(
  bytecode: DetectorInput["bytecode"],
  code: readonly Instruction[],
  gateMember: (pc: number) => boolean,
  jumpis: ReadonlyMap<number, Expr>,
  afterPc: number,
  slot: number,
): number | null {
  for (const candidate of code) {
    if (!gateMember(candidate.pc) || candidate.opcode !== 0x57) {
      continue;
    }
    if (candidate.pc <= afterPc || candidate.pc > afterPc + 64) {
      continue;
    }
    if (
      hasRevertingSide(bytecode, code, gateMember, candidate.pc, "fall") &&
      gateProvesLimit(jumpis.get(candidate.pc), slot)
    ) {
      return candidate.pc;
    }
  }
  return null;
}

// Transfer gate proof for one limit slot (P-11 follow-up): the beside
// compare with a reverting jump, or the helper-interleaved linear scan
// when the compare sits past an internal helper return. Exported for the
// extended-proof diagnostics beside the detectors, which re-run the same
// search to explain a missing fact.
export function limitTransferGate(
  bytecode: DetectorInput["bytecode"],
  code: readonly Instruction[],
  gateMember: (pc: number) => boolean,
  jumpis: ReadonlyMap<number, Expr>,
  transfer: RegionFacts,
  slot: number,
): { readonly loadPc: number } | null {
  const memberProof = constSlotLoadNearFlavor(transfer, slot, ["lt", "gt"], EXTENDED_LIMIT_WINDOW_PC);
  if (memberProof !== null) {
    const jumpiPc = revertingLimitGatePc(
      bytecode,
      code,
      gateMember,
      jumpis,
      memberProof.gatePc,
      slot,
    );
    if (jumpiPc !== null) {
      return { loadPc: memberProof.loadPc };
    }
  }
  // Helper-interleaved compare: the load sits in the transfer region,
  // but the LT/GT lands in the small continuation block after an
  // internal helper returns, so it belongs to no region's opcode list.
  // Scan the linear stream forward from the member load instead: a
  // compare in the window whose following jump reverts on its fall side
  // proves the gate. The paired jump must still test the slot
  // (precision): a nearby unrelated revert, or a fee-clamp compare over
  // MUL/DIV arithmetic, never proves a limit.
  for (const load of transfer.loads) {
    if (load.slot.kind !== "const" || load.slot.value !== slot) {
      continue;
    }
    for (const candidate of code) {
      if (candidate.pc <= load.pc || candidate.pc > load.pc + 96) {
        continue;
      }
      if (candidate.opcode !== 0x10 && candidate.opcode !== 0x11) {
        continue;
      }
      for (const jump of code) {
        if (jump.pc <= candidate.pc || jump.pc > candidate.pc + 64 || jump.opcode !== 0x57) {
          continue;
        }
        // The paired jump must belong to the transfer path (SCAN-3): a
        // reverting jump of another function in the window (a writer
        // guard, say) never proves this compare gates a transfer.
        if (!gateMember(jump.pc)) {
          continue;
        }
        if (
          hasRevertingSide(bytecode, code, gateMember, jump.pc, "fall") &&
          gateProvesLimit(jumpis.get(jump.pc), slot)
        ) {
          return { loadPc: load.pc };
        }
      }
    }
  }
  return null;
}

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
  // A packed bool write to a slot (a flag packed beside other fields)
  // is a toggle, never a limit amount, even though its stored word is
  // computed: such slots never become limit candidates.
  const isPackedBoolStore = (
    slot: number,
    pc: number,
    slotOf: SlotLookup,
    exprs: ReturnType<typeof interpretRegionExprs>,
  ): boolean => {
    if (packedBoolWriteExpr(slot, exprs.stores.get(pc)) !== null) {
      return true;
    }
    const index = sstoreIndexAt(pc);
    return index >= 0 && packedBoolWriteAt(code, index, slot, slotOf) !== null;
  };
  const candidates = new Set<number>();
  for (const region of view.regions) {
    if (isStandardTokenWriter(region.selector)) {
      continue;
    }
    const slots = interpretRegionSlots(input.bytecode, region.selector);
    const slotOf: SlotLookup = (pc) => slots.get(pc);
    const exprs = interpretRegionExprs(input.bytecode, region.selector);
    if (!writerGuarded(code, memberOf(region.selector), ownerSlot, slotOf, exprs.jumpis, input.bytecode)) {
      continue;
    }
    for (const store of region.stores) {
      if (store.slot.kind !== "const") {
        continue;
      }
      if (isPackedBoolStore(store.slot.value, store.pc, slotOf, exprs)) {
        continue;
      }
      if ((!store.valueIsZero && store.valueConst === null) || (store.valueConst !== null && store.valueConst > 1)) {
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
      const writePc = limitWriter(region, slot);
      if (writePc === null || isPackedBoolStore(slot, writePc, writerSlotOf, writerExprs)) {
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
        if (transferUsesSlotArithmetically(input.bytecode, transferSelector, slot)) {
          continue;
        }
        const gateMember = memberOf(transferSelector);
        const gateExprs = interpretRegionExprs(input.bytecode, transferSelector);
        let proof = limitTransferGate(
          input.bytecode,
          code,
          gateMember,
          gateExprs.jumpis,
          transfer,
          slot,
        );
        if (proof === null) {
          // Enforce-style expression gate (SCAN-2): a transfer jump whose
          // own condition compares the amount or a balance against the
          // limit slot, reverting on either side.
          const ordered = [...gateExprs.jumpis.entries()].sort((left, right) => left[0] - right[0]);
          for (const [pc, cond] of ordered) {
            if (!gateMember(pc) || cond === undefined || cond.kind === "unknown") {
              continue;
            }
            const { inner } = stripIszero(cond);
            if (inner.kind !== "op" || (inner.name !== "LT" && inner.name !== "GT")) {
              continue;
            }
            if (!gateProvesLimit(cond, slot)) {
              continue;
            }
            if (
              hasRevertingSide(input.bytecode, code, gateMember, pc, "fall") ||
              hasRevertingSide(input.bytecode, code, gateMember, pc, "jump")
            ) {
              proof = { loadPc: pc };
              break;
            }
          }
        }
        if (proof === null) {
          continue;
        }
        const holdersOfWrite = [...attribution.holdersOf(writePc)].sort();
        const firstWriteHolder = holdersOfWrite[0] === undefined ? null : holdersOfWrite[0];
        const holder =
          attribution.holderOf(writePc) ??
          (holdersOfWrite.includes(region.selector) ? region.selector : firstWriteHolder);
        const holdersOfGate = [...attribution.holdersOf(proof.loadPc)].sort();
        const firstGateHolder = holdersOfGate[0] === undefined ? null : holdersOfGate[0];
        const gateHolder =
          attribution.holderOf(proof.loadPc) ??
          (holdersOfGate.includes(transferSelector) ? transferSelector : firstGateHolder);
        if (holder === null || gateHolder === null) {
          continue;
        }
        const evidence: EvidenceType[] = [];
        const written = evidenceFor(input.bytecode, holder, writePc);
        if (written !== null) {
          evidence.push(written);
        }
        const read = evidenceFor(input.bytecode, gateHolder, proof.loadPc);
        if (read !== null) {
          evidence.push(read);
        }
        const nonEmpty = toNonEmpty(evidence);
        if (nonEmpty === null) {
          continue;
        }
        return Object.freeze([
          Object.freeze({
            id: `${PLUGIN_ID}:transfer-limits-extended`,
            pluginId: MANIFEST.id,
            title:
              "The owner can cap how much a wallet may send or hold. Found by extended analysis; not counted in the score.",
            evidence: nonEmpty,
            payload: Object.freeze({ fact: "transfer-limits", slot, limitKind: kindOf(transfer), proof: "extended" }),
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

export const transferLimitsDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
