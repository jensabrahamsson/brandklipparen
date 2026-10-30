// Recorded-fixture proof for the mapping-output robustness (brief 42,
// S-069, P-27): the system prompt states the exact required JSON shape
// with a minimal example built from the request's own ids, harmless
// wrapping (a JSON fence, leading or trailing whitespace) validates,
// and the warn line names the failure with a fixed check constant that
// never carries model text — while unknown ids, floors and extra fields
// still fail validation. No test reaches the network.
import { describe, expect, test } from "vitest";
import { ModelId } from "../../../src/domain/types.ts";
import { Bytecode, CodeHash, PromptVersion, RequestId, Timestamp } from "../../../src/domain/types.ts";
import { SecretString } from "../../../src/ports/config.ts";
import type { Result } from "../../../src/domain/result.ts";
import { PersonalizeInput } from "../../../src/ports/pluginPersonalizeModel.ts";
import type {
  PersonalizeInput as PersonalizeInputValue,
  PluginPersonalizeCallContext,
  PluginPersonalizeModelPort,
  PluginPersonalizeProvider,
} from "../../../src/ports/pluginPersonalizeModel.ts";
import { GenericCompatiblePersonalizeAdapter } from "../../../src/adapters/personalize/GenericCompatiblePersonalizeAdapter.ts";
import type { GenericCompatiblePersonalizeTransport } from "../../../src/adapters/personalize/GenericCompatiblePersonalizeAdapter.ts";
import { MetaModelApiPersonalizeAdapter } from "../../../src/adapters/personalize/metaModelApiPersonalizeAdapter.ts";
import type { MetaModelApiPersonalizeTransport } from "../../../src/adapters/personalize/metaModelApiPersonalizeAdapter.ts";

