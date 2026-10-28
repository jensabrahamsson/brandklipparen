// S-098 calibration read view (K-205, K-210, K-211) and S-099
// deploy-time readiness probe (K-104, K-402) over REST. Written first per
// A-21 (red): no `/v1/calibration` route, no `/ready` route and neither
// option exist yet, so every test below fails until the stories are
// implemented. In-process `inject` only; no listener is opened and no
// outbound network happens in this file.
import { describe, expect, test } from "vitest";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import type { ModelArtifact } from "../../../src/domain/risk.ts";
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
import { calibrationViewOf } from "../../../src/application/calibrationView.ts";
import { createExplainService } from "../../../src/application/explainService.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeExplainModelAdapter } from "../../fakes/fakeExplainModel.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";
import type { RestServer } from "../../../src/interfaces/rest/server.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function placeholderLoaded(): { artifact: ModelArtifact; checksum: string } {
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
  return { artifact, checksum: "cd".repeat(32) };
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_ADDRESS = "0x0405060708090a0b0c0d0e0f1011121314151617";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-ops-suite-only";
const TEST_PEPPER = "test-pepper-for-ops-suite-only";

function testServer(options?: {
  readonly expectedChecksum?: string | undefined;
}): { server: RestServer; artifacts: FakeModelArtifactAdapter } {
  const loaded = placeholderLoaded();
  const artifacts = new FakeModelArtifactAdapter(
    Object.freeze({ artifact: loaded.artifact, checksum: mustOk(ArtifactChecksum.parse(loaded.checksum)) }),
  );
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  const rpcFake = new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK)));
  const services: AppServices = createAppServices(
    {
      rpc: rpcFake,
      modelArtifacts: artifacts,
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
  const checksum = loaded.checksum;
  const server = createRestServer({
    services,
    apiKeys: [new SecretString(TEST_API_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
    calibration: calibrationViewOf(loaded.artifact, mustOk(ArtifactChecksum.parse(checksum))),
    explainService: createExplainService(new FakeExplainModelAdapter("ok")),
    readiness: {
      artifactChecksum: checksum,
      expectedArtifactChecksum: options?.expectedChecksum ?? checksum,
      feedConfigured: false,
    },
  });
  return { server, artifacts };
}

describe("calibration read view and readiness probe (S-098, S-099)", () => {
  test("s098_calibration_read_matches_frozen_artifact", async () => {
    const { server } = testServer();
    try {
      const response = await server.inject({
        method: "GET",
        url: "/v1/calibration",
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as { calibration?: unknown };
      const loaded = placeholderLoaded();
      const expected = JSON.parse(
        JSON.stringify(calibrationViewOf(loaded.artifact, mustOk(ArtifactChecksum.parse(loaded.checksum)))),
      ) as unknown;
      expect(body.calibration).toEqual(expected);
    } finally {
      await server.close();
    }
  });

  test("s098_calibration_read_is_read_only", async () => {
    const { server, artifacts } = testServer();
    try {
      const first = await server.inject({
        method: "GET",
        url: "/v1/calibration",
        headers: { "x-api-key": TEST_API_KEY },
      });
      const loadsBefore = artifacts.loadCalls;
      const second = await server.inject({
        method: "GET",
        url: "/v1/calibration",
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(second.statusCode).toBe(200);
      expect(second.body).toBe(first.body);
      // The read view serves a startup snapshot: no artifact load or write
      // happens across calls.
      expect(artifacts.loadCalls).toBe(loadsBefore);
    } finally {
      await server.close();
    }
  });

  test("s099_readiness_reports_artifact_and_provider_wiring", async () => {
    const { server } = testServer();
    try {
      const response = await server.inject({
        method: "GET",
        url: "/ready",
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        status?: unknown;
        artifactChecksum?: unknown;
        aiPlugins?: ReadonlyArray<{ id?: unknown; configured?: unknown }>;
        feed?: { configured?: unknown };
      };
      expect(body.status).toBe("ready");
      expect(body.artifactChecksum).toBe("cd".repeat(32));
      const byId = new Map((body.aiPlugins ?? []).map((entry) => [entry.id, entry.configured]));
      for (const id of ["assessment", "investigation", "personalize", "naming", "explain", "chat", "rug"]) {
        expect(byId.has(id)).toBe(true);
      }
      // Only the wired explain service reports configured; every other AI
      // plugin reports not-configured.
      expect(byId.get("explain")).toBe(true);
      expect(byId.get("chat")).toBe(false);
      expect(byId.get("rug")).toBe(false);
      expect(byId.get("assessment")).toBe(false);
      expect(body.feed?.configured).toBe(false);
    } finally {
      await server.close();
    }
  });

  test("s099_readiness_fails_on_checksum_mismatch", async () => {
    const { server } = testServer({ expectedChecksum: "ab".repeat(32) });
    try {
      const response = await server.inject({
        method: "GET",
        url: "/ready",
        headers: { "x-api-key": TEST_API_KEY },
      });
      // The probe fails instead of serving a ready analysis plane: 503
      // with the mismatch named and no analysis fields.
      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.body) as { status?: unknown; reason?: unknown; score?: unknown };
      expect(body.status).toBe("not-ready");
      expect(body.reason).toBe("artifact-checksum-mismatch");
      expect(body.score).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
