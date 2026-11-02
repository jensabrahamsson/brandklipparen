// One shared application service for all interfaces (S-026, K-027, A-02).
// The web UI, REST API and MCP server call the same entry point with the same
// typed input and the same model version, so equal code hash and model version
// give equal probabilities, scores and signals in every interface. The service
// depends solely on ports (A-04): bytecode arrives through RpcPort, the risk
// values arrive through ModelArtifactPort and the observation time arrives
// through ClockPort. Detection runs through the detector plugin registry;
// the adapters own only validation at their boundary and response formatting.
// This module performs no I/O of its own; every external call goes through
// a port, and the module imports solely domain, ports and the plugin
// registry. Resolution of proxy contracts, just-deployed
// listing and on-request assessment arrive in later stories; the deterministic
// analysis path here carries zero assessment calls (A-33).
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { noneProxyResolution, proxyFactOf, proxyToCanonical } from "../domain/proxy.ts";
import type { ProxyResolution } from "../domain/proxy.ts";
import { resolveProxy } from "./resolveProxy.ts";
import type { ResolveProxyError, ResolveProxyInput, ResolveProxySuccess } from "./resolveProxy.ts";
import { resolveAnalysisCode } from "./resolveAnalysisCode.ts";
import { standardCantTell } from "../domain/cantTell.ts";
import type { CantTellItem } from "../domain/cantTell.ts";
import { explanationToCanonical, originEntryKey, renderExplanation } from "../domain/explain.ts";
import type { Explanation, ExplainError, ExplanationOrigin } from "../domain/explain.ts";
import { isFeaturePayload, score } from "../domain/risk.ts";
import type { PluginFeatureMapping } from "../domain/risk.ts";
import { canonicalSerialize } from "../domain/serialize.ts";
import type { CanonicalValue } from "../domain/serialize.ts";
import { Address, CacheKey, CallData, Slot } from "../domain/types.ts";
import { isZeroOrDead } from "../domain/onchain/topics.ts";
import { decodeTokenText } from "../domain/tokenMetadata.ts";
import type {
  Address as AddressType,
  ArtifactChecksum as ArtifactChecksumType,
  BlockNumber as BlockNumberType,
  Bytecode as BytecodeType,
  CacheKey as CacheKeyType,
  CodeHash as CodeHashType,
  DomainError,
  IndexVersion as IndexVersionType,
  ModelVersion as ModelVersionType,
  RequestId as RequestIdType,
  RiskScore as RiskScoreType,
  Selector as SelectorType,
  Slot as SlotType,
  StorageWord as StorageWordType,
  TemplateVersion as TemplateVersionType,
  Timestamp as TimestampType,
} from "../domain/types.ts";
import { hasCodeAfterMetadata } from "../domain/metadata.ts";
import { withCountedRpc } from "./observability.ts";
import type { RequestCounterSink } from "./observability.ts";
import { CAPABILITY_KEYS, Signal } from "../domain/signals.ts";
import type {
  CapabilityCatalogue,
  CapabilityKey,
  HardToAnalyzeCause,
  RiskType,
  Temporality,
} from "../domain/signals.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createDetectorInput,
  pluginResultToCanonical,
  runRegisteredDetectorsAsync,
} from "../plugins/detector.ts";
import type {
  DetectorExecution,
  PluginFinding,
  PluginResultEntry,
} from "../plugins/detector.ts";
import type { CloneHit, CloneMapping } from "../domain/clones.ts";
import { CloneGroupId, Probability, SkeletonHash } from "../domain/types.ts";
import { extractSelectors } from "../domain/selectors.ts";
import { Evidence, sortEvidence } from "../domain/evidence.ts";
import type { CodeSnippet as CodeSnippetType } from "../domain/evidence.ts";
import { HARD_TO_ANALYZE_CAUSES } from "../domain/signals.ts";
import type { Probability as ProbabilityType } from "../domain/types.ts";
import type { CachePort, CachedAssessment } from "../ports/cache.ts";
import type { ClockPort } from "../ports/clock.ts";
import type { CloneIndexPort } from "../ports/cloneIndex.ts";
import type { ModelArtifactError } from "../ports/modelArtifact.ts";
import type { ModelArtifactPort } from "../ports/modelArtifact.ts";
import type { CallContext, RpcError, RpcPort } from "../ports/rpc.ts";
import type {
  DecompiledContract,
  DecompilerError,
  DecompilerPort,
} from "../ports/decompiler.ts";

// Ports behind the service. Each driving adapter receives the bound service,
// never these ports directly (A-03). The decompiler stays optional so the
// fast path runs unchanged where no worker is bound; where it is bound, the
// deepening enriches evidence with snippets and maps every failure branch
// to the hard-to-analyze signal (K-008). The cache stays optional so the
// service runs unchanged where no store is bound; where it is bound, a hit
// rebuilds the envelope from the cached code-derived part with a freshly
// resolved proxy, and a miss stores the code-derived part under the code
// hash and model version (K-013).
export type AnalyzeTokenPorts = {
  readonly rpc: RpcPort;
  readonly modelArtifacts: ModelArtifactPort;
  readonly clock: ClockPort;
  readonly decompiler?: DecompilerPort | undefined;
  readonly cache?: CachePort | undefined;
  readonly cloneIndex?: CloneIndexPort | undefined;
};

// Typed input: every adapter validates raw input to these domain values at
// its boundary (A-11), so the service takes validity as given. The catalogue
// maps capability keys to risk, direction and severity; the values steer
// scoring and belong to the versioned calibration setup per K-210 and A-20,
// arriving here as a parameter like the model artifact itself. The clone
// mapping carries the same role for clone-match signals: tests pass a
// placeholder and production passes the artifact mapping.
export type AnalyzeTokenInput = {
  readonly address: AddressType;
  readonly block: BlockNumberType | "latest";
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly modelVersion: ModelVersionType;
  readonly indexVersion: IndexVersionType;
  readonly templateVersion: TemplateVersionType;
  readonly catalogue: CapabilityCatalogue;
  readonly cloneMapping?: CloneMapping | undefined;
  readonly proxyMaxDepth?: number | undefined;
};

// Detector set handed to the application service (S-043, P-08; entries
// in S-071 per ADR section 0.3, D-5): the validated registry of entries.
// Each entry carries its manifest beside its implementation, so the
// service runs solely registered entries and an unregistered plugin never
// runs. The composition root builds the set through the startup builder
// and hands it in explicitly; no defaulted set exists, so a caller cannot
// forget to wire the real set. The optional execution binding routes
// non-first-party detectors through the plugin worker (S-105); without it
// every entry runs inline.
export type DetectorSet = {
  readonly registry: PluginRegistry;
  readonly execution?: DetectorExecution | undefined;
};

// Canonical assessment envelope: the same input triple of bytecode, block
// number and artifact version gives a bit-identical serialisation on every
// run, in every runtime and on every machine (K-102, A-32). The envelope
// carries the reproduction fields per A-32 point 7: block number, code hash,
// model version, artifact checksum, index version and template version.
// Plugin findings travel in the additive `pluginResults` field (P-11),
// sorted by plugin id and reported at weight 0: probabilities, score,
// signals, evidence, explanation and can't-tell bytes stay identical with
// and without the field's contents, and scoring never reads it (P-05).
export type AssessmentEnvelope = {
  readonly kind: "assessed";
  readonly target: AddressType;
  readonly block: BlockNumberType;
  readonly proxy: ProxyResolution;
  readonly codeHash: CodeHashType;
  // Display-only ERC-20 symbol()/name() reads at the pinned block (never
  // scored, never evidence): present when the chain answers with strict
  // printable text, absent otherwise.
  readonly tokenSymbol?: string | undefined;
  readonly tokenName?: string | undefined;
  readonly modelVersion: ModelVersionType;
  readonly artifactChecksum: ArtifactChecksumType;
  readonly indexVersion: IndexVersionType;
  readonly templateVersion: TemplateVersionType;
  readonly assessedAt: TimestampType;
  readonly probabilities: Readonly<Record<RiskType, ProbabilityType>>;
  readonly score: RiskScoreType;
  readonly signals: readonly Signal[];
  readonly pluginResults: readonly PluginResultEntry[];
  readonly explanation: Explanation;
  readonly cantTell: readonly CantTellItem[];
};

