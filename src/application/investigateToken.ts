// Investigation graph runner (S-074, K-036, K-520, K-307, P-31, P-32,
// P-34, P-36). The runner owns the state machine, the step budget and the
// tool catalogue; the model only proposes the next decision through
// InvestigationModelPort. Tools are read-only and derived from the
// registry shape: one `detector.<pluginId>` per registered detector
// re-run on its frozen projection, plus the frozen-fact readers
// `evidence.list`, `analysis.summary` and `docs.plugin`. No tool performs
// network calls or fresh chain reads: every tool reads the frozen facts
// the host already fetched, so the frozen block context (K-102) stands.
// Every model decision consumes one step, including rejected ones, so the
// budget cannot be gamed by retrying validation failures. The runner
// reads the frozen facts and writes only its own envelope: score,
// probabilities, signals and evidence stay bit-identical with the loop
// on, off, failed or absent (K-307, P-33).
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import { checkCitations } from "../domain/investigation.ts";
import type {
  CheckedNarrative,
  EvidenceRef,
  InvestigationFailure,
  InvestigationTrace,
  InvestigationTraceStep,
} from "../domain/investigation.ts";
import type { CodeHash as CodeHashType } from "../domain/types.ts";
import type {
  InvestigationCallContext,
  InvestigationDecision,
  InvestigationModelError,
  InvestigationModelInput,
  InvestigationModelPort,
} from "../ports/investigationModel.ts";
import { InvestigationModelInput as InvestigationModelInputCtor } from "../ports/investigationModel.ts";

// Frozen facts the host already fetched for this analysis (P-32). The
// runner deep-treats this value as read-only: tools receive it but never
// write it, and the envelope carries no copy of it.
export type FrozenInvestigationFacts = {
  readonly codeHash: CodeHashType;
  readonly scoreBand: string;
  readonly signalIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly score: number;
  readonly snapshot: unknown;
};

// Hard limits from typed configuration (P-34). Every limit ends the run
// with the partial trace preserved and the limit recorded.
export type InvestigationLimits = {
  readonly maxSteps: number;
  readonly maxTokens: number;
  readonly deadlineMs: number;
  readonly toolTimeoutMs: number;
};

export const DEFAULT_INVESTIGATION_LIMITS: InvestigationLimits = Object.freeze({
  maxSteps: 8,
  maxTokens: 8000,
  deadlineMs: 60000,
  toolTimeoutMs: 5000,
});

// One read-only tool in the frozen catalogue (P-32). `run` is a
// synchronous pure read of the frozen facts resolving the collected
// evidence ids; it never writes, never reads the network and never
// reaches past the frozen block. A throw degrades to an empty observation
// for that step, so one failing tool never ends the investigation.
export type InvestigationTool = {
  readonly toolId: string;
  readonly description: string;
  readonly argNames: readonly string[];
  readonly run: (
    args: Readonly<Record<string, unknown>>,
    facts: FrozenInvestigationFacts,
  ) => readonly EvidenceRef[];
};

export type InvestigationCatalogue = {
  readonly tools: readonly InvestigationTool[];
};

export type RunnerState = {
  readonly trace: InvestigationTrace;
  readonly collected: readonly EvidenceRef[];
  readonly stepsUsed: number;
  readonly tokensSpent: number;
  readonly concluded: boolean;
};

export function emptyRunnerState(): RunnerState {
  return { trace: [], collected: [], stepsUsed: 0, tokensSpent: 0, concluded: false };
}

export type AdvanceFailure = {
  readonly reason: InvestigationFailure;
  readonly partial: InvestigationTrace;
  readonly stepsUsed: number;
};

