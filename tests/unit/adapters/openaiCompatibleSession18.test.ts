// Session 18 fixes for the vendor-neutral assessment provider: no
// sampling parameters by default, opt-in temperature and token budget,
// strict single-fence tolerance, distinct 4xx kinds with a warn line,
// and loader coverage for the two new variables. No network, no real
// keys: every transport is an in-memory capture.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash, ModelId, PromptVersion, RequestId, Selector, SignalId, Timestamp } from "../../../src/domain/types.ts";
import { Address } from "../../../src/domain/types.ts";
import { Evidence } from "../../../src/domain/evidence.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { EvidenceList } from "../../../src/ports/assessmentModel.ts";
import type {
  AssessmentModelError,
  AssessmentModelPort,
  CallContext,
  EvidenceList as EvidenceListType,
} from "../../../src/ports/assessmentModel.ts";
import type { PromptVersion as PromptVersionType } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { err } from "../../../src/domain/result.ts";
import { GenericCompatibleAdapter } from "../../../src/adapters/assessment/GenericCompatible/GenericCompatibleAdapter.ts";
import { MetaModelApiAdapter } from "../../../src/adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import { hostedOpenWeightsAdapter } from "../../../src/adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import type { ChatCompletionsTransportResponse } from "../../../src/adapters/assessment/chatCompletions/chatCompletionsAdapter.ts";
import { loadConfig } from "../../../src/adapters/config/loader.ts";
import { requestAssessment } from "../../../src/application/requestAssessment.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { ModelArtifact } from "../../../src/domain/risk.ts";
import { SUPPORTED_TEMPLATE_VERSION } from "../../../src/domain/explain.ts";
import { syntheticAddress } from "../../helpers/syntheticAddresses.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const FAKE_KEY = "fake-key-for-tests-only";
const CODE = "0x6001600055";
const COMPAT_MODEL = "fake-compat-model-1";

function fixedEvidence(): EvidenceListType {
  const code = mustOk(Bytecode.parse(CODE));
  const codeHash = mustOk(CodeHash.of(code));
  const first = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0xa9059cbb")) }));
  const second = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x70a08231")) }));
  return mustOk(EvidenceList.create(codeHash, [first, second]));
}

function evidenceLink(): string {
  const code = mustOk(Bytecode.parse(CODE));
  const codeHash = mustOk(CodeHash.of(code));
  return mustOk(SignalId.of(codeHash, mustOk(Selector.parse("0xa9059cbb")))) as string;
}

function fixedPrompt(): PromptVersionType {
  return mustOk(PromptVersion.parse("1.0.0"));
}

function fixedContext(): CallContext {
  return {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1900000000000)),
    block: "latest",
  };
}

type CapturedCall = { url: string; body: string; headers: Record<string, string> };

