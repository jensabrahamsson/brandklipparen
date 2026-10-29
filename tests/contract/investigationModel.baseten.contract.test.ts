// Contract check for the hosted investigation adapter over a recorded
// transport (S-073, K-036, K-520, K-513). No test reaches the network:
// each scenario replays a canned HTTP response. A missing key binds the
// not-configured adapter with zero sends and the analysis standing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ModelId } from "../../src/domain/types.ts";
import { SecretString } from "../../src/ports/config.ts";
import {
  runInvestigationModelPortContract,
  investigationModelId,
} from "./investigationModel.contract.ts";
import type { InvestigationContractScenario } from "./investigationModel.contract.ts";
import {
  hostedInvestigateAdapter,
  createhostedInvestigateAdapterFromConfig,
} from "../../src/adapters/investigation/hostedInvestigateAdapter.ts";
import type { hostedInvestigateTransport } from "../../src/adapters/investigation/hostedInvestigateAdapter.ts";

function mustModelId(): ModelId {
  const parsed = ModelId.parse(investigationModelId());
  if (!parsed.ok) {
    throw new Error(`test model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "investigation");

// Every recorded body is a standard chat-completions envelope: the
// decision travels as `choices[0].message.content`. File fixtures carry
// the success shapes; error envelopes are built inline.
function envelopeFor(inner: string): string {
  return JSON.stringify({
    id: "chatcmpl-recorded-1",
    object: "chat.completion",
    created: 1700000000,
    model: investigationModelId(),
    choices: [{ index: 0, message: { role: "assistant", content: inner }, finish_reason: "stop" }],
    usage: { prompt_tokens: 200, completion_tokens: 60, total_tokens: 260 },
  });
}

function recordedTransport(scenario: InvestigationContractScenario): hostedInvestigateTransport {
  return async () => {
    switch (scenario) {
      case "run-tool":
        return { status: 200, bodyText: readFileSync(join(fixtureDir, "run-tool.json"), "utf8") };
      case "conclude":
        return { status: 200, bodyText: readFileSync(join(fixtureDir, "conclude.json"), "utf8") };
      case "timeout":
        return new Promise<never>(() => {});
      case "rate-limited":
        return { status: 429, bodyText: "limited" };
      case "invalid-output":
        return { status: 200, bodyText: "not json {" };
      case "output-too-large":
        return { status: 200, bodyText: readFileSync(join(fixtureDir, "oversized.json"), "utf8") };
      case "unavailable":
        return { status: 503, bodyText: "down" };
      case "provider-mismatch":
        return {
          status: 200,
          bodyText: envelopeFor(
            JSON.stringify({
              provider: "meta-model-api",
              modelId: investigationModelId(),
              decision: { kind: "conclude", narrativeDraft: "Wrong provider. [E:sig-1]" },
            }),
          ),
        };
    }
  };
}

describe("hosted investigation adapter", () => {
  runInvestigationModelPortContract("hosted-recorded", (scenario: InvestigationContractScenario) => {
    return new hostedInvestigateAdapter({
      endpoint: "https://api.example.test",
      apiKey: new SecretString("test-key"),
      modelId: mustModelId(),
      timeoutMs: scenario === "timeout" ? 5 : 1000,
      transport: recordedTransport(scenario),
    });
  });

  test("k520_investigation_without_key_reports_not_configured_and_sends_nothing", async () => {
    let sends = 0;
    const counting: hostedInvestigateTransport = async () => {
      sends += 1;
      return { status: 200, bodyText: "{}" };
    };
    const built = createhostedInvestigateAdapterFromConfig(
      {
        investigatehostedBaseUrl: undefined,
        investigatehostedApiKey: undefined,
        investigatehostedModelId: undefined,
      },
      counting,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const { CodeHash, Bytecode } = await import("../../src/domain/types.ts");
    const { InvestigationModelInput } = await import("../../src/ports/investigationModel.ts");
    const okOf = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
      if (!result.ok) {
        throw new Error(`expected ok: ${result.error.message}`);
      }
      return result.value;
    };
    const code = okOf(Bytecode.parse("0x6001600055"));
    const input = okOf(
      InvestigationModelInput.create({
        codeHash: okOf(CodeHash.of(code)),
        scoreBand: "High",
        signalIds: ["sig-1"],
        tools: [{ toolId: "evidence.list", description: "list", argNames: [] }],
        trace: [],
        budgets: { stepsLeft: 8, tokensLeft: 4000, deadlineMs: 30000 },
      }),
    );
    const { RequestId, Timestamp } = await import("../../src/domain/types.ts");
    const result = await built.value.decide(input, {
      requestId: okOf(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: okOf(Timestamp.of(1761446400000)),
      block: "latest",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe("not-configured");
    expect(sends).toBe(0);
  });
});
