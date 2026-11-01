// Signals with evidence down to selector and PC offset (K-010, A-12, A-13).
// Pure domain module: smart constructors validate and freeze, structural
// detection reads bytecode only. The signal catalogue identifiers below are
// the closed sets the docs name: risk types, directions, severities, the
// hard-to-analyze causes and the structural capability keys. Detection fires
// solely on opcode presence in the linear disassembly, which needs no
// numeric threshold or weight. Risk, direction and severity mappings arrive
// as an injected catalogue parameter; production values come from the
// versioned model artifact per K-210 and A-20, never from this module.
import { disassemble, extractSelectors } from "./selectors.ts";
import { attributeFunctions } from "./evmFlow.ts";
import { callTargetOfInstruction } from "./ownerControl.ts";
import { Evidence, sortEvidence } from "./evidence.ts";
import type { NonEmpty, Evidence as EvidenceType } from "./evidence.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import { PcOffset, SignalId } from "./types.ts";
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  CloneGroupId as CloneGroupIdType,
  CodeHash as CodeHashType,
  DomainError,
  Probability as ProbabilityType,
  SignalId as SignalIdType,
  Slot as SlotType,
  StorageWord as StorageWordType,
  Timestamp as TimestampType,
} from "./types.ts";

export type RiskType = "rug-pull" | "honeypot" | "bot-pump";
export type Direction = "raises" | "lowers";
export type Severity = "low" | "medium" | "high";

export type HardToAnalyzeCause =
  | "timeout"
  | "resource-limit"
  | "decompiler-error"
  | "obfuscated-structure";

export const HARD_TO_ANALYZE_CAUSES: readonly HardToAnalyzeCause[] = Object.freeze([
  "timeout",
  "resource-limit",
  "decompiler-error",
  "obfuscated-structure",
]);

// Measured on-chain value (A-10): value and slot read at a fixed block and
// time point, delivered through ports and taken as given by the core.
export type MeasuredValue = {
  readonly value: StorageWordType;
  readonly slot: SlotType;
  readonly block: BlockNumberType;
  readonly at: TimestampType;
};

// Holds-now versus can-change (K-303, A-13). The changer of a bytecode
// capability is the authorised caller address proven from the ownership
// evidence; the proxy story (S-006) widens the changer to the authority
// union per A-12. Ownerless code carries the changerless can-change-unknown
// marker: the capability exists in the code but no controlling account is
// proven, so no address is named.
export type Temporality =
  | {
      readonly kind: "applies-now";
      readonly measuredValue: MeasuredValue;
      readonly block: BlockNumberType;
      readonly at: TimestampType;
    }
  | { readonly kind: "can-change"; readonly changer: AddressType }
  | { readonly kind: "can-change-unknown" };

// Capability, clone-match and hard-to-analyze branches (A-12). Each branch
// carries at least one evidence entry; the type makes empty evidence
// unrepresentable and the constructors turn it away with a typed error.
export type Signal =
  | {
      readonly kind: "capability";
      readonly id: SignalIdType;
      readonly risk: RiskType;
      readonly direction: Direction;
      readonly severity: Severity;
      readonly temporality: Temporality;
      readonly evidence: NonEmpty<EvidenceType>;
      // Plugin that produced the finding this signal converts (S-115
      // per-plugin weights): the namespaced plugin id, present only on
      // signals converted from owner-control feature findings through
      // the artifact feature catalogue. The risk model reads the
      // calibrated per-plugin per-head weight for this plugin; signals
      // without it score through the severity weights. Never set from
      // the finding payload, only from the registry entry id.
      readonly sourcePlugin?: string | undefined;
    }
  | {
      readonly kind: "clone-match";
      readonly id: SignalIdType;
      readonly risk: RiskType;
      readonly direction: Direction;
      readonly severity: Severity;
      readonly similarity: ProbabilityType;
      readonly group: CloneGroupIdType;
      readonly priorCount: number;
      readonly evidence: NonEmpty<EvidenceType>;
    }
  | {
      readonly kind: "hard-to-analyze";
      readonly id: SignalIdType;
      readonly risk: RiskType;
      readonly cause: HardToAnalyzeCause;
      readonly evidence: NonEmpty<EvidenceType>;
    };

