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
import { randomUUID } from "node:crypto";
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { Address, PromptVersion, RequestId, TemplateVersion, Timestamp } from "../domain/types.ts";
import type { CapabilityCatalogue } from "../domain/signals.ts";
import { FEED_FACTORIES, QUOTE_TOKENS } from "../domain/lpFeed.ts";
import type { QuoteSet } from "../domain/lpFeed.ts";
import { createEtherscanLogsAdapter } from "../adapters/lpFeed/etherscanLogsAdapter.ts";
import { createRpcLogsAdapter } from "../adapters/lpFeed/rpcLogsAdapter.ts";
import { createMarketFeedAdapter } from "../adapters/market/dexscreenerAdapter.ts";
import { createMarketService } from "../application/marketService.ts";
import { createProofService } from "../application/proofService.ts";
import { calibrationViewOf } from "../application/calibrationView.ts";
import { createSourcifySourceAdapter } from "../adapters/source/sourcifyAdapter.ts";
import type { SourcifyTransport } from "../adapters/source/sourcifyAdapter.ts";
import { ExplorerSourceAdapter } from "../adapters/source/explorerSourceAdapter.ts";
import type { ExplorerSourceTransport } from "../adapters/source/explorerSourceAdapter.ts";
import { createVerifiedSourceService } from "../application/verifiedSource.ts";
import type { VerifiedSourceService } from "../application/verifiedSource.ts";
import type { MarketNewReader } from "../ports/marketFeed.ts";
import { loadLiveTokensFile, saveLiveTokensFile } from "../adapters/liveTokens/liveTokensFile.ts";
import { systemLiveTokensTimers } from "../adapters/liveTokens/systemTimers.ts";
import { createTokenMetadataReader } from "../adapters/liveTokens/tokenMetadata.ts";
import {
  bandForScore,
  createLiveTokensService,
} from "../application/liveTokensService.ts";
import type {
  LiveTokensAnalyzeResult,
  LiveTokensService,
} from "../application/liveTokensService.ts";
import { pluginWeightsOf } from "../application/pluginExposure.ts";
import { buildDetectorSet, wireAppServices } from "./root.ts";
import type {
  AnalyzeTokenPorts,
  AppServices,
  DetectorSet,
} from "../application/analyzeToken.ts";
import { createAssessmentServiceFromConfig } from "./root.ts";
import type { AssessmentTransportOverrides } from "./root.ts";
import { PERSONALIZE_PROMPT_VERSION, createPersonalizeServiceFromConfig } from "./root.ts";
import type { PersonalizeTransportOverrides } from "./root.ts";
import { createInvestigationServiceFromConfig } from "./root.ts";
import {
  createChatServiceFromConfig,
  createExplainCodeServiceFromConfig,
  createExplainServiceFromConfig,
  createRugServiceFromConfig,
} from "./root.ts";
import type { OverlayTransportOverrides } from "./root.ts";
import type { AssessmentService } from "../application/assessmentService.ts";
import type { InvestigationService } from "../application/investigationService.ts";
import type { ChatService } from "../application/chatService.ts";
import type { ExplainCodeService } from "../application/explainCodeService.ts";
import type { ExplainService } from "../application/explainService.ts";
import type { RugService } from "../application/rugService.ts";
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
  // Recorded transport for the experimental AI personalize adapter; tests
  // replay fixtures through it and never touch the network.
  readonly personalizeTransports?: PersonalizeTransportOverrides | undefined;
  // Recorded transports for the opt-in explain, chat and rug overlay
  // adapters; tests replay fixtures through these and never touch the
  // network.
  readonly overlayTransports?: OverlayTransportOverrides | undefined;
  // Recorded transports for the verified-source adapters (VS-B2); tests
  // replay synthetic fixtures through these and never touch the network.
  readonly sourceTransports?:
    | {
        readonly sourcify?: SourcifyTransport | undefined;
        readonly explorer?: ExplorerSourceTransport | undefined;
      }
    | undefined;
};

