// Typed plugin API: manifest types and smart constructors (S-042, P-01).
// The manifest is the single contract per plugin. PluginManifest.parse is
// the single entry path and returns Result, never throws, in the style of
// A-10 and A-11. Values are frozen at construction. Detector plugin
// modules import solely this module and src/domain types and pure
// functions (P-03); the registry and the composition root do the wiring.
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";

// The core exports one plugin API version (P-02). Compatibility follows
// semver on the API, separately from any plugin's own version: the
// registry accepts a plugin whose apiVersion major equals the core major
// and whose minor is at most the core minor. Patch versions stay free.
export const PLUGIN_API_VERSION = "1.0.0";

// Lowercase dotted name with at least two segments, for example
// dev.brandklipparen.capability. The id namespaces every finding the
// plugin emits and must be unique in the registry.
export type PluginId = string & { readonly __brand: "PluginId" };
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

// Semver form, same shape as ModelVersion in A-10.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export type PluginVersion = string & { readonly __brand: "PluginVersion" };
export type PluginApiVersion = string & { readonly __brand: "PluginApiVersion" };

// Closed plugin kind union (P-01). A new kind gives a type error at every
// registry dispatch site until it is handled.
export type PluginKind = "detector" | "assessment";

// Closed catalogue of detector inputs (ADR section 3.2, reviewed
// section 0.1): the three facts the host has already computed
// deterministically. Every fact the host supplies is a fact the detector
// cannot derive purely itself. Requesting a name outside this catalogue
// is unrepresentable in the manifest type; a fact re-enters the catalogue
// only by ADR amendment.
export type PluginInputName = "bytecode" | "cloneMatch" | "decompilerCause";

const PLUGIN_INPUT_NAMES: ReadonlySet<string> = new Set([
  "bytecode",
  "cloneMatch",
  "decompilerCause",
]);

// JSON values carried in the output schema descriptor.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

// JSON Schema descriptor for the plugin output (ADR section 3.3): the
// draft-07 subset already used in v1.json and the MCP JsonSchema type.
// The host validates every plugin output against this descriptor at the
// registry boundary. No new schema library is used.
export type JsonSchema = { readonly [keyword: string]: JsonValue };

// Closed keyword subset the registry supports. Output outside this subset
// is unrepresentable in the manifest and gives a typed construction error.
const ALLOWED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "required",
  "properties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "additionalProperties",
]);

const SCHEMA_TYPE_NAMES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

// Closed capability flags per kind (ADR section 3.4, reviewed section
// 0.2). Capabilities gate what the host offers the plugin; they never
// widen what the plugin can reach, because the plugin receives solely
// values. Detector-forbidden values fail in the manifest smart
// constructor itself, so a detector manifest carrying `needsNetwork: true`
// cannot be constructed, let alone registered.
export type DetectorCapabilities = {
  readonly needsNetwork: false;
  readonly needsSecrets: false;
  readonly affectsScore: boolean;
  readonly runsInFastPath: boolean;
};

export type AssessmentCapabilities = {
  readonly needsNetwork: boolean;
  readonly needsSecrets: false;
  readonly affectsScore: false;
  readonly runsInFastPath: false;
};

export type PluginCapabilities = DetectorCapabilities | AssessmentCapabilities;

// Per-plugin bounds per kind (ADR section 3.4). Detector limits carry the
// three count and size bounds; a detector carrying a provider deadline is
// a type error. Assessment limits add the deadline and byte bounds
// mirroring A-17. Values arrive through typed configuration, never from
// the plugin at run time.
export type DetectorLimits = {
  readonly maxFindings: number;
  readonly maxEvidencePerFinding: number;
  readonly maxOutputBytes: number;
};

export type AssessmentLimits = DetectorLimits & {
  readonly deadlineMs: number;
  readonly maxBytesIn: number;
  readonly maxBytesOut: number;
  readonly maxConcurrency: number;
};

