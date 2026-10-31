// Investigation model input carries meanings beside ids (M-02e). A
// listed finding id means that detector FOUND the pattern: detector
// tools name what each returned id means, the user message pairs each
// id with its plugin id, kind, severity, direction, template sentence,
// temporality and labelled selectors, and the system prompt states the
// found, absent and never-contradict rules with the collected meanings
// beside the citation syntax. No network: the transport is an in-memory
// capture.
import { describe, expect, test } from "vitest";
import {
  MAX_MEANING_LINES_IN_PROMPT,
  buildInvestigateSystemPrompt,
  collectedIdsForPrompt,
  meaningLinesForPrompt,
} from "../../../src/adapters/investigation/investigateChatCompletions.ts";
import { hostedInvestigateAdapter } from "../../../src/adapters/investigation/hostedInvestigateAdapter.ts";
import {
  MAX_CATALOGUE_FINDINGS_PER_TOOL,
  buildInvestigationCatalogue,
} from "../../../src/application/investigateToken.ts";
import { meaningForEvidenceFinding } from "../../../src/domain/modelMeanings.ts";
import { MAX_MODEL_MEANINGS } from "../../../src/domain/modelMeanings.ts";
import { Bytecode, CodeHash, ModelId, RequestId, Timestamp } from "../../../src/domain/types.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { InvestigationModelInput } from "../../../src/ports/investigationModel.ts";
import type {
  InvestigationCallContext,
  InvestigationModelInput as InvestigationModelInputType,
} from "../../../src/ports/investigationModel.ts";
import type { Result } from "../../../src/domain/result.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const FAKE_KEY = "fake-key-for-tests-only";
const MODEL_ID = "meta-models/muse-spark-open-1026";
const BLACKLIST_TITLE = "Privileged caller can set a mapping entry that gates the transfer path";

function blacklistMeaning(): ReturnType<typeof meaningForEvidenceFinding> {
  return meaningForEvidenceFinding({
    id: "dev.brandklipparen.blacklist:blacklist",
    pluginId: "dev.brandklipparen.blacklist",
    title: BLACKLIST_TITLE,
    selectors: ["0xa9059cbb"],
  });
}

function inputWithMeanings(): InvestigationModelInputType {
  const code = mustOk(Bytecode.parse("0x6001600055"));
  const codeHash = mustOk(CodeHash.of(code));
  return mustOk(
    InvestigationModelInput.create({
      codeHash,
      scoreBand: "High",
      signalIds: ["sig-1"],
      tools: [{ toolId: "evidence.list", description: "list frozen evidence", argNames: [] }],
      trace: [
        {
          step: 1,
          toolId: "detector.dev.brandklipparen.blacklist",
          rationale: "Check the blacklist pattern.",
          evidenceIds: ["dev.brandklipparen.blacklist:blacklist"],
        },
      ],
      budgets: { stepsLeft: 7, tokensLeft: 4000, deadlineMs: 30000 },
      meanings: [blacklistMeaning()],
    }),
  );
}

function fixedContext(): InvestigationCallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest",
  };
}

