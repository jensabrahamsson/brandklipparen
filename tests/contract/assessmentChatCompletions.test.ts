// Outgoing chat-completions shape for the assessment adapters (K-305,
// K-309). Written first per A-21 (red): every binding must POST a
// standard chat-completions body (model, system + user messages,
// max_tokens, temperature only, plus an opt-in reasoning_effort on the
// Meta reasoning binding) to `<base>/chat/completions`, and must
// read the assessment from `choices[0].message.content`. No live calls,
// no real keys: the transport is an in-memory capture.
import { describe, expect, test, vi } from "vitest";
import { Bytecode, CodeHash, ModelId, PromptVersion, RequestId, Selector, SignalId, Timestamp } from "../../src/domain/types.ts";
import { Evidence } from "../../src/domain/evidence.ts";
import { SecretString } from "../../src/ports/config.ts";
import { EvidenceList } from "../../src/ports/assessmentModel.ts";
import type { AssessmentModelPort, CallContext, EvidenceList as EvidenceListType } from "../../src/ports/assessmentModel.ts";
import type { PromptVersion as PromptVersionType } from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import { MetaModelApiAdapter } from "../../src/adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import { hostedOpenWeightsAdapter } from "../../src/adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import { GenericCompatibleAdapter } from "../../src/adapters/assessment/GenericCompatible/GenericCompatibleAdapter.ts";
import { fetchChatCompletionsTransport } from "../../src/adapters/assessment/chatCompletions/chatCompletionsAdapter.ts";
import type { ChatCompletionsTransportResponse } from "../../src/adapters/assessment/chatCompletions/chatCompletionsAdapter.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const FAKE_KEY = "fake-key-for-tests-only";
const CODE = "0x6001600055";

function fixedEvidence(): EvidenceListType {
  const code = mustOk(Bytecode.parse(CODE));
  const codeHash = mustOk(CodeHash.of(code));
  const first = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0xa9059cbb")) }));
  const second = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x70a08231")) }));
  return mustOk(EvidenceList.create(codeHash, [first, second]));
}

function fixedPrompt(): PromptVersionType {
  return mustOk(PromptVersion.parse("1.0.0"));
}

function fixedContext(): CallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    block: "latest",
  };
}

type CapturedCall = { url: string; body: string; headers: Record<string, string> };

