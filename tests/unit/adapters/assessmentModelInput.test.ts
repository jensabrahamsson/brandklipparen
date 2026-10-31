// Assessment model input carries meanings beside ids (M-02e). A listed
// finding id means that detector FOUND the pattern: every entry names
// the known canonical signature beside the selector, and the meanings
// list pairs each id with its plugin id, kind, severity, direction,
// template sentence, temporality and labelled selectors. Unknown
// selectors stay the raw selector with a null name. No network: the
// transport is an in-memory capture.
import { describe, expect, test } from "vitest";
import {
  ChatCompletionsAdapter,
  DEFAULT_CHAT_COMPLETIONS_MAX_BYTES_IN,
  buildAssessmentSystemPrompt,
} from "../../../src/adapters/assessment/chatCompletions/chatCompletionsAdapter.ts";
import { Evidence } from "../../../src/domain/evidence.ts";
import { meaningForEvidenceFinding } from "../../../src/domain/modelMeanings.ts";
import { MAX_MODEL_MEANINGS } from "../../../src/domain/modelMeanings.ts";
import { Bytecode, CodeHash, ModelId, PromptVersion, RequestId, Selector, SignalId, Timestamp } from "../../../src/domain/types.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { EvidenceList } from "../../../src/ports/assessmentModel.ts";
import type { CallContext, EvidenceList as EvidenceListType } from "../../../src/ports/assessmentModel.ts";
import type { PromptVersion as PromptVersionType } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const FAKE_KEY = "fake-key-for-tests-only";

function fixedContext(): CallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest",
  };
}

function fixedPrompt(): PromptVersionType {
  return mustOk(PromptVersion.parse("1.0.0"));
}

function requestWithMeanings(): EvidenceListType {
  const code = mustOk(Bytecode.parse("0x6001600055"));
  const codeHash = mustOk(CodeHash.of(code));
  const known = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x18160ddd")) }));
  const unknown = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0xdeadbeef")) }));
  return mustOk(
    EvidenceList.create(
      codeHash,
      [known, unknown],
      [
        meaningForEvidenceFinding({
          id: "dev.brandklipparen.blacklist:blacklist",
          pluginId: "dev.brandklipparen.blacklist",
          title: "Privileged caller can set a mapping entry that gates the transfer path",
          selectors: ["0x18160ddd"],
        }),
      ],
    ),
  );
}

function successEnvelope(model: string, link: string): string {
  const inner = {
    provider: "meta-model-api",
    modelId: model,
    promptVersion: "1.0.0",
    explanationVersion: "1.0.0",
    text: "Recorded assessment text for tests only.",
    claims: [
      {
        text: "Recorded claim linked to the request evidence.",
        signalLinks: [link],
        temporality: { kind: "can-change-unknown" },
      },
    ],
  };
  return JSON.stringify({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(inner) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

describe("m02e assessment model input", () => {
  test("m02e_entries_name_known_selectors_and_meanings_state_the_finding", async () => {
    const model = "meta-muse-spark-test-1";
    const evidence = requestWithMeanings();
    const link = mustOk(SignalId.of(evidence.codeHash, mustOk(Selector.parse("0x18160ddd")))) as string;
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = new ChatCompletionsAdapter({
      endpoint: "https://meta-api.example.invalid",
      apiKey: new SecretString(FAKE_KEY),
      modelId: mustOk(ModelId.parse(model)),
      provider: "meta-model-api",
      transport: async (url, init) => {
        calls.push({ url, body: init.body });
        return { status: 200, bodyText: successEnvelope(model, link) };
      },
      onWarn: () => undefined,
    });
    const result = await adapter.assess(evidence, fixedPrompt(), fixedContext());
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]?.body ?? "") as Record<string, unknown>;
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    const user = JSON.parse(messages[1]?.content ?? "") as {
      codeHash: string;
      entries: Array<{ selector: string; name: string | null; signalId?: string }>;
      meanings: Array<{
        id: string;
        pluginId: string;
        kind: string;
        severity: string | null;
        direction: string | null;
        meaning: string;
        temporality: string;
        selectors: Array<{ selector: string; name: string | null }>;
      }>;
    };
    const bySelector = new Map(user.entries.map((entry) => [entry.selector, entry]));
    expect(bySelector.get("0x18160ddd")?.name).toBe("totalSupply()");
    expect(bySelector.get("0xdeadbeef")?.name).toBe(null);
    expect(bySelector.get("0x18160ddd")?.signalId).toBe(link);
    const blacklist = user.meanings.find((meaning) => meaning.id === "dev.brandklipparen.blacklist:blacklist");
    expect(blacklist?.pluginId).toBe("dev.brandklipparen.blacklist");
    expect(blacklist?.meaning).toBe("Privileged caller can set a mapping entry that gates the transfer path");
    expect(blacklist?.selectors).toContainEqual({ selector: "0x18160ddd", name: "totalSupply()" });
    expect(user.meanings.length).toBeLessThanOrEqual(MAX_MODEL_MEANINGS);
    expect(new TextEncoder().encode(calls[0]?.body ?? "").length).toBeLessThanOrEqual(
      DEFAULT_CHAT_COMPLETIONS_MAX_BYTES_IN,
    );
  });

  test("m02e_assessment_prompt_states_found_absent_and_never_contradict", () => {
    const prompt = buildAssessmentSystemPrompt({
      provider: "meta-model-api",
      modelId: mustOk(ModelId.parse("meta-muse-spark-test-1")),
      promptVersion: fixedPrompt(),
    });
    expect(prompt).toContain("FOUND the pattern");
    expect(prompt).toContain("Absence of a finding id means the pattern was not found");
    expect(prompt).toContain("Never contradict a finding's stated meaning");
  });
});