function captureTransport(response: ChatCompletionsTransportResponse): {
  calls: CapturedCall[];
  transport: (
    url: string,
    init: { body: string; headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<ChatCompletionsTransportResponse>;
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

function innerAssessment(link: string): unknown {
  return {
    provider: "generic-compatible",
    modelId: COMPAT_MODEL,
    promptVersion: "1.0.0",
    explanationVersion: "1.0.0",
    text: "Recorded assessment text for tests only.",
    claims: [
      {
        text: "Recorded claim linked to the request evidence.",
        signalLinks: [link],
        temporality: { kind: "can-change", changer: syntheticAddress(9) },
      },
    ],
  };
}

function compatAdapter(
  response: ChatCompletionsTransportResponse,
  calls: CapturedCall[],
  warned: string[],
  options?: { temperature?: number | undefined; maxTokens?: number | undefined },
): { adapter: GenericCompatibleAdapter; calls: CapturedCall[] } {
  const captured = captureTransport(response);
  const adapter = new GenericCompatibleAdapter({
    endpoint: "https://compat.example.invalid/",
    apiKey: new SecretString(FAKE_KEY),
    modelId: mustOk(ModelId.parse(COMPAT_MODEL)),
    transport: async (url, init) => {
      calls.push({ url, body: init.body, headers: { ...init.headers } });
      return captured.transport(url, init);
    },
    onWarn: (line: string): void => {
      warned.push(line);
    },
    ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  });
  return { adapter, calls };
}

function successResponse(link: string): ChatCompletionsTransportResponse {
  return { status: 200, bodyText: envelopeFor(innerAssessment(link), COMPAT_MODEL) };
}

describe("vendor-neutral assessment request shape (session 18)", () => {
  test("omits sampling parameters by default with a larger token budget", async () => {
    const calls: CapturedCall[] = [];
    const warned: string[] = [];
    const { adapter } = compatAdapter(successResponse(evidenceLink()), calls, warned);
    const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["max_tokens", "messages", "model"]);
    expect(body["max_tokens"]).toBe(4096);
    expect("temperature" in body).toBe(false);
    expect("top_p" in body).toBe(false);
    expect(warned).toEqual([]);
  });

  test("sends only temperature when the temperature option is set", async () => {
    const calls: CapturedCall[] = [];
    const warned: string[] = [];
    const { adapter } = compatAdapter(successResponse(evidenceLink()), calls, warned, { temperature: 0.5 });
    const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
    expect(result.ok).toBe(true);
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["temperature"]).toBe(0.5);
    expect("top_p" in body).toBe(false);
    expect(body["max_tokens"]).toBe(4096);
  });

  test("honours an explicit max-tokens option", async () => {
    const calls: CapturedCall[] = [];
    const warned: string[] = [];
    const { adapter } = compatAdapter(successResponse(evidenceLink()), calls, warned, { maxTokens: 2048 });
    const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
    expect(result.ok).toBe(true);
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["max_tokens"]).toBe(2048);
    expect("temperature" in body).toBe(false);
    expect("top_p" in body).toBe(false);
  });

  test("the other providers keep deterministic sampling", async () => {
    const link = evidenceLink();
    const metaInner = { ...(innerAssessment(link) as Record<string, unknown>), provider: "meta-model-api", modelId: "meta-muse-spark-test-1" };
    const hostedInner = {
      ...(innerAssessment(link) as Record<string, unknown>),
      provider: "hosted-open-weights",
      modelId: "meta-models/muse-spark-open-1026",
    };
    const metaCalls: CapturedCall[] = [];
    const meta = new MetaModelApiAdapter({
      endpoint: "https://meta-api.example.invalid",
      apiKey: new SecretString(FAKE_KEY),
      modelId: mustOk(ModelId.parse("meta-muse-spark-test-1")),
      transport: async (url, init) => {
        metaCalls.push({ url, body: init.body, headers: { ...init.headers } });
        return { status: 200, bodyText: envelopeFor(metaInner, "meta-muse-spark-test-1") };
      },
      onWarn: () => undefined,
    });
    const hostedCalls: CapturedCall[] = [];
    const hosted = new hostedOpenWeightsAdapter({
      endpoint: "https://hosted.example.invalid",
      apiKey: new SecretString(FAKE_KEY),
      modelId: mustOk(ModelId.parse("meta-models/muse-spark-open-1026")),
      transport: async (url, init) => {
        hostedCalls.push({ url, body: init.body, headers: { ...init.headers } });
        return { status: 200, bodyText: envelopeFor(hostedInner, "meta-models/muse-spark-open-1026") };
      },
      onWarn: () => undefined,
    });
    expect((await meta.assess(fixedEvidence(), fixedPrompt(), fixedContext())).ok).toBe(true);
    expect((await hosted.assess(fixedEvidence(), fixedPrompt(), fixedContext())).ok).toBe(true);
    const metaBody = JSON.parse(metaCalls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(metaBody["temperature"]).toBe(0);
    expect(metaBody["max_tokens"]).toBe(8192);
    expect(metaBody["reasoning_effort"]).toBe("low");
    expect("top_p" in metaBody).toBe(false);
    const hostedBody = JSON.parse(hostedCalls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(hostedBody["temperature"]).toBe(0);
    expect(hostedBody["max_tokens"]).toBe(1024);
    expect("reasoning_effort" in hostedBody).toBe(false);
    expect("top_p" in hostedBody).toBe(false);
  });
});

describe("vendor-neutral fence tolerance and 4xx mapping (session 18)", () => {
  function fencedResponse(content: string): ChatCompletionsTransportResponse {
    return {
      status: 200,
      bodyText: JSON.stringify({
        id: "chatcmpl-test-2",
        object: "chat.completion",
        created: 1700000000,
        model: COMPAT_MODEL,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    };
  }

  test("strips a single json fence and an untagged fence", async () => {
    const link = evidenceLink();
    const inner = JSON.stringify(innerAssessment(link));
    for (const content of [`\`\`\`json\n${inner}\n\`\`\``, `\`\`\`\n${inner}\n\`\`\``]) {
      const calls: CapturedCall[] = [];
      const warned: string[] = [];
      const { adapter } = compatAdapter(fencedResponse(content), calls, warned);
      const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
      expect(result.ok).toBe(true);
    }
  });

  test("leaves non-json fences and unclosed fences alone", async () => {
    const link = evidenceLink();
    const inner = JSON.stringify(innerAssessment(link));
    const cases = [
      `\`\`\`python\n${inner}\n\`\`\``,
      `\`\`\`json\n${inner}\n`,
      `\`\`\`json\n${inner}\n\`\`\`\n\`\`\`trailing\`\`\``,
    ];
    for (const content of cases) {
      const calls: CapturedCall[] = [];
      const warned: string[] = [];
      const { adapter } = compatAdapter(fencedResponse(content), calls, warned);
      const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("invalid-output");
      }
    }
  });

  test("401 and 403 map to rejected credentials with one warn line", async () => {
    for (const status of [401, 403]) {
      const calls: CapturedCall[] = [];
      const warned: string[] = [];
      const marker = `secret-body-marker-${status}`;
      const { adapter } = compatAdapter({ status, bodyText: marker }, calls, warned);
      const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("unauthorized");
        expect(result.error.message).toContain("rejected the credentials");
      }
      expect(warned.length).toBe(1);
      const line = warned[0] ?? "";
      expect(line).toContain("unauthorized");
      expect(line).toContain(String(status));
      expect(line).not.toContain(marker);
      expect(line).not.toContain(FAKE_KEY);
      expect(line).not.toContain("compat.example.invalid");
    }
  });

  test("400, 404 and 422 map to a rejected request naming the status", async () => {
    for (const status of [400, 404, 422]) {
      const calls: CapturedCall[] = [];
      const warned: string[] = [];
      const { adapter } = compatAdapter({ status, bodyText: "rejected" }, calls, warned);
      const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("rejected");
        expect(result.error.message).toContain(`status ${status}`);
      }
      expect(warned.length).toBe(1);
      expect(warned[0] ?? "").toContain(String(status));
    }
  });

  test("429 stays rate-limited with one warn line", async () => {
    const calls: CapturedCall[] = [];
    const warned: string[] = [];
    const { adapter } = compatAdapter({ status: 429, bodyText: "limited" }, calls, warned);
    const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rate-limited");
    }
    expect(warned.length).toBe(1);
  });
});

