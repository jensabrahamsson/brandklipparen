// Experimental AI personalize service (S-069, K-519, P-27). One mapping
// call per uncached request over the frozen analysis: the service quotes
// the visitor's priorities and the per-plugin frontmatter references,
// calls the single `PluginPersonalizeModelPort` adapter, validates the
// envelope, and caches the spec per (code hash, prompt version, provider,
// model id) — never per priorities text. Errors map to typed outcomes;
// the deterministic baseline always stands.
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

export type PersonalizeCacheKeyParts = {
  readonly codeHash: CodeHashType;
  readonly promptVersion: PromptVersionType;
  readonly provider: string;
  readonly modelId: string;
};

export function personalizeCacheKeyOf(parts: PersonalizeCacheKeyParts): string {
  return canonicalSerialize({
    codeHash: parts.codeHash as string,
    modelId: parts.modelId,
    promptVersion: parts.promptVersion as string,
    provider: parts.provider,
  });
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
};

export type PersonalizeService = {
  readonly provider: string;
  readonly modelId: string;
  requestPersonalize(input: PersonalizeRequestInput, ctx: PluginPersonalizeCallContext): Promise<PersonalizeOutcome>;
};

export function createPersonalizeService(deps: PersonalizeServiceDeps): PersonalizeService {
  const cache = deps.cache ?? createInMemoryPersonalizeCache();
  return {
    provider: deps.adapter.provider(),
    modelId: deps.adapter.modelId() as string,
    async requestPersonalize(
      input: PersonalizeRequestInput,
      ctx: PluginPersonalizeCallContext,
    ): Promise<PersonalizeOutcome> {
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
