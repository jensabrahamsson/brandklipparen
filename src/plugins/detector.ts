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
import type { CloneHit } from "../domain/clones.ts";
import { CodeSnippet, Evidence } from "../domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../domain/evidence.ts";
import type { HardToAnalyzeCause } from "../domain/signals.ts";
import { PcOffset, Selector } from "../domain/types.ts";
import type {
  Bytecode as BytecodeType,
  CodeHash as CodeHashType,
} from "../domain/types.ts";
import type {
  DetectorManifest,
  JsonSchema,
  JsonValue,
  PluginApiVersion,
  PluginId,
  PluginVersion,
} from "./api.ts";
import type { PluginRegistry } from "./registry.ts";

// Full host fact set for one analysis (ADR section 3.2): every fact the
// host computed deterministically. The registry projects this set per
// detector before the call, so a detector never observes an undeclared
// fact. `bytecode` travels with its `codeHash` per the catalogue row
// "Bytecode with CodeHash"; `cloneMatch` is the template hit the host
// looked up through CloneIndexPort (null on a miss or an index failure);
// `decompilerCause` is the cause the host derived from the DecompilerPort
// failure (null when decompilation succeeded or no worker is bound).
export type DetectorFacts = {
  readonly bytecode: BytecodeType;
  readonly codeHash: CodeHashType;
  readonly cloneMatch: CloneHit | null;
  readonly decompilerCause: HardToAnalyzeCause | null;
};

