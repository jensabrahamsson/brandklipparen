// S-069/S-070 REST mapping route (K-519, P-27, P-28). POST
// /v1/personalize runs the frozen analysis, quotes priorities and
// frontmatter references as data, and answers the outcome envelope: an
// error kind means the deterministic baseline stands, never a partial
// spec. Written against the new route; the fake adapter keeps every call
// offline.
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
import { createPersonalizeService } from "../../../src/application/personalizeService.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { validatePluginDocs } from "../../../src/plugins/docs.ts";
import type { PluginDocsMap } from "../../../src/plugins/exposure.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
import { NotConfiguredPersonalizeAdapter } from "../../../src/adapters/personalize/hostedPersonalizeAdapter.ts";
import { FakePluginPersonalizeModelAdapter } from "../../fakes/fakePluginPersonalizeModel.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
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

function baseOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    services: testServices(),
    apiKeys: [new SecretString(TEST_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
    pluginDocs: docsMap(),
    personalizePromptVersion: mustOk(PromptVersion.parse("1.0.0")),
    ...extra,
  };
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

describe("POST /v1/personalize mapping route", () => {
  test("an ordered mapping answers the validated spec envelope", async () => {
    const service = createPersonalizeService({ adapter: new FakePluginPersonalizeModelAdapter("ordered") });
    const rest = createRestServer(baseOptions({ personalizeService: service }) as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status, json } = await postPersonalize(base, {
        address: TEST_ADDRESS,
        priorities: "Can the owner stop me selling?",
      });
      expect(status).toBe(200);
      const body = json as { personalize?: { kind?: unknown; spec?: { pluginRanking?: unknown; placements?: unknown[] } } };
      expect(body.personalize?.kind).toBe("ok");
      expect(body.personalize?.spec?.pluginRanking).toEqual([
        "dev.brandklipparen.transfer-limits",
        "dev.brandklipparen.transfer-hooks",
        "dev.brandklipparen.transfer-fee",
        "dev.brandklipparen.sell-block",
        "dev.brandklipparen.proxy-upgrade",
        "dev.brandklipparen.pause",
        "dev.brandklipparen.ownership",
        "dev.brandklipparen.mint",
        "dev.brandklipparen.hard-to-analyze",
        "dev.brandklipparen.decompiler",
        "dev.brandklipparen.clone-match",
        "dev.brandklipparen.capability",
        "dev.brandklipparen.blacklist",
      ]);
      expect(body.personalize?.spec?.placements?.length).toBeGreaterThan(0);
    } finally {
      await rest.close();
    }
  });

  test("an invalid model spec answers the error envelope, never a partial spec", async () => {
    const service = createPersonalizeService({ adapter: new FakePluginPersonalizeModelAdapter("invalid-output") });
    const rest = createRestServer(baseOptions({ personalizeService: service }) as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status, json } = await postPersonalize(base, {
        address: TEST_ADDRESS,
        priorities: "Can the owner stop me selling?",
      });
      expect(status).toBe(200);
      const body = json as { personalize?: { kind?: unknown; error?: unknown } };
      expect(body.personalize?.kind).toBe("error");
      expect(body.personalize?.error).toBe("invalid-output");
    } finally {
      await rest.close();
    }
  });

  test("a missing service answers the not-configured envelope", async () => {
    const rest = createRestServer(baseOptions() as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status, json } = await postPersonalize(base, {
        address: TEST_ADDRESS,
        priorities: "Can the owner stop me selling?",
      });
      expect(status).toBe(200);
      const body = json as { personalize?: { kind?: unknown; error?: unknown } };
      expect(body.personalize?.kind).toBe("error");
      expect(body.personalize?.error).toBe("not-configured");
    } finally {
      await rest.close();
    }
  });

  test("a missing key answers not-configured with zero sends", async () => {
    const service = createPersonalizeService({ adapter: new NotConfiguredPersonalizeAdapter() });
    const rest = createRestServer(baseOptions({ personalizeService: service }) as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status, json } = await postPersonalize(base, {
        address: TEST_ADDRESS,
        priorities: "Can fees change?",
      });
      expect(status).toBe(200);
      const body = json as { personalize?: { kind?: unknown; error?: unknown } };
      expect(body.personalize?.kind).toBe("error");
      expect(body.personalize?.error).toBe("not-configured");
    } finally {
      await rest.close();
    }
  });

  test("empty priorities are a client error, not a mapping call", async () => {
    const service = createPersonalizeService({ adapter: new FakePluginPersonalizeModelAdapter("ordered") });
    const rest = createRestServer(baseOptions({ personalizeService: service }) as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status } = await postPersonalize(base, { address: TEST_ADDRESS, priorities: "" });
      expect(status).toBe(400);
    } finally {
      await rest.close();
    }
  });
});
