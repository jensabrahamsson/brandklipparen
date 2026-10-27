// Detector plugin entry point (S-043, P-03).
// A detector plugin is a synchronous pure function from its frozen
// DetectorInput to a frozen list of findings. The signature admits no
// Promise, no port, no clock and no options bag through which I/O could be
// requested; inputs are readonly and frozen at construction. Detector
// plugin modules import solely the plugin API (src/plugins/api.ts) and
// src/domain types and pure functions. The registry boundary in this module
// wraps each call: schema, evidence, size and count failures degrade to a
// typed plugin outcome while the rest of the analysis stands (P-06).
import { canonicalSerialize } from "../domain/serialize.ts";
import type { CanonicalValue } from "../domain/serialize.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../domain/evidence.ts";
import type {
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
} from "../domain/types.ts";
import type {
  JsonSchema,
  JsonValue,
  PluginApiVersion,
  PluginId,
  PluginManifest,
  PluginVersion,
} from "./api.ts";
import type { PluginRegistry } from "./registry.ts";

// Closed detector input for v1 (ADR section 3.2): facts the host has already
// computed deterministically. The capability plugin declares solely
// `bytecode`, which travels with its CodeHash per the catalogue row
// "Bytecode with CodeHash". Later detectors add optional catalogue facts
// here as their manifests declare them.
export type DetectorInput = {
  readonly bytecode: BytecodeType;
  readonly codeHash: CodeHashType;
};

// One detector finding (ADR section 4.1): the id namespaces the plugin id
// (`<pluginId>:<localId>`), the title is one short English line, every
// finding carries at least one evidence entry, and the kind-specific
// payload is validated against the manifest outputSchema at the boundary.
export type PluginFinding = {
  readonly id: string;
  readonly pluginId: PluginId;
  readonly title: string;
  readonly evidence: NonEmpty<EvidenceType>;
  readonly payload: JsonValue;
};

export type DetectorPlugin = {
  readonly manifest: PluginManifest;
  readonly detect: (input: DetectorInput) => readonly PluginFinding[];
};

// Per-plugin outcome per analysis (ADR section 5.4). Every outcome leaves
// the rest of the analysis standing; only `ok` contributes findings.
export type PluginOutcome = "ok" | "invalid-output" | "threw" | "input-unavailable";

export type PluginResultEntry = {
  readonly pluginId: PluginId;
  readonly pluginVersion: PluginVersion;
  readonly apiVersion: PluginApiVersion;
  readonly outcome: PluginOutcome;
  readonly findings: readonly PluginFinding[];
};

// Frozen detector input construction. The host passes exactly the declared
// inputs and nothing else; values are frozen so detect cannot widen them.
export function createDetectorInput(
  bytecode: BytecodeType,
  codeHash: CodeHashType,
): DetectorInput {
  return Object.freeze({ bytecode, codeHash });
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkJsonType(value: unknown, name: string): boolean {
  switch (name) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return false;
  }
}