export type PluginLimits = DetectorLimits | AssessmentLimits;

type SharedManifestFields = {
  readonly id: PluginId;
  readonly version: PluginVersion;
  readonly kind: PluginKind;
  readonly apiVersion: PluginApiVersion;
  readonly displayName: string;
  readonly description: string;
  // Required plugin docs reference (S-052, P-15): the fixed file name of
  // the plugin's `PLUGIN.md` beside its manifest. The version lives in the
  // manifest `version` and in the doc, never in this reference.
  readonly docs: "PLUGIN.md";
  readonly outputSchema: JsonSchema;
};

// Discriminated manifest union (ADR section 3.1, reviewed section 0.2):
// detector and assessment manifests are different types with different
// `inputs`, `capabilities` and `limits` shapes, so a state that mixes
// kinds (a detector with a provider deadline, an assessment declaring
// detector inputs) fails to typecheck instead of failing at run time.
export type DetectorManifest = SharedManifestFields & {
  readonly kind: "detector";
  readonly inputs: readonly PluginInputName[];
  readonly capabilities: DetectorCapabilities;
  readonly limits: DetectorLimits;
};

export type AssessmentManifest = SharedManifestFields & {
  readonly kind: "assessment";
  readonly inputs: readonly [];
  readonly capabilities: AssessmentCapabilities;
  readonly limits: AssessmentLimits;
};

export type PluginManifest = DetectorManifest | AssessmentManifest;

// One branch per manifest field, so a new field forces an explicit branch
// at every exhaustive switch. Values stay outside the error text where
// they could carry secrets (P-01); the plugin id travels in the registry
// error where the registry must name it (P-02).
export type PluginManifestError =
  | { kind: "invalid-plugin-id"; message: string }
  | { kind: "invalid-plugin-version"; message: string }
  | { kind: "invalid-plugin-kind"; message: string }
  | { kind: "invalid-plugin-api-version"; message: string }
  | { kind: "invalid-plugin-display-name"; message: string }
  | { kind: "invalid-plugin-description"; message: string }
  | { kind: "invalid-plugin-inputs"; message: string }
  | { kind: "invalid-plugin-docs"; message: string }
  | { kind: "invalid-plugin-output-schema"; message: string }
  | { kind: "invalid-plugin-capabilities"; message: string }
  | { kind: "invalid-plugin-limits"; message: string };

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSemver(raw: unknown): string | null {
  if (typeof raw !== "string" || !SEMVER_PATTERN.test(raw)) {
    return null;
  }
  return raw;
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) {
    return null;
  }
  return raw;
}

function splitSemverParts(version: string): readonly [number, number] | null {
  const parts = version.split(".");
  const major = parts[0] === undefined ? NaN : Number(parts[0]);
  const minor = parts[1] === undefined ? NaN : Number(parts[1]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    return null;
  }
  return [major, minor];
}

// True when the plugin API version falls in the supported range (P-02):
// same major as the core, minor at most the core minor. Patch versions
// stay free on both sides.
export function isSupportedApiVersion(apiVersion: PluginApiVersion): boolean {
  const core = splitSemverParts(PLUGIN_API_VERSION);
  const plugin = splitSemverParts(apiVersion);
  if (core === null || plugin === null) {
    return false;
  }
  return plugin[0] === core[0] && plugin[1] <= core[1];
}

