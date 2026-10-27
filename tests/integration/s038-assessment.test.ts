// S-038 Muse contract assessment through REST and MCP (K-305, K-309, K-513).
// Written first per A-21 (red): the assessment service, the REST endpoint
// and the MCP tool do not exist yet, so every test below fails until the
// implementation lands. All providers are fakes or recorded fixtures: no
// live calls, no real keys. Detection thresholds stay in the versioned
// artifact; the values below are placeholders for tests only (K-210).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Ajv } from "ajv";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { ModelArtifact } from "../../src/domain/risk.ts";
import { Evidence } from "../../src/domain/evidence.ts";
import { canonicalSerialize } from "../../src/domain/serialize.ts";
import type { CanonicalValue } from "../../src/domain/serialize.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  Bytecode,
  CodeHash,
  IndexVersion,
  ModelId,
  ModelVersion,
  PromptVersion,
  RequestId,
  Selector,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type {
  BlockNumber as BlockNumberType,
  PromptVersion as PromptVersionType,
  TemplateVersion as TemplateVersionType,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { AppServices } from "../../src/application/analyzeToken.ts";
import {
  assessmentCacheKeyOf,
  createAssessmentService,
  createInMemoryAssessmentCache,
  createInMemoryAssessmentCostMeter,
  toAssessmentTab,
} from "../../src/application/assessmentService.ts";
import type { AssessmentCacheKeyParts } from "../../src/application/assessmentService.ts";
import type { AssessmentService } from "../../src/application/assessmentService.ts";
import { MetaModelApiAdapter } from "../../src/adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import { EvidenceList } from "../../src/ports/assessmentModel.ts";
import { SecretString } from "../../src/ports/config.ts";
import type { AssessmentModelPort } from "../../src/ports/assessmentModel.ts";
import type { Result } from "../../src/domain/result.ts";
import { FakeAssessmentModelAdapter } from "../fakes/fakeAssessmentModel.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { createRestServer } from "../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../src/interfaces/rest/server.ts";
import { createMcpServer } from "../../src/interfaces/mcp/server.ts";
import type { McpServer } from "../../src/interfaces/mcp/server.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const fixtureDir = join(here, "..", "fixtures", "assessment");

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Placeholder calibration for tests only (K-210): finite test weights with
// no learned values, so scoring runs deterministically.
function placeholderArtifact(): FakeModelArtifactAdapter {
  const artifact: ModelArtifact = mustOk(
    parseModelArtifact({
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
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({
      artifact,
      checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))),
    }),
  );
}

// Placeholder catalogue for tests only: fixed risk mapping per capability
// key, so detection yields signals without carrying learned values.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const ADDRESS_A = "0x0102030405060708090a0b0c0d0e0f1011121314";
const ADDRESS_B = "0x1112131415161718191a1b1c1d1e1f2021222324";
const BYTECODE_A = `0x8063a9059cbb14600057${"00".repeat(10)}ff`;
const BYTECODE_B = `0x8063a9059cbb14600057${"00".repeat(12)}ff`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-s038-suite-only";
const TEST_PEPPER = "test-pepper-for-s038-suite-only";
const TEST_DAY = "2026-10-27";

const PROVIDERS = ["meta-model-api", "hosted-open-weights"] as const;
const MODEL_IDS = {
  "meta-model-api": "fake-meta-spark-1",
  "hosted-open-weights": "fake-open-weights-1",
} as const;

function prompt10(): PromptVersionType {
  return mustOk(PromptVersion.parse("1.0.0"));
}

function testVersions() {
  return {
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
  };
}

function buildStack(bytecodes?: ReadonlyMap<string, string>): {
  services: AppServices;
  rpcFake: FakeRpcAdapter;
} {
  const codes = new Map<string, string>([
    [mustOk(Address.parse(ADDRESS_A)) as string, BYTECODE_A],
    [mustOk(Address.parse(ADDRESS_B)) as string, BYTECODE_B],
  ]);
  if (bytecodes !== undefined) {
    for (const [address, code] of bytecodes) {
      codes.set(address, code);
    }
  }
  const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  const services = createAppServices({
    rpc: rpcFake,
    modelArtifacts: placeholderArtifact(),
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
  },
  mustDefaultDetectorSet());
  return { services, rpcFake };
}

