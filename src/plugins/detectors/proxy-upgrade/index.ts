// Proxy-upgrade detector plugin `dev.brandklipparen.proxy-upgrade`
// (S-115, P-12 step 1). First-party detector behind the registry: reports
// proxy upgradeability as a privileged capability by reusing the domain
// proxy helpers from src/domain/proxy.ts. An upgrade entry
// (`upgradeTo(address)` or `upgradeToAndCall(address,bytes)`, derived
// through the shared Keccak helper) behind a caller guard reports the
// UUPS kind; a delegatecall-behind-storage region beside an upgrade entry
// reports the EIP-1967 kind. An unguarded upgrade entry alone, or a
// delegatecall proxy with no upgrade entry, stays silent: the proof is
// incomplete, so no positive finding is reported. Pure and synchronous:
// this module imports solely the plugin API and domain types and pure
// functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { analyzeOwnerControl } from "../../../domain/ownerControl.ts";
import { bytecodeHasSelector, selectorOffsetInBytecode } from "../../../domain/proxy.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import { extractSelectors } from "../../../domain/selectors.ts";
import { Selector, keccak256HexOfUtf8 } from "../../../domain/types.ts";
import type { Selector as SelectorType } from "../../../domain/types.ts";
import { PcOffset } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.proxy-upgrade";

// Public upgrade entry signatures. The selectors derive from these
// signatures through the shared Keccak implementation, never from a
// copied table.
const UPGRADE_SIGNATURES: readonly string[] = Object.freeze([
  "upgradeTo(address)",
  "upgradeToAndCall(address,bytes)",
]);

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
        required: Object.freeze(["feature", "proxyKind", "upgradeSelector"]),
        properties: Object.freeze({
          feature: Object.freeze({ const: "proxy-upgrade" }),
          proxyKind: Object.freeze({ enum: Object.freeze(["uups", "eip1967"]) }),
          upgradeSelector: Object.freeze({ type: "string", minLength: 1 }),
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
    displayName: "Proxy-upgrade detector",
    description: "Reports upgradeable proxy shapes: a guarded upgrade entry or a delegatecall proxy with one.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 4, maxEvidencePerFinding: 32, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`proxy-upgrade plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(
      `proxy-upgrade plugin manifest carries kind ${parsed.value.kind}, expected detector`,
    );
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

function selectorOf(signature: string): SelectorType | null {
  const digest = keccak256HexOfUtf8(signature);
  const parsed = Selector.parse(`0x${digest.slice(2, 10)}`);
  return parsed.ok ? parsed.value : null;
}

function upgradeSelectors(): readonly SelectorType[] {
  const out: SelectorType[] = [];
  for (const signature of UPGRADE_SIGNATURES) {
    const selector = selectorOf(signature);
    if (selector !== null) {
      out.push(selector);
    }
  }
  return Object.freeze(out);
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

// Proxy-upgrade proof over the frozen input. Total: arbitrary bytecode
// yields a finding list, never an exception. Deterministic: upgrade
// selectors scan in signature order and the first provable shape wins.
// Bytecode without selectors yields no findings, since a finding without
// selector evidence is unrepresentable.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const attribution = attributeFunctions(input.bytecode);
  const view = analyzeOwnerControl(input.bytecode);
  const privilegedSet = new Set(view.privileged);
  for (const upgrade of upgradeSelectors()) {
    const upgradeText = upgrade as string;
    if (!bytecodeHasSelector(input.bytecode, upgrade)) {
      continue;
    }
    const target = selectorOffsetInBytecode(input.bytecode, upgrade);
    if (target === null) {
      continue;
    }
    if (privilegedSet.has(upgrade)) {
      const entry = evidenceFor(input.bytecode, upgrade, target as number);
      const evidence = toNonEmpty(entry === null ? [] : [entry]);
      if (evidence === null) {
        continue;
      }
      return Object.freeze([
        Object.freeze({
          id: `${PLUGIN_ID}:proxy-upgrade`,
          pluginId: MANIFEST.id,
          title: "Guarded upgrade entry gives the proxy an upgrade path",
          evidence,
          payload: Object.freeze({
            feature: "proxy-upgrade",
            proxyKind: "uups",
            upgradeSelector: upgradeText,
          }),
        }),
      ]);
    }
    for (const region of view.regions) {
      const forwards = region.calls.some((call) => call.kind === "delegatecall");
      if (!forwards || region.loads.length === 0) {
        continue;
      }
      const call = region.calls.find((candidate) => candidate.kind === "delegatecall");
      if (call === undefined) {
        continue;
      }
      const evidence: EvidenceType[] = [];
      const entry = evidenceFor(input.bytecode, upgrade, target as number);
      if (entry !== null) {
        evidence.push(entry);
      }
      const holder = attribution.holderOf(call.pc);
      if (holder === null) {
        continue;
      }
      const forward = evidenceFor(input.bytecode, holder, call.pc);
      if (forward !== null) {
        evidence.push(forward);
      }
      const nonEmpty = toNonEmpty(evidence);
      if (nonEmpty === null) {
        continue;
      }
      return Object.freeze([
        Object.freeze({
          id: `${PLUGIN_ID}:proxy-upgrade`,
          pluginId: MANIFEST.id,
          title: "Delegatecall proxy carries an upgrade entry",
          evidence: nonEmpty,
          payload: Object.freeze({
            feature: "proxy-upgrade",
            proxyKind: "eip1967",
            upgradeSelector: upgradeText,
          }),
        }),
      ]);
    }
  }
  return Object.freeze([]);
}

const MANIFEST = manifestOf();

export const proxyUpgradeDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