function validateOutputSchema(value: unknown): value is JsonSchema {
  if (!isRecord(value)) {
    return false;
  }
  for (const keyword of Object.keys(value)) {
    if (!ALLOWED_SCHEMA_KEYWORDS.has(keyword)) {
      return false;
    }
  }
  const typeField: unknown = value["type"];
  if (typeField !== undefined) {
    if (typeof typeField === "string") {
      if (!SCHEMA_TYPE_NAMES.has(typeField)) {
        return false;
      }
    } else if (Array.isArray(typeField)) {
      if (
        typeField.length === 0 ||
        !typeField.every(
          (entry): entry is string => typeof entry === "string" && SCHEMA_TYPE_NAMES.has(entry),
        )
      ) {
        return false;
      }
    } else {
      return false;
    }
  }
  const required: unknown = value["required"];
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((entry) => typeof entry === "string")) {
      return false;
    }
  }
  const properties: unknown = value["properties"];
  if (properties !== undefined) {
    if (!isRecord(properties)) {
      return false;
    }
    for (const entry of Object.values(properties)) {
      if (!validateOutputSchema(entry)) {
        return false;
      }
    }
  }
  const items: unknown = value["items"];
  if (items !== undefined) {
    if (Array.isArray(items)) {
      for (const entry of items) {
        if (!validateOutputSchema(entry)) {
          return false;
        }
      }
    } else if (!validateOutputSchema(items)) {
      return false;
    }
  }
  const additional: unknown = value["additionalProperties"];
  if (additional !== undefined) {
    if (typeof additional !== "boolean" && !validateOutputSchema(additional)) {
      return false;
    }
  }
  const enumValues: unknown = value["enum"];
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues) || enumValues.length === 0) {
      return false;
    }
  }
  for (const bound of ["minimum", "maximum"] as const) {
    const entry: unknown = value[bound];
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) {
      return false;
    }
  }
  for (const bound of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    const entry: unknown = value[bound];
    if (
      entry !== undefined &&
      (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)
    ) {
      return false;
    }
  }
  return true;
}

function deepFreezeSchema(schema: JsonSchema): JsonSchema {
  for (const entry of Object.values(schema)) {
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === "object" && item !== null) {
          deepFreezeSchema(item as JsonSchema);
        }
      }
      Object.freeze(entry);
    } else if (typeof entry === "object" && entry !== null) {
      deepFreezeSchema(entry as JsonSchema);
    }
  }
  return Object.freeze(schema);
}

function parseCapabilities(
  kind: "detector",
  raw: unknown,
): Result<DetectorCapabilities, PluginManifestError>;
function parseCapabilities(
  kind: "assessment",
  raw: unknown,
): Result<AssessmentCapabilities, PluginManifestError>;
function parseCapabilities(
  kind: PluginKind,
  raw: unknown,
): Result<PluginCapabilities, PluginManifestError> {
  if (raw === undefined) {
    return ok(
      kind === "detector"
        ? { needsNetwork: false, needsSecrets: false, affectsScore: false, runsInFastPath: true }
        : { needsNetwork: true, needsSecrets: false, affectsScore: false, runsInFastPath: false },
    );
  }
  if (!isRecord(raw)) {
    return err({
      kind: "invalid-plugin-capabilities",
      message: "plugin capabilities must be an object of booleans",
    });
  }
  const defaults =
    kind === "detector"
      ? { needsNetwork: false, needsSecrets: false, affectsScore: false, runsInFastPath: true }
      : { needsNetwork: true, needsSecrets: false, affectsScore: false, runsInFastPath: false };
  const parsed: { [key: string]: boolean } = {};
  for (const key of ["needsNetwork", "needsSecrets", "affectsScore", "runsInFastPath"] as const) {
    const entry: unknown = raw[key];
    if (entry === undefined) {
      parsed[key] = defaults[key];
    } else if (typeof entry === "boolean") {
      parsed[key] = entry;
    } else {
      return err({
        kind: "invalid-plugin-capabilities",
        message: `plugin capability ${key} must be a boolean`,
      });
    }
  }
  for (const key of Object.keys(raw)) {
    if (!(key in parsed)) {
      return err({
        kind: "invalid-plugin-capabilities",
        message: `plugin capability ${key} is outside the closed capability set`,
      });
    }
  }
  if (kind === "detector") {
    if (parsed["needsNetwork"] === true) {
      return err({
        kind: "invalid-plugin-capabilities",
        message: "detector plugins hold zero network capability",
      });
    }
    if (parsed["needsSecrets"] === true) {
      return err({
        kind: "invalid-plugin-capabilities",
        message: "detector plugins hold zero secret capability",
      });
    }
    return ok({
      needsNetwork: false,
      needsSecrets: false,
      affectsScore: parsed["affectsScore"] ?? false,
      runsInFastPath: parsed["runsInFastPath"] ?? false,
    });
  }
  if (parsed["needsSecrets"] === true) {
    return err({
      kind: "invalid-plugin-capabilities",
      message: "assessment plugins never receive key values",
    });
  }
  if (parsed["affectsScore"] === true) {
    return err({
      kind: "invalid-plugin-capabilities",
      message: "assessment plugins never affect the score",
    });
  }
  if (parsed["runsInFastPath"] === true) {
    return err({
      kind: "invalid-plugin-capabilities",
      message: "assessment plugins never run in the fast path",
    });
  }
  return ok({
    needsNetwork: parsed["needsNetwork"] ?? false,
    needsSecrets: false,
    affectsScore: false,
    runsInFastPath: false,
  });
}