function toNonEmpty(items: readonly EvidenceType[]): NonEmpty<EvidenceType> | null {
  const sorted = sortEvidence(items);
  const first = sorted[0];
  if (first === undefined) {
    return null;
  }
  return Object.freeze([first, ...sorted.slice(1)]) as NonEmpty<EvidenceType>;
}

// Unique signal ids (C-27, F-25): `keepId` wins outright so enrichment
// rebuilds keep the converted id; otherwise a `discriminator` hashes
// through `SignalId.ofKey`, and direct construction without either keeps
// the legacy code-hash-plus-first-selector formula.
function signalIdOf(
  codeHash: CodeHashType,
  evidence: NonEmpty<EvidenceType>,
  discriminator?: string | undefined,
  keepId?: SignalIdType | undefined,
): Result<SignalIdType, DomainError> {
  if (keepId !== undefined) {
    return ok(keepId);
  }
  if (discriminator !== undefined) {
    return SignalId.ofKey(codeHash, discriminator);
  }
  const first = evidence[0];
  if (first === undefined) {
    return err({ kind: "invalid-signal", message: "signal needs at least one evidence entry" });
  }
  return SignalId.of(codeHash, first.selector);
}

export const Signal = {
  createCapability(input: {
    readonly codeHash: CodeHashType;
    readonly risk: RiskType;
    readonly direction: Direction;
    readonly severity: Severity;
    readonly temporality: Temporality;
    readonly evidence: readonly EvidenceType[];
    readonly sourcePlugin?: string | undefined;
    readonly discriminator?: string | undefined;
    readonly keepId?: SignalIdType | undefined;
  }): Result<Signal, DomainError> {
    const evidence = toNonEmpty(input.evidence);
    if (evidence === null) {
      return err({ kind: "invalid-signal", message: "signal needs at least one evidence entry" });
    }
    const id = signalIdOf(input.codeHash, evidence, input.discriminator, input.keepId);
    if (!id.ok) {
      return err(id.error);
    }
    return ok(
      Object.freeze({
        kind: "capability",
        id: id.value,
        risk: input.risk,
        direction: input.direction,
        severity: input.severity,
        temporality: input.temporality,
        evidence,
        ...(input.sourcePlugin === undefined ? {} : { sourcePlugin: input.sourcePlugin }),
      }) as Signal,
    );
  },

  createCloneMatch(input: {
    readonly codeHash: CodeHashType;
    readonly risk: RiskType;
    readonly direction: Direction;
    readonly severity: Severity;
    readonly similarity: ProbabilityType;
    readonly group: CloneGroupIdType;
    readonly priorCount: number;
    readonly evidence: readonly EvidenceType[];
    readonly discriminator?: string | undefined;
    readonly keepId?: SignalIdType | undefined;
  }): Result<Signal, DomainError> {
    const evidence = toNonEmpty(input.evidence);
    if (evidence === null) {
      return err({ kind: "invalid-signal", message: "signal needs at least one evidence entry" });
    }
    if (!Number.isInteger(input.priorCount) || input.priorCount < 0) {
      return err({
        kind: "invalid-signal",
        message: `prior count must be an integer at least 0: ${input.priorCount}`,
      });
    }
    const id = signalIdOf(input.codeHash, evidence, input.discriminator, input.keepId);
    if (!id.ok) {
      return err(id.error);
    }
    return ok(
      Object.freeze({
        kind: "clone-match",
        id: id.value,
        risk: input.risk,
        direction: input.direction,
        severity: input.severity,
        similarity: input.similarity,
        group: input.group,
        priorCount: input.priorCount,
        evidence,
      }) as Signal,
    );
  },

  createHardToAnalyze(input: {
    readonly codeHash: CodeHashType;
    readonly risk: RiskType;
    readonly cause: HardToAnalyzeCause;
    readonly evidence: readonly EvidenceType[];
    readonly discriminator?: string | undefined;
    readonly keepId?: SignalIdType | undefined;
  }): Result<Signal, DomainError> {
    const evidence = toNonEmpty(input.evidence);
    if (evidence === null) {
      return err({ kind: "invalid-signal", message: "signal needs at least one evidence entry" });
    }
    const id = signalIdOf(input.codeHash, evidence, input.discriminator, input.keepId);
    if (!id.ok) {
      return err(id.error);
    }
    return ok(
      Object.freeze({
        kind: "hard-to-analyze",
        id: id.value,
        risk: input.risk,
        cause: input.cause,
        evidence,
      }) as Signal,
    );
  },
};