// Plain-check validation of a plugin output value against the manifest
// outputSchema descriptor (ADR section 3.3): the same closed keyword subset
// the registry documents, with no new schema library. Output outside the
// schema gives the typed outcome `invalid-output` for that plugin.
export function validatePluginOutput(value: unknown, schema: JsonSchema): boolean {
  const descriptor = schema as { readonly [keyword: string]: unknown };
  const typeField: unknown = descriptor["type"];
  if (typeField !== undefined) {
    if (typeof typeField === "string") {
      if (!checkJsonType(value, typeField)) {
        return false;
      }
    } else if (Array.isArray(typeField)) {
      if (!typeField.some((name) => typeof name === "string" && checkJsonType(value, name))) {
        return false;
      }
    } else {
      return false;
    }
  }
  const constField: unknown = descriptor["const"];
  if (constField !== undefined && !deepEqualJson(value, constField)) {
    return false;
  }
  const enumField: unknown = descriptor["enum"];
  if (enumField !== undefined) {
    if (!Array.isArray(enumField) || !enumField.some((entry) => deepEqualJson(value, entry))) {
      return false;
    }
  }
  if (typeof value === "number") {
    const minimum: unknown = descriptor["minimum"];
    if (minimum !== undefined && (typeof minimum !== "number" || value < minimum)) {
      return false;
    }
    const maximum: unknown = descriptor["maximum"];
    if (maximum !== undefined && (typeof maximum !== "number" || value > maximum)) {
      return false;
    }
  }
  if (typeof value === "string") {
    const minLength: unknown = descriptor["minLength"];
    if (minLength !== undefined && (typeof minLength !== "number" || value.length < minLength)) {
      return false;
    }
    const maxLength: unknown = descriptor["maxLength"];
    if (maxLength !== undefined && (typeof maxLength !== "number" || value.length > maxLength)) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    const minItems: unknown = descriptor["minItems"];
    if (minItems !== undefined && (typeof minItems !== "number" || value.length < minItems)) {
      return false;
    }
    const maxItems: unknown = descriptor["maxItems"];
    if (maxItems !== undefined && (typeof maxItems !== "number" || value.length > maxItems)) {
      return false;
    }
    const items: unknown = descriptor["items"];
    if (items !== undefined) {
      if (Array.isArray(items)) {
        for (const entry of items) {
          if (!validatePluginOutput(entry, entry as JsonSchema)) {
            return false;
          }
        }
      } else if (isRecord(items)) {
        for (const entry of value) {
          if (!validatePluginOutput(entry, items as JsonSchema)) {
            return false;
          }
        }
      } else {
        return false;
      }
    }
  }
  if (isRecord(value)) {
    const required: unknown = descriptor["required"];
    if (required !== undefined) {
      if (!Array.isArray(required) || !required.every((entry) => typeof entry === "string")) {
        return false;
      }
      for (const key of required as string[]) {
        if ((value as { readonly [key: string]: unknown })[key] === undefined) {
          return false;
        }
      }
    }
    const properties: unknown = descriptor["properties"];
    if (properties !== undefined) {
      if (!isRecord(properties)) {
        return false;
      }
      for (const [key, subschema] of Object.entries(properties)) {
        const entry = value[key];
        if (entry !== undefined && isRecord(subschema)) {
          if (!validatePluginOutput(entry, subschema as JsonSchema)) {
            return false;
          }
        }
      }
      const additional: unknown = descriptor["additionalProperties"];
      if (additional === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            return false;
          }
        }
      } else if (isRecord(additional)) {
        for (const [key, entry] of Object.entries(value)) {
          if (!(key in properties) && !validatePluginOutput(entry, additional as JsonSchema)) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

function outcomeEntry(
  plugin: DetectorPlugin,
  outcome: PluginOutcome,
  findings: readonly PluginFinding[],
): PluginResultEntry {
  return Object.freeze({
    pluginId: plugin.manifest.id,
    pluginVersion: plugin.manifest.version,
    apiVersion: plugin.manifest.apiVersion,
    outcome,
    findings: Object.freeze([...findings]),
  });
}

function toPlainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// Evidence shape check ahead of schema validation: every finding carries at
// least one entry and every entry carries a selector string, mirroring A-13
// so a finding without evidence never reaches scoring or rendering.
function hasValidEvidence(findings: readonly PluginFinding[], maxPerFinding: number): boolean {
  for (const finding of findings) {
    if (!isRecord(finding)) {
      return false;
    }
    const record = finding as { readonly [key: string]: unknown };
    if (
      typeof record["id"] !== "string" ||
      (record["id"] as string).length === 0 ||
      typeof record["title"] !== "string" ||
      (record["title"] as string).trim().length === 0
    ) {
      return false;
    }
    const evidence: unknown = record["evidence"];
    if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > maxPerFinding) {
      return false;
    }
    for (const entry of evidence) {
      if (!isRecord(entry) || typeof entry["selector"] !== "string") {
        return false;
      }
    }
  }
  return true;
}

// Runs one detector plugin behind the registry boundary (P-06): the call is
// wrapped, limits are enforced on the returned value, and every failure
// contributes an empty finding list with its typed outcome.
export function runDetectorPlugin(
  plugin: DetectorPlugin,
  input: DetectorInput,
): PluginResultEntry {
  const limits = plugin.manifest.limits;
  let raw: readonly PluginFinding[];
  try {
    raw = plugin.detect(input);
  } catch {
    return outcomeEntry(plugin, "threw", []);
  }
  if (!Array.isArray(raw) || raw.length > limits.maxFindings) {
    return outcomeEntry(plugin, "invalid-output", []);
  }
  if (!hasValidEvidence(raw, limits.maxEvidencePerFinding)) {
    return outcomeEntry(plugin, "invalid-output", []);
  }
  let plain: unknown;
  try {
    plain = toPlainJson(raw);
  } catch {
    return outcomeEntry(plugin, "invalid-output", []);
  }
  let bytes = 0;
  try {
    bytes = new TextEncoder().encode(canonicalSerialize(plain as CanonicalValue)).length;
  } catch {
    return outcomeEntry(plugin, "invalid-output", []);
  }
  if (bytes > limits.maxOutputBytes) {
    return outcomeEntry(plugin, "invalid-output", []);
  }
  if (!validatePluginOutput(plain, plugin.manifest.outputSchema)) {
    return outcomeEntry(plugin, "invalid-output", []);
  }
  const sorted = [...raw].sort((left, right) => {
    if (left.id < right.id) {
      return -1;
    }
    if (left.id > right.id) {
      return 1;
    }
    return 0;
  });
  return outcomeEntry(plugin, "ok", Object.freeze(sorted));
}

// Runs every registered detector whose manifest names it (P-08): solely
// registered plugins run, so a plugin absent from the registry array never
// executes. Results sort by plugin id for canonical output (P-11). A
// registered manifest without a bound implementation is a wiring defect and
// degrades to `invalid-output` with an empty finding list, keeping the
// analysis standing.
export function runRegisteredDetectors(
  registry: PluginRegistry,
  plugins: ReadonlyMap<string, DetectorPlugin>,
  input: DetectorInput,
): readonly PluginResultEntry[] {
  const manifests = [...registry.plugins].sort((left, right) => {
    if (left.id < right.id) {
      return -1;
    }
    if (left.id > right.id) {
      return 1;
    }
    return 0;
  });
  const out: PluginResultEntry[] = [];
  for (const manifest of manifests) {
    const plugin = plugins.get(manifest.id);
    if (plugin === undefined) {
      out.push(
        Object.freeze({
          pluginId: manifest.id,
          pluginVersion: manifest.version,
          apiVersion: manifest.apiVersion,
          outcome: "invalid-output",
          findings: Object.freeze([]),
        }),
      );
      continue;
    }
    out.push(runDetectorPlugin(plugin, input));
  }
  return Object.freeze(out);
}

// Canonical mapping of one plugin result entry (P-11): finding payload keys
// serialize in lexicographic order through the canonical path, and offsets
// write as numbers with null where the offset is underivable.
export function pluginResultToCanonical(entry: PluginResultEntry): CanonicalValue {
  return {
    pluginId: entry.pluginId as string,
    pluginVersion: entry.pluginVersion as string,
    apiVersion: entry.apiVersion as string,
    outcome: entry.outcome,
    findings: entry.findings.map((finding) => ({
      id: finding.id,
      pluginId: finding.pluginId as string,
      title: finding.title,
      payload: finding.payload as CanonicalValue,
      evidence: finding.evidence.map((item) => ({
        selector: item.selector as string,
        offset: (item.offset as number | undefined) ?? null,
      })),
    })),
  };
}
