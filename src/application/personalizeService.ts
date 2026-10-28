// Experimental AI personalize service (S-069, K-519, P-27). One mapping
// call per uncached request over the frozen analysis: the service quotes
// the visitor's priorities and the per-plugin frontmatter references,
// calls the single `PluginPersonalizeModelPort` adapter, validates the
// envelope, and caches the spec per (code hash, prompt version, provider,
// model id, salted priorities hash) — never per raw priorities text, so
// one visitor's layout is never served to another visitor. Errors map to
// typed outcomes; the deterministic baseline always stands.
import { keccak256HexOfUtf8 } from "../domain/types.ts";
import type { Signal } from "../domain/signals.ts";
import { parsePersonalizeSpec } from "../plugins/personalizeSpec.ts";
import type { PersonalizeSpec } from "../plugins/personalizeSpec.ts";
import { PersonalizeInput } from "../ports/pluginPersonalizeModel.ts";
import type {
  PluginPersonalizeCallContext,
  PluginPersonalizeModelError,
  PluginPersonalizeModelPort,
} from "../ports/pluginPersonalizeModel.ts";
import type {
  CodeHash as CodeHashType,
  PromptVersion as PromptVersionType,
} from "../domain/types.ts";
import { canonicalSerialize } from "../domain/serialize.ts";
import type { OverlayBudget } from "./overlayBudget.ts";


// Floored sections derived from the envelope (P-26): `summary` and
// `score` always, plus `signals` whenever a signal raises risk and
// `signals` beside `evidence` whenever a high-severity signal is present.
// Specs collapsing a floored section are rejected, so an AI layout (or
// injected priorities steering it) can never bury a high finding. The
// server and the web client compute the same set from the same envelope.
export function requiredFlooredSections(signals: readonly Signal[]): readonly string[] {
  let raises = false;
  let high = false;
  for (const signal of signals) {
    if (signal.kind === "hard-to-analyze") {
      raises = true;
      continue;
    }
    if (signal.direction === "raises") {
      raises = true;
    }
    if (signal.severity === "high") {
      high = true;
    }
  }
  const floored = ["summary", "score"];
  if (raises || high) {
    floored.push("signals");
  }
  if (high) {
    floored.push("evidence");
  }
  return Object.freeze(floored);
}

export type PersonalizeCacheKeyParts = {
  readonly codeHash: CodeHashType;
  readonly promptVersion: PromptVersionType;
  readonly provider: string;
  readonly modelId: string;
  readonly prioritiesHash: string;
};

export function personalizeCacheKeyOf(parts: PersonalizeCacheKeyParts): string {
  return canonicalSerialize({
    codeHash: parts.codeHash as string,
    modelId: parts.modelId,
    prioritiesHash: parts.prioritiesHash,
    promptVersion: parts.promptVersion as string,
    provider: parts.provider,
  });
}

// Salted hash of the normalised priorities text for the cache key (K-519):
// the raw text is never stored or keyed on directly, while different
// priorities never share a cached spec. Normalisation trims the text and
// collapses inner whitespace, so immaterial keying differences do not
// cause redundant adapter calls.
export function prioritiesHashOf(priorities: string): string {
  const normalised = priorities.trim().replace(/\s+/g, " ");
  return keccak256HexOfUtf8(`brandklipparen-personalize-priorities-v1:${normalised}`);
}

export type PersonalizeCacheStore = {
  get(key: string): PersonalizeSpec | null;
  set(key: string, spec: PersonalizeSpec): void;
};

export function createInMemoryPersonalizeCache(): PersonalizeCacheStore {
  const store = new Map<string, PersonalizeSpec>();
  return {
    get: (key: string) => store.get(key) ?? null,
    set: (key: string, spec: PersonalizeSpec) => {
      if (store.size < 256) {
        store.set(key, spec);
      }
    },
  };
}

export type PersonalizePluginReferenceInput = {
  readonly pluginId: string;
  readonly tags: readonly string[];
  readonly severityMax: string;
  readonly quotedExcerpt: string;
};

