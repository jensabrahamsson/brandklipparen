// Transfer-fee detector plugin `dev.brandklipparen.transfer-fee` (S-115,
// P-12 step 1). First-party detector behind the registry: proves an
// owner-settable transfer fee from code paths. A finding needs a
// privileged writer storing a caller-chosen rate (a computed, non-constant
// value) to a constant fee slot, and a transfer path that loads the same
// slot beside multiply or divide arithmetic (the rate application) with a
// subtraction in the region (the deduction from the transfer amount). The
// writer and the reader may share one merged function.
// The max-fee bound is the largest constant the setter
// compares with while bounding (LT or GT present), capped at basis-point
// sense: a bound above 10000, or no bounding compare at all, reports a
// null bound instead of a guess. A fee slot the transfer path never
// computes with, a hardcoded constant rate, or fee arithmetic with no
// privileged writer, stays silent. Pure and synchronous: this module
// imports solely the plugin API and domain types and pure functions
// (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import {
  TRANSFER_FROM_SELECTOR,
  TRANSFER_SELECTOR,
  analyzeOwnerControl,
  constSlotLoadNearFlavor,
  feeArithProven,
  interpretRegionExprs,
  interpretRegionSlots,
  isStandardTokenWriter,
  ownerCheckVia,
} from "../../../domain/ownerControl.ts";
import type { Expr, RegionFacts, SlotLookup } from "../../../domain/ownerControl.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import type { FunctionAttribution } from "../../../domain/evmFlow.ts";
import { disassemble, extractSelectors } from "../../../domain/selectors.ts";
import type { Selector as SelectorType } from "../../../domain/types.ts";
import { PcOffset } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.transfer-fee";

// Basis-point sense cap for the reported max-fee bound: a fee cap above
// one hundred percent is not a cap, so the bound stays unknown instead
// of reporting a meaningless constant.
const MAX_SANE_BASIS_POINTS = 10000;

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
        required: Object.freeze(["slot"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "transfer-fee" }),
          fact: Object.freeze({ const: "transfer-fee" }),
          proof: Object.freeze({ const: "extended" }),
          slot: Object.freeze({ type: "integer", minimum: 0 }),
          maxFeeBasisPoints: Object.freeze({ type: Object.freeze(["integer", "null"]), minimum: 0 }),
          capSlot: Object.freeze({ type: Object.freeze(["integer", "null"]), minimum: 0 }),
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
    displayName: "Transfer-fee detector",
    description: "Reports a fee slot set by a privileged caller and used arithmetically in the transfer path.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`transfer-fee plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`transfer-fee plugin manifest carries kind ${parsed.value.kind}, expected detector`);
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

// Largest constant PUSH in the setter region while it bounds with LT or
// GT, or null when the setter carries no bounding compare or no sane
// constant to report.
function maxFeeBound(bytecode: DetectorInput["bytecode"], entryPc: number, endPc: number): number | null {
  let bounded = false;
  let best: number | null = null;
  for (const instruction of disassemble(bytecode)) {
    if (instruction.pc < entryPc || instruction.pc >= endPc) {
      continue;
    }
    if (instruction.opcode === 0x10 || instruction.opcode === 0x11) {
      bounded = true;
    }
    if (instruction.opcode >= 0x60 && instruction.opcode <= 0x7f) {
      let value = 0;
      let fits = true;
      for (let i = 0; i < instruction.immediate.length; i += 1) {
        value = value * 256 + (instruction.immediate[i] ?? 0);
        if (value > MAX_SANE_BASIS_POINTS) {
          fits = false;
          break;
        }
      }
      if (fits && (best === null || value > best)) {
        best = value;
      }
    }
  }
  if (!bounded || best === null) {
    return null;
  }
  return best;
}

