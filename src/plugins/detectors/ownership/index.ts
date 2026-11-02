// Ownership detector plugin `dev.brandklipparen.ownership` (S-115, P-12
// step 1). First-party detector behind the registry: identifies the owner
// slot and the renounce path from code paths. The owner slot is the lowest
// constant slot loaded beside a caller compare through EQ; privileged
// functions are the caller-guarded regions; a renounce path is any store
// of zero to the owner slot. With no caller compare the proof is
// incomplete and the detector stays silent: it reports no owner rather
// than a guessed one. The live owner value is read by the application
// service through RpcPort after detection and never by this pure plugin
// (P-03). Pure and synchronous: this module imports solely the plugin API
// and domain types and pure functions.
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { analyzeOwnerControl, slotLoadFeedsCallerEq } from "../../../domain/ownerControl.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import type { FunctionAttribution } from "../../../domain/evmFlow.ts";
import { extractSelectors } from "../../../domain/selectors.ts";
import { PcOffset } from "../../../domain/types.ts";
import type { Bytecode as BytecodeType } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.ownership";

// Output schema descriptor for the finding list (ADR section 3.3): the
// draft-07 subset the registry documents. The contract suite checks the
// typed output and this descriptor against each other in both directions.
const OUTPUT_SCHEMA = Object.freeze({
  type: "array",
  maxItems: 8,
  items: Object.freeze({
    type: "object",
    required: Object.freeze(["id", "pluginId", "title", "payload", "evidence"]),
    properties: Object.freeze({
      id: Object.freeze({ type: "string", minLength: 1 }),
      pluginId: Object.freeze({ const: PLUGIN_ID }),
      title: Object.freeze({ type: "string", minLength: 1 }),
      payload: Object.freeze({
        type: "object",
        required: Object.freeze(["feature", "slot", "privilegedFunctions"]),
        properties: Object.freeze({
          feature: Object.freeze({ enum: Object.freeze(["owner-slot", "renounce"]) }),
          slot: Object.freeze({ type: "integer", minimum: 0 }),
          privilegedFunctions: Object.freeze({
            type: Object.freeze(["integer", "null"]),
            minimum: 0,
          }),
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
    displayName: "Ownership detector",
    description: "Identifies the owner slot, the privileged functions guarding on it and the renounce path.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 8, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`ownership plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`ownership plugin manifest carries kind ${parsed.value.kind}, expected detector`);
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
  bytecode: BytecodeType,
  attribution: FunctionAttribution,
  pc: number,
): EvidenceType | null {
  const selector = attribution.holderOf(pc);
  if (selector === null) {
    return null;
  }
  const offset = PcOffset.of(pc, bytecode);
  if (!offset.ok) {
    return null;
  }
  const created = Evidence.create({ selector, offset: offset.value });
  return created.ok ? created.value : null;
}

// Ownership proof over the frozen input. Total: arbitrary bytecode yields
// a finding list, never an exception. Deterministic: one region scan in
// selector order, evidence sorted canonically, final sort on the
// namespaced finding id. Bytecode without selectors yields no findings,
// since a finding without selector evidence is unrepresentable. Only
// loads that feed the caller compare count as owner checks (F-10c): a
// supply read in a guarded region is not an ownership proof.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode);
  const view = analyzeOwnerControl(input.bytecode);
  if (view.ownerSlot === null) {
    return Object.freeze([]);
  }
  const slot = view.ownerSlot;
  const out: PluginFinding[] = [];
  const checks: EvidenceType[] = [];
  for (const region of view.regions) {
    for (const load of region.loads) {
      if (load.slot.kind !== "const" || load.slot.value !== slot) {
        continue;
      }
      if (!slotLoadFeedsCallerEq(region, load.pc)) {
        continue;
      }
      const entry = evidenceFor(input.bytecode, attribution, load.pc);
      if (entry !== null) {
        checks.push(entry);
      }
    }
  }
  // Shared-helper checks (SCORE-3): when the caller compare lives in an
  // internal `_checkOwner` helper no single region owns, the shared
  // analysis names the reaching selector and proving pc instead. Those
  // locations are evidence only when no in-region load proved a check.
  if (checks.length === 0) {
    for (const check of view.ownerChecks) {
      const offset = PcOffset.of(check.pc, input.bytecode);
      if (!offset.ok) {
        continue;
      }
      const entry = Evidence.create({ selector: check.selector, offset: offset.value });
      if (entry.ok) {
        checks.push(entry.value);
      }
    }
  }
  const checkEvidence = toNonEmpty(checks.slice(0, MANIFEST.limits.maxEvidencePerFinding));
  if (checkEvidence !== null) {
    out.push(
      Object.freeze({
        id: `${PLUGIN_ID}:owner-slot`,
        pluginId: MANIFEST.id,
        title: "Owner slot compared against the caller with privileged functions present",
        evidence: checkEvidence,
        payload: Object.freeze({
          feature: "owner-slot",
          slot,
          privilegedFunctions: view.privileged.length,
        }),
      }),
    );
  }
  const zeroWrites: EvidenceType[] = [];
  for (const region of view.regions) {
    for (const store of region.stores) {
      if (store.slot.kind === "const" && store.slot.value === slot && store.valueIsZero) {
        const entry = evidenceFor(input.bytecode, attribution, store.pc);
        if (entry !== null) {
          zeroWrites.push(entry);
        }
      }
    }
  }
  const renounceEvidence = toNonEmpty(zeroWrites.slice(0, MANIFEST.limits.maxEvidencePerFinding));
  if (renounceEvidence !== null) {
    out.push(
      Object.freeze({
        id: `${PLUGIN_ID}:renounce`,
        pluginId: MANIFEST.id,
        title: "Renounce path writes zero to the owner slot",
        evidence: renounceEvidence,
        payload: Object.freeze({ feature: "renounce", slot, privilegedFunctions: null }),
      }),
    );
  }
  out.sort((left, right) => {
    if (left.id < right.id) {
      return -1;
    }
    if (left.id > right.id) {
      return 1;
    }
    return 0;
  });
  return Object.freeze(out.slice(0, MANIFEST.limits.maxFindings));
}

const MANIFEST = manifestOf();

export const ownershipDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