function captureTransport(response: ChatCompletionsTransportResponse): {
  calls: CapturedCall[];
  transport: (url: string, init: { body: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<ChatCompletionsTransportResponse>;
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

function envelopeFor(inner: unknown, model: string): string {
  return JSON.stringify({
    id: "chatcmpl-test-1",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(inner) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

function innerAssessment(provider: string, model: string, link: string): unknown {
  return {
    provider,
    modelId: model,
    promptVersion: "1.0.0",
    explanationVersion: "1.0.0",
    text: "Recorded assessment text for tests only.",
    claims: [
      {
        text: "Recorded claim linked to the request evidence.",
        signalLinks: [link],
        temporality: { kind: "can-change", changer: "0xe943a4b43ad372355be29445a2532cc0920a7108" },
      },
    ],
  };
}

type Binding = {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly make: (transport: ReturnType<typeof captureTransport>["transport"]) => AssessmentModelPort;
};

const BINDINGS: readonly Binding[] = [
  {
    name: "meta",
    provider: "meta-model-api",
    model: "meta-muse-spark-test-1",
    make: (transport) =>
      new MetaModelApiAdapter({
        endpoint: "https://meta-api.example.invalid",
        apiKey: new SecretString(FAKE_KEY),
        modelId: mustOk(ModelId.parse("meta-muse-spark-test-1")),
        transport,
        onWarn: () => undefined,
      }),
  },
  {
    name: "hosted",
    provider: "hosted-open-weights",
    model: "meta-models/muse-spark-open-1026",
    make: (transport) =>
      new hostedOpenWeightsAdapter({
        endpoint: "https://hosted.example.invalid",
        apiKey: new SecretString(FAKE_KEY),
        modelId: mustOk(ModelId.parse("meta-models/muse-spark-open-1026")),
        transport,
        onWarn: () => undefined,
      }),
  },
  {
    name: "generic-compatible",
    provider: "generic-compatible",
    model: "fake-compat-model-1",
    make: (transport) =>
      new GenericCompatibleAdapter({
        endpoint: "https://compat.example.invalid/",
        apiKey: new SecretString(FAKE_KEY),
        modelId: mustOk(ModelId.parse("fake-compat-model-1")),
        transport,
        onWarn: () => undefined,
      }),
  },
];

// Per-provider request budgets (session 18, M2b): the hosted binding
// keeps deterministic sampling (temperature 0, 1024 tokens), the Meta
// reasoning binding sends 8192 tokens with a low reasoning effort, and
// the vendor-neutral binding sends no sampling parameter at all with a
// larger token budget. Only the Meta binding sends reasoning_effort.
const EXPECTED_REQUEST: Record<
  string,
  { keys: readonly string[]; maxTokens: number; temperature: number | undefined; reasoningEffort: string | undefined }
> = {
  meta: {
    keys: ["max_tokens", "messages", "model", "reasoning_effort", "temperature"],
    maxTokens: 8192,
    temperature: 0,
    reasoningEffort: "low",
  },
  hosted: {
    keys: ["max_tokens", "messages", "model", "temperature"],
    maxTokens: 1024,
    temperature: 0,
    reasoningEffort: undefined,
  },
  "generic-compatible": {
    keys: ["max_tokens", "messages", "model"],
    maxTokens: 4096,
    temperature: undefined,
    reasoningEffort: undefined,
  },
};

const EXPECTED_URLS: Record<string, string> = {
  meta: "https://meta-api.example.invalid/chat/completions",
  hosted: "https://hosted.example.invalid/chat/completions",
  "generic-compatible": "https://compat.example.invalid/chat/completions",
};

describe("assessment chat-completions request shape", () => {
  for (const binding of BINDINGS) {
    test(`${binding.name} posts a standard body to <base>/chat/completions`, async () => {
      const evidence = fixedEvidence();
      const code = mustOk(Bytecode.parse(CODE));
      const codeHash = mustOk(CodeHash.of(code));
      const link = mustOk(SignalId.of(codeHash, mustOk(Selector.parse("0xa9059cbb")))) as string;
      const captured = captureTransport({
        status: 200,
        bodyText: envelopeFor(innerAssessment(binding.provider, binding.model, link), binding.model),
      });
      const adapter = binding.make(captured.transport);
      const result = await adapter.assess(evidence, fixedPrompt(), fixedContext());
      expect(result.ok).toBe(true);
      expect(captured.calls.length).toBe(1);
      const call = captured.calls[0];
      if (call === undefined) {
        throw new Error("expected one outgoing call");
      }
      expect(call.url).toBe(EXPECTED_URLS[binding.name]);
      expect(call.headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
      expect(call.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(call.body) as Record<string, unknown>;
      expect(body["model"]).toBe(binding.model);
      const expected = EXPECTED_REQUEST[binding.name];
      if (expected === undefined) {
        throw new Error(`missing request expectation for ${binding.name}`);
      }
      expect(Object.keys(body).sort()).toEqual([...expected.keys].sort());
      expect(body["max_tokens"]).toBe(expected.maxTokens);
      if (expected.temperature === undefined) {
        expect("temperature" in body).toBe(false);
      } else {
        expect(body["temperature"]).toBe(expected.temperature);
      }
      if (expected.reasoningEffort === undefined) {
        expect("reasoning_effort" in body).toBe(false);
      } else {
        expect(body["reasoning_effort"]).toBe(expected.reasoningEffort);
      }
      expect("top_p" in body).toBe(false);
      expect("promptVersion" in body).toBe(false);
      expect("evidence" in body).toBe(false);
      const messages = body["messages"] as Array<{ role: string; content: string }>;
      expect(messages.length).toBe(2);
      expect(messages[0]?.role).toBe("system");
      expect(messages[1]?.role).toBe("user");
      const system = messages[0]?.content ?? "";
      expect(system).toContain("1.0.0");
      expect(system).toContain("untrusted");
      expect(system).toContain("claims");
      const user = JSON.parse(messages[1]?.content ?? "") as {
        codeHash: string;
        entries: Array<{ selector: string }>;
      };
      expect(user.codeHash).toBe(codeHash as string);
      expect(user.entries.map((entry) => entry.selector).sort()).toEqual(["0x70a08231", "0xa9059cbb"]);
      expect(call.url).not.toContain(FAKE_KEY);
      expect(call.body).not.toContain(FAKE_KEY);
    });
  }

  test("fenced JSON content parses to a valid assessment", async () => {
    const evidence = fixedEvidence();
    const code = mustOk(Bytecode.parse(CODE));
    const codeHash = mustOk(CodeHash.of(code));
    const link = mustOk(SignalId.of(codeHash, mustOk(Selector.parse("0xa9059cbb")))) as string;
    const binding = BINDINGS[0];
    if (binding === undefined) {
      throw new Error("expected at least one binding");
    }
    const inner = JSON.stringify(innerAssessment(binding.provider, binding.model, link));
    const captured = captureTransport({
      status: 200,
      bodyText: JSON.stringify({
        id: "chatcmpl-test-2",
        object: "chat.completion",
        created: 1700000000,
        model: binding.model,
        choices: [{ index: 0, message: { role: "assistant", content: "```json\n" + inner + "\n```" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    });
    const result = await binding.make(captured.transport).assess(evidence, fixedPrompt(), fixedContext());
    expect(result.ok).toBe(true);
  });

  test("envelope failures map to typed errors", async () => {
    const binding = BINDINGS[0];
    if (binding === undefined) {
      throw new Error("expected at least one binding");
    }
    const inner = JSON.stringify(
      innerAssessment(binding.provider, binding.model, "unused"),
    );
    const cases: Array<{ name: string; bodyText: string; status: number; kind: string }> = [
      {
        name: "empty choices",
        status: 200,
        bodyText: JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: binding.model, choices: [] }),
        kind: "invalid-output",
      },
      {
        name: "missing content",
        status: 200,
        bodyText: JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: binding.model,
          choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        }),
        kind: "invalid-output",
      },
      {
        name: "non-JSON content",
        status: 200,
        bodyText: JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 1,
          model: binding.model,
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
          model: binding.model,
          choices: [{ index: 0, message: { role: "assistant", content: "{\"provider\":\"x\"}" }, finish_reason: "stop" }],
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
          model: binding.model,
          choices: [{ index: 0, message: { role: "assistant", content: inner }, finish_reason: "length" }],
        }),
        kind: "invalid-output",
      },
      { name: "http 400", status: 400, bodyText: "refused", kind: "rejected" },
      { name: "http 401", status: 401, bodyText: "unauthorized", kind: "unauthorized" },
      { name: "http 403", status: 403, bodyText: "forbidden", kind: "unauthorized" },
      { name: "http 404", status: 404, bodyText: "missing", kind: "rejected" },
      { name: "http 422", status: 422, bodyText: "unprocessable", kind: "rejected" },
      { name: "http 429", status: 429, bodyText: "limited", kind: "rate-limited" },
      { name: "http 500", status: 500, bodyText: "down", kind: "unavailable" },
    ];
    for (const { name, bodyText, status, kind } of cases) {
      const captured = captureTransport({ status, bodyText });
      const result = await binding.make(captured.transport).assess(fixedEvidence(), fixedPrompt(), fixedContext());
      expect(result.ok, name).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.error.kind, name).toBe(kind);
    }
  });

  test("oversized envelope body reports output-too-large", async () => {
    const binding = BINDINGS[0];
    if (binding === undefined) {
      throw new Error("expected at least one binding");
    }
    const captured = captureTransport({ status: 200, bodyText: "x".repeat(3000) });
    const adapter = new MetaModelApiAdapter({
      endpoint: "https://meta-api.example.invalid",
      apiKey: new SecretString(FAKE_KEY),
      modelId: mustOk(ModelId.parse("meta-muse-spark-test-1")),
      maxBytesIn: 1024,
      transport: captured.transport,
    });
    const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("output-too-large");
    }
  });

  test("production transport posts with method POST", async () => {
    const seen: { url: string; init: { method: string; headers: unknown; body: unknown } }[] = [];
    vi.stubGlobal(
      "fetch",
      (async (url: string, init: { method: string; headers: unknown; body: unknown }) => {
        seen.push({ url, init });
        return { status: 200, text: async () => "{}" };
      }) as typeof fetch,
    );
    try {
      await fetchChatCompletionsTransport("https://meta-api.example.invalid/chat/completions", {
        body: "{}",
        headers: { "Content-Type": "application/json", Authorization: "Bearer fake" },
        signal: new AbortController().signal,
      });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen.length).toBe(1);
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.url).toBe("https://meta-api.example.invalid/chat/completions");
  });
});