// Privileged fee proof over the frozen input. Total: arbitrary bytecode
// yields a finding list, never an exception. Deterministic: candidate
// slots scan ascending and the lowest provable slot wins. Bytecode without
// selectors yields no findings, since a finding without selector evidence
// is unrepresentable.
// An owner-settable rate: the writer stores a computed value (from the
// caller's argument), never a hardcoded constant, so the owner can change
// the rate after deployment.
function feeWriter(region: RegionFacts, slot: number): number | null {
  const store = region.stores.find(
    (candidate) => candidate.slot.kind === "const" && candidate.slot.value === slot && !candidate.valueIsZero,
  );
  if (store === undefined) {
    return null;
  }
  if (store.valueConst !== null) {
    return null;
  }
  return store.pc;
}

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
      if (store.slot.kind === "const" && !store.valueIsZero && store.valueConst === null) {
        candidates.add(store.slot.value);
      }
    }
  }
  const orderedSlots = [...candidates].sort((left, right) => left - right);
  const orderedRegions = view.regions.slice().sort((left, right) => left.entryPc - right.entryPc);
  for (const slot of orderedSlots) {
    for (let order = 0; order < orderedRegions.length; order += 1) {
      const region = orderedRegions[order];
      if (region === undefined) {
        continue;
      }
      const following = orderedRegions[order + 1];
      const regionEnd = following === undefined ? Number.MAX_SAFE_INTEGER : following.entryPc;
      if (!privilegedSet.has(region.selector)) {
        continue;
      }
      const writePc = feeWriter(region, slot);
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
        const proof = constSlotLoadNearFlavor(transfer, slot, ["mul", "div"]);
        if (proof === null) {
          continue;
        }
        // F-10d: an unpack shift (DIV by a power of two) beside the
        // load, or arithmetic with no calldata operand, never proves
        // a rate application.
        const transferMember = (pc: number): boolean => attribution.holderOf(pc) === transferSelector;
        if (!feeArithProven(code, transferMember, proof.gatePc)) {
          continue;
        }
        if (writePc === proof.loadPc) {
          continue;
        }
        if (!transfer.hasSub) {
          continue;
        }
        const holder = attribution.holderOf(writePc);
        const readerHolder = attribution.holderOf(proof.loadPc);
        if (holder === null || readerHolder === null) {
          continue;
        }
        const evidence: EvidenceType[] = [];
        const write = evidenceFor(input.bytecode, holder, writePc);
        if (write !== null) {
          evidence.push(write);
        }
        const seen = evidenceFor(input.bytecode, readerHolder, proof.loadPc);
        if (seen !== null) {
          evidence.push(seen);
        }
        const nonEmpty = toNonEmpty(evidence);
        if (nonEmpty === null) {
          continue;
        }
        return Object.freeze([
          Object.freeze({
            id: `${PLUGIN_ID}:transfer-fee`,
            pluginId: MANIFEST.id,
            title: "Privileged caller sets a fee slot used arithmetically in the transfer path",
            evidence: nonEmpty,
            payload: Object.freeze({
              feature: "transfer-fee",
              slot,
              maxFeeBasisPoints: maxFeeBound(input.bytecode, region.entryPc, regionEnd),
            }),
          }),
        ]);
      }
    }
  }
  return Object.freeze([]);
}

// Extended-analysis helpers (P-11 follow-up, weight-0 facts only; the
// scored path above never reads them).

// Wider beside window for the extended rate proof: real compiler output
// separates the rate load from its use further than the scored window.
const EXTENDED_FEE_WINDOW_PC = 64;

// Backward scan window for the straight-line rate fallback: branch and
// bookkeeping code between the rate load and its multiply can span
// hundreds of PCs in real compiler output.
const EXTENDED_STRAIGHT_LINE_WINDOW_PC = 512;

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