// The assessed outcome beside the empty-address outcome (K-001): an address
// without code yields the no-contract branch with the resolved block.
export type AnalyzeTokenSuccess =
  | { readonly kind: "assessed"; readonly envelope: AssessmentEnvelope }
  | { readonly kind: "no-contract"; readonly target: AddressType; readonly block: BlockNumberType };

// Application errors wrap the port error with the port name and request id
// (A-15). Each branch is handled explicitly at the interface translation.
export type ApplicationError =
  | { readonly kind: "rpc-error"; readonly requestId: RequestIdType; readonly error: RpcError }
  | {
      readonly kind: "model-artifact-error";
      readonly requestId: RequestIdType;
      readonly error: ModelArtifactError;
    }
  | {
      readonly kind: "domain-error";
      readonly requestId: RequestIdType;
      readonly error: DomainError | ExplainError;
    };

// Error branch to detector input fact per A-15: every decompiler failure
// branch maps to the `decompilerCause` fact the hard-to-analyze detector
// reads, while the fast path's response stands (K-008, M-02).
function causeOfDecompilerError(error: DecompilerError): HardToAnalyzeCause {
  switch (error.kind) {
    case "timeout":
      return "timeout";
    case "resource-limit":
      return "resource-limit";
    case "process-error":
      return "decompiler-error";
    case "invalid-output":
      return "decompiler-error";
    case "output-too-large":
      return "resource-limit";
  }
}

// Fallback risk bucket for unanalyzable code (K-210, S-047): the risk
// steering for decompilation failures arrives through the artifact mapping
// handed to the single conversion path below; until calibration names a
// dedicated entry this frozen fallback applies and the artifact's cause
// weights steer scoring.
const FALLBACK_HARD_TO_ANALYZE_RISK: RiskType = "rug-pull";

// Clone hit read from a plugin finding payload: the similarity share
// beside the mandatory group id and prior count, or null when the payload
// carries anything else, in which case the finding stays a weight-0 display
// record and never reaches scoring.
function cloneHitOf(finding: PluginFinding): CloneHit | null {
  const payload: unknown = finding.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const fields = payload as { readonly [field: string]: unknown };
  const rawSimilarity: unknown = fields["similarity"];
  if (typeof rawSimilarity !== "number") {
    return null;
  }
  const similarity = Probability.of(rawSimilarity);
  if (!similarity.ok) {
    return null;
  }
  const rawGroup: unknown = fields["group"];
  if (typeof rawGroup !== "string") {
    return null;
  }
  const group = CloneGroupId.parse(rawGroup);
  if (!group.ok) {
    return null;
  }
  const rawCount: unknown = fields["priorCount"];
  if (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 0) {
    return null;
  }
  return Object.freeze({ similarity: similarity.value, group: group.value, priorCount: rawCount });
}

// (S-047: retired with the legacy converters; the clone-match branch now
// lives in the single conversion path `signalsFromPluginResults` below.)

// Hard-to-analyze cause read from a plugin finding payload: the closed
// cause the detector reported, or null when the payload carries anything
// else, in which case the finding stays a weight-0 display record and
// never reaches scoring.
function hardCauseOf(finding: PluginFinding): HardToAnalyzeCause | null {
  const payload: unknown = finding.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const cause: unknown = (payload as { readonly [field: string]: unknown })["cause"];
  if (typeof cause !== "string") {
    return null;
  }
  return (HARD_TO_ANALYZE_CAUSES as readonly string[]).includes(cause)
    ? (cause as HardToAnalyzeCause)
    : null;
}

// (S-047: retired with the legacy converters; the hard-to-analyze branch
// now lives in the single conversion path `signalsFromPluginResults`
// below.)

// Snippet enrichment for a successful decompilation (K-008): each evidence
// entry whose selector the worker decompiled gains its snippet, keeping
// every other field bit-identical. Entries without a matching function and
// functions without a matching signal pass through untouched.
function attachSnippets(
  signals: readonly Signal[],
  codeHash: CodeHashType,
  decompiled: DecompiledContract,
): readonly Signal[] {
  const bySelector = new Map<string, CodeSnippetType>();
  for (const fn of decompiled.functions) {
    bySelector.set(fn.selector as string, fn.snippet);
  }
  if (bySelector.size === 0) {
    return signals;
  }
  const out: Signal[] = [];
  for (const signal of signals) {
    if (signal.kind !== "capability" && signal.kind !== "clone-match") {
      out.push(signal);
      continue;
    }
    let changed = false;
    const evidence = signal.evidence.map((entry) => {
      const snippet = bySelector.get(entry.selector as string);
      if (snippet === undefined || entry.snippet !== undefined) {
        return entry;
      }
      const rebuilt =
        entry.offset === undefined
          ? Evidence.create({ selector: entry.selector, snippet })
          : Evidence.create({ selector: entry.selector, offset: entry.offset, snippet });
      if (!rebuilt.ok) {
        return entry;
      }
      changed = true;
      return rebuilt.value;
    });
    if (!changed) {
      out.push(signal);
      continue;
    }
    const rebuiltSignal =
      signal.kind === "capability"
        ? Signal.createCapability({
            codeHash,
            risk: signal.risk,
            direction: signal.direction,
            severity: signal.severity,
            temporality: signal.temporality,
            evidence,
            keepId: signal.id,
            ...(signal.sourcePlugin === undefined ? {} : { sourcePlugin: signal.sourcePlugin }),
          })
        : Signal.createCloneMatch({
            codeHash,
            risk: signal.risk,
            direction: signal.direction,
            severity: signal.severity,
            similarity: signal.similarity,
            group: signal.group,
            priorCount: signal.priorCount,
            evidence,
            keepId: signal.id,
          });
    out.push(rebuiltSignal.ok ? rebuiltSignal.value : signal);
  }
  return Object.freeze(out);
}

// Address index for the cache fast path (K-013): repeat requests for an
// explicitly pinned block reuse the stored code-derived result. The proxy
// is re-resolved on every hit and the envelope rebuilt with the live
// target, block and timestamp, so a memo entry never serves another
// address's details. Requests at "latest" skip the index and always
// resolve the head block first, so a new head is never hidden behind a
// memo entry.
function memoKeyOf(input: AnalyzeTokenInput): string {
  return `${input.address as string}|${input.block as number}|${input.modelVersion as string}`;
}

// Rebuilt envelope from a cached code-derived entry (K-013): the stored
// part carries signals, probabilities, score and plugin results, while
// target, block, proxy and assessed-at always come from the live request.
function envelopeFromCached(
  cached: CachedAssessment,
  target: AddressType,
  block: BlockNumberType,
  proxy: ProxyResolution,
  assessedAt: TimestampType,
): AssessmentEnvelope {
  return Object.freeze({
    kind: "assessed",
    target,
    block,
    proxy,
    codeHash: cached.codeHash,
    modelVersion: cached.modelVersion,
    artifactChecksum: cached.artifactChecksum,
    indexVersion: cached.indexVersion,
    templateVersion: cached.templateVersion,
    assessedAt,
    probabilities: cached.probabilities,
    score: cached.score,
    signals: cached.signals,
    pluginResults: cached.pluginResults,
    explanation: cached.explanation,
    cantTell: cached.cantTell,
  });
}

