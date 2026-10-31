// Rendered personalize ids (P0-4): the route offers the rendered overview
// ids and the floor always includes the explanation card.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseModelArtifact } from "../../../../src/domain/risk.ts";
import type { Result } from "../../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  PromptVersion,
  TemplateVersion,
  Timestamp,
} from "../../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../../src/domain/signals.ts";
import { createAppServices } from "../../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../../src/application/analyzeToken.ts";
import { createPersonalizeService } from "../../../../src/application/personalizeService.ts";
import { requiredFlooredSections } from "../../../../src/application/personalizeService.ts";
import { PERSONALIZE_SECTION_IDS } from "../../../../src/plugins/personalizeSpec.ts";
import { SecretString } from "../../../../src/ports/config.ts";
import { validatePluginDocs } from "../../../../src/plugins/docs.ts";
import type { PluginDocsMap } from "../../../../src/plugins/exposure.ts";
import { capabilityDetectorPlugin } from "../../../../src/plugins/detectors/capability/index.ts";
import { mustDefaultDetectorSet } from "../../../helpers/detectorSets.ts";
import { FakeClockAdapter } from "../../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../../src/interfaces/rest/server.ts";
import type { PersonalizeInput } from "../../../../src/ports/pluginPersonalizeModel.ts";
import type { PersonalizeSpec, PersonalizeSpecContext } from "../../../../src/plugins/personalizeSpec.ts";
import { parsePersonalizeSpec } from "../../../../src/plugins/personalizeSpec.ts";
import { err, ok } from "../../../../src/domain/result.ts";
import type { PluginPersonalizeModelError, PluginPersonalizeModelPort } from "../../../../src/ports/pluginPersonalizeModel.ts";
import type { ModelId as ModelIdType } from "../../../../src/domain/types.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

class CapturingPersonalizeAdapter implements PluginPersonalizeModelPort {
  public seen: PersonalizeInput | null = null;

  provider(): "hosted-open-weights" {
    return "hosted-open-weights";
  }

  modelId(): ModelIdType {
    return "meta-models/muse-spark-open-1026" as ModelIdType;
  }

  async personalize(
    input: PersonalizeInput,
  ): Promise<Result<PersonalizeSpec, PluginPersonalizeModelError>> {
    this.seen = input;
    const context: PersonalizeSpecContext = {
      sectionIds: input.sectionIds,
      pluginIds: input.pluginIds,
      flooredSectionIds: input.flooredSectionIds,
      maxPlacements: 16,
      maxRanking: 16,
    };
    const offered = new Set(input.sectionIds);
    const scoreId = offered.has("score") ? "score" : "summary";
    const explanationId = offered.has("explanation") ? "explanation" : "evidence";
    const placements: { sectionId: string; emphasis: "normal" }[] = [];
    placements.push({ sectionId: scoreId, emphasis: "normal" });
    placements.push({ sectionId: explanationId, emphasis: "normal" });
    if (offered.has("signals")) {
      placements.push({ sectionId: "signals", emphasis: "normal" });
    }
    const checked = parsePersonalizeSpec(
      { specVersion: 1, pluginRanking: [], placements },
      context,
    );
    if (!checked.ok) {
      return err({ kind: "invalid-output", message: checked.error.message });
    }
    return ok(checked.value);
  }
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
const TEST_KEY = "test-key-for-rendered-ids-only";
const TEST_PEPPER = "test-pepper-for-rendered-ids-only";

describe("personalize route offers rendered ids with explanation floored (P0-4)", () => {
  test("the whitelist accepts explanation and keeps legacy ids", () => {
    for (const id of ["score", "explanation", "signals", "plugin-findings", "cant-tell"]) {
      expect(PERSONALIZE_SECTION_IDS).toContain(id);
    }
    for (const id of ["summary", "evidence", "assessment", "expert-detail"]) {
      expect(PERSONALIZE_SECTION_IDS).toContain(id);
    }
  });

  test("the service floor always includes explanation", () => {
    expect(requiredFlooredSections([])).toContain("explanation");
    expect(requiredFlooredSections([])).toContain("score");
  });

  test("the route offers rendered ids with explanation floored", async () => {
    const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
    const services: AppServices = createAppServices(
      {
        rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
        modelArtifacts: placeholderArtifact(),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      mustDefaultDetectorSet(),
    );
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = join(here, "..", "..", "..", "..");
    const markdown = readFileSync(join(repoRoot, "src/plugins/detectors/capability/PLUGIN.md"), "utf8");
    const checked = validatePluginDocs(capabilityDetectorPlugin.manifest, markdown);
    if (!checked.ok) {
      throw new Error(`capability docs must validate: ${checked.error.kind} ${checked.error.message}`);
    }
    const docsMap: PluginDocsMap = new Map([[checked.value.pluginId, checked.value]]);
    const capturing = new CapturingPersonalizeAdapter();
    const service = createPersonalizeService({ adapter: capturing });
    const rest = createRestServer({
      services,
      apiKeys: [new SecretString(TEST_KEY)] as readonly SecretString[],
      apiKeyPepper: new SecretString(TEST_PEPPER),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      detectors: mustDefaultDetectorSet(),
      pluginDocs: docsMap,
      personalizePromptVersion: mustOk(PromptVersion.parse("1.0.0")),
      personalizeService: service,
    } as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const response = await fetch(`${base}/v1/personalize`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": TEST_KEY },
        body: JSON.stringify({ address: TEST_ADDRESS, priorities: "Can the owner stop me selling?" }),
      });
      expect(response.status).toBe(200);
      expect(capturing.seen).not.toBe(null);
      expect(capturing.seen?.sectionIds).toEqual(["score", "explanation", "signals", "plugin-findings", "cant-tell"]);
      expect(capturing.seen?.flooredSectionIds).toContain("explanation");
      expect(capturing.seen?.flooredSectionIds).toContain("score");
    } finally {
      await rest.close();
    }
  });
});
