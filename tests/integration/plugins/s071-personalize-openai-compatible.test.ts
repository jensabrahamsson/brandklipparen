// Composition and route proof for the generic-compatible personalize
// provider (brief 41, S-069, P-27). The validated configuration wires a
// PersonalizeService over a recorded chat-completions transport: POST
// /v1/personalize returns a validated spec, invalid model output falls
// back deterministically, and the status and health responses report the
// configured provider and model id honestly. No test reaches the network.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  PromptVersion,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../src/application/analyzeToken.ts";
import { loadConfig } from "../../../src/adapters/config/loader.ts";
import { createPersonalizeServiceFromConfig } from "../../../src/composition/root.ts";
import type { GenericCompatiblePersonalizeTransport } from "../../../src/adapters/personalize/GenericCompatiblePersonalizeAdapter.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { validatePluginDocs } from "../../../src/plugins/docs.ts";
import type { PluginDocsMap } from "../../../src/plugins/exposure.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";

const MODEL_ID = "fake-compat-model-1";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function compatEnv(): Record<string, string | undefined> {
  return {
    BRANDKLIPPAREN_ENV: "ci",
    BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
    BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
    BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
    BRANDKLIPPAREN_LOG_LEVEL: "info",
    BRANDKLIPPAREN_PERSONALIZE_PROVIDER: "generic-compatible",
    BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-compat-key-for-tests-only",
    BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_MODEL_ID: MODEL_ID,
    BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_BASE_URL: "https://compat.example.invalid",
  };
}

function placeholderArtifact(): FakeModelArtifactAdapter {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: { timeout: 0.4, "resource-limit": 0.4, "decompiler-error": 0.6, "obfuscated-structure": 0.6 },
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
    Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))) }),
  );
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_KEY = "test-key-for-personalize-route-only";
const TEST_PEPPER = "test-pepper-for-personalize-route-only";