// Structural capability keys. Each key maps to one opcode whose presence in
// the executable disassembly directly shows the capability, with PUSH data
// skipped by the sweep so constants never count as opcodes:
// SELFDESTRUCT ends the contract and redirects funds, DELEGATECALL runs
// foreign code in local storage context, CALL forwards to an outside
// contract, SSTORE writes storage. No count, share or size cutoff steers
// detection: one occurrence is enough, so no threshold is needed.
export const CAPABILITY_KEYS = ["selfdestruct", "delegatecall", "call", "storage-write"] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

const CAPABILITY_OPCODES: Readonly<Record<CapabilityKey, number>> = {
  selfdestruct: 0xff,
  delegatecall: 0xf4,
  call: 0xf1,
  "storage-write": 0x55,
};

// Injected risk mapping per capability key. The values steer scoring, so
// they belong to the versioned model artifact per K-210 and A-20; tests
// carry placeholders and production passes the artifact mapping.
export type CapabilityCatalogue = {
  readonly [key in CapabilityKey]: {
    readonly risk: RiskType;
    readonly direction: Direction;
    readonly severity: Severity;
  };
};

// Structural capability detection. Total: arbitrary bytecode yields a signal
// list, never an exception; entries that fail validation are skipped.
// Deterministic: fixed key order, canonical evidence order, final sort on
// SignalId. Bytecode without selectors yields no signals, since a signal
// without selector evidence is unrepresentable per A-13. Each opcode
// occurrence becomes one evidence entry pairing the occurrence PC offset
// with the selector of the dispatcher function whose body reaches that
// PC, so the evidence names the function the capability sits in;
// occurrences no unique function reaches (dispatcher preamble, fallback,
// shared tails, dead code) are skipped, never guessed: a finding must
// name the function the capability sits in. A CALL that pays out to
// msg.sender is a withdraw, not an outside-contract power, and stays
// silent here like in the registry detector.
export function detectCapabilities(
  bytecode: BytecodeType,
  codeHash: CodeHashType,
  catalogue: CapabilityCatalogue,
  temporality: Temporality,
): readonly Signal[] {
  const entries = extractSelectors(bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const code = disassemble(bytecode);
  const attribution = attributeFunctions(bytecode);
  const pcsByKey = new Map<CapabilityKey, number[]>();
  for (let index = 0; index < code.length; index += 1) {
    const instruction = code[index];
    if (instruction === undefined) {
      continue;
    }
    for (const key of CAPABILITY_KEYS) {
      if (instruction.opcode === CAPABILITY_OPCODES[key]) {
        if (key === "call" && callTargetOfInstruction(code, index) === "caller") {
          continue;
        }
        const known = pcsByKey.get(key);
        if (known === undefined) {
          pcsByKey.set(key, [instruction.pc]);
        } else {
          known.push(instruction.pc);
        }
      }
    }
  }
  const out: Signal[] = [];
  for (const key of CAPABILITY_KEYS) {
    const pcs = pcsByKey.get(key);
    if (pcs === undefined) {
      continue;
    }
    const mapping = catalogue[key];
    const evidence: EvidenceType[] = [];
    for (let index = 0; index < pcs.length; index += 1) {
      const pc = pcs[index] ?? 0;
      const selector = attribution.holderOf(pc);
      if (selector === null) {
        continue;
      }
      const offset = PcOffset.of(pc, bytecode);
      if (!offset.ok) {
        continue;
      }
      const created = Evidence.create({ selector, offset: offset.value });
      if (created.ok) {
        evidence.push(created.value);
      }
    }
    // Padding truth (C-26, F-26): mirror the registry detector — a key
    // with more than 128 sites keeps the first 128 in canonical order
    // instead of dropping the signal, so parity holds entry for entry.
    const capped = sortEvidence(evidence).slice(0, 128);
    if (capped.length === 0) {
      continue;
    }
    const signal = Signal.createCapability({
      codeHash,
      risk: mapping.risk,
      direction: mapping.direction,
      severity: mapping.severity,
      temporality,
      evidence: capped,
    });
    if (signal.ok) {
      out.push(signal.value);
    }
  }
  out.sort((left, right) => {
    const leftId = left.id as string;
    const rightId = right.id as string;
    if (leftId < rightId) {
      return -1;
    }
    if (leftId > rightId) {
      return 1;
    }
    return 0;
  });
  return Object.freeze(out);
}
