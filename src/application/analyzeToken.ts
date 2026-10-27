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
import { noneProxyResolution, proxyToCanonical } from "../domain/proxy.ts";
import type { ProxyResolution } from "../domain/proxy.ts";
import { resolveProxy } from "./resolveProxy.ts";
import type { ResolveProxyError, ResolveProxyInput, ResolveProxySuccess } from "./resolveProxy.ts";
import { standardCantTell } from "../domain/cantTell.ts";
import type { CantTellItem } from "../domain/cantTell.ts";
import { explanationToCanonical, renderExplanation } from "../domain/explain.ts";
import type { Explanation, ExplainError } from "../domain/explain.ts";
import { score } from "../domain/risk.ts";
import { canonicalSerialize } from "../domain/serialize.ts";
import type { CanonicalValue } from "../domain/serialize.ts";
import { CacheKey, CodeHash } from "../domain/types.ts";
import type {
  Address as AddressType,
  ArtifactChecksum as ArtifactChecksumType,
  BlockNumber as BlockNumberType,
  CacheKey as CacheKeyType,
  CodeHash as CodeHashType,
  DomainError,
  IndexVersion as IndexVersionType,
  ModelVersion as ModelVersionType,
  RequestId as RequestIdType,
  RiskScore as RiskScoreType,
  TemplateVersion as TemplateVersionType,
  Timestamp as TimestampType,
} from "../domain/types.ts";
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
import {
  DEFAULT_DETECTOR_PLUGINS,
  DEFAULT_PLUGIN_REGISTRY,
  detectorPluginTable,
} from "../plugins/registry.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createDetectorInput,
  pluginResultToCanonical,
  runRegisteredDetectors,
} from "../plugins/detector.ts";
import type {
  DetectorPlugin,
  PluginFinding,
  PluginResultEntry,
} from "../plugins/detector.ts";
import type { CloneHit, CloneMapping } from "../domain/clones.ts";
import { CloneGroupId, Probability, SkeletonHash } from "../domain/types.ts";
import { Evidence } from "../domain/evidence.ts";
import type { CodeSnippet as CodeSnippetType } from "../domain/evidence.ts";
import { HARD_TO_ANALYZE_CAUSES } from "../domain/signals.ts";
import type { Probability as ProbabilityType } from "../domain/types.ts";
import type { CachePort } from "../ports/cache.ts";
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
// returns the stored assessment with zero external calls and a miss stores
// the fresh envelope under the code hash and model version (K-013).
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

// Detector set handed to the application service (S-043, P-08): the
// validated manifest registry beside the executable lookup. The service runs
// solely plugins named by the registry value, so an unregistered plugin
// never runs. The composition root owns the default value; tests pass their
// own set to select among already-registered plugins.
export type DetectorSet = {
  readonly registry: PluginRegistry;
  readonly plugins: ReadonlyMap<string, DetectorPlugin>;
};

export const DEFAULT_DETECTOR_SET: DetectorSet = Object.freeze({
  registry: DEFAULT_PLUGIN_REGISTRY,
  plugins: detectorPluginTable(DEFAULT_DETECTOR_PLUGINS),
});

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

// Placeholder risk bucket for unanalyzable code (K-210): the mapping from
// decompilation failure to risk steering belongs in the versioned model
// artifact once calibrated; until then the host conversion below reports
// the single frozen placeholder and the artifact's cause weights steer
// scoring.
const UNANALYZABLE_RISK: RiskType = "rug-pull";

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

// Host conversion of clone-match findings to today's Signal values through
// the existing clone-mapping path (S-044, P-12 step 2): risk, direction and
// severity come from the injected clone mapping, never from the finding, so
// scores stay bit-identical until calibration names the findings (P-05).
// Findings with unknown payloads or failed construction are skipped; the
// plugin record in `pluginResults` still carries them.
function signalsFromCloneMatchFindings(
  results: readonly PluginResultEntry[],
  codeHash: CodeHashType,
  mapping: CloneMapping | undefined,
): readonly Signal[] {
  if (mapping === undefined) {
    return Object.freeze([]);
  }
  const out: Signal[] = [];
  for (const entry of results) {
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
        risk: mapping.risk,
        direction: mapping.direction,
        severity: mapping.severity,
        similarity: hit.similarity,
        group: hit.group,
        priorCount: hit.priorCount,
        evidence: finding.evidence,
      });
      if (signal.ok) {
        out.push(signal.value);
      }
    }
  }
  return Object.freeze(out);
}

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