function fakeAdapter(
  provider: (typeof PROVIDERS)[number],
  scenario?: "success" | "invalid-output" | "output-too-large",
): FakeAssessmentModelAdapter {
  return new FakeAssessmentModelAdapter({
    provider,
    modelId: MODEL_IDS[provider],
    ...(scenario === undefined ? {} : { scenario }),
  });
}

function assessmentServiceFor(
  services: AppServices,
  adapter: AssessmentModelPort | undefined,
  options?: {
    readonly promptVersion?: PromptVersionType | undefined;
    readonly dailyCapPerKey?: number | undefined;
    readonly sharedCache?: ReturnType<typeof createInMemoryAssessmentCache> | undefined;
    readonly sharedMeter?: ReturnType<typeof createInMemoryAssessmentCostMeter> | undefined;
  },
): AssessmentService {
  return createAssessmentService({
    analyze: services.analyzeToken,
    ...(adapter === undefined ? {} : { adapter }),
    promptVersion: options?.promptVersion ?? prompt10(),
    dailyCapPerKey: options?.dailyCapPerKey ?? 100,
    cache: options?.sharedCache ?? createInMemoryAssessmentCache(),
    meter: options?.sharedMeter ?? createInMemoryAssessmentCostMeter(),
  });
}

function analyzeInputFor(address: string, templateVersion?: TemplateVersionType) {
  const versions = testVersions();
  return {
    address: mustOk(Address.parse(address)),
    block: mustOk(BlockNumber.of(TEST_BLOCK)) as BlockNumberType,
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1761446400000)),
    modelVersion: versions.modelVersion,
    indexVersion: versions.indexVersion,
    templateVersion: templateVersion ?? versions.templateVersion,
    catalogue: TEST_CATALOGUE,
  };
}

// Canonical shape of the deterministic fields only: probabilities, score,
// signal ids and evidence selectors. The assessment field stays outside, so
// byte identity here proves scores and evidence never move (K-307).
function deterministicFingerprint(body: unknown): string {
  const record = body as Record<string, unknown>;
  const signals = Array.isArray(record["signals"])
    ? (record["signals"] as Array<Record<string, unknown>>).map((signal) => ({
        id: (signal["id"] as string | null) ?? null,
        evidence: (signal["evidence"] as unknown) ?? null,
      }))
    : null;
  return canonicalSerialize({
    probabilities: (record["probabilities"] as Record<string, number> | null) ?? null,
    score: (record["score"] as number | null) ?? null,
    signals: (signals as unknown as CanonicalValue) ?? null,
  });
}

