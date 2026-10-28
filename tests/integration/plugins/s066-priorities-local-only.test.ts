// S-066 priorities never leave the device (K-035, P-24, H-26/M-32).
// The priorities text lives under one versioned `localStorage` key in
// the browser only: no REST field, no MCP field and no cache key ever
// carries it, so the key name and any canary text are absent from every
// REST/MCP response. Written first (red) per A-21 — run before the
// matcher UI lands to prove the server half holds. No network; the only
// randomness is the request id.
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
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
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
const TEST_KEY = "test-key-for-priorities-suite-only";
const TEST_PEPPER = "test-pepper-for-priorities-suite-only";

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

function serverOptions(): Record<string, unknown> {
  return {
    services: testServices(),
    apiKeys: [new SecretString(TEST_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
  };
}

describe("k519_priorities_absent_from_logs_cache_and_responses", () => {
  test("no REST or MCP response carries a priorities field or the storage key", async () => {
    const canary = "brandklipparen-user-priorities";
    const rest = createRestServer(serverOptions() as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const headers = { "x-api-key": TEST_KEY };
      const analyze = await fetch(
        `${base}/v1/analyze?address=${TEST_ADDRESS}&block=${TEST_BLOCK}`,
        { headers },
      );
      expect(analyze.status).toBe(200);
      const analyzeText = await analyze.text();
      expect(analyzeText).not.toContain("priorities");
      expect(analyzeText).not.toContain(canary);

      const plugins = await fetch(`${base}/v1/plugins`, { headers });
      const pluginsText = await plugins.text();
      expect(pluginsText).not.toContain("priorities");
      expect(pluginsText).not.toContain(canary);

      const mcp = createMcpServer(serverOptions() as never);
      const assessed = await mcp.callTool("assess_token", { address: TEST_ADDRESS }, { apiKey: TEST_KEY });
      if (!assessed.ok) {
        throw new Error(`expected assess_token ok, got: ${assessed.error.message}`);
      }
      const assessedText = assessed.value.content.map((block) => block.text).join("\n");
      expect(assessedText).not.toContain("priorities");
      expect(assessedText).not.toContain(canary);

      const listed = await mcp.callTool("list_plugins", {}, { apiKey: TEST_KEY });
      if (!listed.ok) {
        throw new Error(`expected list_plugins ok, got: ${listed.error.message}`);
      }
      const listedText = listed.value.content.map((block) => block.text).join("\n");
      expect(listedText).not.toContain("priorities");
      expect(listedText).not.toContain(canary);
    } finally {
      await rest.close();
    }
  });
});