// Host conversion of hard-to-analyze findings to today's Signal values
// (S-044, P-12 step 2): the cause comes from the finding while the risk
// stays the frozen placeholder, so scores stay bit-identical until
// calibration names the findings (P-05). Findings with unknown payloads or
// failed construction are skipped; the plugin record in `pluginResults`
// still carries them.
function signalsFromHardToAnalyzeFindings(
  results: readonly PluginResultEntry[],
  codeHash: CodeHashType,
): readonly Signal[] {
  const out: Signal[] = [];
  for (const entry of results) {
    if (entry.outcome !== "ok") {
      continue;
    }
    for (const finding of entry.findings) {
      const cause = hardCauseOf(finding);
      if (cause === null) {
        continue;
      }
      const signal = Signal.createHardToAnalyze({
        codeHash,
        risk: UNANALYZABLE_RISK,
        cause,
        evidence: finding.evidence,
      });
      if (signal.ok) {
        out.push(signal.value);
      }
    }
  }
  return Object.freeze(out);
}

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
          });
    out.push(rebuiltSignal.ok ? rebuiltSignal.value : signal);
  }
  return Object.freeze(out);
}

// Address index for the cache fast path (K-013): repeat requests for an
// explicitly pinned block reuse the stored assessment without fetching
// bytecode. Code at an address is immutable, and the stored key still binds
// code hash and model version, so a changed artifact misses. Requests at
// "latest" skip the index and always resolve the head block first, so a
// new head is never hidden behind a memo entry.
function memoKeyOf(input: AnalyzeTokenInput): string {
  return `${input.address as string}|${input.block as number}|${input.modelVersion as string}`;
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

// Host conversion of capability findings to today's Signal values through
// the existing catalogue path (S-043, P-12 step 1): risk, direction and
// severity come from the injected catalogue, never from the finding, so
// scores stay bit-identical until calibration names the findings (P-05).
// Findings with unknown payloads or failed construction are skipped; the
// plugin record in `pluginResults` still carries them.
function signalsFromCapabilityFindings(
  results: readonly PluginResultEntry[],
  codeHash: CodeHashType,
  catalogue: CapabilityCatalogue,
  temporality: Temporality,
): readonly Signal[] {
  // Conversion order follows the fixed capability key order, matching the
  // legacy sweep: signals sharing one SignalId keep a stable, deterministic
  // order through the final id sort below.
  const keyOrder = new Map<CapabilityKey, number>(
    CAPABILITY_KEYS.map((key, index) => [key, index] as const),
  );
  const ordered: PluginFinding[] = [];
  for (const entry of results) {
    if (entry.outcome !== "ok") {
      continue;
    }
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
      .map(({ finding }) => finding);
    ordered.push(...ranked);
  }
  const out: Signal[] = [];
  for (const finding of ordered) {
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
    });
    if (signal.ok) {
      out.push(signal.value);
    }
  }
  out.sort((left, right) => {
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
  return Object.freeze(out);
}

// Numbers first, text second: scoring and the template render run before the
// envelope is frozen, so an assessment added later leaves them unchanged.
// An optional request-scoped sink counts each RPC call in this run (K-107);
// without a sink the run behaves exactly as before.
export async function analyzeToken(
  ports: AnalyzeTokenPorts,
  input: AnalyzeTokenInput,
  addressIndex: Map<string, CacheKeyType> = new Map(),
  counters?: RequestCounterSink | undefined,
  detectors: DetectorSet = DEFAULT_DETECTOR_SET,
): Promise<Result<AnalyzeTokenSuccess, ApplicationError>> {
  const rpc = counters === undefined ? ports.rpc : withCountedRpc(ports.rpc, counters);
  const countedPorts = counters === undefined ? ports : { ...ports, rpc };
  // Cache lookup before any external call (I-14): a remembered key gives a
  // hit with zero RPC, decompiler and model calls. A miss, a rejected entry
  // or an unreachable store falls through to the fresh path below (A-15).
  if (ports.cache !== undefined && input.block !== "latest") {
    const memoKey = memoKeyOf(input);
    const remembered = addressIndex.get(memoKey);
    if (remembered !== undefined) {
      const hit = await ports.cache.get(remembered);
      if (hit.ok && hit.value !== null) {
        return ok({ kind: "assessed", envelope: hit.value });
      }
      addressIndex.delete(memoKey);
    }
  }
  const ctx: CallContext = { requestId: input.requestId, deadline: input.deadline, block: input.block };
  const resolvedBlock = await resolveBlock(rpc, input, ctx);
  if (!resolvedBlock.ok) {
    return resolvedBlock;
  }
  const block = resolvedBlock.value;
  const blockCtx: CallContext = { requestId: input.requestId, deadline: input.deadline, block };
  const fetched = await rpc.getCode(input.address, blockCtx);
  if (!fetched.ok) {
    if (fetched.error.kind === "no-code") {
      return ok({ kind: "no-contract", target: input.address, block });
    }
    return err({ kind: "rpc-error", requestId: input.requestId, error: fetched.error });
  }
  const codeHash = CodeHash.of(fetched.value.bytecode);
  if (!codeHash.ok) {
    return err({ kind: "domain-error", requestId: input.requestId, error: codeHash.error });
  }
  const cacheKey = CacheKey.of(codeHash.value, input.modelVersion);
  if (!cacheKey.ok) {
    return err({ kind: "domain-error", requestId: input.requestId, error: cacheKey.error });
  }
  // Second lookup on the code-hash key: a new address with known code and a
  // request without a memo entry still skip proxy resolution, decompilation
  // and the model load (K-013).
  if (ports.cache !== undefined) {
    const hit = await ports.cache.get(cacheKey.value);
    if (hit.ok && hit.value !== null) {
      if (input.block !== "latest") {
        addressIndex.set(memoKeyOf(input), cacheKey.value);
      }
      return ok({ kind: "assessed", envelope: hit.value });
    }
  }
  // Proxy resolution runs on the pinned block through RpcPort; a typed
  // port failure degrades to no proxy info so the deterministic analysis
  // still delivers its result (K-002, K-005).
  const proxyInput: ResolveProxyInput = {
    address: input.address,
    block,
    requestId: input.requestId,
    deadline: input.deadline,
    ...(input.proxyMaxDepth === undefined ? {} : { maxDepth: input.proxyMaxDepth }),
  };
  const resolvedProxy = await resolveProxy(countedPorts, proxyInput);
  const proxy: ProxyResolution = resolvedProxy.ok
    ? resolvedProxy.value.resolution
    : noneProxyResolution();
  const loaded = ports.modelArtifacts.load(input.modelVersion);
  if (!loaded.ok) {
    return err({ kind: "model-artifact-error", requestId: input.requestId, error: loaded.error });
  }
  const observed: Temporality = { kind: "can-change", changer: input.address };
  // Clone-hit lookup ahead of detection (K-017): where a clone index is
  // bound, an exact code-hash or skeleton-hash hit becomes the `cloneMatch`
  // input fact for the single registry run below. A miss yields a null fact
  // and therefore no clone finding, and a port error continues with a null
  // fact while the fast path's response stands. The response names the
  // bound index version, so hits stay reproducible per K-102.
  const indexVersion = ports.cloneIndex === undefined ? input.indexVersion : ports.cloneIndex.indexVersion();
  let cloneHit: CloneHit | null = null;
  if (ports.cloneIndex !== undefined && input.cloneMapping !== undefined) {
    const skeletonHash = SkeletonHash.of(fetched.value.bytecode);
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
  // fast path's response stands.
  let decompiled: DecompiledContract | null = null;
  let decompilerCause: HardToAnalyzeCause | null = null;
  if (ports.decompiler !== undefined) {
    const outcome = await ports.decompiler.decompile(
      fetched.value.bytecode,
      codeHash.value,
      blockCtx,
    );
    if (outcome.ok) {
      decompiled = outcome.value;
    } else {
      decompilerCause = causeOfDecompilerError(outcome.error);
    }
  }
  // Single detection run through the registry (S-043 step 1, S-044 step 2):
  // every registered detector runs behind the registry boundary and its
  // findings convert to today's Signal values through the existing
  // catalogue, clone-mapping and placeholder-risk paths. The legacy direct
  // cloneMatchSignal call and the inline fallback-signal construction are
  // deleted; the service reads detector output solely through the
  // registry/detect path.
  const pluginResults = runRegisteredDetectors(
    detectors.registry,
    detectors.plugins,
    createDetectorInput(fetched.value.bytecode, codeHash.value, {
      cloneMatch: cloneHit,
      decompilerCause,
    }),
  );
  const fastPath = signalsFromCapabilityFindings(
    pluginResults,
    codeHash.value,
    input.catalogue,
    observed,
  );
  const cloneSignals = signalsFromCloneMatchFindings(
    pluginResults,
    codeHash.value,
    input.cloneMapping,
  );
  const hardSignals = signalsFromHardToAnalyzeFindings(pluginResults, codeHash.value);
  let signals: readonly Signal[] = Object.freeze([...fastPath, ...cloneSignals, ...hardSignals]);
  // Snippet enrichment for a successful decompilation (K-008): each
  // evidence entry whose selector the worker decompiled gains its snippet,
  // keeping every other field bit-identical.
  if (decompiled !== null) {
    signals = attachSnippets(signals, codeHash.value, decompiled);
  }
  const risk = score(signals, loaded.value.artifact);
  const rendered = renderExplanation({ signals, templateVersion: input.templateVersion, observed });
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
  // Store the fresh envelope under the code-hash key (K-013): best effort,
  // so a rejected write still returns the analysis. A new model version
  // keys new entries, so older entries stay unused beside the new one.
  if (ports.cache !== undefined) {
    await ports.cache.put(cacheKey.value, envelope);
    if (input.block !== "latest") {
      addressIndex.set(memoKeyOf(input), cacheKey.value);
    }
  }
  return ok({ kind: "assessed", envelope });
}

async function resolveBlock(
  rpc: RpcPort,
  input: AnalyzeTokenInput,
  ctx: CallContext,
): Promise<Result<BlockNumberType, ApplicationError>> {
  if (input.block !== "latest") {
    return ok(input.block);
  }
  const head = await rpc.getBlockNumber(ctx);
  if (!head.ok) {
    return err({ kind: "rpc-error", requestId: input.requestId, error: head.error });
  }
  return ok(head.value);
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
  detectors: DetectorSet = DEFAULT_DETECTOR_SET,
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
      analyzeToken(ports, input, addressIndex, counters, detectors),
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
