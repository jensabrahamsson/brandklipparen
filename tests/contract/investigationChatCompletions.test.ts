// Outgoing chat-completions shape for the investigation adapter (S-073,
// K-036, K-520). Written first per A-21 (red): every decide call must
// POST a standard chat-completions body (model, system + user messages,
// max_tokens, temperature only, plus an opt-in reasoning_effort on the
// Meta reasoning binding) to `<base>/chat/completions`, and must
// read the decision from `choices[0].message.content`. No live calls, no
// real keys: the transport is an in-memory capture.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash, ModelId, RequestId, Timestamp } from "../../src/domain/types.ts";
import { SecretString } from "../../src/ports/config.ts";
import { InvestigationModelInput } from "../../src/ports/investigationModel.ts";
import type {
  InvestigationCallContext,
  InvestigationModelInput as InvestigationModelInputType,
} from "../../src/ports/investigationModel.ts";
import type { Result } from "../../src/domain/result.ts";
import { MetaModelApiInvestigateAdapter } from "../../src/adapters/investigation/metaModelApiInvestigateAdapter.ts";
import type { MetaInvestigateTransportResponse } from "../../src/adapters/investigation/metaModelApiInvestigateAdapter.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const FAKE_KEY = "fake-key-for-tests-only";
const MODEL_ID = "meta-models/muse-spark-open-1026";

function fixedInput(): InvestigationModelInputType {
  const code = mustOk(Bytecode.parse("0x6001600055"));
  const codeHash = mustOk(CodeHash.of(code));
  return mustOk(
    InvestigationModelInput.create({
      codeHash,
      scoreBand: "High",
      signalIds: ["sig-1", "sig-2"],
      tools: [
        { toolId: "evidence.list", description: "list frozen evidence", argNames: [] },
        { toolId: "detector.capability", description: "re-run capability detector", argNames: [] },
      ],
      trace: [],
      budgets: { stepsLeft: 8, tokensLeft: 4000, deadlineMs: 30000 },
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

type CapturedCall = { url: string; body: string; headers: Record<string, string> };

function captureTransport(response: MetaInvestigateTransportResponse): {
  calls: CapturedCall[];
  transport: (
    url: string,
    init: { body: string; headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<MetaInvestigateTransportResponse>;
} {
  const calls: CapturedCall[] = [];
  return {
    calls,
    transport: async (url, init) => {
      calls.push({ url, body: init.body, headers: { ...init.headers } });
      return response;
    },
  };
}

function envelopeFor(inner: unknown): string {
  return JSON.stringify({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1700000000,
    model: MODEL_ID,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(inner) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

function concludeInner(): unknown {
  return {
    provider: "meta-model-api",
    modelId: MODEL_ID,
    decision: {
      kind: "conclude",
      narrativeDraft: "Recorded draft citing frozen evidence. [E:sig-1]",
      rationale: "Recorded rationale: conclude from the frozen evidence.",
    },
  };
}

function makeAdapter(
  transport: ReturnType<typeof captureTransport>["transport"],
  endpoint = "https://api.example.invalid/v1/",
): MetaModelApiInvestigateAdapter {
  return new MetaModelApiInvestigateAdapter({
    endpoint,
    apiKey: new SecretString(FAKE_KEY),
    modelId: mustOk(ModelId.parse(MODEL_ID)),
    transport,
  });
}

describe("investigation chat-completions request shape", () => {
  test("decide posts a standard body to <base>/chat/completions", async () => {
    const input = fixedInput();
    const captured = captureTransport({ status: 200, bodyText: envelopeFor(concludeInner()) });
    const result = await makeAdapter(captured.transport).decide(input, fixedContext());
    expect(result.ok).toBe(true);
    expect(captured.calls.length).toBe(1);
    const call = captured.calls[0];
    if (call === undefined) {
      throw new Error("expected one outgoing call");
    }
    expect(call.url).toBe("https://api.example.invalid/v1/chat/completions");
    expect(call.headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(call.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body["model"]).toBe(MODEL_ID);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "reasoning_effort", "temperature"]);
    expect(body["max_tokens"]).toBe(8192);
    expect(body["temperature"]).toBe(0);
    expect(body["reasoning_effort"]).toBe("low");
    expect("top_p" in body).toBe(false);
    expect("codeHash" in body).toBe(false);
    expect("tools" in body).toBe(false);
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    expect(messages[0]?.content ?? "").toContain("untrusted");
    const user = JSON.parse(messages[1]?.content ?? "") as {
      codeHash: string;
      scoreBand: string;
      signalIds: string[];
    };
    expect(user.codeHash).toBe(input.codeHash as string);
    expect(user.scoreBand).toBe("High");
    expect(user.signalIds).toEqual(["sig-1", "sig-2"]);
    expect(call.url).not.toContain(FAKE_KEY);
    expect(call.body).not.toContain(FAKE_KEY);
  });

  test("fenced JSON content parses to a valid decision", async () => {
    const inner = JSON.stringify(concludeInner());
    const captured = captureTransport({
      status: 200,
      bodyText: JSON.stringify({
        id: "chatcmpl-test-2",
        object: "chat.completion",
        created: 1700000000,
        model: MODEL_ID,
        choices: [
          { index: 0, message: { role: "assistant", content: "```json\n" + inner + "\n```" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    });
    const result = await makeAdapter(captured.transport).decide(fixedInput(), fixedContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("conclude");
    }
  });

  test("envelope failures map to typed errors", async () => {
    const inner = JSON.stringify(concludeInner());
    const cases: Array<{ name: string; bodyText: string; status: number; kind: string }> = [
      {
        name: "empty choices",
        status: 200,
        bodyText: JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: MODEL_ID, choices: [] }),
        kind: "invalid-output",
      },
      {
        name: "non-JSON content",
        status: 200,
        bodyText: JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: MODEL_ID,
          choices: [{ index: 0, message: { role: "assistant", content: "not json {" }, finish_reason: "stop" }],
        }),
        kind: "invalid-output",
      },
      {
        name: "schema-invalid content",
        status: 200,
        bodyText: JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: MODEL_ID,
          choices: [{ index: 0, message: { role: "assistant", content: "{\"decision\":{}}" }, finish_reason: "stop" }],
        }),
        kind: "invalid-output",
      },
      {
        name: "length finish reason",
        status: 200,
        bodyText: JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: MODEL_ID,
          choices: [{ index: 0, message: { role: "assistant", content: inner }, finish_reason: "length" }],
        }),
        kind: "invalid-output",
      },
      { name: "http 401", status: 401, bodyText: "unauthorized", kind: "invalid-output" },
      { name: "http 429", status: 429, bodyText: "limited", kind: "rate-limited" },
      { name: "http 500", status: 500, bodyText: "down", kind: "unavailable" },
    ];
    for (const { name, bodyText, status, kind } of cases) {
      const captured = captureTransport({ status, bodyText });
      const result = await makeAdapter(captured.transport).decide(fixedInput(), fixedContext());
      expect(result.ok, name).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.error.kind, name).toBe(kind);
    }
  });

  test("oversized envelope body reports output-too-large", async () => {
    const captured = captureTransport({ status: 200, bodyText: "x".repeat(200000) });
    const result = await makeAdapter(captured.transport).decide(fixedInput(), fixedContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("output-too-large");
    }
  });
});