describe("S-038 assessment service over fakes (K-305, K-309)", () => {
  test("k305_no_assessment_call_until_user_requests_assessment", async () => {
    for (const provider of PROVIDERS) {
      const { services } = buildStack();
      const adapter = fakeAdapter(provider);
      const assessment = assessmentServiceFor(services, adapter);
      const analysed = await services.analyzeToken(analyzeInputFor(ADDRESS_A));
      expect(analysed.ok).toBe(true);
      expect(adapter.callCount).toBe(0);
      const requested = await assessment.requestForToken({
        ...analyzeInputFor(ADDRESS_A),
        apiKeyId: "key-1",
        day: TEST_DAY,
      });
      expect(requested.ok).toBe(true);
      if (!requested.ok) {
        continue;
      }
      expect(requested.value.kind).toBe("assessed");
      expect(adapter.callCount).toBe(1);
    }
  });

  test("k305_daily_cost_cap_per_key_stops_assessment_calls", async () => {
    for (const provider of PROVIDERS) {
      const { services } = buildStack();
      const adapter = fakeAdapter(provider);
      const meter = createInMemoryAssessmentCostMeter();
      const assessment = assessmentServiceFor(services, adapter, {
        dailyCapPerKey: 1,
        sharedMeter: meter,
      });
      const first = await assessment.requestForToken({
        ...analyzeInputFor(ADDRESS_A),
        apiKeyId: "key-1",
        day: TEST_DAY,
      });
      expect(first.ok).toBe(true);
      expect(adapter.callCount).toBe(1);
      // Same key, uncached code hash: the cap closes the provider path and
      // the template explanation stands with zero new provider calls.
      const capped = await assessment.requestForToken({
        ...analyzeInputFor(ADDRESS_B),
        apiKeyId: "key-1",
        day: TEST_DAY,
      });
      expect(capped.ok).toBe(true);
      if (!capped.ok || capped.value.kind !== "assessed") {
        throw new Error("expected an assessed outcome with a fallback");
      }
      expect(adapter.callCount).toBe(1);
      expect(capped.value.assessment).toBeNull();
      expect(capped.value.fallback?.errorKind).toBe("rate-limited");
      expect((capped.value.fallback?.reason ?? "").length).toBeGreaterThan(0);
      expect(meter.consumed("key-1", provider, TEST_DAY)).toBe(1);
      // Another key still passes: per-key measurement, per provider.
      const otherKey = await assessment.requestForToken({
        ...analyzeInputFor(ADDRESS_B),
        apiKeyId: "key-2",
        day: TEST_DAY,
      });
      expect(otherKey.ok).toBe(true);
      expect(adapter.callCount).toBe(2);
      expect(meter.consumed("key-2", provider, TEST_DAY)).toBe(1);
    }
  });

  test("k305_refined_text_cached_per_codehash_and_template_version", async () => {
    for (const provider of PROVIDERS) {
      const { services } = buildStack();
      const adapter = fakeAdapter(provider);
      const cache = createInMemoryAssessmentCache();
      const assessment = assessmentServiceFor(services, adapter, { sharedCache: cache });
      const input = { ...analyzeInputFor(ADDRESS_A), apiKeyId: "key-1", day: TEST_DAY };
      const first = await assessment.requestForToken(input);
      const second = await assessment.requestForToken(input);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || first.value.kind !== "assessed" || !second.ok || second.value.kind !== "assessed") {
        throw new Error("expected assessed outcomes");
      }
      expect(adapter.callCount).toBe(1);
      expect(second.value.fromCache).toBe(true);
      expect(second.value.assessment?.text).toBe(first.value.assessment?.text);
      expect(second.value.assessment?.provider).toBe(provider);
      expect(second.value.assessment?.modelId).toBe(MODEL_IDS[provider]);
      // An unsupported template version fails the deterministic analysis
      // before any provider call: the template version gates the key and
      // the render alike, with zero new assessment calls.
      const otherTemplate = await assessment.requestForToken({
        ...analyzeInputFor(ADDRESS_A, mustOk(TemplateVersion.parse("9.9.9"))),
        apiKeyId: "key-1",
        day: TEST_DAY,
      });
      expect(otherTemplate.ok).toBe(false);
      expect(adapter.callCount).toBe(1);
      // A different prompt version misses as well.
      const otherPromptService = assessmentServiceFor(services, adapter, {
        promptVersion: mustOk(PromptVersion.parse("2.0.0")),
        sharedCache: cache,
      });
      const otherPrompt = await otherPromptService.requestForToken(input);
      expect(otherPrompt.ok).toBe(true);
      expect(adapter.callCount).toBe(2);
      // The other provider misses: provider and model id are key parts.
      const otherProvider = provider === "meta-model-api" ? "hosted-open-weights" : "meta-model-api";
      const otherAdapter = fakeAdapter(otherProvider);
      const otherProviderService = assessmentServiceFor(services, otherAdapter, { sharedCache: cache });
      const otherProviderResult = await otherProviderService.requestForToken(input);
      expect(otherProviderResult.ok).toBe(true);
      expect(otherAdapter.callCount).toBe(1);
      expect(adapter.callCount).toBe(2);
      // The full key is distinct per component: spot-check the encoding.
      const base: AssessmentCacheKeyParts = {
        codeHash: "deadbeef",
        promptVersion: "1.0.0",
        templateVersion: "1.0.0",
        provider,
        modelId: MODEL_IDS[provider],
      };
      const altered: readonly AssessmentCacheKeyParts[] = [
        { ...base, codeHash: "beefdead" },
        { ...base, promptVersion: "2.0.0" },
        { ...base, templateVersion: "2.0.0" },
        { ...base, provider: otherProvider, modelId: MODEL_IDS[otherProvider] },
        { ...base, modelId: "another-model-id" },
      ];
      const keys = new Set([assessmentCacheKeyOf(base), ...altered.map((entry) => assessmentCacheKeyOf(entry))]);
      expect(keys.size).toBe(1 + altered.length);
    }
  });

  test("k513_tampered_or_oversize_provider_response_rejected", async () => {
    for (const provider of PROVIDERS) {
      const { services } = buildStack();
      const plain = await services.analyzeToken(analyzeInputFor(ADDRESS_A));
      expect(plain.ok).toBe(true);
      for (const scenario of ["invalid-output", "output-too-large"] as const) {
        const adapter = fakeAdapter(provider, scenario);
        const assessment = assessmentServiceFor(services, adapter);
        const requested = await assessment.requestForToken({
          ...analyzeInputFor(ADDRESS_A),
          apiKeyId: "key-1",
          day: TEST_DAY,
        });
        expect(requested.ok).toBe(true);
        if (!requested.ok || requested.value.kind !== "assessed" || !plain.ok || plain.value.kind !== "assessed") {
          throw new Error("expected assessed outcomes");
        }
        // Tampered or oversize output never reaches the response: the
        // assessment stays null and the template explanation stands.
        expect(requested.value.assessment).toBeNull();
        expect(requested.value.fallback?.errorKind).toBe(scenario);
        expect(deterministicFingerprint(requested.value.envelope)).toBe(
          deterministicFingerprint(plain.value.envelope),
        );
      }
    }
    // Recorded tampered fixture through the real Meta adapter (K-513): an
    // unknown field fails validation and keeps the template standing.
    const tampered = new MetaModelApiAdapter({
      endpoint: "https://meta-api.example.invalid/assessment",
      apiKey: new SecretString("fake-meta-key-for-tests-only"),
      modelId: mustOk(ModelId.parse("meta-muse-spark-test-1")),
      transport: async () => ({
        status: 200,
        bodyText: readFileSync(join(fixtureDir, "meta-invalid-output.json"), "utf8"),
      }),
    });
    const code = mustOk(Bytecode.parse("0x6001600055"));
    const codeHash = mustOk(CodeHash.of(code));
    const evidence = mustOk(
      EvidenceList.create(codeHash, [
        mustOk(Evidence.create({ selector: mustOk(Selector.parse("0xa9059cbb")) })),
        mustOk(Evidence.create({ selector: mustOk(Selector.parse("0x70a08231")) })),
      ]),
    );
    const rejected = await tampered.assess(
      evidence,
      prompt10(),
      {
        requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
        deadline: mustOk(Timestamp.of(1761446400000)),
        block: "latest",
      },
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) {
      return;
    }
    expect(rejected.error.kind).toBe("invalid-output");
  });
});

