// Meta Model API investigate adapter behind InvestigationModelPort:
// valid decisions bind provider and model id labelling, invalid output
// is rejected without touching score or evidence, and the factory
// validates at startup like the other adapters. Fake transport only:
// no network, no real keys.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash, ModelId, RequestId, Timestamp } from "../../../src/domain/types.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { InvestigationModelInput } from "../../../src/ports/investigationModel.ts";
import type {
  InvestigationCallContext,
  InvestigationModelInput as InvestigationModelInputType,
} from "../../../src/ports/investigationModel.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  INVESTIGATE_META_MODEL_ID,
  MetaModelApiInvestigateAdapter,
  createMetaModelApiInvestigateAdapterFromConfig,
} from "../../../src/adapters/investigation/metaModelApiInvestigateAdapter.ts";
import type {
  MetaInvestigateLogEntry,
  MetaInvestigateTransportResponse,
} from "../../../src/adapters/investigation/metaModelApiInvestigateAdapter.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const FAKE_KEY = "fake-key-for-tests-only";
const MODEL_ID = INVESTIGATE_META_MODEL_ID;

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
  sends: { count: number };
  transport: (
    url: string,
    init: { body: string; headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<MetaInvestigateTransportResponse>;
} {
  const calls: CapturedCall[] = [];
  const sends = { count: 0 };
  return {
    calls,
    sends,
    transport: async (url, init) => {
      calls.push({ url, body: init.body, headers: { ...init.headers } });
      sends.count += 1;
      return response;
    },
  };
}

function envelopeFor(inner: unknown, model: string): string {
  return JSON.stringify({
    id: "chatcmpl-test-meta-1",
    object: "chat.completion",
    created: 1700000000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(inner) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

function concludeInner(
  provider = "meta-model-api",
  modelId: string = MODEL_ID,
): unknown {
  return {
    provider,
    modelId,
    decision: {
      kind: "conclude",
      narrativeDraft: "Recorded draft citing frozen evidence. [E:sig-1]",
      rationale: "Recorded rationale: conclude from the frozen evidence.",
    },
  };
}

function makeAdapter(
  transport: ReturnType<typeof captureTransport>["transport"],
  onLog?: (entry: MetaInvestigateLogEntry) => void,
): MetaModelApiInvestigateAdapter {
  return new MetaModelApiInvestigateAdapter({
    endpoint: "https://meta.example.invalid/v1/",
    apiKey: new SecretString(FAKE_KEY),
    modelId: mustOk(ModelId.parse(MODEL_ID)),
    transport,
    onLog,
  });
}

function decideCase(
  inner: unknown,
  status = 200,
  bodyText?: string,
): ReturnType<typeof captureTransport> {
  const captured = captureTransport({
    status,
    bodyText: bodyText ?? envelopeFor(inner, MODEL_ID),
  });
  return captured;
}

describe("meta investigate adapter over a fake transport", () => {
  test("decide posts a standard body to <base>/chat/completions", async () => {
    const input = fixedInput();
    const captured = decideCase(concludeInner());
    const result = await makeAdapter(captured.transport).decide(input, fixedContext());
    expect(result.ok).toBe(true);
    expect(captured.calls.length).toBe(1);
    const call = captured.calls[0];
    if (call === undefined) {
      throw new Error("expected one outgoing call");
    }
    expect(call.url).toBe("https://meta.example.invalid/v1/chat/completions");
    expect(call.headers["Authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(call.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body["model"]).toBe(MODEL_ID);
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model", "reasoning_effort", "temperature"]);
    expect(body["max_tokens"]).toBe(8192);
    expect(body["reasoning_effort"]).toBe("low");
    expect(body["temperature"]).toBe(0);
    expect("top_p" in body).toBe(false);
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(2);
    expect(messages[0]?.content ?? "").toContain("meta-model-api");
    expect(messages[0]?.content ?? "").toContain(MODEL_ID);
    expect(call.url).not.toContain(FAKE_KEY);
    expect(call.body).not.toContain(FAKE_KEY);
  });

  test("valid conclude and run-tool decisions bind provider and model labelling", async () => {
    const adapter = makeAdapter(decideCase(concludeInner()).transport);
    expect(adapter.provider()).toBe("meta-model-api");
    expect(adapter.modelId()).toBe(MODEL_ID);
    const concluded = await adapter.decide(fixedInput(), fixedContext());
    expect(concluded.ok).toBe(true);
    if (concluded.ok) {
      expect(concluded.value.kind).toBe("conclude");
    }
    const runTool = decideCase({
      provider: "meta-model-api",
      modelId: MODEL_ID,
      decision: {
        kind: "run-tool",
        toolId: "evidence.list",
        args: {},
        rationale: "List the frozen evidence first.",
      },
    });
    const decided = await makeAdapter(runTool.transport).decide(fixedInput(), fixedContext());
    expect(decided.ok).toBe(true);
    if (decided.ok && decided.value.kind === "run-tool") {
      expect(decided.value.toolId).toBe("evidence.list");
    } else {
      throw new Error("expected a run-tool decision");
    }
  });

  test("invalid output is rejected with typed errors", async () => {
    const providerMismatch = decideCase(concludeInner("other-provider"));
    const wrongProvider = await makeAdapter(providerMismatch.transport).decide(fixedInput(), fixedContext());
    expect(wrongProvider.ok).toBe(false);
    if (!wrongProvider.ok) {
      expect(wrongProvider.error.kind).toBe("provider-mismatch");
    }
    const modelMismatch = decideCase(concludeInner("meta-model-api", "other-model-1"));
    const wrongModel = await makeAdapter(modelMismatch.transport).decide(fixedInput(), fixedContext());
    expect(wrongModel.ok).toBe(false);
    if (!wrongModel.ok) {
      expect(wrongModel.error.kind).toBe("provider-mismatch");
    }
    const garbage = decideCase(null, 200, "not json {");
    const invalid = await makeAdapter(garbage.transport).decide(fixedInput(), fixedContext());
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.kind).toBe("invalid-output");
    }
    const limited = decideCase(null, 429, "limited");
    const rateLimited = await makeAdapter(limited.transport).decide(fixedInput(), fixedContext());
    expect(rateLimited.ok).toBe(false);
    if (!rateLimited.ok) {
      expect(rateLimited.error.kind).toBe("rate-limited");
    }
    const down = decideCase(null, 500, "down");
    const unavailable = await makeAdapter(down.transport).decide(fixedInput(), fixedContext());
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.error.kind).toBe("unavailable");
    }
  });

  test("a length finish reason is a typed invalid-output error", async () => {
    const truncated = decideCase(
      null,
      200,
      JSON.stringify({
        id: "chatcmpl-test-meta-truncated",
        object: "chat.completion",
        created: 1700000000,
        model: MODEL_ID,
        choices: [
          { index: 0, message: { role: "assistant", content: JSON.stringify(concludeInner()) }, finish_reason: "length" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 },
      }),
    );
    const result = await makeAdapter(truncated.transport).decide(fixedInput(), fixedContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid-output");
    }
  });

  test("log entries label provider and model without the key", async () => {
    const entries: MetaInvestigateLogEntry[] = [];
    const captured = decideCase(concludeInner());
    const result = await makeAdapter(captured.transport, (entry) => {
      entries.push(entry);
    }).decide(fixedInput(), fixedContext());
    expect(result.ok).toBe(true);
    expect(entries.length).toBe(1);
    expect(entries[0]?.provider).toBe("meta-model-api");
    expect(entries[0]?.modelId).toBe(MODEL_ID);
    expect(entries[0]?.outcome).toBe("ok");
    expect(JSON.stringify(entries[0])).not.toContain(FAKE_KEY);
  });
});

describe("meta investigate adapter factory validation", () => {
  const baseUrl = "https://meta.example.invalid/v1";

  test("a complete triple binds the configured adapter", () => {
    const built = createMetaModelApiInvestigateAdapterFromConfig({
      investigateMetaBaseUrl: baseUrl,
      investigateMetaApiKey: new SecretString(FAKE_KEY),
      investigateMetaModelId: mustOk(ModelId.parse("fake-meta-investigate-1")),
      investigateDeadlineMs: undefined,
      investigateMaxInputBytes: undefined,
      investigateMaxOutputBytes: undefined,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.provider()).toBe("meta-model-api");
      expect(built.value.modelId()).toBe("fake-meta-investigate-1");
    }
  });

  test("an unset model id defaults to muse-spark-1.3", () => {
    expect(INVESTIGATE_META_MODEL_ID).toBe("muse-spark-1.3");
    const built = createMetaModelApiInvestigateAdapterFromConfig({
      investigateMetaBaseUrl: baseUrl,
      investigateMetaApiKey: new SecretString(FAKE_KEY),
      investigateMetaModelId: undefined,
      investigateDeadlineMs: undefined,
      investigateMaxInputBytes: undefined,
      investigateMaxOutputBytes: undefined,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.provider()).toBe("meta-model-api");
      expect(built.value.modelId()).toBe("muse-spark-1.3");
    }
  });

  test("a missing key or base URL binds not-configured with zero sends", async () => {
    let sends = 0;
    const transport = async (): Promise<MetaInvestigateTransportResponse> => {
      sends += 1;
      return { status: 200, bodyText: envelopeFor(concludeInner(), MODEL_ID) };
    };
    for (const partial of [
      {
        investigateMetaBaseUrl: undefined,
        investigateMetaApiKey: new SecretString(FAKE_KEY),
      },
      {
        investigateMetaBaseUrl: baseUrl,
        investigateMetaApiKey: undefined,
      },
    ]) {
      const built = createMetaModelApiInvestigateAdapterFromConfig(
        {
          ...partial,
          investigateMetaModelId: mustOk(ModelId.parse(MODEL_ID)),
          investigateDeadlineMs: undefined,
          investigateMaxInputBytes: undefined,
          investigateMaxOutputBytes: undefined,
        },
        transport,
      );
      expect(built.ok).toBe(true);
      if (!built.ok) {
        continue;
      }
      expect(built.value.provider()).toBe("meta-model-api");
      const decided = await built.value.decide(fixedInput(), fixedContext());
      expect(decided.ok).toBe(false);
      if (!decided.ok) {
        expect(decided.error.kind).toBe("not-configured");
      }
    }
    expect(sends).toBe(0);
  });

  test("a malformed base URL is a typed startup error", () => {
    const built = createMetaModelApiInvestigateAdapterFromConfig({
      investigateMetaBaseUrl: "http://meta.example.invalid/v1",
      investigateMetaApiKey: new SecretString(FAKE_KEY),
      investigateMetaModelId: mustOk(ModelId.parse(MODEL_ID)),
      investigateDeadlineMs: undefined,
      investigateMaxInputBytes: undefined,
      investigateMaxOutputBytes: undefined,
    });
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.variable).toBe("BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL");
    }
  });
});

describe("m2d conclude prompt over a fake transport", () => {
  test("system prompt shows the citation syntax with a collected id", async () => {
    const input = fixedInput();
    const captured = decideCase(concludeInner());
    await makeAdapter(captured.transport).decide(input, fixedContext());
    expect(captured.calls.length).toBe(1);
    const call = captured.calls[0];
    if (call === undefined) {
      throw new Error("expected one outgoing call");
    }
    const body = JSON.parse(call.body) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages[0]?.content ?? "";
    expect(system).toContain("[E:<id>]");
    expect(system).toContain("every sentence must end with one or more [E:<id>] markers");
    expect(system).toContain("[E:signal:sig-1]");
    expect(system).toContain("Collected evidence ids (copy verbatim): signal:sig-1, signal:sig-2");
  });
});
