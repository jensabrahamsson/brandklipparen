// UI types derived from the published REST schema
// (src/interfaces/rest/schema/v1.json). The web app talks to the core only
// through the REST published schema (A-04): these shapes mirror the schema
// and never import domain, application or adapter modules.

export type RiskKind = "rug-pull" | "honeypot" | "bot-pump";

export type RiskWord = "Low" | "Elevated" | "High";

export type RiskBand = {
  readonly word: RiskWord;
  readonly min: number;
  readonly max: number;
};

export type Probabilities = Record<RiskKind, number>;

export type EvidenceEntry = {
  readonly selector: string;
  readonly offset: number | null;
};

export type SignalDirection = "raises" | "lowers";

export type Signal = {
  readonly kind: "capability" | "clone-match" | "hard-to-analyze";
  readonly id: string;
  readonly risk: RiskKind;
  readonly direction?: SignalDirection | undefined;
  readonly severity?: "low" | "medium" | "high" | undefined;
  readonly similarity?: number | undefined;
  readonly group?: string | undefined;
  readonly priorCount?: number | undefined;
  readonly cause?: string | undefined;
  readonly evidence: readonly EvidenceEntry[];
};

export type ExplanationClaim = {
  readonly text: string;
  readonly signalLinks: readonly string[];
  readonly temporality: { readonly kind: "applies-now" | "can-change" };
};

export type CantTellEntry = {
  readonly question: string;
  readonly dataSource: string;
};

export type ProxyInfo = {
  readonly kind: string;
  readonly implementation?: string | undefined;
  readonly admin?: string | undefined;
};

export type AnalyzeSuccess = {
  readonly kind: "assessed";
  readonly target: string;
  readonly block: number;
  readonly proxy: ProxyInfo;
  readonly codeHash: string;
  readonly modelVersion: string;
  readonly artifactChecksum: string;
  readonly indexVersion: string;
  readonly templateVersion: string;
  readonly assessedAt: number;
  readonly probabilities: Probabilities;
  readonly score: number;
  readonly signals: readonly Signal[];
  // Additive detector plugin results (S-043, P-11): present in REST
  // responses beside the calibrated signals. The generic Plugins panel
  // renders them in S-046; until then the UI ignores this field.
  readonly pluginResults?: readonly unknown[] | undefined;
  readonly explanation: {
    readonly kind: "template";
    readonly templateVersion: string;
    readonly claims: readonly ExplanationClaim[];
  };
  readonly cantTell: readonly CantTellEntry[];
  // "unavailable" is UI-side only (design review P0-6): the header only
  // ever says pending/ready; the UI records exhausted deepening polls so
  // it can hide the streaming promise instead of leaving a lying line.
  readonly deepening: "pending" | "ready" | "unavailable";
};

export type NoContract = {
  readonly kind: "no-contract";
  readonly target: string;
  readonly block: number;
};

export type AnalyzeResult = AnalyzeSuccess | NoContract;

export type AssessmentReady = {
  readonly status: "ready";
  readonly text: string;
  readonly provider: string;
  readonly modelId: string;
};

export type AssessmentState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "not-configured" }
  | { readonly status: "error"; readonly message: string }
  | AssessmentReady;

// Provider label for the assessment panel (design review P0-3): the real
// {provider, modelId} from GET /health, or disabled when the REST API
// reports no assessment provider. Never hard-coded.
export type ProviderInfo =
  | { readonly status: "loading" }
  | { readonly status: "disabled" }
  | { readonly status: "ready"; readonly provider: string; readonly modelId: string };

export type HealthState =
  | { readonly assessment: { readonly provider: string; readonly modelId: string } }
  | { readonly assessment: { readonly disabled: true } };
