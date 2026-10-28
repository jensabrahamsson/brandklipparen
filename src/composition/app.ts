// Application builder for the S-105 composition main (K-101, K-104).
// `buildApp` wires the validated configuration to adapters, services and
// the REST/MCP driving adapters without listening on a port: `src/main.ts`
// calls it once, then listens (REST) or serves stdio (MCP). Rate limiting
// is required here: a configuration without the three versioned
// rate-limit values fails as a typed missing-variable error before any
// service, adapter or listener is built, so no composed app ever runs
// without the limiter. Non-first-party detectors are admitted through the
// signed allowlist before any load (S-049): an entry the allowlist does
// not name fails startup as a typed error, and an admitted entry with a
// static worker module runs off the hot path through the plugin worker.
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { TemplateVersion } from "../domain/types.ts";
import type { CapabilityCatalogue } from "../domain/signals.ts";
import { buildDetectorSet, wireAppServices } from "./root.ts";
import type {
  AnalyzeTokenPorts,
  AppServices,
  DetectorSet,
} from "../application/analyzeToken.ts";
import { createAssessmentServiceFromConfig } from "./root.ts";
import type { AssessmentTransportOverrides } from "./root.ts";
import { createInvestigationServiceFromConfig } from "./root.ts";
import type { AssessmentService } from "../application/assessmentService.ts";
import type { InvestigationService } from "../application/investigationService.ts";
import { FIRST_PARTY_DETECTOR_IDS } from "../plugins/detector.ts";
import type { DetectorExecution } from "../plugins/detector.ts";
import type { PluginRegistryError } from "../plugins/registry.ts";
import { verifyPluginPackage } from "../adapters/pluginAllowlist/allowlist.ts";
import type {
  Allowlist,
  PluginPackage,
} from "../adapters/pluginAllowlist/allowlist.ts";
import { runDetectorInWorker } from "../adapters/pluginWorker/pluginWorker.ts";
import type { PluginWorkerOptions } from "../adapters/pluginWorker/pluginWorker.ts";
import type { AppConfig, ConfigError } from "../ports/config.ts";
import type { RateLimitConfig } from "../interfaces/rest/rateLimit.ts";
import type { RestServerOptions } from "../interfaces/rest/server.ts";
import type { McpServerOptions } from "../interfaces/mcp/server.ts";

// Startup errors from the application builder: configuration errors name
// the variable with values kept outside the text (A-15); registry errors
// name the plugin id (P-02).
export type BuildAppError = ConfigError | PluginRegistryError;

// Worker process bounds for off-hot-path detectors (S-105, A-17): the
// composition passes versioned values, never detector-chosen ones.
export type DetectorWorkerConfig = {
  readonly runnerPath: string;
  readonly nodePath?: string | undefined;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
};

export type BuildAppDeps = {
  // Bound ports: the caller (tests with fakes, main with adapters)
  // supplies every port the shared service reads.
  readonly ports: AnalyzeTokenPorts;
  // Detector set; defaults to the static first-party set built at
  // startup. A caller that registers extra detectors passes its own set.
  readonly detectors?: DetectorSet | undefined;
  // Worker bounds for off-hot-path detectors; without it every entry runs
  // in-process.
  readonly detectorExecution?: DetectorWorkerConfig | undefined;
  // Signed allowlist admitting separately published detectors (S-049).
  // Required as soon as the registry holds a non-first-party detector.
  readonly allowlist?: Allowlist | undefined;
  // Package bytes per non-first-party detector id, verified against the
  // allowlist before any import.
  readonly detectorPackages?: Readonly<Record<string, PluginPackage>> | undefined;
  // Recorded transports for the assessment adapters; tests replay
  // fixtures through these and never touch the network.
  readonly assessmentTransports?: AssessmentTransportOverrides | undefined;
};

export type BuiltApp = {
  readonly services: AppServices;
  readonly detectors: DetectorSet;
  readonly assessment: AssessmentService;
  readonly investigation: InvestigationService;
  // Required rate limiting shared by both driving adapters (K-504, M-08).
  readonly rateLimit: RateLimitConfig;
  // Ready server options: the drivers construct their servers from these
  // without further wiring. Neither server listens here.
  readonly rest: RestServerOptions;
  readonly mcp: McpServerOptions;
};

// Pinned template version for composed servers (K-102): the deterministic
// template set is fixed in v1, so the builder pins it instead of reading
// a per-setup value. A mismatch with the loaded artifact fails at the
// first analysis like any caller-supplied version.
const PINNED_TEMPLATE_VERSION = "1.0.0";

// Operational capability catalogue for composed servers (K-102, K-210):
// the v1 mapping of structural capability keys to risk, direction and
// severity. The values steer scoring, so a future artifact-carried
// catalogue replaces this constant without touching the wiring.
export const DEFAULT_CAPABILITY_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// Logical setting naming the allowlist source for error text (A-15): the
// value (entries, digests, signatures) never enters the message.
const ALLOWLIST_VARIABLE = "BRANDKLIPPAREN_PLUGIN_ALLOWLIST";

function requireRateLimit(config: AppConfig): Result<RateLimitConfig, ConfigError> {
  if (config.rateLimitPerKeyPerMinute === undefined) {
    return err({
      kind: "missing-variable",
      variable: "BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE",
    });
  }
  if (config.quotaPerKeyPerDay === undefined) {
    return err({ kind: "missing-variable", variable: "BRANDKLIPPAREN_QUOTA_PER_KEY_PER_DAY" });
  }
  if (config.globalRatePerMinute === undefined) {
    return err({ kind: "missing-variable", variable: "BRANDKLIPPAREN_GLOBAL_RATE_PER_MINUTE" });
  }
  return ok(
    Object.freeze({
      perKeyPerMinute: config.rateLimitPerKeyPerMinute,
      perKeyPerDay: config.quotaPerKeyPerDay,
      globalPerMinute: config.globalRatePerMinute,
    }),
  );
}

