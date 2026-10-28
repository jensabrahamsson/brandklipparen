// Mint detector plugin `dev.brandklipparen.mint` (S-115, P-12 step 1).
// First-party detector behind the registry: proves a privileged mint from
// code paths instead of matching admin selectors. A finding needs all
// three: a privileged region (a caller guard, see ownerControl.ts) that
// stores to a constant slot, a transfer path that loads the same slot,
// and addition arithmetic beside the supply flow. A guarded write to a
// slot the transfer path never reads, or an unguarded write, stays
// silent: the proof is incomplete, so no positive finding is reported.
// Pure and synchronous: this module imports solely the plugin API and
// domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { analyzeOwnerControl } from "../../../domain/ownerControl.ts";
import { containingSelector, extractSelectors } from "../../../domain/selectors.ts";
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
        required: Object.freeze(["feature", "slot"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "mint" }),
          slot: Object.freeze({ type: "integer", minimum: 0 }),
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
// since a finding without selector evidence is unrepresentable.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
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
    const proof = proveMint(input.bytecode, entries, view, privilegedSet, transferSet, slot);
    if (proof !== null) {
      return Object.freeze([proof]);
    }
  }
  return Object.freeze([]);
}

function proveMint(
  bytecode: DetectorInput["bytecode"],
  entries: ReturnType<typeof extractSelectors>,
  view: ReturnType<typeof analyzeOwnerControl>,
  privilegedSet: ReadonlySet<string>,
  transferSet: ReadonlySet<string>,
  slot: number,
): PluginFinding | null {
  for (const region of view.regions) {
    if (!privilegedSet.has(region.selector)) {
      continue;
    }
    const store = region.stores.find(
      (candidate) => candidate.slot.kind === "const" && candidate.slot.value === slot,
    );
    if (store === undefined) {
      continue;
    }
    for (const transferSelector of transferSet) {
      if (transferSelector === region.selector) {
        continue;
      }
      const transfer = view.regions.find((candidate) => candidate.selector === transferSelector);
      if (transfer === undefined) {
        continue;
      }
      const read = transfer.loads.find(
        (load) => load.slot.kind === "const" && load.slot.value === slot,
      );
      if (read === undefined) {
        continue;
      }
      if (!region.hasAdd && !transfer.hasAdd) {
        continue;
      }
      const holder = containingSelector(entries, store.pc) ?? region.selector;
      const readerHolder = containingSelector(entries, read.pc) ?? transfer.selector;
      const evidence: EvidenceType[] = [];
      const write = evidenceFor(bytecode, holder, store.pc);
      if (write !== null) {
        evidence.push(write);
      }
      const seen = evidenceFor(bytecode, readerHolder, read.pc);
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

const MANIFEST = manifestOf();

export const mintDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