export type PersonalizeRequestInput = {
  readonly codeHash: CodeHashType;
  readonly scoreBand: "low" | "medium" | "high";
  readonly sectionIds: readonly string[];
  readonly pluginIds: readonly string[];
  readonly flooredSectionIds: readonly string[];
  readonly priorities: string;
  readonly plugins: readonly PersonalizePluginReferenceInput[];
  readonly promptVersion: PromptVersionType;
};

export type PersonalizeOutcome =
  | {
      readonly kind: "ok";
      readonly spec: PersonalizeSpec;
      readonly provider: string;
      readonly modelId: string;
      readonly promptVersion: string;
      readonly cache: "hit" | "miss";
    }
  | { readonly kind: "error"; readonly error: PluginPersonalizeModelError["kind"]; readonly message: string };

export type PersonalizeServiceDeps = {
  readonly adapter: PluginPersonalizeModelPort;
  readonly cache?: PersonalizeCacheStore | undefined;
  readonly budget?: OverlayBudget | undefined;
};

export type PersonalizeService = {
  readonly provider: string;
  readonly modelId: string;
  requestPersonalize(
    input: PersonalizeRequestInput,
    ctx: PluginPersonalizeCallContext,
    keyId?: string | undefined,
  ): Promise<PersonalizeOutcome>;
};

export function createPersonalizeService(deps: PersonalizeServiceDeps): PersonalizeService {
  const cache = deps.cache ?? createInMemoryPersonalizeCache();
  return {
    provider: deps.adapter.provider(),
    modelId: deps.adapter.modelId() as string,
    async requestPersonalize(
      input: PersonalizeRequestInput,
      ctx: PluginPersonalizeCallContext,
      keyId?: string | undefined,
    ): Promise<PersonalizeOutcome> {
      const budget = deps.budget;
      const built = PersonalizeInput.create(input);
      if (!built.ok) {
        return { kind: "error", error: "invalid-output", message: built.error.message };
      }
      const adapter = deps.adapter;
      const key = personalizeCacheKeyOf({
        codeHash: built.value.codeHash,
        promptVersion: built.value.promptVersion,
        provider: adapter.provider(),
        modelId: adapter.modelId() as string,
        prioritiesHash: prioritiesHashOf(built.value.priorities),
      });
      const cached = cache.get(key);
      if (cached !== null) {
        const rechecked = parsePersonalizeSpec(JSON.parse(JSON.stringify(cached)) as unknown, {
          sectionIds: built.value.sectionIds,
          pluginIds: built.value.pluginIds,
          flooredSectionIds: built.value.flooredSectionIds,
          maxPlacements: 16,
          maxRanking: 16,
        });
        if (rechecked.ok) {
          return {
            kind: "ok",
            spec: cached,
            provider: adapter.provider(),
            modelId: adapter.modelId() as string,
            promptVersion: built.value.promptVersion as string,
            cache: "hit",
          };
        }
      }
      // The input cache above already served repeats for zero cost; the
      // budget gates the provider call itself per key and day (S-106).
      if (budget !== undefined && keyId !== undefined && !budget.trySpend(keyId)) {
        return {
          kind: "error",
          error: "rate-limited",
          message: "personalize daily cost cap reached for this key",
        };
      }
      const result = await adapter.personalize(built.value, ctx);
      if (!result.ok) {
        return { kind: "error", error: result.error.kind, message: result.error.message };
      }
      cache.set(key, result.value);
      return {
        kind: "ok",
        spec: result.value,
        provider: adapter.provider(),
        modelId: adapter.modelId() as string,
        promptVersion: built.value.promptVersion as string,
        cache: "miss",
      };
    },
  };
}

export function serializePersonalizeOutcome(outcome: PersonalizeOutcome): string {
  if (outcome.kind === "error") {
    return canonicalSerialize({ error: outcome.error, kind: "error", message: outcome.message });
  }
  return canonicalSerialize({
    cache: outcome.cache,
    kind: "ok",
    modelId: outcome.modelId,
    promptVersion: outcome.promptVersion,
    provider: outcome.provider,
    spec: outcome.spec as never,
  });
}
