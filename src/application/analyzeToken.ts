// One shared application service for all interfaces (S-026, K-027, A-02).
// The web UI, REST API and MCP server call the same entry point with the same
// typed input and the same model version, so equal code hash and model version
// give equal probabilities, scores and signals in every interface. The service
// depends solely on ports (A-04): bytecode arrives through RpcPort, the risk
// values arrive through ModelArtifactPort and the observation time arrives
// through ClockPort. Detection lives in the domain core; the adapters own only
// validation at their boundary and response formatting. This module performs
// no I/O of its own; every external call goes through a port, and the module
// imports solely domain and ports. Resolution of proxy contracts, just-deployed
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
  Bytecode as BytecodeType,
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
import { Signal, detectCapabilities } from "../domain/signals.ts";
import type {
  CapabilityCatalogue,
  HardToAnalyzeCause,
  RiskType,
  Temporality,
} from "../domain/signals.ts";
import { cloneMatchSignal } from "../domain/clones.ts";
import type { CloneMapping } from "../domain/clones.ts";
import { SkeletonHash } from "../domain/types.ts";
import { Evidence } from "../domain/evidence.ts";
import type { CodeSnippet as CodeSnippetType } from "../domain/evidence.ts";
import { extractSelectors } from "../domain/selectors.ts";
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

// Canonical assessment envelope: the same input triple of bytecode, block
// number and artifact version gives a bit-identical serialisation on every
// run, in every runtime and on every machine (K-102, A-32). The envelope
// carries the reproduction fields per A-32 point 7: block number, code hash,
// model version, artifact checksum, index version and template version.
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

// Error branch to signal cause per A-15: every decompiler failure branch
// yields the hard-to-analyze signal in the deepening while the fast path's
// response stands (K-008, M-02).
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
// artifact once calibrated; until then the deepening reports the single
// frozen placeholder below and the artifact's cause weights steer scoring.
const UNANALYZABLE_RISK: RiskType = "rug-pull";

// Fallback signal for a failed decompilation (K-008): the signal carries
// the first dispatcher selector as evidence, so it links to the analysed
// bytecode. Bytecode without selectors yields no signal, since a signal
// without evidence is unrepresentable per A-13.
function fallbackSignal(
  bytecode: BytecodeType,
  codeHash: CodeHashType,
  error: DecompilerError,
): Signal | null {
  const first = extractSelectors(bytecode)[0];
  if (first === undefined) {
    return null;
  }
  const evidence = Evidence.create({ selector: first.selector });
  if (!evidence.ok) {
    return null;
  }
  const signal = Signal.createHardToAnalyze({
    codeHash,
    risk: UNANALYZABLE_RISK,
    cause: causeOfDecompilerError(error),
    evidence: [evidence.value],
  });
  if (!signal.ok) {
    return null;
  }
  return signal.value;
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

// Numbers first, text second: scoring and the template render run before the
// envelope is frozen, so an assessment added later leaves them unchanged.
export async function analyzeToken(
  ports: AnalyzeTokenPorts,
  input: AnalyzeTokenInput,
  addressIndex: Map<string, CacheKeyType> = new Map(),
): Promise<Result<AnalyzeTokenSuccess, ApplicationError>> {
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
  const resolvedBlock = await resolveBlock(ports.rpc, input, ctx);
  if (!resolvedBlock.ok) {
    return resolvedBlock;
  }
  const block = resolvedBlock.value;
  const blockCtx: CallContext = { requestId: input.requestId, deadline: input.deadline, block };
  const fetched = await ports.rpc.getCode(input.address, blockCtx);
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
  const resolvedProxy = await resolveProxy(ports, proxyInput);
  const proxy: ProxyResolution = resolvedProxy.ok
    ? resolvedProxy.value.resolution
    : noneProxyResolution();
  const loaded = ports.modelArtifacts.load(input.modelVersion);
  if (!loaded.ok) {
    return err({ kind: "model-artifact-error", requestId: input.requestId, error: loaded.error });
  }
  const observed: Temporality = { kind: "can-change", changer: input.address };
  const fastPath = detectCapabilities(
    fetched.value.bytecode,
    codeHash.value,
    input.catalogue,
    observed,
  );
  // Clone matching against known trap templates (K-017): where a clone
  // index is bound, an exact code-hash or skeleton-hash hit appends a
  // clone-match signal with the mandatory group id and prior count before
  // scoring runs on the frozen artifact. A miss yields no clone signal, and
  // a port error continues without one while the fast path's response
  // stands. The response names the bound index version, so hits stay
  // reproducible per K-102.
  const indexVersion = ports.cloneIndex === undefined ? input.indexVersion : ports.cloneIndex.indexVersion();
  let signals: readonly Signal[] = fastPath;
  if (ports.cloneIndex !== undefined && input.cloneMapping !== undefined) {
    const skeletonHash = SkeletonHash.of(fetched.value.bytecode);
    if (!skeletonHash.ok) {
      return err({ kind: "domain-error", requestId: input.requestId, error: skeletonHash.error });
    }
    const matched = ports.cloneIndex.match(codeHash.value, skeletonHash.value);
    if (matched.ok && matched.value !== null) {
      const cloneSignal = cloneMatchSignal({
        codeHash: codeHash.value,
        bytecode: fetched.value.bytecode,
        hit: matched.value,
        mapping: input.cloneMapping,
      });
      if (cloneSignal !== null) {
        signals = Object.freeze([...signals, cloneSignal]);
      }
    }
  }
  // Deepening through DecompilerPort (K-008): a successful run links
  // snippets to the fast-path evidence, while every failure branch yields
  // the hard-to-analyze signal and the fast path's response stands, so
  // scoring still runs on the frozen artifact either way.
  if (ports.decompiler !== undefined) {
    const decompiled = await ports.decompiler.decompile(
      fetched.value.bytecode,
      codeHash.value,
      blockCtx,
    );
    if (decompiled.ok) {
      signals = attachSnippets(signals, codeHash.value, decompiled.value);
    } else {
      const fallback = fallbackSignal(fetched.value.bytecode, codeHash.value, decompiled.error);
      if (fallback !== null) {
        signals = Object.freeze([...signals, fallback]);
      }
    }
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
// the web UI.
export type AppServices = {
  readonly analyzeToken: (
    input: AnalyzeTokenInput,
  ) => Promise<Result<AnalyzeTokenSuccess, ApplicationError>>;
  readonly resolveProxy: (
    input: ResolveProxyInput,
  ) => Promise<Result<ResolveProxySuccess, ApplicationError>>;
};

export function createAppServices(ports: AnalyzeTokenPorts): AppServices {
  // Address index for the cache fast path, shared by every call through
  // this service (K-013). The index maps address, block and model version
  // to the cache key and is re-verified through the cache on every use.
  const addressIndex = new Map<string, CacheKeyType>();
  return Object.freeze({
    analyzeToken: (input: AnalyzeTokenInput): Promise<Result<AnalyzeTokenSuccess, ApplicationError>> =>
      analyzeToken(ports, input, addressIndex),
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