// Allowlist admission for one non-first-party detector (S-105): the
// registry id and version must verify against the allowlist from package
// bytes before any import. First-party detectors skip this gate: they are
// reviewed in-tree code, not separately published packages.
function admitDetector(
  pluginId: string,
  pluginVersion: string,
  allowlist: Allowlist | undefined,
  packages: Readonly<Record<string, PluginPackage>> | undefined,
): Result<null, ConfigError> {
  if (allowlist === undefined) {
    return err({
      kind: "invalid-value",
      variable: ALLOWLIST_VARIABLE,
      reason: `plugin ${pluginId} is not admitted by the allowlist`,
    });
  }
  const pkg = packages?.[pluginId];
  if (pkg === undefined || pkg.version !== pluginVersion) {
    return err({
      kind: "invalid-value",
      variable: ALLOWLIST_VARIABLE,
      reason: `plugin ${pluginId} is not admitted by the allowlist`,
    });
  }
  const admitted = verifyPluginPackage(pkg, allowlist);
  if (!admitted.ok) {
    return err({
      kind: "invalid-value",
      variable: ALLOWLIST_VARIABLE,
      reason: `plugin ${pluginId} is not admitted by the allowlist`,
    });
  }
  return ok(null);
}

function toDetectorExecution(config: DetectorWorkerConfig): DetectorExecution {
  const workerOptions: PluginWorkerOptions = Object.freeze({
    runnerPath: config.runnerPath,
    nodePath: config.nodePath,
    timeoutMs: config.timeoutMs,
    maxInputBytes: config.maxInputBytes,
    maxOutputBytes: config.maxOutputBytes,
  });
  return Object.freeze({
    runInWorker: (modulePath: string, input: unknown) =>
      runDetectorInWorker(modulePath, input, workerOptions),
  });
}

// Single composition point for the served app (S-105, A-03): validated
// configuration to bound ports, detector set, services and both driving
// adapters. Pure wiring apart from the bound ports the caller supplies:
// builds nothing at module load, throws nothing, listens on no port.
export function buildApp(config: AppConfig, deps: BuildAppDeps): Result<BuiltApp, BuildAppError> {
  const rateLimit = requireRateLimit(config);
  if (!rateLimit.ok) {
    return err(rateLimit.error);
  }
  let detectors = deps.detectors;
  if (detectors === undefined) {
    const built = buildDetectorSet();
    if (!built.ok) {
      return err(built.error);
    }
    detectors = built.value;
  }
  for (const entry of detectors.registry.entries) {
    const pluginId = entry.manifest.id;
    if (FIRST_PARTY_DETECTOR_IDS.includes(pluginId)) {
      continue;
    }
    const admitted = admitDetector(
      pluginId,
      entry.manifest.version,
      deps.allowlist,
      deps.detectorPackages,
    );
    if (!admitted.ok) {
      return err(admitted.error);
    }
  }
  const wired: DetectorSet = Object.freeze({
    registry: detectors.registry,
    execution:
      deps.detectorExecution === undefined
        ? detectors.execution
        : toDetectorExecution(deps.detectorExecution),
  });
  const services: AppServices = wireAppServices(deps.ports, wired);
  const assessment = createAssessmentServiceFromConfig(config, services, deps.assessmentTransports);
  if (!assessment.ok) {
    return err(assessment.error);
  }
  const investigation = createInvestigationServiceFromConfig(config, wired);
  if (!investigation.ok) {
    return err(investigation.error);
  }
  const templateVersion = TemplateVersion.parse(PINNED_TEMPLATE_VERSION);
  if (!templateVersion.ok) {
    return err({
      kind: "invalid-value",
      variable: "BRANDKLIPPAREN_TEMPLATE_VERSION",
      reason: "the pinned template version must parse",
    });
  }
  // Calibrated detector weights read once at startup from the loaded
  // artifact (S-047, P-05): absent on a load failure, in which case the
  // routes expose the uncalibrated weight-0 list like the test wiring.
  const loaded = deps.ports.modelArtifacts.load(config.modelVersion);
  const pluginWeights = loaded.ok ? loaded.value.artifact.pluginWeights : undefined;
  const apiKeys = config.apiKeys ?? Object.freeze([]);
  const rest: RestServerOptions = Object.freeze({
    services,
    apiKeys,
    apiKeyPepper: config.apiKeyPepper,
    modelVersion: config.modelVersion,
    indexVersion: config.cloneIndexVersion,
    templateVersion: templateVersion.value,
    catalogue: DEFAULT_CAPABILITY_CATALOGUE,
    detectors: wired,
    pluginWeights,
    assessmentService: assessment.value,
    investigationService: investigation.value,
    rateLimit: rateLimit.value,
  });
  const mcp: McpServerOptions = Object.freeze({
    services,
    apiKeys,
    apiKeyPepper: config.apiKeyPepper,
    modelVersion: config.modelVersion,
    indexVersion: config.cloneIndexVersion,
    templateVersion: templateVersion.value,
    catalogue: DEFAULT_CAPABILITY_CATALOGUE,
    detectors: wired,
    pluginWeights,
    assessmentService: assessment.value,
    investigationService: investigation.value,
    rateLimit: rateLimit.value,
  });
  return ok(
    Object.freeze({
      services,
      detectors: wired,
      assessment: assessment.value,
      investigation: investigation.value,
      rateLimit: rateLimit.value,
      rest,
      mcp,
    }),
  );
}