describe("S-038 disabled wiring with no default provider (K-305, K-309)", () => {
  let rest: RestServer;
  let restBaseUrl: string;
  let mcp: McpServer;
  const adapter = fakeAdapter("meta-model-api");

  beforeAll(async () => {
    const { services } = buildStack();
    const versions = testVersions();
    rest = createRestServer({ detectors: mustDefaultDetectorSet(),
      services,
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      modelVersion: versions.modelVersion,
      indexVersion: versions.indexVersion,
      templateVersion: versions.templateVersion,
      catalogue: TEST_CATALOGUE,
    });
    restBaseUrl = await rest.listen("127.0.0.1", 0);
    const stack = buildStack();
    mcp = createMcpServer({ detectors: mustDefaultDetectorSet(),
      services: stack.services,
      modelVersion: versions.modelVersion,
      indexVersion: versions.indexVersion,
      templateVersion: versions.templateVersion,
      catalogue: TEST_CATALOGUE,
    });
  });

  afterAll(async () => {
    await rest.close();
  });

  test("k305_assessment_not_configured_without_provider", async () => {
    const authed = { headers: { "x-api-key": TEST_API_KEY } };
    const response = await fetch(`${restBaseUrl}/v1/assessment?address=${ADDRESS_A}`, authed);
    expect(response.status).toBe(501);
    const body = (await response.json()) as { code?: string; message?: string };
    expect(body.code).toBe("assessment-not-configured");
    expect(body.message ?? "").toContain("not configured");
    expect(adapter.callCount).toBe(0);
    const tool = await mcp.callTool("request_assessment", { address: ADDRESS_A });
    expect(tool.ok).toBe(false);
    if (tool.ok) {
      return;
    }
    expect(tool.error.code).toBe("assessment-not-configured");
    expect(adapter.callCount).toBe(0);
  });
});