export type BuiltApp = {
  readonly services: AppServices;
  readonly detectors: DetectorSet;
  readonly assessment: AssessmentService;
  readonly investigation: InvestigationService;
  readonly explain: ExplainService | undefined;
  readonly chat: ChatService | undefined;
  readonly rug: RugService | undefined;
  readonly explainCode: ExplainCodeService | undefined;
  // Live new-tokens service (E-11 follow-up): constructed here so the
  // REST/demo runtime can start it; it runs nothing until start() is
  // called, so tests and CLI one-shots that never start it stay idle.
  readonly liveTokens: LiveTokensService;
  // Market listing reader (DX-B1): the cached listing behind GET
  // /v1/market-new. Undefined when the provider selection is off, so the
  // route answers market-not-configured with zero provider calls.
  readonly marketNew: MarketNewReader | undefined;
  // Required rate limiting shared by both driving adapters (K-504, M-08).
  readonly rateLimit: RateLimitConfig;
  // Ready server options: the drivers construct their servers from these
  // without further wiring. Neither server listens here.
  readonly rest: RestServerOptions;
  readonly mcp: McpServerOptions;
};

// Pinned template version for composed servers (K-102): the deterministic
// template set is fixed in v1.1.0, so the builder pins it instead of
// reading a per-setup value. A mismatch with the loaded artifact fails at
// the first analysis like any caller-supplied version. 1.0.0 stays
// supported for reproducible reads.
const PINNED_TEMPLATE_VERSION = "1.1.0";

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
      ...(config.rateLimitPerKeyGlobalSharePercent === undefined
        ? {}
        : { perKeyGlobalSharePercent: config.rateLimitPerKeyGlobalSharePercent }),
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
  // Experimental AI personalize mapping (S-069, P-27): the service when
  // the provider is configured, otherwise undefined so the routes answer
  // not-configured with zero provider calls and the deterministic
  // baseline stands. The prompt version travels beside the service for
  // the route cache key; an absent service disables the route like an
  // absent version.
  const personalize = createPersonalizeServiceFromConfig(config, deps.personalizeTransports);
  if (!personalize.ok) {
    return err(personalize.error);
  }
  // Opt-in explain, chat and rug overlays: each service when its provider
  // is configured, otherwise undefined so the routes answer not-configured
  // with zero provider calls and the deterministic explanation stands.
  const explain = createExplainServiceFromConfig(config, deps.overlayTransports);
  if (!explain.ok) {
    return err(explain.error);
  }
  const chat = createChatServiceFromConfig(config, deps.overlayTransports);
  if (!chat.ok) {
    return err(chat.error);
  }
  const rug = createRugServiceFromConfig(config, deps.overlayTransports);
  if (!rug.ok) {
    return err(rug.error);
  }
  // Per-function code explanation (VS-B3): the service when its provider
  // is configured, otherwise undefined so the route answers not-configured
  // with zero provider calls and the deterministic code view stands.
  const explainCode = createExplainCodeServiceFromConfig(config, deps.overlayTransports);
  if (!explainCode.ok) {
    return err(explainCode.error);
  }
  const personalizePromptVersion =
    personalize.value === undefined ? undefined : PromptVersion.parse(PERSONALIZE_PROMPT_VERSION);
  if (personalizePromptVersion !== undefined && !personalizePromptVersion.ok) {
    return err({
      kind: "invalid-value",
      variable: "BRANDKLIPPAREN_PERSONALIZE_PROVIDER",
      reason: "the pinned personalize prompt version must parse",
    });
  }
  // Calibrated detector weights read once at startup from the loaded
  // artifact (S-047, P-05): absent on a load failure, in which case the
  // routes expose the uncalibrated weight-0 list like the test wiring.
  const loaded = deps.ports.modelArtifacts.load(config.modelVersion);
  const pluginWeights = loaded.ok ? pluginWeightsOf(wired.registry, loaded.value.artifact) : undefined;
  const apiKeys = config.apiKeys ?? Object.freeze([]);
  // Snippet deepening source (B-2, S-095, K-008): the route reads the
  // contract code through the bound chain port, so a composed server
  // answers `/v1/snippet` instead of the not-available branch.
  const snippetRpc = deps.ports.rpc;
  // Extended-proof diagnostics (VS-B1, main spec B-3): the application
  // proof service with its bounded per-code-hash memo, injected into the
  // REST driving adapter so interfaces never import plugins directly.
  const proofService = createProofService();
  // On-chain feature reads (session A): serving-mode reads through the
  // bound chain port with the operator-configured canonical WETH (null
  // when unset, in which case WETH-quoted pools do not qualify).
  const onchain = Object.freeze({
    rpc: deps.ports.rpc,
    weth: config.feedWethAddress === undefined ? null : (config.feedWethAddress as string),
  });
  const templateVersion = TemplateVersion.parse(PINNED_TEMPLATE_VERSION);
  if (!templateVersion.ok) {
    return err({
      kind: "invalid-value",
      variable: "BRANDKLIPPAREN_TEMPLATE_VERSION",
      reason: "the pinned template version must parse",
    });
  }
  const liveTokens = buildLiveTokensService(config, services, deps, templateVersion.value);
  // Market listing (DX-B1): the demo selects the public listing adapter
  // unless the operator set the provider explicitly; other setups stay
  // off when unset. The service never starts an analysis: enrichment
  // reads solely through bound lookups, and none is bound here, so items
  // serve without an analysis field until a lookup is wired.
  const marketProvider =
    config.marketProvider ?? (config.env === "demo" ? ("dexscreener" as const) : undefined);
  const marketNew: MarketNewReader | undefined =
    marketProvider === undefined || marketProvider === "off"
      ? undefined
      : createMarketService({ feed: createMarketFeedAdapter(marketProvider), now: () => Date.now() });
  // Verified sources (VS-B2): the demo selects the open
  // source-verification API unless the operator set the provider
  // explicitly; other setups stay off when unset. The explorer fallback
  // binds only when its key is configured, so a keyless server checks
  // the primary alone. The service never enters scoring or evidence.
  const sourceProvider =
    config.sourceProvider ?? (config.env === "demo" ? ("sourcify" as const) : undefined);
  const sourceService: VerifiedSourceService | undefined =
    sourceProvider === undefined || sourceProvider === "off"
      ? undefined
      : createVerifiedSourceService({
          primary: createSourcifySourceAdapter({ transport: deps.sourceTransports?.sourcify }),
          fallback:
            config.feedEtherscanApiKey === undefined
              ? undefined
              : new ExplorerSourceAdapter({
                  apiKey: config.feedEtherscanApiKey,
                  transport: deps.sourceTransports?.explorer,
                }),
          rpc: deps.ports.rpc,
          clock: deps.ports.clock,
        });
  // BK-23: readiness and calibration come from the artifact loaded
  // above; a failed load leaves both absent so /ready fails closed.
  const calibration = loaded.ok ? calibrationViewOf(loaded.value.artifact, loaded.value.checksum) : undefined;
  const readiness = loaded.ok
    ? Object.freeze({
        artifactChecksum: loaded.value.checksum as string,
        expectedArtifactChecksum: loaded.value.checksum as string,
        feedConfigured: config.feedWethAddress !== undefined,
      })
    : undefined;
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
    calibration,
    readiness,
    assessmentService: assessment.value,
    investigationService: investigation.value,
    explainService: explain.value,
    chatService: chat.value,
    rugService: rug.value,
    explainCodeService: explainCode.value,
    personalizeService: personalize.value,
    personalizePromptVersion:
      personalizePromptVersion === undefined ? undefined : personalizePromptVersion.value,
    snippetRpc,
    proofService,
    sourceService,
    onchain,
    rateLimit: rateLimit.value,
    liveTokens,
    marketNew,
  });
  const mcp: McpServerOptions = Object.freeze({
    services,
    apiKeys,
    apiKeyPepper: config.apiKeyPepper,
    ...(config.mcpApiKey === undefined
      ? {}
      : {
          envApiKey: config.mcpApiKey,
          defaultApiKey: config.mcpApiKey,
          mcpApiKey: config.mcpApiKey,
          clientApiKey: config.mcpApiKey,
          stdioApiKey: config.mcpApiKey,
        }),
    modelVersion: config.modelVersion,
    indexVersion: config.cloneIndexVersion,
    templateVersion: templateVersion.value,
    catalogue: DEFAULT_CAPABILITY_CATALOGUE,
    detectors: wired,
    pluginWeights,
    assessmentService: assessment.value,
    investigationService: investigation.value,
    explainService: explain.value,
    explainCodeService: explainCode.value,
    snippetRpc,
    proofService,
    sourceService,
    liveTokens,
    marketNew,
    onchain,
    rateLimit: rateLimit.value,
  });
  return ok(
    Object.freeze({
      services,
      detectors: wired,
      assessment: assessment.value,
      investigation: investigation.value,
      explain: explain.value,
      chat: chat.value,
      rug: rug.value,
      explainCode: explainCode.value,
      liveTokens,
      marketNew,
      rateLimit: rateLimit.value,
      rest,
      mcp,
    }),
  );
}