function testServices(): AppServices {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  return createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
      modelArtifacts: placeholderArtifact(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
}

function docsMap(): PluginDocsMap {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const markdown = readFileSync(join(repoRoot, "src/plugins/detectors/capability/PLUGIN.md"), "utf8");
  const checked = validatePluginDocs(capabilityDetectorPlugin.manifest, markdown);
  if (!checked.ok) {
    throw new Error(`capability docs must validate: ${checked.error.kind} ${checked.error.message}`);
  }
  return new Map([[checked.value.pluginId, checked.value]]);
}

// Recorded mapping transport: reads the request's closed id lists and
// echoes a valid spec over them, so the route proof stays independent of
// fixture plugin counts. Invalid input to the transport is impossible:
// the adapter validates the request before sending.
function echoTransport(): GenericCompatiblePersonalizeTransport {
  return async (_url, init) => {
    const body = JSON.parse(init.body) as { messages?: { content?: unknown }[] };
    const user = JSON.parse(String(body.messages?.[1]?.content ?? "{}")) as {
      sectionIds?: unknown;
      pluginIds?: unknown;
    };
    const sectionIds = Array.isArray(user.sectionIds) ? (user.sectionIds as string[]) : [];
    const pluginIds = Array.isArray(user.pluginIds) ? (user.pluginIds as string[]) : [];
    const wanted = ["signals", "score", "explanation"];
    const placements = wanted
      .filter((id) => sectionIds.includes(id))
      .map((sectionId) => ({ sectionId, emphasis: "normal" }));
    if (!placements.some((placement) => placement.sectionId === "score")) {
      placements.push({ sectionId: "score", emphasis: "normal" });
    }
    if (!placements.some((placement) => placement.sectionId === "explanation")) {
      placements.push({ sectionId: "explanation", emphasis: "normal" });
    }
    return {
      status: 200,
      bodyText: JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                provider: "generic-compatible",
                modelId: MODEL_ID,
                spec: { specVersion: 1, pluginRanking: pluginIds, placements },
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
    };
  };
}

function invalidTransport(): GenericCompatiblePersonalizeTransport {
  return async () => ({ status: 200, bodyText: "not json {" });
}

async function buildServer(
  transport: GenericCompatiblePersonalizeTransport,
): Promise<ReturnType<typeof createRestServer>> {
  const loaded = loadConfig(compatEnv());
  if (!loaded.ok) {
    throw new Error(`expected the test config to load: ${loaded.error.kind}`);
  }
  const built = createPersonalizeServiceFromConfig(loaded.value, { transport });
  if (!built.ok || built.value === undefined) {
    throw new Error("expected the personalize service to be wired");
  }
  expect(built.value.provider).toBe("generic-compatible");
  expect(built.value.modelId).toBe(MODEL_ID);
  return createRestServer({
    services: testServices(),
    apiKeys: [new SecretString(TEST_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
    pluginDocs: docsMap(),
    personalizeService: built.value,
    personalizePromptVersion: mustOk(PromptVersion.parse("1.0.0")),
  } as never);
}

async function postPersonalize(
  base: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}/v1/personalize`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TEST_KEY },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as unknown };
}

describe("POST /v1/personalize over the generic-compatible provider", () => {
  test("a validated spec answers with the configured provider and model id", async () => {
    const rest = await buildServer(echoTransport());
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status, json } = await postPersonalize(base, {
        address: TEST_ADDRESS,
        priorities: "Can the owner stop me selling?",
      });
      expect(status).toBe(200);
      const body = json as {
        personalize?: { kind?: unknown; spec?: { pluginRanking?: unknown; placements?: unknown[] }; provider?: unknown; modelId?: unknown };
      };
      expect(body.personalize?.kind).toBe("ok");
      expect(body.personalize?.provider).toBe("generic-compatible");
      expect(body.personalize?.modelId).toBe(MODEL_ID);
      expect(Array.isArray(body.personalize?.spec?.pluginRanking)).toBe(true);
      expect(body.personalize?.spec?.placements?.length).toBeGreaterThan(0);
    } finally {
      await rest.close();
    }
  });

  test("invalid model output falls back deterministically with no partial spec", async () => {
    const rest = await buildServer(invalidTransport());
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status, json } = await postPersonalize(base, {
        address: TEST_ADDRESS,
        priorities: "Can the owner stop me selling?",
      });
      expect(status).toBe(200);
      const body = json as { personalize?: { kind?: unknown; error?: unknown; spec?: unknown } };
      expect(body.personalize?.kind).toBe("error");
      expect(body.personalize?.error).toBe("invalid-output");
      expect(body.personalize?.spec).toBeUndefined();
    } finally {
      await rest.close();
    }
  });

  test("status and health report the configured provider and model id", async () => {
    const rest = await buildServer(echoTransport());
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const statusResponse = await fetch(`${base}/v1/personalize/status`, {
        headers: { "x-api-key": TEST_KEY },
      });
      expect(statusResponse.status).toBe(200);
      const statusBody = (await statusResponse.json()) as {
        personalize?: { provider?: unknown; modelId?: unknown };
      };
      expect(statusBody.personalize).toEqual({ provider: "generic-compatible", modelId: MODEL_ID });
      const healthResponse = await fetch(`${base}/health`);
      expect(healthResponse.status).toBe(200);
      const healthBody = (await healthResponse.json()) as {
        personalize?: { provider?: unknown; modelId?: unknown };
      };
      expect(healthBody.personalize).toEqual({ provider: "generic-compatible", modelId: MODEL_ID });
    } finally {
      await rest.close();
    }
  });

  test("the small default daily cap rate-limits the sixth mapping call", async () => {
    const rest = await buildServer(echoTransport());
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const errors: unknown[] = [];
      for (let index = 1; index <= 6; index += 1) {
        const { json } = await postPersonalize(base, {
          address: TEST_ADDRESS,
          priorities: `mapping priority number ${index} for the daily cap`,
        });
        const body = json as { personalize?: { kind?: unknown; error?: unknown } };
        if (body.personalize?.kind !== "ok") {
          errors.push(body.personalize?.error);
        }
      }
      expect(errors).toEqual(["rate-limited"]);
    } finally {
      await rest.close();
    }
  });
});