describe("vendor-neutral loader variables (session 18)", () => {
  function baseEnv(): Record<string, string | undefined> {
    return {
      BRANDKLIPPAREN_ENV: "ci",
      BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
      BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
      BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
      BRANDKLIPPAREN_extdecomp_DEADLINE_MS: "5000",
      BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB: "512",
      BRANDKLIPPAREN_extdecomp_MAX_OUTPUT_BYTES: "100000",
      BRANDKLIPPAREN_LOG_LEVEL: "info",
    };
  }

  test("temperature and max tokens parse when set", () => {
    const loaded = loadConfig({
      ...baseEnv(),
      BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_TEMPERATURE: "0.5",
      BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MAX_TOKENS: "8192",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.assessmentGenericCompatibleTemperature).toBe(0.5);
    expect(loaded.value.assessmentGenericCompatibleMaxTokens).toBe(8192);
  });

  test("both variables stay undefined when unset", () => {
    const loaded = loadConfig(baseEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.assessmentGenericCompatibleTemperature).toBeUndefined();
    expect(loaded.value.assessmentGenericCompatibleMaxTokens).toBeUndefined();
  });

  test("out-of-range values fail with the variable name", () => {
    for (const env of [
      { BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_TEMPERATURE: "1.5" },
      { BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_TEMPERATURE: "-0.1" },
      { BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_TEMPERATURE: "warm" },
      { BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MAX_TOKENS: "0" },
      { BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MAX_TOKENS: "many" },
      { BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MAX_TOKENS: "999999999" },
    ]) {
      const loaded = loadConfig({ ...baseEnv(), ...env });
      expect(loaded.ok).toBe(false);
    }
  });
});

describe("vendor-neutral fallback reasons (session 18)", () => {
  function placeholderArtifact(): ModelArtifact {
    const parsed = parseModelArtifact({
      version: "0.1.0",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: {
        timeout: 0.4,
        "resource-limit": 0.4,
        "decompiler-error": 0.6,
        "obfuscated-structure": 0.6,
      },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
    });
    if (!parsed.ok) {
      throw new Error(`placeholder artifact must parse: ${parsed.error.message}`);
    }
    return parsed.value;
  }

  async function fallbackFor(error: AssessmentModelError): Promise<{ kind: string; reason: string }> {
    const stub: AssessmentModelPort = {
      provider: () => "generic-compatible",
      modelId: () => mustOk(ModelId.parse(COMPAT_MODEL)),
      assess: async () => err(error),
    };
    const changer = mustOk(Address.parse(syntheticAddress(9)));
    const outcome = await requestAssessment({
      signals: [],
      artifact: placeholderArtifact(),
      evidence: fixedEvidence(),
      templateVersion: SUPPORTED_TEMPLATE_VERSION,
      observed: { kind: "can-change", changer },
      promptVersion: fixedPrompt(),
      ctx: fixedContext(),
      adapter: stub,
    });
    if (!outcome.ok) {
      throw new Error(`expected ok, got error: ${outcome.error.kind}`);
    }
    const assessed = outcome.value;
    if (assessed.fallback === null) {
      throw new Error("expected an assessed outcome with a fallback");
    }
    return { kind: assessed.fallback.errorKind, reason: assessed.fallback.reason };
  }

  test("rejected credentials stay accurate in the fallback", async () => {
    const fallback = await fallbackFor({ kind: "unauthorized", message: "provider rejected the credentials" });
    expect(fallback.kind).toBe("unauthorized");
    expect(fallback.reason).toContain("rejected the credentials");
    expect(fallback.reason).toContain("template explanation stands");
    expect(fallback.reason).not.toContain("failed validation");
  });

  test("rejected requests stay accurate in the fallback", async () => {
    const fallback = await fallbackFor({ kind: "rejected", message: "provider rejected the request (status 400)" });
    expect(fallback.kind).toBe("rejected");
    expect(fallback.reason).toContain("rejected the request");
    expect(fallback.reason).toContain("template explanation stands");
    expect(fallback.reason).not.toContain("failed validation");
  });

  test("cost caps keep working: the assessment path still records one call", async () => {
    const link = evidenceLink();
    const calls: CapturedCall[] = [];
    const warned: string[] = [];
    const { adapter } = compatAdapter(successResponse(link), calls, warned);
    const result = await adapter.assess(fixedEvidence(), fixedPrompt(), fixedContext());
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
  });
});

describe("recorded realistic provider answer (S-136)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const recordedDir = join(here, "..", "..", "fixtures", "assessment");

  // Synthetic evidence matching the recorded fixtures: plain synthetic
  // bytecode with synthetic selectors only, no real token data. The
  // recorded signal links derive from these exact inputs.
  function recordedEvidence(): EvidenceListType {
    const code = mustOk(Bytecode.parse("0x6001600055"));
    const codeHash = mustOk(CodeHash.of(code));
    const first = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x01020304")) }));
    const second = mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x05060708")) }));
    return mustOk(EvidenceList.create(codeHash, [first, second]));
  }

  function recordedAdapter(bodyText: string, warned: string[]): GenericCompatibleAdapter {
    return new GenericCompatibleAdapter({
      endpoint: "https://compat.example.invalid/",
      apiKey: new SecretString(FAKE_KEY),
      modelId: mustOk(ModelId.parse(COMPAT_MODEL)),
      transport: async () => ({ status: 200, bodyText }),
      onWarn: (line: string): void => {
        warned.push(line);
      },
    });
  }

  test("s136_recorded_realistic_answer_validates", async () => {
    const bodyText = readFileSync(join(recordedDir, "compat-realistic-recorded.json"), "utf8");
    const warned: string[] = [];
    const adapter = recordedAdapter(bodyText, warned);
    const result = await adapter.assess(recordedEvidence(), fixedPrompt(), fixedContext());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.provider).toBe("generic-compatible");
    expect(result.value.claims.length).toBe(2);
    expect(warned).toEqual([]);
  });

  test("s136_invalid_output_logs_schema_path_without_content", async () => {
    const unknownId = `0x${"02".repeat(32)}`;
    const unknownBody = readFileSync(join(recordedDir, "compat-unknown-signal-recorded.json"), "utf8");
    expect(unknownBody.includes(unknownId)).toBe(true);
    const warnedUnknown: string[] = [];
    const unknown = await recordedAdapter(unknownBody, warnedUnknown).assess(
      recordedEvidence(),
      fixedPrompt(),
      fixedContext(),
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) {
      return;
    }
    expect(unknown.error.kind).toBe("invalid-output");
    expect(warnedUnknown.length).toBe(1);
    const unknownLine = warnedUnknown[0] ?? "";
    expect(unknownLine).toContain("claims[0].signalLinks");
    expect(unknownLine).toContain("unknown-signal");
    expect(unknownLine.includes(unknownId)).toBe(false);
    expect(unknownLine.includes(FAKE_KEY)).toBe(false);

    const scriptBody = readFileSync(join(recordedDir, "compat-script-html-recorded.json"), "utf8");
    expect(scriptBody.includes("<script")).toBe(true);
    const warnedScript: string[] = [];
    const scripted = await recordedAdapter(scriptBody, warnedScript).assess(
      recordedEvidence(),
      fixedPrompt(),
      fixedContext(),
    );
    expect(scripted.ok).toBe(false);
    if (scripted.ok) {
      return;
    }
    expect(scripted.error.kind).toBe("invalid-output");
    expect(warnedScript.length).toBe(1);
    const scriptLine = warnedScript[0] ?? "";
    expect(scriptLine).toContain("claims[0].text");
    expect(scriptLine).toContain("no-markup");
    expect(scriptLine.includes("<script")).toBe(false);
    expect(scriptLine.includes("scripts.example.invalid")).toBe(false);
    expect(scriptLine.includes(FAKE_KEY)).toBe(false);
  });
});