// Owner-state refresh for a code-hash hit carrying an owner-slot proof
// (C-20, F-21): the cached score and probabilities are reused untouched,
// while the owner is re-read at the requesting address and the
// explanation re-rendered beside the refreshed signals. Null means the
// re-read cannot complete (artifact or RPC failure, or an unreadable
// render): the caller falls through to the fresh path instead of serving
// another address's owner.
async function reattachOwnerStateOnHit(
  counted: AnalyzeTokenPorts,
  input: AnalyzeTokenInput,
  block: BlockNumberType,
  codeHash: CodeHashType,
  analysisBytecode: BytecodeType,
  cached: CachedAssessment,
): Promise<{ signals: readonly Signal[]; explanation: Explanation } | null> {
  const loaded = counted.modelArtifacts.load(input.modelVersion);
  if (!loaded.ok) {
    return null;
  }
  const ownerState = await attachOwnerState(
    counted.rpc,
    input,
    block,
    counted.clock.now(),
    codeHash,
    cached.pluginResults,
    cached.signals,
    loaded.value.artifact.pluginWeights,
    loaded.value.artifact.pluginFeatureCatalogue,
    analysisBytecode,
  );
  if (ownerState.readFailed) {
    return null;
  }
  const origins = explanationOriginsOf(cached.pluginResults, ownerState.signals);
  const rendered = renderExplanation({
    signals: ownerState.signals,
    templateVersion: cached.templateVersion,
    observed: { kind: "can-change-unknown" },
    origins,
  });
  if (!rendered.ok) {
    return null;
  }
  return { signals: ownerState.signals, explanation: rendered.value };
}

// Proxy resolution that degrades to no proxy info on a typed port failure
// (K-002, K-005): the deterministic analysis still delivers its result.
async function resolveProxyOrNone(
  ports: AnalyzeTokenPorts,
  input: ResolveProxyInput,
): Promise<ProxyResolution> {
  const resolved = await resolveProxy(ports, input);
  return resolved.ok ? resolved.value.resolution : noneProxyResolution();
}

// implementationOfProxy is shared with the code routes through
// resolveAnalysisCode (C-4, F-6): one resolution path for the scored code.

// Display-only ERC-20 metadata (symbol()/name()) at the pinned block:
// one eth_call per selector through the existing RpcPort, decoded
// strictly (printable ASCII, trimmed, 32 chars max, bytes32 legacy form
// supported). Any failure — parse, RPC, decode — yields undefined, so the
// response carries no symbol or name instead of a guessed one. The values
// never reach scoring, evidence or the code-hash cache through this path;
// callers attach them to the envelope only, and the canonical form carries
// them when present so every interface serves the same response.
const TOKEN_SYMBOL_SELECTOR = "0x95d89b41";
const TOKEN_NAME_SELECTOR = "0x06fdde03";

async function readTokenText(
  rpc: RpcPort,
  target: AddressType,
  ctx: CallContext,
  selector: string,
): Promise<string | undefined> {
  const data = CallData.parse(selector);
  if (!data.ok) {
    return undefined;
  }
  const called = await rpc.call(target, data.value, ctx);
  if (!called.ok) {
    return undefined;
  }
  return decodeTokenText(called.value) ?? undefined;
}

async function readTokenMetadata(
  rpc: RpcPort,
  target: AddressType,
  ctx: CallContext,
): Promise<{ readonly symbol: string | undefined; readonly name: string | undefined }> {
  const [symbol, name] = await Promise.all([
    readTokenText(rpc, target, ctx, TOKEN_SYMBOL_SELECTOR),
    readTokenText(rpc, target, ctx, TOKEN_NAME_SELECTOR),
  ]);
  return { symbol, name };
}

// Attaches display-only symbol/name to an assessed envelope when the
// chain answers: the spread keeps absent fields absent (never explicit
// undefined), so cached and older responses keep their exact shape.
function withTokenMetadata(
  envelope: AssessmentEnvelope,
  metadata: { readonly symbol: string | undefined; readonly name: string | undefined },
): AssessmentEnvelope {
  return Object.freeze({
    ...envelope,
    ...(metadata.symbol === undefined ? {} : { tokenSymbol: metadata.symbol }),
    ...(metadata.name === undefined ? {} : { tokenName: metadata.name }),
  });
}

// First-party plugins whose findings convert to scored signals (P-05):
// the capability, clone-match and hard-to-analyze detectors. Every other
// plugin (including the decompiler detector, whose `cause` payload key
// collides in shape with the hard-to-analyze one) converts only when the
// versioned artifact names it in `pluginWeights` with a weight above 0,
// so a plugin can never steer its own score and only artifact-named
// findings shape the result.
const FIRST_PARTY_SCORING_PLUGIN_IDS: readonly string[] = Object.freeze([
  "dev.brandklipparen.capability",
  "dev.brandklipparen.clone-match",
  "dev.brandklipparen.hard-to-analyze",
]);

function pluginAllowedForScoring(
  pluginId: string,
  pluginWeights: Readonly<Record<string, number>>,
): boolean {
  if (FIRST_PARTY_SCORING_PLUGIN_IDS.includes(pluginId)) {
    return true;
  }
  return (pluginWeights[pluginId] ?? 0) > 0;
}

// Capability key read from a plugin finding payload: the closed catalogue
// key the plugin reported, or null when the payload carries anything else,
// in which case the finding stays a weight-0 display record and never
// reaches scoring.
function capabilityKeyOf(finding: PluginFinding): CapabilityKey | null {
  const payload: unknown = finding.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const key: unknown = (payload as { readonly [field: string]: unknown })["capability"];
  if (typeof key !== "string") {
    return null;
  }
  return (CAPABILITY_KEYS as readonly string[]).includes(key) ? (key as CapabilityKey) : null;
}

// Unique signal ids (C-27, F-25): the discriminator binds the producing
// plugin, the finding, the converted risk and the first canonical evidence
// entry, so findings sharing one first selector (the USDT honeypot shape)
// convert to distinct ids. Canonical evidence order keeps the id stable
// across runs and finding input order. The failed-plugin fallback below is
// the only legacy-id signal per analysis; its preimage carries a bare
// selector while every discriminated preimage carries `|` separators, so
// the two id domains cannot collide.
// Single conversion path from plugin findings to today's Signal values
// through the artifact mapping (S-047, P-05, P-12 step 5): the one function
// that reads detector output. Risk, direction and severity come from the
// injected artifact mapping (capability catalogue, clone mapping and the
// hard-to-analyze fallback), never from the finding, so a plugin cannot
// steer its own score and only allowlisted findings shape the result.
// Findings from unlisted plugins, unknown payloads or failed construction
// are skipped; the plugin record in `pluginResults` still carries them at
// weight 0. Conversion order follows the fixed capability key order,
// matching the legacy sweep: signals sort into a stable, deterministic
// order through the final id sort below.
// Owner-control `feature` findings convert beside the capability keys
// (S-115): the artifact `pluginFeatureCatalogue` maps the plugin id to
// the risk, direction and severity the finding converts with, and the
// finding's own `feature` value stays display data. A plugin the
// catalogue does not name converts nothing, whatever its finding says.
function featureMappingOf(
  finding: PluginFinding,
  pluginId: string,
  featureCatalogue: Readonly<Record<string, PluginFeatureMapping>>,
): PluginFeatureMapping | null {
  if (!isFeaturePayload(finding.payload)) {
    return null;
  }
  return featureCatalogue[pluginId] ?? null;
}

// Discriminator for one converted signal (C-27, F-25):
// `pluginId|finding.id|risk|selector:offset` from the first canonical
// evidence entry, so the id is stable across runs and finding input order
// while distinct across findings that share one first selector.
function discriminatorOf(pluginId: string, finding: PluginFinding, risk: string): string {
  const first = sortEvidence(finding.evidence)[0];
  const point =
    first === undefined
      ? "none:none"
      : `${first.selector as string}:${first.offset === undefined ? "none" : String(first.offset as number)}`;
  return `${pluginId}|${finding.id}|${risk}|${point}`;
}

