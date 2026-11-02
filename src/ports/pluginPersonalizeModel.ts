// PluginPersonalizeModelPort: the single experimental AI personalize mode
// (S-069, K-519, P-27). One toggle, one port, one spec family (ADR P-27,
// section 0.1: the retired layout-only port never shipped, so there is
// nothing to extend — open decision 12 resolves to this sibling). The
// port is owned by the core: the input is a closed frozen value (code
// hash, closed layout facts, quoted priorities text, quoted per-plugin
// frontmatter and doc excerpts, prompt version) and the output is one
// validated `PersonalizeSpec`. The port never shares prompt text, input
// shapes, output schemas or caching keys with the assessment or audit
// ports; only the Meta transport layer is shared. Key handling stays
// server-side (K-505, K-513).
import { err, ok } from "../domain/result.ts";
import type { Result } from "../domain/result.ts";
import type { PersonalizeSpec, PersonalizeSpecContext } from "../plugins/personalizeSpec.ts";
import type {
  CodeHash as CodeHashType,
  ModelId as ModelIdType,
  PromptVersion as PromptVersionType,
  RequestId as RequestIdType,
  Timestamp as TimestampType,
  BlockNumber as BlockNumberType,
} from "../domain/types.ts";

export type PluginPersonalizeProvider = "meta-model-api";

// One plugin's quoted reference data for the mapping call (P-27): the
// validated frontmatter tags plus capped excerpts of the `What it checks`
// and `Why it matters to you` sections, quoted through `UntrustedText`
// with per-item caps. Never raw markdown, never the full doc.
export type PersonalizePluginReference = {
  readonly pluginId: string;
  readonly tags: readonly string[];
  readonly severityMax: string;
  readonly quotedExcerpt: string;
};

// Closed, frozen mapping input: code hash, closed layout facts (present
// section ids, score band, severity counts, plugin outcomes), the quoted
// priorities text, and the quoted per-plugin references. Nothing else
// enters — in particular no finding text beyond quoted titles and no
// neighbouring page data.
export type PersonalizeInput = {
  readonly codeHash: CodeHashType;
  readonly scoreBand: "low" | "medium" | "high";
  readonly sectionIds: readonly string[];
  readonly pluginIds: readonly string[];
  readonly flooredSectionIds: readonly string[];
  readonly priorities: string;
  readonly plugins: readonly PersonalizePluginReference[];
  readonly promptVersion: PromptVersionType;
};

// Request size caps for the mapping call (P-27): per-excerpt and total
// input bounds mirror the audit path.
export const PERSONALIZE_MAX_EXCERPT_CHARS = 1000;
export const PERSONALIZE_MAX_INPUT_CHARS = 8192;
export const PERSONALIZE_MAX_PRIORITIES_CHARS = 500;

export const PersonalizeInput = {
  create(input: {
    readonly codeHash: CodeHashType;
    readonly scoreBand: "low" | "medium" | "high";
    readonly sectionIds: readonly string[];
    readonly pluginIds: readonly string[];
    readonly flooredSectionIds: readonly string[];
    readonly priorities: string;
    readonly plugins: readonly PersonalizePluginReference[];
    readonly promptVersion: PromptVersionType;
  }): Result<PersonalizeInput, { kind: "invalid-personalize-input"; message: string }> {
    if (input.sectionIds.length === 0 || input.sectionIds.length > 16) {
      return err({ kind: "invalid-personalize-input", message: "section list must hold 1 to 16 ids" });
    }
    if (input.pluginIds.length > 16) {
      return err({ kind: "invalid-personalize-input", message: "plugin list must hold at most 16 ids" });
    }
    if (input.priorities.length === 0 || input.priorities.length > PERSONALIZE_MAX_PRIORITIES_CHARS) {
      return err({ kind: "invalid-personalize-input", message: "priorities text must be 1 to 500 characters" });
    }
    let total = input.priorities.length;
    for (const plugin of input.plugins) {
      total += plugin.quotedExcerpt.length;
    }
    if (total > PERSONALIZE_MAX_INPUT_CHARS) {
      return err({ kind: "invalid-personalize-input", message: "personalize input exceeds the total size limit" });
    }
    return ok(
      Object.freeze({
        codeHash: input.codeHash,
        scoreBand: input.scoreBand,
        sectionIds: Object.freeze(input.sectionIds.slice()),
        pluginIds: Object.freeze(input.pluginIds.slice()),
        flooredSectionIds: Object.freeze(input.flooredSectionIds.slice()),
        priorities: input.priorities,
        plugins: Object.freeze(input.plugins.slice()),
        promptVersion: input.promptVersion,
      }),
    );
  },
};

// Error union per A-15, mirroring the audit port branches plus
// `not-configured` for the keyless run (P-27).
export type PluginPersonalizeModelError =
  | { kind: "timeout"; message: string }
  | { kind: "rate-limited"; message: string }
  | { kind: "invalid-output"; message: string }
  | { kind: "output-too-large"; message: string; limitChars: number }
  | { kind: "provider-mismatch"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "not-configured"; message: string };

export type PluginPersonalizeCallContext = {
  readonly requestId: RequestIdType;
  readonly deadline: TimestampType;
  readonly block: BlockNumberType | "latest";
};

export interface PluginPersonalizeModelPort {
  personalize(
    input: PersonalizeInput,
    ctx: PluginPersonalizeCallContext,
  ): Promise<Result<PersonalizeSpec, PluginPersonalizeModelError>>;
  provider(): PluginPersonalizeProvider;
  modelId(): ModelIdType;
}

// Spec types re-exported beside the port so adapters and the service
// import the contract from one module.
export type { PersonalizeSpec, PersonalizeSpecContext };
