// S-067 frontmatter exposure (K-035, P-25): the registry plugin list
// carries each plugin's validated frontmatter (tags, audience, severity
// range) when the caller supplies the validated docs, so the web matcher
// reads the typed value, never raw markdown. REST and MCP carry the same
// bytes. Written first (red) per A-21: the exposure carries no
// frontmatter yet. No network; in-memory fakes only.
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
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../src/application/analyzeToken.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { validatePluginDocs } from "../../../src/plugins/docs.ts";
import type { PluginDocsMap } from "../../../src/plugins/exposure.ts";
import { capabilityDetectorPlugin } from "../../../src/plugins/detectors/capability/index.ts";
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
const TEST_KEY = "test-key-for-frontmatter-suite-only";
const TEST_PEPPER = "test-pepper-for-frontmatter-suite-only";

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

function serverOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    services: testServices(),
    apiKeys: [new SecretString(TEST_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
    ...extra,
  };
}

describe("frontmatter travels with the registry plugin list", () => {
  test("REST and MCP lists carry the same validated frontmatter per plugin", async () => {
    const docs = docsMap();
    const rest = createRestServer(serverOptions({ pluginDocs: docs }) as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const response = await fetch(`${base}/v1/plugins`, { headers: { "x-api-key": TEST_KEY } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        plugins: readonly {
          id?: unknown;
          frontmatter?: { tags?: unknown; audience?: unknown; severity?: unknown };
        }[];
      };
      const entry = body.plugins.find((candidate) => candidate.id === "dev.brandklipparen.capability");
      expect(entry?.frontmatter?.tags).toEqual(["owner-powers", "upgradeability"]);
      expect(entry?.frontmatter?.audience).toEqual(["holder", "auditor"]);
      expect(entry?.frontmatter?.severity).toEqual({ min: "low", max: "high" });

      const mcp = createMcpServer(serverOptions({ pluginDocs: docs }) as never);
      const called = await mcp.callTool("list_plugins", {}, { apiKey: TEST_KEY });
      if (!called.ok) {
        throw new Error(`expected list_plugins ok, got: ${called.error.message}`);
      }
      const text = called.value.content[0]?.text ?? "";
      const listed = JSON.parse(text) as { plugins: readonly { id?: unknown; frontmatter?: unknown }[] };
      const listedEntry = listed.plugins.find((candidate) => candidate.id === "dev.brandklipparen.capability");
      expect(listedEntry?.frontmatter).toEqual(entry?.frontmatter);
    } finally {
      await rest.close();
    }
  });

  test("without validated docs the list carries no frontmatter", async () => {
    const rest = createRestServer(serverOptions() as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const response = await fetch(`${base}/v1/plugins`, { headers: { "x-api-key": TEST_KEY } });
      const body = (await response.json()) as { plugins: readonly { frontmatter?: unknown }[] };
      for (const entry of body.plugins) {
        expect(entry.frontmatter).toBeUndefined();
      }
    } finally {
      await rest.close();
    }
  });
});