function signalsFromPluginResults(
  results: readonly PluginResultEntry[],
  codeHash: CodeHashType,
  catalogue: CapabilityCatalogue,
  cloneMapping: CloneMapping | undefined,
  temporality: Temporality,
  pluginWeights: Readonly<Record<string, number>>,
  featureCatalogue: Readonly<Record<string, PluginFeatureMapping>>,
  detectorHeadWeights?: Readonly<Record<string, Readonly<Record<string, number>>>> | undefined,
  firstSelector?: SelectorType | null | undefined,
): readonly Signal[] {
  // Scoring reads findings solely from allowlisted plugins (P-05): every
  // other entry stays in `pluginResults` at weight 0 and never converts.
  const scored = results.filter(
    (entry) => entry.outcome === "ok" && pluginAllowedForScoring(entry.pluginId as string, pluginWeights),
  );
  // Conversion order follows the fixed capability key order, matching the
  // legacy sweep: signals sort into a stable, deterministic order through
  // the final id sort below.
  const keyOrder = new Map<CapabilityKey, number>(
    CAPABILITY_KEYS.map((key, index) => [key, index] as const),
  );
  const ordered: { readonly finding: PluginFinding; readonly pluginId: string }[] = [];
  for (const entry of scored) {
    if (entry.outcome !== "ok") {
      continue;
    }
    const pluginId = entry.pluginId as string;
    const ranked = entry.findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding }) => capabilityKeyOf(finding) !== null)
      .sort((left, right) => {
        const leftKey = capabilityKeyOf(left.finding) as CapabilityKey;
        const rightKey = capabilityKeyOf(right.finding) as CapabilityKey;
        const byKey =
          (keyOrder.get(leftKey) ?? left.index) - (keyOrder.get(rightKey) ?? right.index);
        return byKey === 0 ? left.index - right.index : byKey;
      })
      .map(({ finding }) => ({ finding, pluginId }));
    ordered.push(...ranked);
  }
  // Branch order reproduces the retired converters entry for entry:
  // capability signals id-sorted first, then clone-match signals in
  // registry order, then hard-to-analyze signals in registry order, so
  // frozen envelopes stay bit-identical.
  const capability: Signal[] = [];
  for (const { finding, pluginId } of ordered) {
    const key = capabilityKeyOf(finding);
    if (key === null) {
      continue;
    }
    const mapping = catalogue[key];
    const signal = Signal.createCapability({
      codeHash,
      risk: mapping.risk,
      direction: mapping.direction,
      severity: mapping.severity,
      temporality,
      evidence: finding.evidence,
      discriminator: discriminatorOf(pluginId, finding, mapping.risk),
    });
    if (signal.ok) {
      capability.push(signal.value);
    }
  }
  // Owner-control features join the capability bucket: each converts with
  // the artifact mapping for its plugin id, in registry order and finding
  // order, so equal inputs give the same signals on every run. A signal
  // carries its source plugin id only when the artifact holds calibrated
  // head weights for that plugin (any head), so artifacts without head
  // weights keep producing bit-identical signals while calibrated ones
  // score with the fitted per-plugin magnitudes on every fitted head.
  for (const entry of scored) {
    if (entry.outcome !== "ok") {
      continue;
    }
    for (const finding of entry.findings) {
      const mapping = featureMappingOf(finding, entry.pluginId as string, featureCatalogue);
      if (mapping === null) {
        continue;
      }
      const pluginId = entry.pluginId as string;
      const signal = Signal.createCapability({
        codeHash,
        risk: mapping.risk,
        direction: mapping.direction,
        severity: mapping.severity,
        temporality,
        evidence: finding.evidence,
        discriminator: discriminatorOf(pluginId, finding, mapping.risk),
        ...(detectorHeadWeights?.[pluginId] === undefined ? {} : { sourcePlugin: pluginId }),
      });
      if (signal.ok) {
        capability.push(signal.value);
      }
    }
  }
  capability.sort((left, right) => {
    const leftId = left.id as string;
    const rightId = right.id as string;
    if (leftId < rightId) {
      return -1;
    }
    if (leftId > rightId) {
      return 1;
    }
    return 0;
  });
  const clones: Signal[] = [];
  if (cloneMapping !== undefined) {
    for (const entry of scored) {
      if (entry.outcome !== "ok") {
        continue;
      }
      for (const finding of entry.findings) {
        const hit = cloneHitOf(finding);
        if (hit === null) {
          continue;
        }
        const signal = Signal.createCloneMatch({
          codeHash,
          risk: cloneMapping.risk,
          direction: cloneMapping.direction,
          severity: cloneMapping.severity,
          similarity: hit.similarity,
          group: hit.group,
          priorCount: hit.priorCount,
          evidence: finding.evidence,
          discriminator: discriminatorOf(entry.pluginId as string, finding, cloneMapping.risk),
        });
        if (signal.ok) {
          clones.push(signal.value);
        }
      }
    }
  }
  // Wall-clock causes (A-07, K-102) never reach the score: `timeout` and
  // `resource-limit` depend on RPC latency and host load, so the finding
  // stays in `pluginResults` as a display record while scoring ignores it.
  // Deterministic causes (`decompiler-error`, `obfuscated-structure`) still
  // convert, since the same bytecode always maps to the same cause.
  const TRANSIENT_HARD_CAUSES: readonly HardToAnalyzeCause[] = Object.freeze(["timeout", "resource-limit"]);
  const hard: Signal[] = [];
  for (const entry of scored) {
    if (entry.outcome !== "ok") {
      continue;
    }
    for (const finding of entry.findings) {
      const cause = hardCauseOf(finding);
      if (cause === null || TRANSIENT_HARD_CAUSES.includes(cause)) {
        continue;
      }
      const signal = Signal.createHardToAnalyze({
        codeHash,
        risk: FALLBACK_HARD_TO_ANALYZE_RISK,
        cause,
        evidence: finding.evidence,
        discriminator: discriminatorOf(entry.pluginId as string, finding, FALLBACK_HARD_TO_ANALYZE_RISK),
      });
      if (signal.ok) {
        hard.push(signal.value);
      }
    }
  }
  // Failed scored plugins (C-26, F-26): an allowlisted plugin whose
  // outcome is `invalid-output` or `threw` proves the analysis did not
  // fully cover the code, so it contributes exactly one deterministic
  // `obfuscated-structure` hard-to-analyze signal per analysis instead
  // of reading as "nothing found". The evidence is the first dispatcher
  // selector, mirroring the decompiler fallback signal entry for entry.
  // `timeout` and `input-unavailable` stay transient: they depend on host
  // load and RPC latency, so they never score and the run is not cached.
  const failedScored = results
    .filter(
      (entry) =>
        (entry.outcome === "invalid-output" || entry.outcome === "threw") &&
        pluginAllowedForScoring(entry.pluginId as string, pluginWeights),
    )
    .map((entry) => entry.pluginId as string)
    .sort();
  if (failedScored.length > 0 && firstSelector !== undefined && firstSelector !== null) {
    const evidence = Evidence.create({ selector: firstSelector });
    if (evidence.ok) {
      const signal = Signal.createHardToAnalyze({
        codeHash,
        risk: FALLBACK_HARD_TO_ANALYZE_RISK,
        cause: "obfuscated-structure",
        evidence: [evidence.value],
      });
      if (signal.ok) {
        hard.push(signal.value);
      }
    }
  }
  return Object.freeze([...capability, ...clones, ...hard]);
}

// Wall-clock plugin outcomes (C-26, F-26): `timeout` and
// `input-unavailable` depend on host load and RPC latency, so a run
// carrying either never enters the code-hash cache, like a transient
// decompiler failure.
function hasTransientPluginOutcome(results: readonly PluginResultEntry[]): boolean {
  return results.some(
    (entry) => entry.outcome === "timeout" || entry.outcome === "input-unavailable",
  );
}

// Live owner value through RpcPort (S-115, K-016): the ownership detector
// identifies the owner slot from bytecode, and this step reads the current
// word at the analysed address on the pinned block. The read happens only
// when the owner-slot finding exists and its signal converts (the prior
// artifact names the plugin with a weight above 0 and carries its feature
// mapping); otherwise no storage read happens and scoring stays
// untouched. A failed read, a zero word or a dead (renounced) word keeps
// the changerless can-change-unknown temporality: the live value is
// unknown, never guessed as renounced, and no address is named.
// The enriched signal carries applies-now; enriched analyses skip the
// code-hash cache because the value is live chain state, not
// code-derived.
const OWNERSHIP_PLUGIN_ID = "dev.brandklipparen.ownership";

