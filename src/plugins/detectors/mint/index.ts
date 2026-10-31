// Mint detector plugin `dev.brandklipparen.mint` (S-115, P-12 step 1).
// First-party detector behind the registry: proves a privileged mint from
// code paths instead of matching admin selectors. The scored proof needs
// a privileged writer that increases a constant supply slot (addition
// beside the store) and credits a caller-chosen balance (a mapping store
// beside calldata in the same writer region), plus a transfer path that
// loads the same slot beside addition arithmetic. The writer and the
// reader may live in the same function when solc merges code into one
// region; evidence still names each containing function. A guarded write
// with no supply increase, no balance credit, or no transfer read stays
// silent: the proof is incomplete, so no positive finding is reported.
// When the scored proof finds nothing, the same search re-runs on the v2
// reachability view (P-12) and emits a weight-0 `fact` finding with
// `proof: "extended"` that never converts to a signal: the supply slot is
// the constant slot the totalSupply() region loads, the guard may be an
// owner check, a minter role-slot check or an auth-mapping check, and the
// transfer-path read requirement drops. Pure and synchronous: this module
// imports solely the plugin API and domain types and pure functions
// (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import {
  SLOT_FLAVOR_WINDOW_PC,
  analyzeOwnerControl,
  callGraphBodyPcs,
  constSlotLoadNearFlavor,
  interpretRegionExprs,
  interpretRegionSlots,
  isStandardTokenWriter,
  nearestFlavorPc,
  privilegedGuardKind,
  supplySlotOf,
} from "../../../domain/ownerControl.ts";
import type { Expr, RegionFacts, SlotLookup } from "../../../domain/ownerControl.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import type { FunctionAttribution } from "../../../domain/evmFlow.ts";
import { disassemble, extractSelectors } from "../../../domain/selectors.ts";
import type { Instruction } from "../../../domain/selectors.ts";
import type { Selector as SelectorType } from "../../../domain/types.ts";
import { PcOffset } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.mint";

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
          feature: Object.freeze({ const: "mint" }),
          fact: Object.freeze({ const: "mint" }),
          proof: Object.freeze({ const: "extended" }),
          slot: Object.freeze({ type: "integer", minimum: 0 }),
          auth: Object.freeze({
            enum: Object.freeze(["owner", "role-slot", "role-mapping"]),
          }),
          recipient: Object.freeze({ enum: Object.freeze(["argument", "stored"]) }),
          capped: Object.freeze({ type: "boolean" }),
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
    displayName: "Mint detector",
    description: "Reports a privileged caller-gated write that grows a supply-like slot read in the transfer path.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`mint plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`mint plugin manifest carries kind ${parsed.value.kind}, expected detector`);
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

// Privileged mint proof over the frozen input. Total: arbitrary bytecode
// yields a finding list, never an exception. Deterministic: one region
// scan in selector order, canonical evidence order, final sort on the
// namespaced finding id. Bytecode without selectors yields no findings,
// since a finding without selector evidence is unrepresentable. Scored
// (v1) proof: byte-identical, never extended.
function detectV1(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode);
  const view = analyzeOwnerControl(input.bytecode);
  const privilegedSet = new Set(view.privileged);
  const transferSet = new Set(view.transfers);
  // Candidate supply slots in ascending order: every constant slot a
  // privileged region stores to without zeroing. The lowest provable slot
  // wins, so equal inputs always name the same slot.
  const candidates = new Set<number>();
  for (const region of view.regions) {
    if (!privilegedSet.has(region.selector)) {
      continue;
    }
    for (const store of region.stores) {
      if (store.slot.kind === "const" && !store.valueIsZero) {
        candidates.add(store.slot.value);
      }
    }
  }
  const orderedSlots = [...candidates].sort((left, right) => left - right);
  for (const slot of orderedSlots) {
    const proof = proveMint(input.bytecode, attribution, view, privilegedSet, transferSet, slot);
    if (proof !== null) {
      return Object.freeze([proof]);
    }
  }
  return Object.freeze([]);
}