// Live new-tokens service wiring (E-11 follow-up): Etherscan logs as the
// primary source with the RPC logs adapter as fallback, Uniswap V2 and
// V3 factories only, WETH from BK_WETH_ADDRESS (never hard-coded), the
// deterministic analyze pipeline for the queue (no model-assisted
// assessment), ERC-20 name/symbol reads over the shared RPC port, and
// the persisted list under the configured cache dir. Construction binds
// ports only; the service polls solely after start(), which the REST
// runtime calls.
function buildLiveTokensService(
  config: AppConfig,
  services: AppServices,
  deps: BuildAppDeps,
  templateVersion: TemplateVersion,
): LiveTokensService {
  const quotes: QuoteSet = Object.freeze({
    usdc: QUOTE_TOKENS.usdc,
    usdt: QUOTE_TOKENS.usdt,
    dai: QUOTE_TOKENS.dai,
    weth: (config.feedWethAddress as string | undefined) ?? null,
    allowNativeZero: false,
  });
  const factories = FEED_FACTORIES.filter(
    (entry) => entry.dex === "uniswap-v2" || entry.dex === "uniswap-v3",
  );
  const filePath =
    config.cacheDir === undefined ? undefined : `${config.cacheDir}/live-tokens.json`;
  return createLiveTokensService({
    timers: systemLiveTokensTimers,
    primary: createEtherscanLogsAdapter({ apiKey: config.feedEtherscanApiKey }),
    fallback: createRpcLogsAdapter({ url: config.feedRpcUrl }),
    quotes,
    factories,
    getLatestBlock: async (): Promise<number | null> => {
      const requestId = RequestId.parse(randomUUID());
      const deadline = Timestamp.of(Date.now() + 15_000);
      if (!requestId.ok || !deadline.ok) {
        return null;
      }
      const numbered = await deps.ports.rpc.getBlockNumber({
        requestId: requestId.value,
        deadline: deadline.value,
        block: "latest",
      });
      if (!numbered.ok) {
        return null;
      }
      return numbered.value as number;
    },
    analyze: async (tokenAddress: string): Promise<LiveTokensAnalyzeResult> => {
      const address = Address.parse(tokenAddress);
      const requestId = RequestId.parse(randomUUID());
      const deadline = Timestamp.of(Date.now() + 30_000);
      if (!address.ok || !requestId.ok || !deadline.ok) {
        return { kind: "cant-tell", reason: "invalid token address" };
      }
      const analysed = await services.analyzeToken({
        address: address.value,
        block: "latest",
        requestId: requestId.value,
        deadline: deadline.value,
        modelVersion: config.modelVersion,
        indexVersion: config.cloneIndexVersion,
        templateVersion,
        catalogue: DEFAULT_CAPABILITY_CATALOGUE,
      });
      if (!analysed.ok) {
        if (analysed.error.kind === "rpc-error" && analysed.error.error.kind === "no-code") {
          return { kind: "cant-tell", reason: "no contract code at the pinned block" };
        }
        return { kind: "error", reason: "the deterministic analysis failed" };
      }
      if (analysed.value.kind === "no-contract") {
        return { kind: "cant-tell", reason: "no contract code at the pinned block" };
      }
      const score = analysed.value.envelope.score as number;
      return { kind: "done", score, riskBand: bandForScore(score) };
    },
    readMetadata: createTokenMetadataReader(deps.ports.rpc),
    store:
      filePath === undefined
        ? undefined
        : {
            load: () => {
              const loaded = loadLiveTokensFile(filePath);
              return loaded.ok ? loaded.value : null;
            },
            save: (doc) => {
              saveLiveTokensFile(filePath, doc);
            },
          },
  });
}