function ownerSlotProof(
  results: readonly PluginResultEntry[],
): { slot: number; evidenceKey: string } | null {
  for (const entry of results) {
    if (entry.outcome !== "ok" || (entry.pluginId as string) !== OWNERSHIP_PLUGIN_ID) {
      continue;
    }
    for (const finding of entry.findings) {
      const payload: unknown = finding.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        continue;
      }
      const record = payload as { readonly [field: string]: unknown };
      if (record["feature"] !== "owner-slot") {
        continue;
      }
      const slot: unknown = record["slot"];
      if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0) {
        continue;
      }
      return { slot, evidenceKey: evidenceKeyOf(finding.evidence) };
    }
  }
  return null;
}

// Origin key read from a plugin finding payload (P-1): the capability
// key the capability plugin reported, else the owner-control `feature`
// the detector reported, else null. Unknown payloads stay origin-less;
// the template falls back to its risk frame for those signals.
function originKeyOf(finding: PluginFinding): string | null {
  const payload: unknown = finding.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as { readonly [field: string]: unknown };
  const capability = capabilityKeyOf(finding);
  if (capability !== null) {
    return capability;
  }
  const feature: unknown = record["feature"];
  if (typeof feature === "string" && feature.length > 0) {
    return feature;
  }
  return null;
}

// Origins for the 1.1.0 explanation templates (P-1, P-2 follow-up 2): one
// entry per signal naming the plugin and key behind the signal, filed
// under the signal's origin entry key. Findings match signals by evidence
// key, as `ownerSlotProof` already does: the same selector-offset pairs
// on both sides name the same pattern. Signals sharing one signal id
// (one code hash plus one first selector) keep their own entries, so a
// gated mint signal keeps the mint origin beside the owner-slot signal's
// ownership origin instead of merging into one claim. Display-only: the
// map travels to the template renderer and never touches score,
// probabilities or the signal list.
function explanationOriginsOf(
  results: readonly PluginResultEntry[],
  signals: readonly Signal[],
): ReadonlyMap<string, ExplanationOrigin> {
  const byEvidence = new Map<string, ExplanationOrigin>();
  for (const entry of results) {
    if (entry.outcome !== "ok") {
      continue;
    }
    for (const finding of entry.findings) {
      const key = originKeyOf(finding);
      if (key === null) {
        continue;
      }
      const evidenceKey = evidenceKeyOf(finding.evidence);
      if (!byEvidence.has(evidenceKey)) {
        byEvidence.set(evidenceKey, Object.freeze({ pluginId: entry.pluginId as string, key }));
      }
    }
  }
  const origins = new Map<string, ExplanationOrigin>();
  for (const signal of signals) {
    const found = byEvidence.get(evidenceKeyOf(signal.evidence));
    if (found !== undefined) {
      origins.set(originEntryKey(signal), found);
    }
  }
  return origins;
}

function evidenceKeyOf(
  list: readonly { readonly selector: unknown; readonly offset?: unknown }[],
): string {
  return list
    .map((entry) => `${entry.selector as string}:${entry.offset === undefined ? "none" : String(entry.offset as number)}`)
    .sort()
    .join(",");
}

// Owner getters verified against the slot (P-2, RC-3): the dispatcher
// selectors for `owner()` and `getOwner()`.
const OWNER_SELECTOR = "0x8da5cb5b";
const GET_OWNER_SELECTOR = "0x893d20e8";

// Owner-gated finding origins (P-2, RC-3): only signals converted from
// these owner-control features may name the proven owner as their
// changer. Capability signals never carry a changer and stay
// can-change-unknown, so no invented account appears in any claim.
const OWNER_GATED_ORIGINS: readonly string[] = Object.freeze([
  "blacklist",
  "mint",
  "pause",
  "proxy-upgrade",
  "sell-block",
  "transfer-fee",
  "transfer-hooks",
  "transfer-limits",
]);

// A proven 32-byte address word carries twelve zero bytes above the
// 20-byte address. Anything else (a supply, a packed word, unrelated
// storage) is not an address.
function isAddressWord(word: string): boolean {
  return /^0x0{24}[0-9a-f]{40}$/.test(word.toLowerCase());
}

// Owner getters the bytecode dispatches, if any: `owner()`, `getOwner()`
// or both. Presence comes from the dispatcher scan, so a getter that the
// code never exposes is never called.
function dispatchedOwnerGetters(bytecode: BytecodeType): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of extractSelectors(bytecode)) {
    const selector = (entry.selector as string).toLowerCase();
    if (selector === OWNER_SELECTOR || selector === GET_OWNER_SELECTOR) {
      out.add(selector);
    }
  }
  return out;
}

// One owner getter answer at the pinned block through RpcPort: the
// proven address, or null when the answer is not a zero-padded address
// word. A slot word counts as an owner only beside an answering getter;
// agreement is decided by the caller. A failed call is reported through
// `failed` (not as a null address) so the caller can tell an RPC error
// apart from a non-address answer (C-20): only the error skips the cache.
type OwnerGetterRead = {
  readonly address: AddressType | null;
  readonly failed: boolean;
};

async function readOwnerGetter(
  rpc: RpcPort,
  target: AddressType,
  selector: string,
  ctx: CallContext,
): Promise<OwnerGetterRead> {
  const data = CallData.parse(selector);
  if (!data.ok) {
    return { address: null, failed: false };
  }
  const called = await rpc.call(target, data.value, ctx);
  if (!called.ok) {
    return { address: null, failed: true };
  }
  let hex = "0x";
  for (const byte of called.value) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return { address: addressOfStoredWord(hex.toLowerCase()), failed: false };
}