// A privileged supply increase with a balance credit to a caller-chosen
// address: the writer region stores to the constant slot with addition
// beside the store (the increase), and carries a mapping store beside
// calldata (the balance credit keyed by an address the caller chose).
function mintWriter(
  region: RegionFacts,
  slot: number,
): number | null {
  const store = region.stores.find(
    (candidate) => candidate.slot.kind === "const" && candidate.slot.value === slot && !candidate.valueIsZero,
  );
  if (store === undefined) {
    return null;
  }
  if (nearestFlavorPc(region, ["add"], store.pc) === null) {
    return null;
  }
  const credits = region.stores.some((candidate) => candidate.slot.kind === "mapping");
  if (!credits || !region.hasCalldataLoad) {
    return null;
  }
  return store.pc;
}

function proveMint(
  bytecode: DetectorInput["bytecode"],
  attribution: FunctionAttribution,
  view: ReturnType<typeof analyzeOwnerControl>,
  privilegedSet: ReadonlySet<string>,
  transferSet: ReadonlySet<string>,
  slot: number,
): PluginFinding | null {
  for (const region of view.regions) {
    if (!privilegedSet.has(region.selector)) {
      continue;
    }
    const writePc = mintWriter(region, slot);
    if (writePc === null) {
      continue;
    }
    // Distinct functions first, merged same-function proofs last: keeps
    // the two-function evidence stable while still proving merged solc
    // output where the writer and the reader share one region.
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
      const proof = constSlotLoadNearFlavor(transfer, slot, ["add"]);
      if (proof === null) {
        continue;
      }
      if (writePc === proof.loadPc) {
        continue;
      }
      const holder = attribution.holderOf(writePc);
      const readerHolder = attribution.holderOf(proof.loadPc);
      if (holder === null || readerHolder === null) {
        continue;
      }
      const evidence: EvidenceType[] = [];
      const write = evidenceFor(bytecode, holder, writePc);
      if (write !== null) {
        evidence.push(write);
      }
      const seen = evidenceFor(bytecode, readerHolder, proof.loadPc);
      if (seen !== null) {
        evidence.push(seen);
      }
      const nonEmpty = toNonEmpty(evidence);
      if (nonEmpty === null) {
        continue;
      }
      return Object.freeze({
        id: `${PLUGIN_ID}:mint`,
        pluginId: MANIFEST.id,
        title: "Privileged caller-gated write grows a supply-like slot read in the transfer path",
        evidence: nonEmpty,
        payload: Object.freeze({ feature: "mint", slot }),
      });
    }
  }
  return null;
}

// Extended-analysis helpers (P-12, weight-0 facts only; the scored path
// above never reads them).

// Whether an expression tree holds an SLOAD of the given constant slot.
function exprContainsSupplyLoad(expr: Expr | undefined, supply: number): boolean {
  if (expr === undefined) {
    return false;
  }
  if (expr.kind === "sload" && expr.slot.kind === "const" && expr.slot.value === BigInt(supply)) {
    return true;
  }
  if (expr.kind === "calldata") {
    return exprContainsSupplyLoad(expr.offset, supply);
  }
  if (expr.kind === "sload") {
    return exprContainsSupplyLoad(expr.slot, supply);
  }
  if (expr.kind === "keccak") {
    return expr.words.some((word) => exprContainsSupplyLoad(word, supply));
  }
  if (expr.kind === "op") {
    return expr.args.some((arg) => exprContainsSupplyLoad(arg, supply));
  }
  return false;
}

// Whether a stored value expression increases the supply slot: an ADD
// anywhere in the value whose operands load the supply slot. A burn
// stores a SUB-driven value and never matches.
function exprIsSupplyIncrease(value: Expr | undefined, supply: number): boolean {
  if (value === undefined) {
    return false;
  }
  if (
    value.kind === "op" &&
    value.name === "ADD" &&
    value.args.some((arg) => exprContainsSupplyLoad(arg, supply))
  ) {
    return true;
  }
  if (value.kind === "calldata") {
    return exprIsSupplyIncrease(value.offset, supply);
  }
  if (value.kind === "sload") {
    return exprIsSupplyIncrease(value.slot, supply);
  }
  if (value.kind === "keccak") {
    return value.words.some((word) => exprIsSupplyIncrease(word, supply));
  }
  if (value.kind === "op") {
    return value.args.some((arg) => exprIsSupplyIncrease(arg, supply));
  }
  return false;
}