const ASSESSMENT_LIMIT_KEYS = [
  "deadlineMs",
  "maxBytesIn",
  "maxBytesOut",
  "maxConcurrency",
] as const;

function parseLimits(
  kind: "detector",
  raw: unknown,
): Result<DetectorLimits, PluginManifestError>;
function parseLimits(
  kind: "assessment",
  raw: unknown,
): Result<AssessmentLimits, PluginManifestError>;
function parseLimits(
  kind: PluginKind,
  raw: unknown,
): Result<PluginLimits, PluginManifestError> {
  if (!isRecord(raw)) {
    return err({
      kind: "invalid-plugin-limits",
      message: "plugin limits must be an object with positive integer bounds",
    });
  }
  const maxFindings = parsePositiveInt(raw["maxFindings"]);
  const maxEvidencePerFinding = parsePositiveInt(raw["maxEvidencePerFinding"]);
  const maxOutputBytes = parsePositiveInt(raw["maxOutputBytes"]);
  if (maxFindings === null || maxEvidencePerFinding === null || maxOutputBytes === null) {
    return err({
      kind: "invalid-plugin-limits",
      message:
        "plugin limits require positive integer maxFindings, maxEvidencePerFinding and maxOutputBytes",
    });
  }
  if (kind === "detector") {
    for (const key of ASSESSMENT_LIMIT_KEYS) {
      if (raw[key] !== undefined) {
        return err({
          kind: "invalid-plugin-limits",
          message: `detector plugins carry no provider limit ${key}`,
        });
      }
    }
    return ok(Object.freeze({ maxFindings, maxEvidencePerFinding, maxOutputBytes }));
  }
  const assessed: { [key: string]: number } = {
    maxFindings,
    maxEvidencePerFinding,
    maxOutputBytes,
  };
  for (const key of ASSESSMENT_LIMIT_KEYS) {
    const parsed = parsePositiveInt(raw[key]);
    if (parsed === null) {
      return err({
        kind: "invalid-plugin-limits",
        message: `assessment plugins require positive integer limit ${key}`,
      });
    }
    assessed[key] = parsed;
  }
  return ok(Object.freeze(assessed) as PluginLimits);
}