// Projected detector input for v1 (ADR section 3.2): one frozen input per
// detector holding exactly the facts that detector declared. An undeclared
// fact is absent (the field is missing, not nulled), so a detector that
// reads one reads `undefined` and the registry contract suite catches it
// by requiring the projected run and the full-fact run to agree.
export type DetectorInput = {
  readonly bytecode: BytecodeType;
  readonly codeHash: CodeHashType;
  readonly cloneMatch?: CloneHit | null;
  readonly decompilerCause?: HardToAnalyzeCause | null;
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
  readonly manifest: DetectorManifest;
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

// Frozen full fact set construction. The host computes every fact once
// per analysis; values are frozen so detect cannot widen them. A missing
// hit or cause arrives as its stated null, so the projection below passes
// an explicit empty fact for a declared-but-absent input.
export function createDetectorInput(
  bytecode: BytecodeType,
  codeHash: CodeHashType,
  facts?: {
    readonly cloneMatch?: CloneHit | null;
    readonly decompilerCause?: HardToAnalyzeCause | null;
  },
): DetectorFacts {
  return Object.freeze({
    bytecode,
    codeHash,
    cloneMatch: facts?.cloneMatch ?? null,
    decompilerCause: facts?.decompilerCause ?? null,
  });
}

// Projection to one detector's declared inputs (ADR section 3.2): the host
// builds one frozen input per detector holding exactly the facts that
// detector declared. An undeclared fact is absent, so a detector that
// reads one reads `undefined`. `bytecode` with its `codeHash` always
// travels, since every detector declares it.
export function projectDetectorInput(
  manifest: DetectorManifest,
  facts: DetectorFacts,
): DetectorInput {
  const declared = new Set<string>(manifest.inputs);
  const projected: {
    bytecode: BytecodeType;
    codeHash: CodeHashType;
    cloneMatch?: CloneHit | null;
    decompilerCause?: HardToAnalyzeCause | null;
  } = {
    bytecode: facts.bytecode,
    codeHash: facts.codeHash,
  };
  if (declared.has("cloneMatch")) {
    projected.cloneMatch = facts.cloneMatch;
  }
  if (declared.has("decompilerCause")) {
    projected.decompilerCause = facts.decompilerCause;
  }
  return Object.freeze(projected);
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

// Boundary re-proof of finding identity and evidence ahead of schema
// validation (ADR section 4.1): every finding id carries the
// `<pluginId>:` prefix, `finding.pluginId` equals the manifest id, and
// each evidence entry is re-parsed through the domain smart constructors.
// A selector-shaped string is not evidence until the domain constructor
// accepts it (A-13), and an offset must derive from the analysed bytecode
// (K-010). Any failure is `invalid-output` for that plugin; unproven
// evidence never reaches scoring, serialisation, or rendering.
function hasProvenFindings(
  plugin: DetectorPlugin,
  input: DetectorInput,
  findings: readonly PluginFinding[],
  maxPerFinding: number,
): boolean {
  const prefix = `${plugin.manifest.id}:`;
  for (const finding of findings) {
    if (!isRecord(finding)) {
      return false;
    }
    const record = finding as { readonly [key: string]: unknown };
    const id: unknown = record["id"];
    if (typeof id !== "string" || !id.startsWith(prefix) || id.length === prefix.length) {
      return false;
    }
    if (record["pluginId"] !== plugin.manifest.id) {
      return false;
    }
    if (typeof record["title"] !== "string" || (record["title"] as string).trim().length === 0) {
      return false;
    }
    const evidence: unknown = record["evidence"];
    if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > maxPerFinding) {
      return false;
    }
    for (const entry of evidence) {
      if (!isProvenEvidence(entry, input.bytecode)) {
        return false;
      }
    }
  }
  return true;
}

function isProvenEvidence(entry: unknown, bytecode: BytecodeType): boolean {
  if (!isRecord(entry) || typeof entry["selector"] !== "string") {
    return false;
  }
  const selector = Selector.parse(entry["selector"]);
  if (!selector.ok) {
    return false;
  }
  const offset: unknown = entry["offset"];
  if (offset !== undefined && offset !== null) {
    if (typeof offset !== "number" || !PcOffset.of(offset, bytecode).ok) {
      return false;
    }
  }
  const snippet: unknown = entry["snippet"];
  if (snippet === undefined) {
    return Evidence.create({ selector: selector.value }).ok;
  }
  if (!isRecord(snippet) || typeof snippet["selector"] !== "string") {
    return false;
  }
  const snippetSelector = Selector.parse(snippet["selector"]);
  if (!snippetSelector.ok) {
    return false;
  }
  if (
    typeof snippet["text"] !== "string" ||
    (snippet["text"] as string).length === 0 ||
    typeof snippet["line"] !== "number" ||
    !Number.isInteger(snippet["line"]) ||
    (snippet["line"] as number) < 0
  ) {
    return false;
  }
  const built = CodeSnippet.create({
    text: snippet["text"] as string,
    line: snippet["line"] as number,
    selector: snippetSelector.value,
  });
  if (!built.ok) {
    return false;
  }
  if (offset === undefined || offset === null) {
    return Evidence.create({ selector: selector.value, snippet: built.value }).ok;
  }
  const provenOffset = PcOffset.of(offset, bytecode);
  return provenOffset.ok && Evidence.create({ selector: selector.value, offset: provenOffset.value, snippet: built.value }).ok;
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
  if (!hasProvenFindings(plugin, input, raw, limits.maxEvidencePerFinding)) {
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

// Runs every registered detector entry (P-08): solely registered entries
// run, so a plugin absent from the registry never executes. Each entry
// carries its implementation, so a registered manifest without an
// implementation is unrepresentable and needs no per-analysis outcome.
// The host projects the full fact set to each detector's declared inputs
// before the call (ADR section 3.2). Results sort by plugin id for
// canonical output (P-11).
export function runRegisteredDetectors(
  registry: PluginRegistry,
  facts: DetectorFacts,
): readonly PluginResultEntry[] {
  const entries = [...registry.entries].sort((left, right) => {
    if (left.manifest.id < right.manifest.id) {
      return -1;
    }
    if (left.manifest.id > right.manifest.id) {
      return 1;
    }
    return 0;
  });
  const out: PluginResultEntry[] = [];
  for (const plugin of entries) {
    out.push(runDetectorPlugin(plugin, projectDetectorInput(plugin.manifest, facts)));
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
