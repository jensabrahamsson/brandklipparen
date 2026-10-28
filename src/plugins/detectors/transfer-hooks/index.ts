// Transfer-hooks detector plugin `dev.brandklipparen.transfer-hooks`
// (S-115, P-12 step 1). First-party detector behind the registry: reports
// external calls reachable in the transfer path from code paths. One
// finding per call kind present in a transfer region carries every call
// site of that kind as selector evidence with PC offsets, with the
// best-effort target source of the first site: an address loaded from
// storage, a pushed constant address, an argument from calldata, or
// unknown when the window shows none of these. A transfer path with no
// external calls stays silent. Pure and synchronous: this module imports
// solely the plugin API and domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { analyzeOwnerControl } from "../../../domain/ownerControl.ts";
import type { ExternalCallOp } from "../../../domain/ownerControl.ts";
import { containingSelector, extractSelectors } from "../../../domain/selectors.ts";
import { PcOffset } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.transfer-hooks";

const CALL_KINDS: readonly ExternalCallOp["kind"][] = Object.freeze(["call", "staticcall", "delegatecall"]);

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
        required: Object.freeze(["feature", "callKind", "target"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "transfer-hooks" }),
          callKind: Object.freeze({ enum: Object.freeze(["call", "staticcall", "delegatecall"]) }),
          target: Object.freeze({
            enum: Object.freeze(["constant", "storage", "argument", "unknown"]),
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
    displayName: "Transfer-hooks detector",
    description: "Reports external calls reachable in the transfer path with their best-effort target source.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 8, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`transfer-hooks plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(`transfer-hooks plugin manifest carries kind ${parsed.value.kind}, expected detector`);
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

// External-call proof over the frozen input. Total: arbitrary bytecode
// yields a finding list, never an exception. Deterministic: call kinds
// scan in fixed order and sites in PC order, evidence sorted canonically,
// final sort on the namespaced finding id. Bytecode without selectors
// yields no findings, since a finding without selector evidence is
// unrepresentable.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const view = analyzeOwnerControl(input.bytecode);
  const transferSet = new Set(view.transfers);
  const sites = new Map<
    ExternalCallOp["kind"],
    { pc: number; target: ExternalCallOp["target"]; region: EvidenceType["selector"] }[]
  >();
  for (const region of view.regions) {
    if (!transferSet.has(region.selector)) {
      continue;
    }
    for (const call of region.calls) {
      const known = sites.get(call.kind);
      if (known === undefined) {
        sites.set(call.kind, [{ pc: call.pc, target: call.target, region: region.selector }]);
      } else {
        known.push({ pc: call.pc, target: call.target, region: region.selector });
      }
    }
  }
  const out: PluginFinding[] = [];
  for (const kind of CALL_KINDS) {
    const calls = sites.get(kind);
    if (calls === undefined) {
      continue;
    }
    const ordered = calls.slice().sort((left, right) => left.pc - right.pc);
    const evidence: EvidenceType[] = [];
    for (const call of ordered.slice(0, MANIFEST.limits.maxEvidencePerFinding)) {
      const holder = containingSelector(entries, call.pc) ?? call.region;
      const entry = evidenceFor(input.bytecode, holder, call.pc);
      if (entry !== null) {
        evidence.push(entry);
      }
    }
    const first = ordered[0];
    if (first === undefined) {
      continue;
    }
    const nonEmpty = toNonEmpty(evidence);
    if (nonEmpty === null) {
      continue;
    }
    out.push(
      Object.freeze({
        id: `${PLUGIN_ID}:${kind}`,
        pluginId: MANIFEST.id,
        title: `Transfer path reaches an external call of kind ${kind}`,
        evidence: nonEmpty,
        payload: Object.freeze({ feature: "transfer-hooks", callKind: kind, target: first.target }),
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

export const transferHooksDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