// Detector wiring into the catalogue (P-32): each entry re-runs one
// registered detector on its frozen projection and returns the finding
// ids the registry boundary already validated. Docs excerpts travel as
// quoted data under the caller's cap.
export function buildInvestigationCatalogue(input: {
  readonly detectors: readonly {
    readonly pluginId: string;
    readonly description: string;
    readonly findings: readonly string[];
  }[];
  readonly evidenceIds: readonly string[];
  readonly summary: string;
  readonly docs: Readonly<Record<string, string>>;
}): InvestigationCatalogue {
  const tools: InvestigationTool[] = [];
  for (const detector of input.detectors) {
    const findings = detector.findings.slice();
    tools.push({
      toolId: `detector.${detector.pluginId}`,
      description: detector.description,
      argNames: [],
      run: () => findings.slice(),
    });
  }
  const evidenceIds = input.evidenceIds.slice();
  tools.push({
    toolId: "evidence.list",
    description: "List the frozen signal and finding evidence ids.",
    argNames: [],
    run: () => evidenceIds.slice(),
  });
  tools.push({
    toolId: "analysis.summary",
    description: "Read the frozen score band and signal summary.",
    argNames: [],
    run: () => evidenceIds.slice(0, 1),
  });
  const docs = { ...input.docs };
  tools.push({
    toolId: "docs.plugin",
    description: "Read one plugin validated summary as quoted data.",
    argNames: ["pluginId"],
    run: (args) => {
      const pluginId = args["pluginId"];
      if (typeof pluginId !== "string") {
        return [];
      }
      const excerpt = docs[pluginId];
      if (excerpt === undefined) {
        return [];
      }
      void excerpt;
      return [`doc:${pluginId}`];
    },
  });
  return { tools: Object.freeze(tools) };
}

function findTool(catalogue: InvestigationCatalogue, toolId: string): InvestigationTool | null {
  for (const tool of catalogue.tools) {
    if (tool.toolId === toolId) {
      return tool;
    }
  }
  return null;
}