async function attachOwnerState(
  rpc: RpcPort,
  input: AnalyzeTokenInput,
  block: BlockNumberType,
  at: TimestampType,
  codeHash: CodeHashType,
  pluginResults: readonly PluginResultEntry[],
  signals: readonly Signal[],
  pluginWeights: Readonly<Record<string, number>>,
  featureCatalogue: Readonly<Record<string, PluginFeatureMapping>>,
  analysisBytecode: BytecodeType,
): Promise<{ signals: readonly Signal[]; enriched: boolean; readFailed: boolean }> {
  const ctx: CallContext = { requestId: input.requestId, deadline: input.deadline, block };
  const proof = ownerSlotProof(pluginResults);
  const mapping = featureCatalogue[OWNERSHIP_PLUGIN_ID] ?? null;
  const ownershipScored =
    proof !== null && mapping !== null && pluginAllowedForScoring(OWNERSHIP_PLUGIN_ID, pluginWeights);
  // Proven slot value: the stored word must be an address word. A zero
  // word is ambiguous (existing): it may mean a renounced owner, an
  // unwritten slot or a stubbed offline read, so the run keeps its
  // changerless temporality. A nonzero word with nonzero upper bytes is
  // not an address at all (P-2 item 1), so the run names no changer and
  // carries no measured value for it. A failed storage read is neither:
  // it sets `readFailed` so the run skips the code-hash cache instead of
  // freezing an unread owner under the code hash (C-20).
  let readFailed = false;
  let slotValue: StorageWordType | null = null;
  let slot: SlotType | null = null;
  let slotAddress: AddressType | null = null;
  if (ownershipScored && proof !== null) {
    const parsed = Slot.parse(`0x${proof.slot.toString(16).padStart(64, "0")}`);
    if (parsed.ok) {
      const stored = await rpc.getStorageAt(input.address, parsed.value, ctx);
      if (!stored.ok) {
        readFailed = true;
      } else {
        if (/^0+$/.test((stored.value as string).slice(2))) {
          return { signals, enriched: false, readFailed };
        }
        const candidate = addressOfStoredWord(stored.value as string);
        if (candidate === null) {
          return { signals, enriched: false, readFailed };
        }
        slotValue = stored.value;
        slot = parsed.value;
        slotAddress = candidate;
      }
    }
  }
  // Getter answers where the bytecode dispatches them (P-2 item 2): one
  // eth_call per dispatched getter at the pinned block through RpcPort.
  // The calls ride the counted rpc, so the request sink counts them. A
  // failed call marks the run, never an address: the failure skips the
  // cache while a non-address answer simply proves nothing (C-20).
  const dispatched = dispatchedOwnerGetters(analysisBytecode);
  const getterAddresses: AddressType[] = [];
  for (const selector of [OWNER_SELECTOR, GET_OWNER_SELECTOR]) {
    if (!dispatched.has(selector)) {
      continue;
    }
    const answer = await readOwnerGetter(rpc, input.address, selector, ctx);
    if (answer.failed) {
      readFailed = true;
      continue;
    }
    if (answer.address !== null) {
      getterAddresses.push(answer.address);
    }
  }
  const gettersRepeat = (base: AddressType): boolean =>
    getterAddresses.every((answer) => (answer as string).toLowerCase() === (base as string).toLowerCase());
  // Agreement: the slot is accepted only when a dispatched owner getter
  // repeats it. A slot word alone — however address-shaped — never proves
  // an owner (P-2 follow-up): with no dispatched getter, or a dispatched
  // getter that does not answer, the run names no one and measures
  // nothing. With no slot but an answering getter, the getter answer
  // proves the owner (source `owner()`); without a slot there is still no
  // measured value.
  let proven: AddressType | null = null;
  let slotAccepted = false;
  if (slotAddress !== null && getterAddresses.length > 0) {
    if (!gettersRepeat(slotAddress)) {
      return { signals, enriched: false, readFailed };
    }
    proven = slotAddress;
    slotAccepted = true;
  } else if (slotAddress !== null) {
    // No getter proves the slot: the stored value may be a supply, a
    // packed word or unrelated storage that happens to fit in 20 bytes,
    // so the run keeps changerless temporality and no measured value.
    return { signals, enriched: false, readFailed };
  } else if (getterAddresses.length > 0) {
    const first = getterAddresses[0];
    if (first === undefined || !gettersRepeat(first)) {
      return { signals, enriched: false, readFailed };
    }
    proven = first;
    slotAccepted = false;
  } else {
    return { signals, enriched: false, readFailed };
  }
  // Evidence keys behind owner-gated findings (P-2 item 3): only signals
  // with one of these keys may name the proven owner as their changer.
  const gatedEvidence = new Set<string>();
  for (const entry of pluginResults) {
    if (entry.outcome !== "ok") {
      continue;
    }
    for (const finding of entry.findings) {
      const key = originKeyOf(finding);
      if (key !== null && OWNER_GATED_ORIGINS.includes(key)) {
        gatedEvidence.add(evidenceKeyOf(finding.evidence));
      }
    }
  }
  const observed: Temporality | null =
    slotAccepted && slotValue !== null && slot !== null
      ? {
          kind: "applies-now",
          measuredValue: { value: slotValue, slot, block, at },
          block,
          at,
        }
      : null;
  const changer: Temporality = { kind: "can-change", changer: proven };
  let enriched = false;
  const out = signals.map((signal) => {
    if (signal.kind !== "capability") {
      return signal;
    }
    const isOwnerSignal =
      slotAccepted &&
      proof !== null &&
      mapping !== null &&
      signal.risk === mapping.risk &&
      signal.direction === mapping.direction &&
      signal.severity === mapping.severity &&
      evidenceKeyOf(signal.evidence) === proof.evidenceKey;
    if (isOwnerSignal && observed !== null) {
      const rebuilt = Signal.createCapability({
        codeHash,
        risk: signal.risk,
        direction: signal.direction,
        severity: signal.severity,
        temporality: observed,
        evidence: signal.evidence,
        keepId: signal.id,
        ...(signal.sourcePlugin === undefined ? {} : { sourcePlugin: signal.sourcePlugin }),
      });
      if (!rebuilt.ok) {
        return signal;
      }
      enriched = true;
      return rebuilt.value;
    }
    // Only owner-gated signals name the proven owner (P-2 item 3):
    // capability signals keep can-change-unknown.
    if (!gatedEvidence.has(evidenceKeyOf(signal.evidence))) {
      return signal;
    }
    if (signal.temporality.kind === "can-change-unknown") {
      const renamed = Signal.createCapability({
        codeHash,
        risk: signal.risk,
        direction: signal.direction,
        severity: signal.severity,
        temporality: changer,
        evidence: signal.evidence,
        keepId: signal.id,
        ...(signal.sourcePlugin === undefined ? {} : { sourcePlugin: signal.sourcePlugin }),
      });
      if (renamed.ok) {
        enriched = true;
        return renamed.value;
      }
    }
    return signal;
  });
  return { signals: Object.freeze(out), enriched, readFailed };
}

// Proven controller behind a stored owner word: the last 20 bytes parsed
// as an address, or null when the word is not a zero-padded address
// word, or zero or dead (renounced). A null here keeps the changerless
// marker, never a guess.
function addressOfStoredWord(word: string): AddressType | null {
  const hex = word.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) {
    return null;
  }
  if (!isAddressWord(hex)) {
    return null;
  }
  const parsed = Address.parse(`0x${hex.slice(-40)}`);
  if (!parsed.ok) {
    return null;
  }
  if (isZeroOrDead(parsed.value as string)) {
    return null;
  }
  return parsed.value;
}