// Whether an expression tree holds calldata (a caller-chosen amount or
// address flows in).
function exprContainsCalldata(expr: Expr | undefined): boolean {
  if (expr === undefined) {
    return false;
  }
  if (expr.kind === "calldata") {
    return true;
  }
  if (expr.kind === "sload") {
    return exprContainsCalldata(expr.slot);
  }
  if (expr.kind === "keccak") {
    return expr.words.some((word) => exprContainsCalldata(word));
  }
  if (expr.kind === "op") {
    return expr.args.some((arg) => exprContainsCalldata(arg));
  }
  return false;
}

// Whether an expression tree holds a stored load (an SLOAD anywhere,
// constant or mapping-derived).
function exprContainsStoredLoad(expr: Expr | undefined): boolean {
  if (expr === undefined) {
    return false;
  }
  if (expr.kind === "sload") {
    return true;
  }
  if (expr.kind === "calldata") {
    return exprContainsStoredLoad(expr.offset);
  }
  if (expr.kind === "keccak") {
    return expr.words.some((word) => exprContainsStoredLoad(word));
  }
  if (expr.kind === "op") {
    return expr.args.some((arg) => exprContainsStoredLoad(arg));
  }
  return false;
}

// The pushed value beside an SSTORE of the shape PUSH value, PUSH slot,
// SSTORE: zero exactly for PUSH0 or all-zero PUSH, the constant for any
// other short PUSH, null otherwise. Local to the extended proof; the
// scored path owns its own reader and never changes.
function adjacentStoreZero(insns: readonly Instruction[], index: number): boolean | null {
  const slotPush = insns[index - 1];
  if (
    slotPush === undefined ||
    (slotPush.opcode !== 0x5f && !(slotPush.opcode >= 0x60 && slotPush.opcode <= 0x7f))
  ) {
    return null;
  }
  const valuePush = insns[index - 2];
  if (valuePush === undefined) {
    return null;
  }
  if (valuePush.opcode === 0x5f) {
    return true;
  }
  if (valuePush.opcode >= 0x60 && valuePush.opcode <= 0x7f) {
    return valuePush.immediate.every((byte) => byte === 0);
  }
  return null;
}

// The constant slot behind an SSTORE: the slot push directly beside the
// store, or past DUP/SWAP shuffles compilers leave between the push and
// its use. Null when no short slot push shows through. Local to the
// extended proof.
function adjacentStoreSlot(insns: readonly Instruction[], index: number): number | null {
  for (let back = index - 1, steps = 0; back >= 0 && steps < 8; back -= 1, steps += 1) {
    const candidate = insns[back];
    if (candidate === undefined) {
      return null;
    }
    if (candidate.opcode === 0x5f) {
      return 0;
    }
    if (candidate.opcode >= 0x60 && candidate.opcode <= 0x7f) {
      if (candidate.immediate.length === 0 || candidate.immediate.length > 4) {
        return null;
      }
      let value = 0;
      for (const byte of candidate.immediate) {
        value = value * 256 + (byte ?? 0);
      }
      return value;
    }
    if (candidate.opcode >= 0x80 && candidate.opcode <= 0x9f) {
      continue;
    }
    return null;
  }
  return null;
}

export type BodyStore = {
  readonly pc: number;
  readonly slot: number;
  readonly member: boolean;
};

export type BodyCredit = {
  readonly pc: number;
  readonly recipient: "argument" | "stored";
};