describe("S-038 assessment end to end over REST and MCP (K-305, K-309)", () => {
  let rest: RestServer;
  let restBaseUrl: string;
  let mcp: McpServer;
  const adapters = {
    "meta-model-api": fakeAdapter("meta-model-api"),
    "hosted-open-weights": fakeAdapter("hosted-open-weights"),
  };

  let assessment: AssessmentService | undefined;

  beforeAll(async () => {
    const { services } = buildStack();
    const versions = testVersions();
    assessment = assessmentServiceFor(services, adapters["meta-model-api"]);
    rest = createRestServer({ detectors: mustDefaultDetectorSet(),
      services,
      apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      modelVersion: versions.modelVersion,
      indexVersion: versions.indexVersion,
      templateVersion: versions.templateVersion,
      catalogue: TEST_CATALOGUE,
      assessmentService: assessment,
    });
    restBaseUrl = await rest.listen("127.0.0.1", 0);
    const stack = buildStack();
    const mcpAssessment = assessmentServiceFor(stack.services, adapters["hosted-open-weights"]);
    mcp = createMcpServer({ detectors: mustDefaultDetectorSet(),
      services: stack.services,
      modelVersion: versions.modelVersion,
      indexVersion: versions.indexVersion,
      templateVersion: versions.templateVersion,
      catalogue: TEST_CATALOGUE,
      assessmentService: mcpAssessment,
    });
  });

  afterAll(async () => {
    await rest.close();
  });

  test("k305_assessment_works_over_rest_and_mcp", async () => {
    const authed = { headers: { "x-api-key": TEST_API_KEY } };
    const analysed = await fetch(`${restBaseUrl}/v1/analyze?address=${ADDRESS_A}`, authed);
    expect(analysed.status).toBe(200);
    const analysedBody = (await analysed.json()) as unknown;
    const assessed = await fetch(`${restBaseUrl}/v1/assessment?address=${ADDRESS_A}`, authed);
    expect(assessed.status).toBe(200);
    const assessedBody = (await assessed.json()) as Record<string, unknown>;
    const assessmentField = assessedBody["assessment"] as Record<string, unknown> | null;
    expect(assessmentField?.["text"]).toBe("Placeholder assessment text for tests only.");
    expect(assessmentField?.["provider"]).toBe("meta-model-api");
    expect(assessmentField?.["modelId"]).toBe("fake-meta-spark-1");
    // Scores and evidence never move: the deterministic fields match the
    // plain analysis byte for byte in fingerprint form.
    expect(deterministicFingerprint(assessedBody)).toBe(deterministicFingerprint(analysedBody));
    // The future UI tab reads the same contract from the service output.
    if (assessment === undefined) {
      throw new Error("expected the assessment service to be wired");
    }
    const direct = await assessment.requestForToken({
      ...analyzeInputFor(ADDRESS_A),
      apiKeyId: "tab-key",
      day: TEST_DAY,
    });
    expect(direct.ok).toBe(true);
    if (!direct.ok) {
      return;
    }
    const tab = toAssessmentTab(direct.value);
    expect(tab.state).toBe("ready");
    if (tab.state !== "ready") {
      return;
    }
    expect(tab.provider).toBe("meta-model-api");
    expect(tab.text).toBe("Placeholder assessment text for tests only.");
    const tool = await mcp.callTool("request_assessment", { address: ADDRESS_A });
    expect(tool.ok).toBe(true);
    if (!tool.ok) {
      return;
    }
    const text = tool.value.content[0]?.text ?? "";
    const mcpBody = JSON.parse(text) as Record<string, unknown>;
    const mcpAssessment = mcpBody["assessment"] as Record<string, unknown> | null;
    expect(mcpAssessment?.["provider"]).toBe("hosted-open-weights");
    expect(mcpAssessment?.["modelId"]).toBe("fake-open-weights-1");
    expect(deterministicFingerprint(mcpBody)).toBe(deterministicFingerprint(analysedBody));
  });

  test("k305_assessment_response_matches_published_schema", async () => {
    const schema = JSON.parse(readFileSync(join(repoRoot, "src", "interfaces", "rest", "schema", "v1.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const validator = new Ajv({ strict: true });
    const validate = validator.compile(schema);
    const authed = { headers: { "x-api-key": TEST_API_KEY } };
    const assessed = await fetch(`${restBaseUrl}/v1/assessment?address=${ADDRESS_A}`, authed);
    expect(assessed.status).toBe(200);
    const body = (await assessed.json()) as unknown;
    expect(validate(body)).toBe(true);
  });
});