function concludeEnvelope(): string {
  const inner = {
    provider: "hosted-open-weights",
    modelId: MODEL_ID,
    decision: {
      kind: "conclude",
      narrativeDraft: "The frozen evidence shows the finding. [E:dev.brandklipparen.blacklist:blacklist]",
      rationale: "Recorded rationale: conclude from the frozen evidence.",
    },
  };
  return JSON.stringify({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1700000000,
    model: MODEL_ID,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(inner) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

describe("m02e investigation model input", () => {
  test("m02e_detector_tool_descriptions_name_what_each_returned_id_means", () => {
    const catalogue = buildInvestigationCatalogue({
      detectors: [
        {
          pluginId: "dev.brandklipparen.blacklist",
          description: "Reports a transfer gate on a mapping entry.",
          findings: ["dev.brandklipparen.blacklist:blacklist"],
          findingTitles: { "dev.brandklipparen.blacklist:blacklist": BLACKLIST_TITLE },
        },
        {
          pluginId: "dev.brandklipparen.pause",
          description: "Reports a privileged pause flag.",
          findings: [],
        },
      ],
      evidenceIds: ["dev.brandklipparen.blacklist:blacklist"],
      summary: "score band High",
      docs: {},
    });
    const blacklist = catalogue.tools.find((tool) => tool.toolId === "detector.dev.brandklipparen.blacklist");
    expect(blacklist?.description).toContain("dev.brandklipparen.blacklist:blacklist");
    expect(blacklist?.description).toContain(BLACKLIST_TITLE);
    expect(blacklist?.description).toContain("FOUND the pattern");
    const pause = catalogue.tools.find((tool) => tool.toolId === "detector.dev.brandklipparen.pause");
    expect(pause?.description).toContain("found none of its patterns");
  });

  test("m02e_detector_tool_descriptions_cap_listed_findings", () => {
    const findings = Array.from({ length: MAX_CATALOGUE_FINDINGS_PER_TOOL + 5 }, (_, index) => `finding:${index}`);
    const titles: Record<string, string> = {};
    for (const id of findings) {
      titles[id] = `title for ${id}`;
    }
    const catalogue = buildInvestigationCatalogue({
      detectors: [
        {
          pluginId: "dev.brandklipparen.decompiler",
          description: "Reports decompiled functions.",
          findings,
          findingTitles: titles,
        },
      ],
      evidenceIds: findings,
      summary: "score band High",
      docs: {},
    });
    const tool = catalogue.tools.find((item) => item.toolId === "detector.dev.brandklipparen.decompiler");
    expect(tool?.description).toContain("title for finding:0");
    expect(tool?.description).toContain("+5 more");
  });

  test("m02e_investigate_prompt_states_found_absent_never_contradict_and_lists_meanings", () => {
    const prompt = buildInvestigateSystemPrompt({
      provider: "hosted-open-weights",
      modelId: mustOk(ModelId.parse(MODEL_ID)),
      stepsLeft: 7,
      concludeOnly: false,
      collectedIds: ["dev.brandklipparen.blacklist:blacklist"],
      meanings: [blacklistMeaning()],
    });
    expect(prompt).toContain("FOUND the pattern");
    expect(prompt).toContain("Absence of a finding id means the pattern was not found");
    expect(prompt).toContain("Never contradict a finding's stated meaning");
    expect(prompt).toContain("blacklist restriction on transfers was found");
    expect(prompt).toContain("Collected evidence meanings (what each id means):");
    expect(prompt).toContain("- [E:dev.brandklipparen.blacklist:blacklist]");
    expect(prompt).toContain(BLACKLIST_TITLE);
    expect(prompt).toContain("transfer(address,uint256)");
  });

  test("m02e_meaning_lines_follow_first_seen_trace_order_and_cap", () => {
    const code = mustOk(Bytecode.parse("0x6001600055"));
    const codeHash = mustOk(CodeHash.of(code));
    const meanings = [blacklistMeaning()];
    for (let index = 0; index < 25; index += 1) {
      meanings.push(
        meaningForEvidenceFinding({
          id: `dev.brandklipparen.decompiler:0x${index.toString(16).padStart(8, "0")}`,
          pluginId: "dev.brandklipparen.decompiler",
          title: `Decompiled function ${index}`,
          selectors: ["0x70a08231"],
        }),
      );
    }
    const input = mustOk(
      InvestigationModelInput.create({
        codeHash,
        scoreBand: "High",
        signalIds: ["sig-1"],
        tools: [{ toolId: "evidence.list", description: "list", argNames: [] }],
        trace: [
          {
            step: 1,
            toolId: "evidence.list",
            rationale: "List.",
            evidenceIds: meanings.map((meaning) => meaning.id),
          },
        ],
        budgets: { stepsLeft: 7, tokensLeft: 4000, deadlineMs: 30000 },
        meanings,
      }),
    );
    expect(collectedIdsForPrompt(input)[0]).toBe("dev.brandklipparen.blacklist:blacklist");
    const lines = meaningLinesForPrompt(input);
    expect(lines.length).toBeLessThanOrEqual(MAX_MEANING_LINES_IN_PROMPT);
    expect(lines[0]).toContain("dev.brandklipparen.blacklist:blacklist");
  });

  test("m02e_decide_posts_meanings_beside_ids_within_size_caps", async () => {
    const input = inputWithMeanings();
    const calls: Array<{ url: string; body: string }> = [];
    const adapter = new hostedInvestigateAdapter({
      endpoint: "https://api.example.invalid/v1/",
      apiKey: new SecretString(FAKE_KEY),
      modelId: mustOk(ModelId.parse(MODEL_ID)),
      transport: async (url, init) => {
        calls.push({ url, body: init.body });
        return { status: 200, bodyText: concludeEnvelope() };
      },
    });
    const result = await adapter.decide(input, fixedContext());
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]?.body ?? "") as Record<string, unknown>;
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    const system = messages[0]?.content ?? "";
    expect(system).toContain("FOUND the pattern");
    expect(system).toContain("- [E:dev.brandklipparen.blacklist:blacklist]");
    const user = JSON.parse(messages[1]?.content ?? "") as {
      meanings: Array<{
        id: string;
        pluginId: string;
        kind: string;
        severity: string | null;
        direction: string | null;
        meaning: string;
        selectors: Array<{ selector: string; name: string | null }>;
      }>;
    };
    expect(user.meanings.length).toBeLessThanOrEqual(MAX_MODEL_MEANINGS);
    const blacklist = user.meanings.find((meaning) => meaning.id === "dev.brandklipparen.blacklist:blacklist");
    expect(blacklist?.pluginId).toBe("dev.brandklipparen.blacklist");
    expect(blacklist?.meaning).toBe(BLACKLIST_TITLE);
    expect(blacklist?.selectors).toContainEqual({ selector: "0xa9059cbb", name: "transfer(address,uint256)" });
  });
});