// Supply and balance stores over the writer body (member PCs plus return
// continuations): constant-slot supply stores resolve through the v2
// interpreter or the adjacent slot push; mapping stores resolve through
// the region, the interpreter, or the keccak window. Zeroing supply
// stores never count: a mint grows supply. Deterministic: ascending pc.
// Exported for the extended-proof diagnostics beside the detectors,
// which re-run the same search to explain a missing fact.
export function bodyStores(
  code: readonly Instruction[],
  body: ReadonlySet<number>,
  isMember: (pc: number) => boolean,
  slotOf: SlotLookup,
  region: RegionFacts,
  supply: number,
): { readonly supplyStores: readonly BodyStore[]; readonly credits: readonly BodyCredit[] } {
  const supplyStores: BodyStore[] = [];
  const credits: BodyCredit[] = [];
  const memberSupply = new Set<number>();
  for (const store of region.stores) {
    if (store.slot.kind === "const" && store.slot.value === supply && !store.valueIsZero) {
      memberSupply.add(store.pc);
    }
  }
  for (let index = 0; index < code.length; index += 1) {
    const instruction = code[index];
    if (instruction === undefined || instruction.opcode !== 0x55 || !body.has(instruction.pc)) {
      continue;
    }
    const member = isMember(instruction.pc);
    const interpreted = slotOf(instruction.pc);
    if (member && memberSupply.has(instruction.pc)) {
      supplyStores.push({ pc: instruction.pc, slot: supply, member });
      continue;
    }
    if (interpreted !== undefined && interpreted.kind === "const" && interpreted.value === supply) {
      if (adjacentStoreZero(code, index) === true) {
        continue;
      }
      supplyStores.push({ pc: instruction.pc, slot: supply, member });
      continue;
    }
    if (adjacentStoreSlot(code, index) === supply) {
      if (adjacentStoreZero(code, index) === true) {
        continue;
      }
      supplyStores.push({ pc: instruction.pc, slot: supply, member });
      continue;
    }
    const memberMapping =
      member &&
      region.stores.some(
        (store) => store.pc === instruction.pc && store.slot.kind === "mapping",
      );
    const interpretedMapping = interpreted !== undefined && interpreted.kind === "mapping";
    let windowMapping = false;
    if (!memberMapping && !interpretedMapping) {
      let steps = 0;
      for (let back = index - 1; back >= 0 && steps < 12; back -= 1, steps += 1) {
        const candidate = code[back];
        if (candidate === undefined) {
          break;
        }
        if (!body.has(candidate.pc)) {
          continue;
        }
        if (candidate.opcode === 0x20) {
          windowMapping = true;
          break;
        }
      }
    }
    if (memberMapping || interpretedMapping || windowMapping) {
      credits.push({ pc: instruction.pc, recipient: "stored" });
    }
  }
  supplyStores.sort((left, right) => left.pc - right.pc);
  credits.sort((left, right) => left.pc - right.pc);
  return { supplyStores, credits };
}

// Whether the SLOAD at a body index loads the constant supply slot:
// the slot push directly beside it names it, or the interpreter
// resolved it through the stack.
function sloadIsSupply(
  code: readonly Instruction[],
  index: number,
  slotOf: SlotLookup,
  supply: number,
): boolean {
  const push = code[index - 1];
  if (push !== undefined) {
    if (push.opcode === 0x5f && supply === 0) {
      return true;
    }
    if (push.opcode >= 0x60 && push.opcode <= 0x7f && push.immediate.length <= 4) {
      let value = 0;
      for (const byte of push.immediate) {
        value = value * 256 + (byte ?? 0);
      }
      if (value === supply) {
        return true;
      }
    }
  }
  const loadPc = code[index]?.pc;
  if (loadPc === undefined) {
    return false;
  }
  const interpreted = slotOf(loadPc);
  return interpreted !== undefined && interpreted.kind === "const" && interpreted.value === supply;
}

// Increase proof for one supply store: the interpreter value adds the
// supply slot (expression rule), an ADD sits beside the store with no
// SUB beside it (window rule), or a supply load sits before the store
// with an ADD in the body and no SUB between (subroutine rule for
// safe-math stores past a dynamic return, where the addition lives in
// the called helper). A burn (SUB-driven value) proves none of the
// three.
// Exported for the extended-proof diagnostics.
export function supplyIncrease(
  code: readonly Instruction[],
  body: ReadonlySet<number>,
  slotOf: SlotLookup,
  value: Expr | undefined,
  storePc: number,
  supply: number,
): boolean {
  if (exprIsSupplyIncrease(value, supply)) {
    return true;
  }
  let addNear = false;
  let subNear = false;
  for (const instruction of code) {
    if (!body.has(instruction.pc)) {
      continue;
    }
    if (Math.abs(instruction.pc - storePc) <= SLOT_FLAVOR_WINDOW_PC) {
      if (instruction.opcode === 0x01) {
        addNear = true;
      }
      if (instruction.opcode === 0x03) {
        subNear = true;
      }
    }
  }
  if (addNear && !subNear) {
    return true;
  }
  let loadPc: number | null = null;
  for (let index = 0; index < code.length; index += 1) {
    const instruction = code[index];
    if (
      instruction !== undefined &&
      instruction.opcode === 0x54 &&
      instruction.pc < storePc &&
      body.has(instruction.pc) &&
      sloadIsSupply(code, index, slotOf, supply)
    ) {
      loadPc = instruction.pc;
    }
  }
  if (loadPc === null) {
    return false;
  }
  let addInBody = false;
  for (const instruction of code) {
    if (!body.has(instruction.pc)) {
      continue;
    }
    if (instruction.opcode === 0x01) {
      addInBody = true;
    }
    if (instruction.opcode === 0x03 && instruction.pc > loadPc && instruction.pc < storePc) {
      return false;
    }
  }
  return addInBody;
}