export const PluginManifest = {
  parse(raw: unknown): Result<PluginManifest, PluginManifestError> {
    if (!isRecord(raw)) {
      return err({ kind: "invalid-plugin-id", message: "plugin manifest must be an object" });
    }
    const id: unknown = raw["id"];
    if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) {
      return err({
        kind: "invalid-plugin-id",
        message:
          "plugin id must be a lowercase dotted name with at least two segments, for example dev.brandklipparen.capability",
      });
    }
    const version = parseSemver(raw["version"]);
    if (version === null) {
      return err({
        kind: "invalid-plugin-version",
        message: "plugin version must be semver MAJOR.MINOR.PATCH",
      });
    }
    const kind: unknown = raw["kind"];
    if (kind !== "detector" && kind !== "assessment") {
      return err({
        kind: "invalid-plugin-kind",
        message: 'plugin kind must be "detector" or "assessment"',
      });
    }
    const apiVersion = parseSemver(raw["apiVersion"]);
    if (apiVersion === null) {
      return err({
        kind: "invalid-plugin-api-version",
        message: "plugin apiVersion must be semver MAJOR.MINOR.PATCH",
      });
    }
    const displayName: unknown = raw["displayName"];
    if (typeof displayName !== "string" || displayName.trim().length === 0 || displayName.length > 200) {
      return err({
        kind: "invalid-plugin-display-name",
        message: "plugin displayName must be a short non-empty English name",
      });
    }
    const description: unknown = raw["description"];
    if (
      typeof description !== "string" ||
      description.trim().length === 0 ||
      description.length > 1000
    ) {
      return err({
        kind: "invalid-plugin-description",
        message: "plugin description must be one or two non-empty English sentences",
      });
    }
    const inputs: unknown = raw["inputs"];
    if (!Array.isArray(inputs)) {
      return err({
        kind: "invalid-plugin-inputs",
        message: "plugin inputs must be an array of declared input catalogue names",
      });
    }
    const seen = new Set<string>();
    for (const entry of inputs) {
      if (typeof entry !== "string" || !PLUGIN_INPUT_NAMES.has(entry) || seen.has(entry)) {
        return err({
          kind: "invalid-plugin-inputs",
          message: "plugin inputs must hold unique names from the closed input catalogue",
        });
      }
      seen.add(entry);
    }
    if (kind === "assessment") {
      if (inputs.length > 0) {
        return err({
          kind: "invalid-plugin-inputs",
          message: "assessment plugins declare no detector inputs",
        });
      }
    } else if (inputs.length === 0 || !seen.has("bytecode")) {
      return err({
        kind: "invalid-plugin-inputs",
        message: "detector plugins declare a non-empty input set holding bytecode",
      });
    }
    const docs: unknown = raw["docs"];
    if (docs !== "PLUGIN.md") {
      return err({
        kind: "invalid-plugin-docs",
        message: 'plugin docs must reference the fixed file name "PLUGIN.md"',
      });
    }
    const outputSchema: unknown = raw["outputSchema"];
    if (!validateOutputSchema(outputSchema)) {
      return err({
        kind: "invalid-plugin-output-schema",
        message: "plugin outputSchema must stay inside the supported keyword subset",
      });
    }
    const frozenInputs = Object.freeze([...(inputs as PluginInputName[])]);
    const shared = {
      id: id as PluginId,
      version: version as PluginVersion,
      apiVersion: apiVersion as PluginApiVersion,
      displayName,
      description,
      docs: "PLUGIN.md" as const,
      outputSchema: deepFreezeSchema(outputSchema),
    };
    if (kind === "assessment") {
      const capabilities = parseCapabilities(kind, raw["capabilities"]);
      if (!capabilities.ok) {
        return err(capabilities.error);
      }
      const limits = parseLimits(kind, raw["limits"]);
      if (!limits.ok) {
        return err(limits.error);
      }
      return ok(
        Object.freeze({
          ...shared,
          kind,
          inputs: frozenInputs as readonly [],
          capabilities: Object.freeze(capabilities.value),
          limits: limits.value,
        }),
      );
    }
    const capabilities = parseCapabilities(kind, raw["capabilities"]);
    if (!capabilities.ok) {
      return err(capabilities.error);
    }
    const limits = parseLimits(kind, raw["limits"]);
    if (!limits.ok) {
      return err(limits.error);
    }
    return ok(
      Object.freeze({
        ...shared,
        kind,
        inputs: frozenInputs as readonly PluginInputName[],
        capabilities: Object.freeze(capabilities.value),
        limits: limits.value,
      }),
    );
  },
};
