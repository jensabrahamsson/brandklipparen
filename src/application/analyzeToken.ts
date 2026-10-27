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
import { CodeHash } from "../domain/types.ts";
import type {
  Address as AddressType,
  ArtifactChecksum as ArtifactChecksumType,
  BlockNumber as BlockNumberType,
  CodeHash as CodeHashType,
  DomainError,
  IndexVersion as IndexVersionType,
  ModelVersion as ModelVersionType,
  RequestId as RequestIdType,
  RiskScore as RiskScoreType,
  TemplateVersion as TemplateVersionType,
  Timestamp as TimestampType,
} from "../domain/types.ts";
import { detectCapabilities } from "../domain/signals.ts";
import type {
  CapabilityCatalogue,
  RiskType,
  Signal,
  Temporality,
} from "../domain/signals.ts";
import type { Probability as ProbabilityType } from "../domain/types.ts";
import type { ClockPort } from "../ports/clock.ts";
import type { ModelArtifactError } from "../ports/modelArtifact.ts";
import type { ModelArtifactPort } from "../ports/modelArtifact.ts";
import type { CallContext, RpcError, RpcPort } from "../ports/rpc.ts";

// Ports behind the service. Each driving adapter receives the bound service,
// never these ports directly (A-03).
export type AnalyzeTokenPorts = {
  readonly rpc: RpcPort;
  readonly modelArtifacts: ModelArtifactPort;
  readonly clock: ClockPort;
};

// Typed input: every adapter validates raw input to these domain values at
// its boundary (A-11), so the service takes validity as given. The catalogue
// maps capability keys to risk, direction and severity; the values steer
// scoring and belong to the versioned calibration setup per K-210 and A-20,
// arriving here as a parameter like the model artifact itself.
export type AnalyzeTokenInput = {
  readonly address: AddressType;
  readonly block: BlockNumberType | "latest";
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly modelVersion: ModelVersionType;
  readonly indexVersion: IndexVersionType;
  readonly templateVersion: TemplateVersionType;
  readonly catalogue: CapabilityCatalogue;
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

// Numbers first, text second: scoring and the template render run before the
// envelope is frozen, so an assessment added later leaves them unchanged.
export async function analyzeToken(
  ports: AnalyzeTokenPorts,
  input: AnalyzeTokenInput,
): Promise<Result<AnalyzeTokenSuccess, ApplicationError>> {
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
  const signals = detectCapabilities(fetched.value.bytecode, codeHash.value, input.catalogue, observed);
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
    indexVersion: input.indexVersion,
    templateVersion: input.templateVersion,
    assessedAt: ports.clock.now(),
    probabilities: risk.probabilities,
    score: risk.score,
    signals,
    explanation: rendered.value,
    cantTell: standardCantTell(),
  });
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
  return Object.freeze({
    analyzeToken: (input: AnalyzeTokenInput): Promise<Result<AnalyzeTokenSuccess, ApplicationError>> =>
      analyzeToken(ports, input),
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
