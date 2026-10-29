// Capability detector plugin `dev.brandklipparen.capability` (S-043, P-12
// step 1). First-party detector behind the registry: the structural opcode
// sweep from the legacy direct call lives here behind `detect`, reading the
// frozen detector input only. The plugin reports raw capability keys with
// selector and PC-offset evidence at weight 0; the application service maps
// findings to calibrated Signals through the existing catalogue path, so
// scores stay bit-identical until calibration names the findings (P-05).
// Pure and synchronous: this module imports solely the plugin API and
// domain types and pure functions (P-03).
import { Evidence } from "../../../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../domain/evidence.ts";
import { attributeFunctions } from "../../../domain/evmFlow.ts";
import { callTargetOfInstruction } from "../../../domain/ownerControl.ts";
import { disassemble, extractSelectors } from "../../../domain/selectors.ts";
import { CAPABILITY_KEYS } from "../../../domain/signals.ts";
import type { CapabilityKey } from "../../../domain/signals.ts";
import { PcOffset } from "../../../domain/types.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../api.ts";
import type { DetectorInput, DetectorPlugin, PluginFinding } from "../../detector.ts";

const PLUGIN_ID = "dev.brandklipparen.capability";

const CAPABILITY_OPCODES: Readonly<Record<CapabilityKey, number>> = {
  selfdestruct: 0xff,
  delegatecall: 0xf4,
  call: 0xf1,
  "storage-write": 0x55,
};

const CAPABILITY_TITLES: Readonly<Record<CapabilityKey, string>> = {
  selfdestruct: "Contract can self-destruct",
  delegatecall: "Contract can delegatecall other code",
  call: "Contract can call other contracts",
  "storage-write": "Contract can write storage",
};

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
        required: Object.freeze(["capability"]),
        properties: Object.freeze({
          capability: Object.freeze({ enum: Object.freeze([...CAPABILITY_KEYS]) }),
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
    displayName: "Capability detector",
    description: "Reports structural bytecode capabilities with selector evidence.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: OUTPUT_SCHEMA,
    capabilities: {},
    limits: { maxFindings: 8, maxEvidencePerFinding: 128, maxOutputBytes: 32768 },
  });
  if (!parsed.ok) {
    throw new Error(`capability plugin manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error(
      `capability plugin manifest carries kind ${parsed.value.kind}, expected detector`,
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

// Structural capability detection over the frozen input. Total: arbitrary
// bytecode yields a finding list, never an exception; entries that fail
// validation are skipped. Deterministic: fixed key order, canonical
// evidence order, final sort on the namespaced finding id. Bytecode without
// selectors yields no findings, since a finding without selector evidence
// is unrepresentable. Each opcode occurrence becomes one evidence entry
// pairing the occurrence PC offset with the selector of the dispatcher
// function whose CFG walk reaches that PC, so the evidence names the
// function the capability sits in; occurrences no unique function reaches
// (dispatcher preamble, fallback, shared tails, dead code) are skipped,
// never guessed. A CALL that pays out to msg.sender is a withdraw, not an
// outside-contract power, and stays silent. This mirrors the legacy domain
// sweep entry for entry, so the host conversion through the catalogue
// reproduces the same Signals.
function detect(input: DetectorInput): readonly PluginFinding[] {
  const entries = extractSelectors(input.bytecode);
  if (entries.length === 0) {
    return Object.freeze([]);
  }
  const code = disassemble(input.bytecode);
  const attribution = attributeFunctions(input.bytecode);
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
  const out: PluginFinding[] = [];
  for (const key of CAPABILITY_KEYS) {
    const pcs = pcsByKey.get(key);
    if (pcs === undefined) {
      continue;
    }
    const evidence: EvidenceType[] = [];
    for (let index = 0; index < pcs.length; index += 1) {
      const pc = pcs[index] ?? 0;
      const selector = attribution.holderOf(pc);
      if (selector === null) {
        continue;
      }
      const offset = PcOffset.of(pc, input.bytecode);
      if (!offset.ok) {
        continue;
      }
      const created = Evidence.create({ selector, offset: offset.value });
      if (created.ok) {
        evidence.push(created.value);
      }
    }
    const nonEmpty = toNonEmpty(evidence);
    if (nonEmpty === null) {
      continue;
    }
    out.push(
      Object.freeze({
        id: `${PLUGIN_ID}:${key}`,
        pluginId: MANIFEST.id,
        title: CAPABILITY_TITLES[key],
        evidence: nonEmpty,
        payload: Object.freeze({ capability: key }),
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
  return Object.freeze(out);
}

const MANIFEST = manifestOf();

export const capabilityDetectorPlugin: DetectorPlugin = Object.freeze({
  manifest: MANIFEST,
  detect,
});