// Strip a leading ISZERO chain, mirroring the domain proof. Local copy:
// the domain helper stays private and the scored path never changes.
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

function exprConstOf(expr: Expr | undefined): bigint | null {
  if (expr !== undefined && expr.kind === "const") {
    return expr.value;
  }
  return null;
}

// Whether one side of a cap compare carries the minted amount: calldata
// or a load of the supply slot.
function capAmountSide(side: Expr | undefined, supply: number): boolean {
  return exprContainsCalldata(side) || exprContainsSupplyLoad(side, supply);
}

// Whether one side of a cap compare is an independent bound: a constant
// or a stored slot other than the supply seat. An overflow assert
// compares the increase against itself, never against such a bound.
function capBoundSide(side: Expr | undefined, supply: number): boolean {
  if (side === undefined) {
    return false;
  }
  if (exprConstOf(side) !== null) {
    return true;
  }
  if (side.kind === "sload" && side.slot.kind === "const" && side.slot.value !== BigInt(supply)) {
    return true;
  }
  return false;
}

// Capped proof (P-12): a GT/LT compare in the writer pits the minted
// amount or supply against an independent constant or stored cap. When
// the interpreter resolved no compare at all but the writer still
// carries a less-than or greater-than, the cap holds by shape (the
// time-gated and capped real writer the walk cannot fully reach).
// Exported for the extended-proof diagnostics.
export function writerCapped(
  region: RegionFacts,
  jumpis: ReadonlyMap<number, Expr>,
  supply: number,
): boolean {
  let sawCompare = false;
  for (const [, cond] of jumpis) {
    if (cond.kind === "unknown") {
      continue;
    }
    const { inner } = stripIszero(cond);
    if (inner.kind !== "op" || (inner.name !== "LT" && inner.name !== "GT")) {
      continue;
    }
    sawCompare = true;
    const left = inner.args[0];
    const right = inner.args[1];
    if (
      (capAmountSide(left, supply) && capBoundSide(right, supply)) ||
      (capAmountSide(right, supply) && capBoundSide(left, supply))
    ) {
      return true;
    }
  }
  if (sawCompare) {
    return false;
  }
  return region.opPcs["lt"].length > 0 || region.opPcs["gt"].length > 0;
}

