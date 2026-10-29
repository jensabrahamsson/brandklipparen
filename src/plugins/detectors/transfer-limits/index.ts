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
// and domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { analyzeOwnerControl, constSlotLoadNearFlavor } from "../../../domain/ownerControl.ts";
import type { RegionFacts } from "../../../domain/ownerControl.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import { extractSelectors } from "../../../domain/selectors.ts";
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
        required: Object.freeze(["feature", "slot", "limitKind"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "transfer-limits" }),
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
// The proof returns the read PC.
function limitCompare(region: RegionFacts, slot: number): number | null {
  const proof = constSlotLoadNearFlavor(region, slot, ["lt", "gt"]);
  return proof === null ? null : proof.loadPc;
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
function detect(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode);
  const view = analyzeOwnerControl(input.bytecode);
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
        const readPc = limitCompare(transfer, slot);
        if (readPc === null) {
          continue;
        }
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

const MANIFEST = manifestOf();

export const transferLimitsDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