type ChatTransport = (url: string, init: { body: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; bodyText: string }>;

const PROVIDERS: readonly { provider: PluginPersonalizeProvider; modelId: string; endpoint: string }[] = [
  { provider: "generic-compatible", modelId: "compat-robust-model-1", endpoint: "https://compat.example.invalid" },
  { provider: "meta-model-api", modelId: "meta-robust-model-1", endpoint: "https://meta.example.invalid" },
];

function mustModelId(raw: string): ModelId {
  const parsed = ModelId.parse(raw);
  if (!parsed.ok) {
    throw new Error(`test model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function fixedInput(): PersonalizeInputValue {
  const bytecode = mustOk(Bytecode.parse(`0x6080604052348015600f${"00".repeat(8)}`));
  return mustOk(
    PersonalizeInput.create({
      codeHash: mustOk(CodeHash.of(bytecode)),
      scoreBand: "medium",
      sectionIds: ["summary", "score", "signals"],
      pluginIds: ["dev.brandklipparen.capability", "dev.brandklipparen.clone-match"],
      flooredSectionIds: ["summary", "score"],
      priorities: "quux-priority-9: keep the score visible",
      plugins: [],
      promptVersion: mustOk(PromptVersion.parse("1.0.0")),
    }),
  );
}

function fixedContext(): PluginPersonalizeCallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest",
  };
}

function envelopeText(provider: string, modelId: string, spec: unknown): string {
  return JSON.stringify({ provider, modelId, spec });
}

function chatBody(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content, role: "assistant" }, finish_reason: "stop" }],
  });
}

function validSpec(): Record<string, unknown> {
  return {
    specVersion: 1,
    pluginRanking: ["dev.brandklipparen.clone-match"],
    placements: [
      { sectionId: "summary", emphasis: "normal" },
      { sectionId: "score", emphasis: "normal" },
      { sectionId: "signals", emphasis: "high" },
    ],
  };
}

function runAdapter(options: {
  provider: PluginPersonalizeProvider;
  modelId: string;
  endpoint: string;
  content: string;
  warns: string[];
  bodies: string[];
}): Promise<Result<import("../../../src/plugins/personalizeSpec.ts").PersonalizeSpec, { kind: string; message: string }>> {
  const transport: ChatTransport = async (_url, init) => {
    options.bodies.push(init.body);
    return { status: 200, bodyText: chatBody(options.content) };
  };
  const onWarn = (line: string): void => {
    options.warns.push(line);
  };
  let adapter: PluginPersonalizeModelPort;
  if (options.provider === "meta-model-api") {
    adapter = new MetaModelApiPersonalizeAdapter({
      endpoint: options.endpoint,
      apiKey: new SecretString("test-personalize-key-only"),
      modelId: mustModelId(options.modelId),
      timeoutMs: 5000,
      transport: transport as MetaModelApiPersonalizeTransport,
      onWarn,
    });
  } else {
    adapter = new GenericCompatiblePersonalizeAdapter({
      endpoint: options.endpoint,
      apiKey: new SecretString("test-personalize-key-only"),
      modelId: mustModelId(options.modelId),
      timeoutMs: 5000,
      transport: transport as GenericCompatiblePersonalizeTransport,
      onWarn,
    });
  }
  return adapter.personalize(fixedInput(), fixedContext()) as Promise<
    Result<import("../../../src/plugins/personalizeSpec.ts").PersonalizeSpec, { kind: string; message: string }>
  >;
}

const WARN_LINE = /^personalize request failed kind=invalid-output status=200 stage=(extraction|validation) path=[\w.[\]]+ check=[a-z-]+$/;

describe("personalize mapping robustness over recorded transports", () => {
  for (const { provider, modelId, endpoint } of PROVIDERS) {
    test(`${provider}: the prompt states the exact shape with this request's ids`, async () => {
      const warns: string[] = [];
      const bodies: string[] = [];
      const result = await runAdapter({
        provider,
        modelId,
        endpoint,
        content: envelopeText(provider, modelId, validSpec()),
        warns,
        bodies,
      });
      expect(result.ok).toBe(true);
      expect(bodies.length).toBe(1);
      const sent = JSON.parse(bodies[0] ?? "{}") as { messages?: { content?: unknown }[] };
      const system = String(sent.messages?.[0]?.content ?? "");
      expect(system).toContain('"provider"');
      expect(system).toContain(`"${provider}"`);
      expect(system).toContain('"specVersion"');
      expect(system).toContain('"pluginRanking"');
      expect(system).toContain('"placements"');
      expect(system).toContain("Minimal example");
      // The example is literal ids from this request's closed lists.
      expect(system).toContain("dev.brandklipparen.capability");
      expect(system).toContain('"summary"');
      expect(system).toContain('"score"');
      // Quoted visitor data stays in the user message, never in the prompt.
      expect(system).not.toContain("quux-priority-9");
      const user = JSON.parse(String(sent.messages?.[1]?.content ?? "{}")) as {
        priorities?: unknown;
      };
      expect(user.priorities).toBe("quux-priority-9: keep the score visible");
    });

    test(`${provider}: a fenced or padded payload still validates`, async () => {
      for (const content of [
        `Here is the mapping:\n\`\`\`json\n${envelopeText(provider, modelId, validSpec())}\n\`\`\`\nDone.`,
        `\n  ${envelopeText(provider, modelId, validSpec())}  \n`,
      ]) {
        const warns: string[] = [];
        const bodies: string[] = [];
        const result = await runAdapter({ provider, modelId, endpoint, content, warns, bodies });
        expect(result.ok).toBe(true);
        expect(warns).toEqual([]);
      }
    });

    test(`${provider}: invalid output names a fixed check and never model text`, async () => {
      const cases: { name: string; content: string; check: string; kind: string }[] = [
        { name: "not-json", content: "not json {", check: "check=not-json", kind: "invalid-output" },
        {
          name: "provider-echo",
          content: envelopeText("hosted-open-weights", "other-model-quux-9", validSpec()),
          check: "check=provider-echo",
          kind: "provider-mismatch",
        },
        {
          name: "unknown-plugin",
          content: envelopeText(provider, modelId, {
            ...validSpec(),
            pluginRanking: ["dev.brandklipparen.absent-quux-7"],
          }),
          check: "check=unknown-plugin",
          kind: "invalid-output",
        },
        {
          name: "unknown-section",
          content: envelopeText(provider, modelId, {
            ...validSpec(),
            placements: [
              { sectionId: "quux-section-7", emphasis: "normal" },
              { sectionId: "summary", emphasis: "normal" },
              { sectionId: "score", emphasis: "normal" },
            ],
          }),
          check: "check=unknown-section",
          kind: "invalid-output",
        },
        {
          name: "floor-violated",
          content: envelopeText(provider, modelId, {
            ...validSpec(),
            placements: [
              { sectionId: "summary", emphasis: "normal", collapsed: true },
              { sectionId: "score", emphasis: "normal" },
            ],
          }),
          check: "check=floor-violated",
          kind: "invalid-output",
        },
        {
          name: "missing-summary",
          content: envelopeText(provider, modelId, {
            ...validSpec(),
            placements: [{ sectionId: "signals", emphasis: "high" }],
          }),
          check: "check=floor-violated",
          kind: "invalid-output",
        },
        {
          name: "missing-field",
          content: envelopeText(provider, modelId, { specVersion: 1, pluginRanking: [] }),
          check: "check=missing-field",
          kind: "invalid-output",
        },
        {
          name: "unknown-field",
          content: envelopeText(provider, modelId, { ...validSpec(), style: "dark-quux-7" }),
          check: "check=unknown-field",
          kind: "invalid-output",
        },
      ];
      for (const { name, content, check, kind } of cases) {
        const warns: string[] = [];
        const bodies: string[] = [];
        const result = await runAdapter({ provider, modelId, endpoint, content, warns, bodies });
        expect(result.ok, name).toBe(false);
        if (result.ok) {
          continue;
        }
        expect(result.error.kind, name).toBe(kind);
        expect(warns.length, name).toBe(1);
        expect(warns[0], name).toContain(check);
        expect(warns[0], name).toMatch(WARN_LINE);
        // Model-derived text (ids, tokens, field values) never reaches the warn line.
        expect(warns[0], name).not.toContain("quux");
      }
    });
  }
});