// Numbers first, text second: scoring and the template render run before the
// envelope is frozen, so an assessment added later leaves them unchanged.
// An optional request-scoped sink counts each RPC call in this run (K-107);
// without a sink the run behaves exactly as before.
export async function analyzeToken(
  ports: AnalyzeTokenPorts,
  input: AnalyzeTokenInput,
  detectors: DetectorSet,
  addressIndex: Map<string, CacheKeyType> = new Map(),
  counters?: RequestCounterSink | undefined,
): Promise<Result<AnalyzeTokenSuccess, ApplicationError>> {
  const rpc = counters === undefined ? ports.rpc : withCountedRpc(ports.rpc, counters);
  const countedPorts = counters === undefined ? ports : { ...ports, rpc };
  const proxyInputFor = (block: BlockNumberType): ResolveProxyInput => ({
    address: input.address,
    block,
    requestId: input.requestId,
    deadline: input.deadline,
    ...(input.proxyMaxDepth === undefined ? {} : { maxDepth: input.proxyMaxDepth }),
  });
  // Cache lookup before decompilation and the model load (I-14): a
  // remembered key gives a hit that still re-resolves the proxy and
  // rebuilds the envelope with the live target, block and timestamp, so a
  // hit never serves another address's details. A miss, a rejected entry
  // or an unreachable store falls through to the fresh path below (A-15).
  // A proxied hit or a hit carrying an owner-slot proof falls through to
  // the code-hash path below instead: the proxy facts are address state
  // and the owner is re-read for the requesting address (C-20, F-21).
  if (ports.cache !== undefined && input.block !== "latest") {
    const memoKey = memoKeyOf(input);
    const remembered = addressIndex.get(memoKey);
    if (remembered !== undefined) {
      const hit = await ports.cache.get(remembered);
      if (hit.ok && hit.value !== null) {
        const proxy = await resolveProxyOrNone(countedPorts, proxyInputFor(input.block));
        if (proxyFactOf(proxy) === null && ownerSlotProof(hit.value.pluginResults) === null) {
          const envelope = envelopeFromCached(hit.value, input.address, input.block, proxy, ports.clock.now());
          const metadata = await readTokenMetadata(countedPorts.rpc, input.address, {
            requestId: input.requestId,
            deadline: input.deadline,
            block: input.block,
          });
          return ok({ kind: "assessed", envelope: withTokenMetadata(envelope, metadata) });
        }
      } else {
        addressIndex.delete(memoKey);
      }
    }
  }
  // Resolved analysis code shared with the code routes (C-4, F-6):
  // the entry code, the proxy on the pinned block, then the
  // implementation code when resolution yields one, so a rug token behind
  // a proxy is scored on the logic that actually runs. An unreadable
  // implementation degrades to the entry bytecode.
  const resolvedCode = await resolveAnalysisCode(countedPorts, {
    address: input.address,
    block: input.block,
    requestId: input.requestId,
    deadline: input.deadline,
    ...(input.proxyMaxDepth === undefined ? {} : { maxDepth: input.proxyMaxDepth }),
  });
  if (!resolvedCode.ok) {
    if (resolvedCode.error.kind === "no-contract") {
      return ok({ kind: "no-contract", target: resolvedCode.error.target, block: resolvedCode.error.block });
    }
    return err(resolvedCode.error);
  }
  const block = resolvedCode.value.block;
  const blockCtx: CallContext = { requestId: input.requestId, deadline: input.deadline, block };
  const proxy = resolvedCode.value.proxy;
  const analysisBytecode = resolvedCode.value.bytecode;
  const codeHash = { ok: true as const, value: resolvedCode.value.codeHash };
  const cacheKey = CacheKey.of(codeHash.value, input.modelVersion);
  if (!cacheKey.ok) {
    return err({ kind: "domain-error", requestId: input.requestId, error: cacheKey.error });
  }
  // Second lookup on the code-hash key: a new address with known code and
  // a request without a memo entry still skips decompilation and the model
  // load, rebuilding the envelope with its own target, block and timestamp
  // beside the already resolved proxy (K-013). A proxied hit is ignored:
  // proxy facts are address state and never enter the cache (C-20, F-21).
  // A hit carrying an owner-slot proof re-reads the owner for the
  // requesting address and re-renders the explanation, reusing the cached
  // score and probabilities, which never move with owner state.
  if (ports.cache !== undefined) {
    const hit = await ports.cache.get(cacheKey.value);
    if (hit.ok && hit.value !== null && proxyFactOf(proxy) === null) {
      if (ownerSlotProof(hit.value.pluginResults) !== null) {
        const reowned = await reattachOwnerStateOnHit(
          countedPorts,
          input,
          block,
          codeHash.value,
          analysisBytecode,
          hit.value,
        );
        if (reowned !== null) {
          if (input.block !== "latest") {
            addressIndex.set(memoKeyOf(input), cacheKey.value);
          }
          const envelope = envelopeFromCached(hit.value, input.address, block, proxy, ports.clock.now());
          const rebuilt: AssessmentEnvelope = Object.freeze({
            ...envelope,
            signals: reowned.signals,
            explanation: reowned.explanation,
          });
          const metadata = await readTokenMetadata(countedPorts.rpc, input.address, blockCtx);
          return ok({ kind: "assessed", envelope: withTokenMetadata(rebuilt, metadata) });
        }
        // A failed re-read falls through to the fresh path below, which
        // re-runs detection and reports the same outcome deterministically
        // instead of serving another address's owner.
      } else {
        if (input.block !== "latest") {
          addressIndex.set(memoKeyOf(input), cacheKey.value);
        }
        const envelope = envelopeFromCached(hit.value, input.address, block, proxy, ports.clock.now());
        const metadata = await readTokenMetadata(countedPorts.rpc, input.address, blockCtx);
        return ok({ kind: "assessed", envelope: withTokenMetadata(envelope, metadata) });
      }
    }
  }
  const loaded = ports.modelArtifacts.load(input.modelVersion);
  if (!loaded.ok) {
    return err({ kind: "model-artifact-error", requestId: input.requestId, error: loaded.error });
  }
  // Changerless by default: no controlling account is named until the
  // ownership proof plus the live owner word below proves one. The analysed
  // address is never the changer.
  const observed: Temporality = { kind: "can-change-unknown" };
  // Clone-hit lookup ahead of detection (K-017): where a clone index is
  // bound, an exact code-hash or skeleton-hash hit becomes the `cloneMatch`
  // input fact for the single registry run below. A miss yields a null fact
  // and therefore no clone finding, and a port error continues with a null
  // fact while the fast path's response stands. The response names the
  // bound index version, so hits stay reproducible per K-102.
  const indexVersion = ports.cloneIndex === undefined ? input.indexVersion : ports.cloneIndex.indexVersion();
  let cloneHit: CloneHit | null = null;
  if (ports.cloneIndex !== undefined && input.cloneMapping !== undefined) {
    const skeletonHash = SkeletonHash.of(analysisBytecode);
    if (!skeletonHash.ok) {
      return err({ kind: "domain-error", requestId: input.requestId, error: skeletonHash.error });
    }
    const matched = ports.cloneIndex.match(codeHash.value, skeletonHash.value);
    if (matched.ok) {
      cloneHit = matched.value;
    }
  }
  // Decompilation ahead of detection (K-008): a successful run is kept for
  // snippet enrichment below, while every failure branch maps to the
  // `decompilerCause` input fact for the single registry run below and the
  // fast path's response stands. Wall-clock failures (timeout,
  // resource-limit) also mark the run transient: its envelope is never
  // cached, so a slow host cannot freeze a degraded score under the code
  // hash (A-07, K-102).
  let decompiled: DecompiledContract | null = null;
  let decompilerCause: HardToAnalyzeCause | null = null;
  let transientDecompilerFailure = false;
  if (ports.decompiler !== undefined) {
    const outcome = await ports.decompiler.decompile(
      analysisBytecode,
      codeHash.value,
      blockCtx,
    );
    if (outcome.ok) {
      decompiled = outcome.value;
    } else {
      decompilerCause = causeOfDecompilerError(outcome.error);
      transientDecompilerFailure =
        outcome.error.kind === "timeout" ||
        outcome.error.kind === "resource-limit" ||
        outcome.error.kind === "output-too-large";
    }
  }
  // Forged metadata footer (F-3, part 1): the bytecode carries a strictly
  // valid metadata-shaped region with referenced code at or past it, so the
  // footer cut was refused and the tail is analysed as code. The shape is
  // deterministic per bytecode, so the cause converts to a scored
  // `obfuscated-structure` signal like any decompiler-error cause. Only a
  // clean decompilation run gains it: a decompiler failure keeps its own
  // cause (and a wall-clock failure keeps its transient no-cache status).
  if (decompilerCause === null && hasCodeAfterMetadata(analysisBytecode)) {
    decompilerCause = "obfuscated-structure";
  }
  // Single detection run through the registry (S-043 step 1, S-044 step 2,
  // S-047 step 5): every registered detector runs behind the registry
  // boundary and its findings convert to today's Signal values through the
  // single conversion path `signalsFromPluginResults` reading the artifact
  // mapping. The legacy direct cloneMatchSignal call, the inline
  // fallback-signal construction and the three interim converters are
  // deleted; the service reads detector output solely through the
  // registry/detect path. With an execution binding, non-first-party
  // detectors run in the plugin worker off the hot path (S-105).
  const pluginResults = await runRegisteredDetectorsAsync(
    detectors.registry,
    createDetectorInput(analysisBytecode, codeHash.value, {
      cloneMatch: cloneHit,
      decompilerCause,
      proxyFact: proxyFactOf(proxy),
    }),
    detectors.execution,
  );
  // First dispatcher selector for the failed-plugin fallback signal
  // (C-26, F-26): the single hard-to-analyze signal a throwing or
  // over-limit scored plugin contributes carries the entry selector,
  // exactly like the decompiler fallback signal.
  const firstSelectorEntry = extractSelectors(analysisBytecode)[0];
  const firstSelector =
    firstSelectorEntry === undefined ? null : (firstSelectorEntry.selector as SelectorType);
  let signals: readonly Signal[] = signalsFromPluginResults(
    pluginResults,
    codeHash.value,
    input.catalogue,
    input.cloneMapping,
    observed,
    loaded.value.artifact.pluginWeights,
    loaded.value.artifact.pluginFeatureCatalogue,
    loaded.value.artifact.detectorHeadWeights,
    firstSelector,
  );
  // Owner state through RpcPort (S-115, K-016): enriches the converted
  // owner-slot signal with the live value where the proof and the
  // artifact mapping allow it, and stays silent otherwise.
  const ownerState = await attachOwnerState(
    countedPorts.rpc,
    input,
    block,
    ports.clock.now(),
    codeHash.value,
    pluginResults,
    signals,
    loaded.value.artifact.pluginWeights,
    loaded.value.artifact.pluginFeatureCatalogue,
    analysisBytecode,
  );
  signals = ownerState.signals;
  // Snippet enrichment for a successful decompilation (K-008): each
  // evidence entry whose selector the worker decompiled gains its snippet,
  // keeping every other field bit-identical.
  if (decompiled !== null) {
    signals = attachSnippets(signals, codeHash.value, decompiled);
  }
  const risk = score(signals, loaded.value.artifact);
  // Origins for the 1.1.0 templates travel as data beside the signals;
  // scoring above never sees them, so text changes stay display-only.
  const rendered = renderExplanation({
    signals,
    templateVersion: input.templateVersion,
    observed,
    origins: explanationOriginsOf(pluginResults, signals),
  });
  if (!rendered.ok) {
    return err({ kind: "domain-error", requestId: input.requestId, error: rendered.error });
  }
  const envelope: AssessmentEnvelope = Object.freeze({
    kind: "assessed",
    target: input.address,
    block,
    proxy,
    codeHash: codeHash.value,
    modelVersion: risk.modelVersion,
    artifactChecksum: loaded.value.checksum,
    indexVersion,
    templateVersion: input.templateVersion,
    assessedAt: ports.clock.now(),
    probabilities: risk.probabilities,
    score: risk.score,
    signals,
    pluginResults,
    explanation: rendered.value,
    cantTell: standardCantTell(),
  });
  // Store the code-derived part under the code-hash key (K-013): best
  // effort, so a rejected write still returns the analysis. Target, block,
  // proxy and assessed-at stay out of the entry and are rebuilt on every
  // hit. A transient decompiler failure skips the store, so a degraded run
  // never poisons the shared entry (A-07, K-102). An owner-state enriched
  // run skips the store too: the live value is chain state, not
  // code-derived, and must never serve another block from the cache. A
  // run whose owner read failed skips the store as well (C-20): a later
  // hit must re-read instead of inheriting an unread owner. A proxied run
  // never stores: the proxy-upgrade facts are address state, and the hit
  // paths ignore proxied entries (C-20, F-21). A new model version keys
  // new entries, so older entries stay unused beside the new one.
  const proxied = proxyFactOf(proxy) !== null;
  // A wall-clock plugin outcome (`timeout`, `input-unavailable`) marks
  // the run transient, so its envelope never poisons the shared entry
  // (C-26, F-26), like a transient decompiler failure.
  const transientPluginFailure = hasTransientPluginOutcome(pluginResults);
  if (
    ports.cache !== undefined &&
    !transientDecompilerFailure &&
    !transientPluginFailure &&
    !ownerState.enriched &&
    !ownerState.readFailed &&
    !proxied
  ) {
    const stored: CachedAssessment = {
      kind: "assessed",
      codeHash: envelope.codeHash,
      modelVersion: envelope.modelVersion,
      artifactChecksum: envelope.artifactChecksum,
      indexVersion: envelope.indexVersion,
      templateVersion: envelope.templateVersion,
      probabilities: envelope.probabilities,
      score: envelope.score,
      signals: envelope.signals,
      pluginResults: envelope.pluginResults,
      explanation: envelope.explanation,
      cantTell: envelope.cantTell,
    };
    await ports.cache.put(cacheKey.value, stored);
    if (input.block !== "latest") {
      addressIndex.set(memoKeyOf(input), cacheKey.value);
    }
  }
  // Display-only metadata reads last: a failure here never fails the
  // analysis, the envelope simply carries no symbol or name.
  const metadata = await readTokenMetadata(countedPorts.rpc, input.address, blockCtx);
  return ok({ kind: "assessed", envelope: withTokenMetadata(envelope, metadata) });
}