// Recipient of the balance credit: the credited mapping key derives from
// a caller-chosen argument, or from a stored account such as the owner.
// The interpreter names the key when it reaches the store; otherwise the
// key source behind the 0x00-word store decides.
// Exported for the extended-proof diagnostics.
export function creditRecipient(
  code: readonly Instruction[],
  body: ReadonlySet<number>,
  slot: Expr | undefined,
  creditPc: number,
): "argument" | "stored" {
  if (slot !== undefined && slot.kind === "keccak" && slot.words.length > 0) {
    const key = slot.words[0];
    if (exprContainsStoredLoad(key)) {
      return "stored";
    }
    if (exprContainsCalldata(key)) {
      return "argument";
    }
  }
  let creditIndex = -1;
  for (let index = 0; index < code.length; index += 1) {
    if (code[index]?.pc === creditPc) {
      creditIndex = index;
      break;
    }
  }
  if (creditIndex >= 0) {
    for (let back = creditIndex - 1, steps = 0; back >= 0 && steps < 40; back -= 1, steps += 1) {
      const candidate = code[back];
      if (candidate === undefined || !body.has(candidate.pc) || candidate.opcode !== 0x52) {
        continue;
      }
      const offset = code[back - 1];
      const source = code[back - 2];
      if (
        offset !== undefined &&
        offset.opcode === 0x60 &&
        offset.immediate.length === 1 &&
        (offset.immediate[0] ?? 1) === 0 &&
        source !== undefined
      ) {
        if (source.opcode === 0x35) {
          return "argument";
        }
        return "stored";
      }
    }
  }
  return "stored";
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

// Extended mint analysis (P-12, weight-0 fact): the supply slot the
// totalSupply() region loads, a writer region carrying an owner,
// role-slot or auth-mapping guard, a supply store with an increase
// proof, and a balance-mapping credit in the same writer body (member
// PCs plus internal-call return continuations). It runs only when the
// v1 proof found nothing, so a scored finding always wins. The payload
// carries `fact` (never `feature`) with `proof: "extended"`, so the
// finding never converts to a signal and stays at weight 0. A burn
// (SUB-driven value), a constructor-only write unreachable at runtime,
// or a writer with no guard, no increase or no credit stays silent.
function detectExtended(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode, { mode: "v2" });
  const view = analyzeOwnerControl(input.bytecode, { reach: "v2" });
  const supply = supplySlotOf(view);
  if (supply === null) {
    return Object.freeze([]);
  }
  const code = disassemble(input.bytecode);
  for (const region of view.regions) {
    if (isStandardTokenWriter(region.selector)) {
      continue;
    }
    const memberOf = (pc: number): boolean => attribution.holdersOf(pc).includes(region.selector);
    const slots = interpretRegionSlots(input.bytecode, region.selector);
    const slotOf: SlotLookup = (pc) => slots.get(pc);
    const exprs = interpretRegionExprs(input.bytecode, region.selector);
    const auth = privilegedGuardKind(
      code,
      memberOf,
      view.ownerSlot,
      slotOf,
      exprs.jumpis,
      input.bytecode,
    );
    if (auth === null) {
      continue;
    }
    // Writer body: the member PCs plus the internal-call graph the
    // entry reaches (return continuations and callee entries past the
    // dynamic jumps the reachability walk cannot follow). Member jumps
    // seed the walk too, so dynamic edges the entry walk cannot
    // reproduce still resolve from proved blocks.
    const seeds: number[] = [];
    for (const instruction of code) {
      if (
        memberOf(instruction.pc) &&
        (instruction.opcode === 0x56 || instruction.opcode === 0x57)
      ) {
        seeds.push(instruction.pc);
      }
    }
    const body = new Set<number>(callGraphBodyPcs(code, region.entryPc, seeds));
    for (const instruction of code) {
      if (memberOf(instruction.pc)) {
        body.add(instruction.pc);
      }
    }
    const { supplyStores, credits } = bodyStores(code, body, memberOf, slotOf, region, supply);
    if (supplyStores.length === 0 || credits.length === 0) {
      continue;
    }
    for (const store of supplyStores) {
      const value = exprs.stores.get(store.pc)?.value;
      if (!supplyIncrease(code, body, slotOf, value, store.pc, supply)) {
        continue;
      }
      const credit = credits[0];
      if (credit === undefined) {
        continue;
      }
      const recipient = creditRecipient(code, body, exprs.stores.get(credit.pc)?.slot, credit.pc);
      const capped = writerCapped(region, exprs.jumpis, supply);
      const evidence: EvidenceType[] = [];
      const written = evidenceFor(input.bytecode, holderFor(attribution, region, store.pc), store.pc);
      if (written !== null) {
        evidence.push(written);
      }
      const credited = evidenceFor(input.bytecode, holderFor(attribution, region, credit.pc), credit.pc);
      if (credited !== null) {
        evidence.push(credited);
      }
      const nonEmpty = toNonEmpty(evidence);
      if (nonEmpty === null) {
        continue;
      }
      return Object.freeze([
        Object.freeze({
          id: `${PLUGIN_ID}:mint-extended`,
          pluginId: MANIFEST.id,
          title: "The owner can create new tokens. Found by extended analysis; not counted in the score.",
          evidence: nonEmpty,
          payload: Object.freeze({
            fact: "mint",
            slot: supply,
            auth,
            recipient,
            capped,
            proof: "extended",
          }),
        }),
      ]);
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

export const mintDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
