// S-058 read view of the last CI audit report (K-516, K-031, K-026).
// The stored report is shown as advisory in REST and MCP with the three
// separate states (deterministic, ai, human-review) plus provider and
// model id; the read view alone never registers a plugin or changes a
// score. Written first (red) per A-21: the report module, the REST route
// and the MCP tool do not exist yet. All ports are in-memory fakes;
// no network happens here.
import { describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../src/application/analyzeToken.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import {
  serializeStoredAuditReport,
} from "../../../src/plugins/auditReport.ts";
import type { StoredAuditReport } from "../../../src/plugins/auditReport.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import { createMcpServer } from "../../../src/interfaces/mcp/server.ts";

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

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-audit-report-suite-only";
const TEST_PEPPER = "test-pepper-for-audit-report-suite-only";
const REPORT_ID = "dev.brandklipparen.capability";

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

function storedReport(): StoredAuditReport {
  return Object.freeze({
    pluginId: REPORT_ID,
    version: "1.0.0",
    deterministic: Object.freeze({ kind: "pass" }),
    ai: Object.freeze({
      kind: "advisory",
      findings: [],
      provider: "meta-model-api",
      modelId: "meta-models/muse-spark-open-1026",
    }),
    humanReview: "recorded",
  }) as StoredAuditReport;
}

function serverOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    services: testServices(),
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
    pluginAudits: new Map([[REPORT_ID, storedReport()]]),
    ...extra,
  };
}

describe("k516_last_audit_report_shown_as_advisory_with_provider_and_model", () => {
  test("REST and MCP carry the same three-state advisory report", async () => {
    const rest = createRestServer(serverOptions() as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const response = await fetch(`${base}/v1/plugins/${REPORT_ID}/audit`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["pluginId"]).toBe(REPORT_ID);
      const deterministic = body["deterministic"] as { kind?: unknown };
      const ai = body["ai"] as { kind?: unknown; provider?: unknown; modelId?: unknown };
      expect(deterministic.kind).toBe("pass");
      expect(ai.kind).toBe("advisory");
      expect(ai.provider).toBe("meta-model-api");
      expect(ai.modelId).toBe("meta-models/muse-spark-open-1026");
      expect(body["humanReview"]).toBe("recorded");

      const mcp = createMcpServer(serverOptions() as never);
      const called = await mcp.callTool("get_plugin_audit", { id: REPORT_ID }, { apiKey: TEST_API_KEY });
      if (!called.ok) {
        throw new Error(`expected MCP audit tool ok, got: ${called.error.message}`);
      }
      const text = called.value.content[0]?.text ?? "";
      expect(text).toBe(serializeStoredAuditReport(storedReport()));
      expect(JSON.parse(text)).toEqual(body);
    } finally {
      await rest.close();
    }
  });

  test("unknown plugin id gives the uniform not-found error in REST and MCP", async () => {
    const rest = createRestServer(serverOptions() as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const response = await fetch(`${base}/v1/plugins/dev.brandklipparen.unknown/audit`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.status).toBe(404);
      const mcp = createMcpServer(serverOptions() as never);
      const called = await mcp.callTool("get_plugin_audit", { id: "dev.brandklipparen.unknown" }, { apiKey: TEST_API_KEY });
      expect(called.ok).toBe(false);
    } finally {
      await rest.close();
    }
  });
});

describe("k516_clean_ai_report_alone_registers_no_plugin", () => {
  test("the read view leaves the registry and the analysis unchanged", async () => {
    const services = testServices();
    const before = createMcpServer(serverOptions({ services }) as never);
    const toolsBefore = before.listTools().map((tool) => tool.name);
    const rest = createRestServer(serverOptions({ services }) as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const listResponse = await fetch(`${base}/v1/plugins`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      const listBody = (await listResponse.json()) as { plugins?: readonly { id?: unknown }[] };
      const idsBefore = (listBody.plugins ?? []).map((entry) => entry.id);
      await fetch(`${base}/v1/plugins/${REPORT_ID}/audit`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      const after = createMcpServer(serverOptions({ services }) as never);
      expect(after.listTools().map((tool) => tool.name)).toEqual(toolsBefore);
      const listAgain = await fetch(`${base}/v1/plugins`, {
        headers: { "x-api-key": TEST_API_KEY },
      });
      const listAgainBody = (await listAgain.json()) as { plugins?: readonly { id?: unknown }[] };
      expect((listAgainBody.plugins ?? []).map((entry) => entry.id)).toEqual(idsBefore);
    } finally {
      await rest.close();
    }
  });
});