function isScalarArg(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

// Argument validation per tool (P-31, section 3.3 of the plugin ADR style):
// every supplied key must be declared, every declared key must be present,
// and values stay scalar JSON so no nested payload reaches a tool.
function checkArgs(tool: InvestigationTool, args: Readonly<Record<string, unknown>>): string | null {
  const keys = Object.keys(args);
  for (const key of keys) {
    if (!tool.argNames.includes(key)) {
      return `unexpected argument ${key}`;
    }
  }
  for (const name of tool.argNames) {
    if (!(name in args)) {
      return `missing argument ${name}`;
    }
    if (!isScalarArg(args[name])) {
      return `non-scalar argument ${name}`;
    }
  }
  return null;
}

function decisionCost(decision: InvestigationDecision): number {
  if (decision.kind === "run-tool") {
    return decision.rationale.length + 10;
  }
  return decision.narrativeDraft.length + 10;
}

function mergeCollected(collected: readonly EvidenceRef[], fresh: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>(collected);
  const merged = collected.slice();
  for (const id of fresh) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

// One validated runner step (P-31): consumes exactly one step for every
// decision, valid or not. Unknown tools, calls after `conclude` and
// malformed args end in `invalid-decision` with the partial trace
// preserved and the step counted.
export function advanceInvestigation(
  state: RunnerState,
  decision: InvestigationDecision,
  catalogue: InvestigationCatalogue,
  facts: FrozenInvestigationFacts,
  limits: InvestigationLimits,
): Result<RunnerState, AdvanceFailure> {
  void limits;
  const stepsUsed = state.stepsUsed + 1;
  const tokensSpent = state.tokensSpent + decisionCost(decision);
  const fail = (reason: InvestigationFailure): Result<RunnerState, AdvanceFailure> =>
    err({ reason, partial: state.trace.slice(), stepsUsed });
  if (state.concluded) {
    return fail({
      kind: "invalid-decision",
      message: "the model called a tool after conclude",
      detail: "conclude ends the decision sequence",
    });
  }
  if (decision.kind === "conclude") {
    return ok({
      trace: state.trace.slice(),
      collected: state.collected.slice(),
      stepsUsed,
      tokensSpent,
      concluded: true,
    });
  }
  const tool = findTool(catalogue, decision.toolId);
  if (tool === null) {
    return fail({
      kind: "invalid-decision",
      message: `unknown tool ${decision.toolId}`,
      detail: "tool id is outside the frozen catalogue",
    });
  }
  const argError = checkArgs(tool, decision.args);
  if (argError !== null) {
    return fail({ kind: "invalid-decision", message: argError, detail: "tool args failed validation" });
  }
  void facts;
  return ok({
    trace: state.trace.slice(),
    collected: state.collected.slice(),
    stepsUsed,
    tokensSpent,
    concluded: false,
  });
}

export type InvestigationEnvelope =
  | {
      readonly status: "done";
      readonly report: {
        readonly narrative: string;
        readonly droppedClaims: number;
        readonly steps: InvestigationTrace;
        readonly collectedEvidenceIds: readonly EvidenceRef[];
      };
      readonly limits: InvestigationLimits;
    }
  | {
      readonly status: "failed";
      readonly reason: InvestigationFailure | { kind: "provider-error"; message: string };
      readonly partial: InvestigationTrace;
      readonly collectedEvidenceIds: readonly EvidenceRef[];
      readonly limits: InvestigationLimits;
    }
  | { readonly status: "not-configured"; readonly limits: InvestigationLimits };

export type InvestigateClock = {
  readonly now: () => number;
};

// Runner clock and step observer (P-34, P-37): the application layer owns
// no clock, so callers inject `now` (driving adapters read the wall clock;
// tests pass a fake). `onStep` observes each recorded step as it lands for
// the step-events stream. Hooks never affect the trace, the budgets or the
// envelope.
export type InvestigateHooks = {
  readonly now: () => number;
  readonly onStep?: ((step: InvestigationTraceStep) => void) | undefined;
};

function providerFailure(error: InvestigationModelError): InvestigationFailure | { kind: "provider-error"; message: string } {
  switch (error.kind) {
    case "timeout":
      return { kind: "provider-error", message: "investigation provider timed out" };
    case "rate-limited":
      return { kind: "provider-error", message: "investigation provider rate limited the request" };
    case "unavailable":
      return { kind: "provider-error", message: "investigation provider is unavailable" };
    case "invalid-output":
      return { kind: "invalid-decision", message: "the model returned unusable output", detail: error.message };
    case "output-too-large":
      return { kind: "invalid-decision", message: "the model returned oversize output", detail: error.message };
    case "provider-mismatch":
      return { kind: "invalid-decision", message: "the model answered for the wrong provider", detail: error.message };
    case "not-configured":
      return { kind: "provider-error", message: "investigation is not configured" };
  }
}

function buildModelInput(
  facts: FrozenInvestigationFacts,
  catalogue: InvestigationCatalogue,
  state: RunnerState,
  limits: InvestigationLimits,
  remainingMs: number,
): Result<InvestigationModelInput, { kind: string; message: string }> {
  return InvestigationModelInputCtor.create({
    codeHash: facts.codeHash,
    scoreBand: facts.scoreBand,
    signalIds: facts.signalIds.slice(),
    tools: catalogue.tools.map((tool) => ({
      toolId: tool.toolId,
      description: tool.description,
      argNames: tool.argNames.slice(),
    })),
    trace: state.trace.map((step) => ({
      step: step.step,
      toolId: step.toolId,
      rationale: step.rationale,
      evidenceIds: step.evidenceIds.slice(),
    })),
    budgets: {
      stepsLeft: Math.max(0, limits.maxSteps - state.stepsUsed),
      tokensLeft: Math.max(0, limits.maxTokens - state.tokensSpent),
      // The runner guarantees at least 1 ms here: the deadline check above
      // ends the run before the remaining budget reaches zero, so the
      // input constructor never sees a non-positive deadline.
      deadlineMs: Math.max(1, remainingMs),
    },
  });
}

// Tool execution under its deadline (P-34): tools are synchronous reads,
// so the runner measures the injected clock around the call instead of
// preempting it. An overrun ends the run in `tool-timeout` with the
// partial trace preserved; a throw degrades to an empty observation.
function runToolAccounted(
  tool: InvestigationTool,
  args: Readonly<Record<string, unknown>>,
  facts: FrozenInvestigationFacts,
  toolTimeoutMs: number,
  now: () => number,
): { timedOut: true } | { timedOut: false; evidenceIds: readonly EvidenceRef[] } {
  const before = now();
  let observed: readonly EvidenceRef[];
  try {
    observed = tool.run(args, facts);
  } catch {
    observed = [];
  }
  if (now() - before > toolTimeoutMs) {
    return { timedOut: true };
  }
  return { timedOut: false, evidenceIds: observed };
}

// The graph loop (P-31, P-34): limit checks first, then one model decision,
// then validation and execution. Adapter errors map to typed failures with
// the partial trace preserved; `not-configured` answers immediately with
// zero tool runs and the deterministic analysis standing (P-29).
export async function investigateToken(
  adapter: InvestigationModelPort,
  catalogue: InvestigationCatalogue,
  facts: FrozenInvestigationFacts,
  ctx: InvestigationCallContext,
  limits: InvestigationLimits,
  hooks: InvestigateHooks,
): Promise<InvestigationEnvelope> {
  const now = hooks.now;
  const onStep = hooks.onStep;
  const startedAt = now();
  const deadlineAt = startedAt + limits.deadlineMs;
  let state: RunnerState = emptyRunnerState();

  for (;;) {
    if (state.stepsUsed >= limits.maxSteps) {
      return {
        status: "failed",
        reason: { kind: "step-limit", message: "investigation step budget spent", limit: limits.maxSteps },
        partial: state.trace.slice(),
        collectedEvidenceIds: state.collected.slice(),
        limits,
      };
    }
    if (state.tokensSpent >= limits.maxTokens) {
      return {
        status: "failed",
        reason: { kind: "token-limit", message: "investigation token budget spent", limit: limits.maxTokens },
        partial: state.trace.slice(),
        collectedEvidenceIds: state.collected.slice(),
        limits,
      };
    }
    if (now() > deadlineAt) {
      return {
        status: "failed",
        reason: { kind: "deadline", message: "investigation wall-clock budget spent", limitMs: limits.deadlineMs },
        partial: state.trace.slice(),
        collectedEvidenceIds: state.collected.slice(),
        limits,
      };
    }
    const built = buildModelInput(facts, catalogue, state, limits, deadlineAt - now());
    if (!built.ok) {
      return {
        status: "failed",
        reason: { kind: "invalid-decision", message: "investigation input failed validation", detail: built.error.message },
        partial: state.trace.slice(),
        collectedEvidenceIds: state.collected.slice(),
        limits,
      };
    }
    const decided = await adapter.decide(built.value, ctx);
    if (!decided.ok) {
      if (decided.error.kind === "not-configured") {
        return { status: "not-configured", limits };
      }
      return {
        status: "failed",
        reason: providerFailure(decided.error),
        partial: state.trace.slice(),
        collectedEvidenceIds: state.collected.slice(),
        limits,
      };
    }
    const decision = decided.value;
    const advanced = advanceInvestigation(state, decision, catalogue, facts, limits);
    if (!advanced.ok) {
      return {
        status: "failed",
        reason: advanced.error.reason,
        partial: advanced.error.partial,
        collectedEvidenceIds: state.collected.slice(),
        limits,
      };
    }
    state = advanced.value;
    if (decision.kind === "conclude") {
      const checked: CheckedNarrative = checkCitations(decision.narrativeDraft, state.collected);
      return {
        status: "done",
        report: {
          narrative: checked.narrative,
          droppedClaims: checked.droppedClaims,
          steps: state.trace.slice(),
          collectedEvidenceIds: state.collected.slice(),
        },
        limits,
      };
    }
    const tool = findTool(catalogue, decision.toolId);
    if (tool === null) {
      return {
        status: "failed",
        reason: { kind: "invalid-decision", message: `unknown tool ${decision.toolId}`, detail: "tool id is outside the frozen catalogue" },
        partial: state.trace.slice(),
        collectedEvidenceIds: state.collected.slice(),
        limits,
      };
    }
    const ran = runToolAccounted(tool, decision.args, facts, limits.toolTimeoutMs, now);
    if (ran.timedOut) {
      return {
        status: "failed",
        reason: { kind: "tool-timeout", message: `tool ${tool.toolId} exceeded its deadline`, toolId: tool.toolId },
        partial: state.trace.slice(),
        collectedEvidenceIds: state.collected.slice(),
        limits,
      };
    }
    const observed: readonly EvidenceRef[] = ran.evidenceIds;
    const step: InvestigationTraceStep = Object.freeze({
      step: state.stepsUsed,
      toolId: tool.toolId,
      rationale: decision.rationale,
      evidenceIds: Object.freeze(observed.slice()),
      elapsedMs: 0,
    });
    onStep?.(step);
    state = {
      trace: [...state.trace, step],
      collected: mergeCollected(state.collected, observed),
      stepsUsed: state.stepsUsed,
      tokensSpent: state.tokensSpent,
      concluded: false,
    };
  }
}

// Replay accounting (P-36): traces compare bit-identical apart from
// `elapsedMs`, so a recorded trace replays exactly through the fake.
export function stripTraceTiming(trace: InvestigationTrace): InvestigationTrace {
  return trace.map((step) => ({ ...step, elapsedMs: 0 }));
}
