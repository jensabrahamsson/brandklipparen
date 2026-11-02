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
  readonly temporality: { readonly kind: "applies-now" | "can-change" | "can-change-unknown" };
};

export type CantTellEntry = {
  readonly question: string;
  readonly dataSource: string;
};

export type ProxyInfo = {
  readonly kind: string;
  readonly implementation?: string | undefined;
  readonly admin?:
    | string
    | { readonly kind: string; readonly address?: string | undefined }
    | undefined;
  readonly upgradeAuthority?:
    | { readonly kind: string; readonly holder?: string | undefined }
    | undefined;
};

export type AnalyzeSuccess = {
  readonly kind: "assessed";
  readonly target: string;
  readonly block: number;
  readonly proxy: ProxyInfo;
  readonly codeHash: string;
  // Display-only ERC-20 symbol()/name() read at the pinned block (never
  // scored, never evidence): present when the chain answers, absent
  // otherwise. The heading prefers these, then the live list, then the
  // short address.
  readonly tokenSymbol?: string | undefined;
  readonly tokenName?: string | undefined;
  readonly tokenSymbolNonAscii?: boolean | undefined;
  readonly tokenNameNonAscii?: boolean | undefined;
  readonly modelVersion: string;
  readonly artifactChecksum: string;
  readonly indexVersion: string;
  readonly templateVersion: string;
  readonly assessedAt: number;
  readonly probabilities: Probabilities;
  readonly score: number;
  // Deterministic evidence floor behind the score (SCORE-1): present
  // when a floor rule applies to the proven owner powers.
  readonly scoreFloor?:
    | {
        readonly rule: string;
        readonly minimum: number;
        readonly label: string;
        readonly facts: readonly string[];
      }
    | undefined;
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
  // Single-fetch token view (F-5): the client reports the terminal
  // state directly and never polls. "pending" and "unavailable" stay in
  // the union only for older cached or mocked payloads.
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

// Investigation step in the visible trace (S-076, K-036): tool, rationale
// as inert text and the collected evidence ids. Rationale is model text
// and renders as text only, never as markup.
export type InvestigationStep = {
  readonly step: number;
  readonly toolId: string;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
};

// Investigation panel state (S-076, K-036): live steps stream in under
// loading; done carries the checked narrative with its drop count; limit
// names the spent budget; failed carries the typed reason. Scores and
// evidence never move with any of these states.
export type InvestigationState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly steps: readonly InvestigationStep[] }
  | { readonly status: "not-configured" }
  | { readonly status: "limit"; readonly message: string; readonly steps: readonly InvestigationStep[] }
  | { readonly status: "failed"; readonly message: string; readonly steps: readonly InvestigationStep[] }
  | {
      readonly status: "done";
      readonly steps: readonly InvestigationStep[];
      readonly narrative: string;
      readonly droppedClaims: number;
      // Typed drop accounting (M-2d): uncited vs unknown-id counts, so
      // the panel can name why an empty narrative shows nothing.
      // Absent on older cached reports, which only carry droppedClaims.
      readonly dropReasons?: { readonly uncited: number; readonly unknownId: number } | undefined;
      readonly provider: string;
      readonly modelId: string;
      // Budget-forced conclusion (M-2c): true when the run concluded
      // only through the forced final conclude call at the step limit.
      readonly forcedConclusion: boolean;
    };

// Provider label for the assessment panel (design review P0-3): the real
// {provider, modelId} from GET /health, or disabled when the REST API
// reports no assessment provider. Never hard-coded.
export type ProviderInfo =
  | { readonly status: "loading" }
  | { readonly status: "disabled" }
  | { readonly status: "ready"; readonly provider: string; readonly modelId: string };

// One AI feature as reported by GET /health (S-123): either configured
// with its provider and model, or disabled. On-chain reads carry no model,
// so a configured reader reports availability only.
export type FeatureCapability =
  | { readonly disabled: true }
  | { readonly provider: string; readonly modelId: string };

export type OnchainCapability = { readonly disabled: true } | { readonly available: true };

export type MarketCapability = { readonly disabled: true } | { readonly provider: string };

export type SourceCapability = { readonly disabled: true } | { readonly provider: string };

export type HealthState = {
  readonly assessment: FeatureCapability;
  readonly investigation?: FeatureCapability | undefined;
  readonly explain?: FeatureCapability | undefined;
  readonly chat?: FeatureCapability | undefined;
  readonly rug?: FeatureCapability | undefined;
  readonly explainCode?: FeatureCapability | undefined;
  readonly personalize?: FeatureCapability | undefined;
  readonly onchain?: OnchainCapability | undefined;
  readonly market?: MarketCapability | undefined;
  readonly source?: SourceCapability | undefined;
};