// Canonical mapping of the envelope for comparison and hashing (A-32 point
// 5): fixed shape, key order normalised by canonicalSerialize, signals in
// their stable SignalId order and probabilities in fixed risk order.
export function assessmentToCanonical(envelope: AssessmentEnvelope): CanonicalValue {
  return {
    kind: "assessed",
    target: envelope.target as string,
    block: envelope.block as number,
    proxy: proxyToCanonical(envelope.proxy),
    codeHash: envelope.codeHash as string,
    ...(envelope.tokenSymbol === undefined ? {} : { tokenSymbol: envelope.tokenSymbol }),
    ...(envelope.tokenName === undefined ? {} : { tokenName: envelope.tokenName }),
    modelVersion: envelope.modelVersion as string,
    artifactChecksum: envelope.artifactChecksum as string,
    indexVersion: envelope.indexVersion as string,
    templateVersion: envelope.templateVersion as string,
    assessedAt: envelope.assessedAt as number,
    probabilities: {
      "bot-pump": envelope.probabilities["bot-pump"] as number,
      honeypot: envelope.probabilities["honeypot"] as number,
      "rug-pull": envelope.probabilities["rug-pull"] as number,
    },
    score: envelope.score as number,
    signals: envelope.signals.map(signalToCanonical),
    pluginResults: envelope.pluginResults.map(pluginResultToCanonical),
    explanation: explanationToCanonical(envelope.explanation),
    cantTell: envelope.cantTell.map((item) => ({
      question: item.question,
      dataSource: item.dataSource,
    })),
  };
}

function signalToCanonical(signal: Signal): CanonicalValue {
  const base = {
    id: signal.id as string,
    risk: signal.risk,
    evidence: signal.evidence.map((entry) => ({
      selector: entry.selector as string,
      offset: (entry.offset as number | undefined) ?? null,
    })),
  };
  switch (signal.kind) {
    case "capability":
      return {
        ...base,
        kind: "capability",
        direction: signal.direction,
        severity: signal.severity,
      };
    case "clone-match":
      return {
        ...base,
        kind: "clone-match",
        direction: signal.direction,
        severity: signal.severity,
        similarity: signal.similarity as number,
        group: signal.group as string,
        priorCount: signal.priorCount,
      };
    case "hard-to-analyze":
      return { ...base, kind: "hard-to-analyze", cause: signal.cause };
  }
}

// The single serialisation path for the envelope: object keys in
// lexicographic order through canonicalSerialize (A-32 point 5).
export function serializeAssessment(envelope: AssessmentEnvelope): string {
  return canonicalSerialize(assessmentToCanonical(envelope));
}

// The bound service handed to the driving adapters (A-02, A-03): one entry
// point with the same typed input and the same model version in REST, MCP and
// the web UI. Driving adapters may pass a request-scoped sink that counts
// each RPC call in that run (K-107); without a sink nothing is counted.
export type AppServices = {
  readonly analyzeToken: (
    input: AnalyzeTokenInput,
    counters?: RequestCounterSink | undefined,
  ) => Promise<Result<AnalyzeTokenSuccess, ApplicationError>>;
  readonly resolveProxy: (
    input: ResolveProxyInput,
  ) => Promise<Result<ResolveProxySuccess, ApplicationError>>;
};

export function createAppServices(
  ports: AnalyzeTokenPorts,
  detectors: DetectorSet,
): AppServices {
  // Address index for the cache fast path, shared by every call through
  // this service (K-013). The index maps address, block and model version
  // to the cache key and is re-verified through the cache on every use.
  const addressIndex = new Map<string, CacheKeyType>();
  return Object.freeze({
    analyzeToken: (
      input: AnalyzeTokenInput,
      counters?: RequestCounterSink | undefined,
    ): Promise<Result<AnalyzeTokenSuccess, ApplicationError>> =>
      analyzeToken(ports, input, detectors, addressIndex, counters),
    resolveProxy: async (
      input: ResolveProxyInput,
    ): Promise<Result<ResolveProxySuccess, ApplicationError>> => {
      const resolved = await resolveProxy(ports, input);
      if (!resolved.ok) {
        const translated: ResolveProxyError = resolved.error;
        return err({
          kind: "rpc-error",
          requestId: translated.requestId,
          error: translated.error,
        });
      }
      return ok(resolved.value);
    },
  });
}