// Whether a transfer jump condition multiplies or divides the loaded
// rate slot as a fee (F-10d): a MUL or DIV node whose subtree loads the
// slot, with the transferred amount beside it (another operand subtree
// carrying calldata) and no constant power-of-two operand (an unpack
// shift like DIV by 256**20, straight or EXP-folded). The slot load and
// its use can sit hundreds of PCs apart in real compiler output, past
// any beside window, while the condition still names both. A bare unpack
// of a packed flag (no calldata operand) never counts as fee arithmetic.
// Exported for the extended-proof diagnostics.
export function condUsesSlotArithmetically(cond: Expr | undefined, slot: number): boolean {
  if (cond === undefined || cond.kind === "unknown") {
    return false;
  }
  if (
    cond.kind === "op" &&
    (cond.name === "MUL" || cond.name === "DIV") &&
    cond.args.some((arg) => exprLoadsSlot(arg, slot))
  ) {
    if (feeOperandsProven(cond.args)) {
      return true;
    }
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

// Fee operands (F-10d): no constant power of two among the MUL/DIV args
// (an unpack shift) and a calldata operand (the transferred amount).
function feeOperandsProven(args: readonly Expr[]): boolean {
  if (args.some((arg) => exprIsPow2Const(arg))) {
    return false;
  }
  return args.some((arg) => exprHasCalldata(arg));
}

function exprHasCalldata(expr: Expr | undefined): boolean {
  if (expr === undefined) {
    return false;
  }
  if (expr.kind === "calldata") {
    return true;
  }
  if (expr.kind === "sload") {
    return exprHasCalldata(expr.slot);
  }
  if (expr.kind === "keccak") {
    return expr.words.some((word) => exprHasCalldata(word));
  }
  if (expr.kind === "op") {
    return expr.args.some((arg) => exprHasCalldata(arg));
  }
  return false;
}

function exprIsPow2Const(expr: Expr | undefined): boolean {
  if (expr === undefined || expr.kind !== "const") {
    return false;
  }
  return expr.value >= 2n && (expr.value & (expr.value - 1n)) === 0n;
}

function holderFor(
  attribution: FunctionAttribution,
  region: RegionFacts,
  pc: number,
): SelectorType {
  const single = attribution.holderOf(pc);
  if (single !== null) {
    return single;
  }
  const holders = [...attribution.holdersOf(pc)].sort();
  if (holders.includes(region.selector)) {
    return region.selector;
  }
  const first = holders[0];
  return first === undefined ? region.selector : first;
}

// Extended fee analysis (P-11 follow-up, weight-0 fact): a guarded writer
// sets rate slot(s) that the transfer path uses as a rate in MUL/DIV with
// the transferred amount, and the result is subtracted from the amount.
// The rate proof runs beside the load (wider window than the scored
// proof) or through a transfer jump condition that multiplies or divides
// the loaded slot. A second guarded slot the transfer path clamps with
// LT/GT reports as the cap slot. It runs only when the v1 proof found
// nothing, so a scored finding always wins. The payload carries `fact`
// (never `feature`) with `proof: "extended"`, so the finding never
// converts to a signal and stays at weight 0. Fee arithmetic with no
// privileged writer, or a hardcoded constant rate, stays silent.
function detectExtended(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode, { mode: "v2" });
  const view = analyzeOwnerControl(input.bytecode, { reach: "v2" });
  if (view.ownerSlot === null) {
    return Object.freeze([]);
  }
  const ownerSlot = view.ownerSlot;
  const code = disassemble(input.bytecode);
  const memberOf = (selector: SelectorType): ((pc: number) => boolean) => {
    return (pc: number): boolean => attribution.holdersOf(pc).includes(selector);
  };
  const candidates = new Set<number>();
  for (const region of view.regions) {
    if (isStandardTokenWriter(region.selector)) {
      continue;
    }
    const slots = interpretRegionSlots(input.bytecode, region.selector);
    const slotOf: SlotLookup = (pc) => slots.get(pc);
    const exprs = interpretRegionExprs(input.bytecode, region.selector);
    if (
      ownerCheckVia(code, memberOf(region.selector), ownerSlot, slotOf, exprs.jumpis, input.bytecode) ===
      null
    ) {
      continue;
    }
    for (const store of region.stores) {
      // The owner seat holds an address, never a fee rate.
      if (store.slot.kind === "const" && store.slot.value === ownerSlot) {
        continue;
      }
      if (store.slot.kind === "const" && !store.valueIsZero && store.valueConst === null) {
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
      if (
        ownerCheckVia(code, writerMember, ownerSlot, writerSlotOf, writerExprs.jumpis, input.bytecode) ===
        null
      ) {
        continue;
      }
      const writePc = feeWriter(region, slot);
      if (writePc === null) {
        continue;
      }
      const transferSelectors = [TRANSFER_SELECTOR, TRANSFER_FROM_SELECTOR]
        .filter((selector) => selector !== region.selector)
        .sort();
      for (const transferSelector of transferSelectors) {
        const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
        if (transfer === undefined || !transfer.hasSub) {
          continue;
        }
        const gateMember = memberOf(transferSelector);
        const windowProof = constSlotLoadNearFlavor(transfer, slot, ["mul", "div"], EXTENDED_FEE_WINDOW_PC);
        // F-10d: an unpack shift beside the load, or arithmetic with
        // no calldata operand, never proves a rate application.
        const windowProven =
          windowProof !== null && feeArithProven(code, gateMember, windowProof.gatePc, EXTENDED_FEE_WINDOW_PC);
        let usePc: number | null = windowProven && windowProof !== null ? windowProof.loadPc : null;
        if (usePc === null) {
          const gateExprs = interpretRegionExprs(input.bytecode, transferSelector);
          for (const [pc, cond] of gateExprs.jumpis) {
            if (gateMember(pc) && condUsesSlotArithmetically(cond, slot)) {
              usePc = pc;
              break;
            }
          }
        }
        if (usePc === null) {
          // Straight-line rate arithmetic: the rate load (often one
          // field of a multi-slot fee struct, summed with its siblings)
          // can sit far before the multiply, past both the beside
          // window and every jump condition. A load followed by a
          // MUL/DIV the fee proof accepts, with the region subtraction
          // already required above, still proves the rate application.
          const rateLoad = transfer.loads.find(
            (load) => load.slot.kind === "const" && load.slot.value === slot,
          );
          const arithPcs = [...transfer.opPcs.mul, ...transfer.opPcs.div].sort(
            (left, right) => left - right,
          );
          if (
            rateLoad !== undefined &&
            arithPcs.some(
              (pc) =>
                pc > rateLoad.pc &&
                feeArithProven(code, gateMember, pc, EXTENDED_STRAIGHT_LINE_WINDOW_PC),
            )
          ) {
            usePc = rateLoad.pc;
          }
        }
        if (usePc === null) {
          continue;
        }
        let capSlot: number | null = null;
        for (const store of region.stores) {
          if (store.slot.kind !== "const" || store.slot.value === slot || store.slot.value === ownerSlot) {
            continue;
          }
          if (constSlotLoadNearFlavor(transfer, store.slot.value, ["lt", "gt"], EXTENDED_FEE_WINDOW_PC) !== null) {
            capSlot = capSlot === null ? store.slot.value : Math.min(capSlot, store.slot.value);
          }
        }
        const evidence: EvidenceType[] = [];
        const written = evidenceFor(input.bytecode, holderFor(attribution, region, writePc), writePc);
        if (written !== null) {
          evidence.push(written);
        }
        const seen = evidenceFor(input.bytecode, holderFor(attribution, transfer, usePc), usePc);
        if (seen !== null) {
          evidence.push(seen);
        }
        const nonEmpty = toNonEmpty(evidence);
        if (nonEmpty === null) {
          continue;
        }
        return Object.freeze([
          Object.freeze({
            id: `${PLUGIN_ID}:transfer-fee-extended`,
            pluginId: MANIFEST.id,
            title:
              "The owner can change the fee taken on each transfer. Found by extended analysis; not counted in the score.",
            evidence: nonEmpty,
            payload: Object.freeze({ fact: "transfer-fee", slot, capSlot, proof: "extended" }),
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

export const transferFeeDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
