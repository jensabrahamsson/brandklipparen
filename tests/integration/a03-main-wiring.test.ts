// S-105 composition main wiring (K-101, K-104): the composition function
// builds the app from the validated configuration without listening on a
// port. Rate limiting is required: a configuration without the rate-limit
// values fails as a typed missing-variable error, and a built app carries
// the limiter into both driving adapters. Non-first-party detectors run
// off the hot path through the plugin worker, admitted by the allowlist;
// an unadmitted non-first-party detector fails startup. Written first
// (red) per A-21: `buildApp` does not exist yet. No network; the worker
// runs the local fixture module and the allowlist keypair is ephemeral.
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { FakeCacheAdapter } from "../fakes/fakeCache.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import { SecretString } from "../../src/ports/config.ts";
import type { AppConfig } from "../../src/ports/config.ts";
import {
  canonicalPackageDigest,
  verifyPluginPackage,
} from "../../src/adapters/pluginAllowlist/allowlist.ts";
import type {
  Allowlist,
  PluginPackage,
} from "../../src/adapters/pluginAllowlist/allowlist.ts";
import { buildApp } from "../../src/composition/app.ts";
import { createRestServer } from "../../src/interfaces/rest/server.ts";
import { PLUGIN_API_VERSION, PluginManifest } from "../../src/plugins/api.ts";
import type { DetectorPlugin } from "../../src/plugins/detector.ts";
import {
  DEFAULT_DETECTOR_PLUGINS,
  buildPluginRegistry,
} from "../../src/plugins/registry.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const RUNNER_PATH = join(repoRoot, "src", "adapters", "pluginWorker", "detectorRunner.ts");
const ROUTED_MODULE_PATH = join(repoRoot, "tests", "fixtures", "pluginWorker", "workerRoutedDetector.ts");

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_API_KEY = "test-key-for-main-wiring-suite-only";
const TEST_PEPPER = "test-pepper-for-main-wiring-suite-only";

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

function baseConfig(): AppConfig {
  return Object.freeze({
    env: "ci",
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    modelArtifactPath: join(repoRoot, "model"),
    cloneIndexVersion: mustOk(IndexVersion.parse("1.0.0")),
    logLevel: "error",
    apiKeys: Object.freeze([new SecretString(TEST_API_KEY)]),
    apiKeyPepper: new SecretString(TEST_PEPPER),
    rateLimitPerKeyPerMinute: 1,
    quotaPerKeyPerDay: 100,
    globalRatePerMinute: 1000,
  });
}

function testPorts() {
  const codes = new Map<string, string>([
    [mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE],
  ]);
  return {
    rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
    modelArtifacts: placeholderArtifact(),
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    cache: new FakeCacheAdapter(),
  };
}

// Non-first-party detector entry: the in-process implementation throws,
// so an `ok` outcome proves the worker route; the module path beside it
// is the static worker entry the composition admits through the allowlist.
function workerRoutedEntry(): DetectorPlugin {
  const parsed = PluginManifest.parse({
    id: "dev.example.worker-routed",
    version: "1.0.0",
    kind: "detector",
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Worker-routed example detector",
    description: "Proves non-first-party detectors run off the hot path.",
    inputs: ["bytecode"],
    docs: "PLUGIN.md",
    outputSchema: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: ["id", "pluginId", "title", "payload", "evidence"],
        properties: {
          id: { type: "string", minLength: 1 },
          pluginId: { const: "dev.example.worker-routed" },
          title: { type: "string", minLength: 1 },
          payload: {
            type: "object",
            required: ["marker"],
            properties: { marker: { type: "string" } },
            additionalProperties: false,
          },
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["selector"],
              properties: {
                selector: { type: "string", minLength: 1 },
                offset: { type: ["integer", "null"], minimum: 0 },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    capabilities: { runsInFastPath: false },
    limits: { maxFindings: 8, maxEvidencePerFinding: 4, maxOutputBytes: 8192 },
  });
  if (!parsed.ok) {
    throw new Error(`worker-routed manifest failed validation: ${parsed.error.kind}`);
  }
  if (parsed.value.kind !== "detector") {
    throw new Error("worker-routed manifest carries the wrong kind");
  }
  return Object.freeze({
    manifest: parsed.value,
    detect: (): readonly never[] => {
      throw new Error("the worker-routed detector must run in the worker, never in-process");
    },
    modulePath: ROUTED_MODULE_PATH,
  });
}

function routedRegistry() {
  const built = buildPluginRegistry([...DEFAULT_DETECTOR_PLUGINS, workerRoutedEntry()]);
  if (!built.ok) {
    throw new Error(`routed registry failed to build: ${built.error.kind}`);
  }
  return built.value;
}

function routedPackage(): PluginPackage {
  return Object.freeze({
    pluginId: "dev.example.worker-routed",
    version: "1.0.0",
    files: Object.freeze([
      Object.freeze({
        path: "workerRoutedDetector.ts",
        text: readFileSync(ROUTED_MODULE_PATH, "utf8"),
      }),
    ]),
  });
}

function signingSetup(): { allowlist: Allowlist; package: PluginPackage } {
  const signingPair = generateKeyPairSync("ed25519");
  const verifier = signingPair.publicKey.export({ format: "jwk" });
  const pkg = routedPackage();
  const digest = canonicalPackageDigest(pkg);
  const payload = Buffer.from(`${pkg.pluginId}\n${pkg.version}\n${digest}`, "utf8");
  const signature = sign(null, payload, signingPair.privateKey).toString("hex");
  const allowlist: Allowlist = Object.freeze({
    signer: "test-main-wiring-signer",
    verifier,
    entries: Object.freeze([
      Object.freeze({ pluginId: pkg.pluginId, version: pkg.version, digest, signature }),
    ]),
  });
  const admitted = verifyPluginPackage(pkg, allowlist);
  if (!admitted.ok) {
    throw new Error("the test allowlist must admit the routed package");
  }
  return { allowlist, package: pkg };
}

describe("composition main wiring (S-105)", () => {
  test("a03_main_wires_rate_limiter_and_worker", async () => {
    // Rate limiting is required: a configuration without the rate-limit
    // values fails as a typed missing-variable error before any service,
    // adapter or listener is built.
    const unlimited = baseConfig();
    const { rateLimitPerKeyPerMinute: _droppedMinute, ...withoutLimits } = unlimited as Record<
      string,
      unknown
    >;
    void _droppedMinute;
    const { quotaPerKeyPerDay: _droppedDay, ...withoutQuota } = withoutLimits;
    void _droppedDay;
    const { globalRatePerMinute: _droppedGlobal, ...withoutGlobal } = withoutQuota;
    void _droppedGlobal;
    const missing = buildApp(withoutGlobal as AppConfig, { ports: testPorts() });
    if (missing.ok) {
      throw new Error("expected a configuration without rate limits to fail startup");
    }
    expect(missing.error).toMatchObject({
      kind: "missing-variable",
      variable: "BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE",
    });

    // An unadmitted non-first-party detector fails startup before any
    // import: the allowlist names no package for it.
    const unadmitted = buildApp(baseConfig(), {
      ports: testPorts(),
      detectors: Object.freeze({ registry: routedRegistry() }),
      detectorExecution: {
        runnerPath: RUNNER_PATH,
        timeoutMs: 5000,
        maxInputBytes: 32768,
        maxOutputBytes: 65536,
      },
    });
    if (unadmitted.ok) {
      throw new Error("expected an unadmitted non-first-party detector to fail startup");
    }
    expect(unadmitted.error).toMatchObject({
      kind: "invalid-value",
      variable: "BRANDKLIPPAREN_PLUGIN_ALLOWLIST",
    });

    // The admitted build carries the required limiter into both driving
    // adapters without listening on a port.
    const { allowlist, package: pkg } = signingSetup();
    const built = buildApp(baseConfig(), {
      ports: testPorts(),
      detectors: Object.freeze({ registry: routedRegistry() }),
      detectorExecution: {
        runnerPath: RUNNER_PATH,
        timeoutMs: 5000,
        maxInputBytes: 32768,
        maxOutputBytes: 65536,
      },
      allowlist,
      detectorPackages: Object.freeze({ "dev.example.worker-routed": pkg }),
    });
    if (!built.ok) {
      throw new Error(`expected the admitted build to succeed, got ${built.error.kind}`);
    }
    const app = built.value;
    expect(app.rateLimit).toEqual({
      perKeyPerMinute: 1,
      perKeyPerDay: 100,
      globalPerMinute: 1000,
    });
    expect(app.rest.rateLimit).toEqual(app.rateLimit);
    expect(app.mcp.rateLimit).toEqual(app.rateLimit);

    // The limiter is on: the first request analyses, the second identical
    // request is turned away with the machine-readable rate-limited error.
    const server = createRestServer(app.rest);
    try {
      const first = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(first.statusCode).toBe(200);
      const second = await server.inject({
        method: "GET",
        url: `/v1/analyze?address=${TEST_ADDRESS}`,
        headers: { "x-api-key": TEST_API_KEY },
      });
      expect(second.statusCode).toBe(429);
      expect((JSON.parse(second.body) as { code?: unknown }).code).toBe("rate-limited");
    } finally {
      await server.close();
    }

    // The non-first-party detector ran off the hot path: its in-process
    // stub throws, so `ok` proves the worker route, while the first-party
    // capability detector still runs inline beside it.
    const services = app.services;
    const analysed = await services.analyzeToken({
      address: mustOk(Address.parse(TEST_ADDRESS)),
      block: mustOk(BlockNumber.of(TEST_BLOCK)),
      requestId: mustOk(RequestId.generate(mustOk(Timestamp.of(1700000000000)))),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    if (!analysed.ok) {
      throw new Error(`expected analysis to succeed, got ${analysed.error.kind}`);
    }
    if (analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const byId = new Map(
      analysed.value.envelope.pluginResults.map((entry) => [entry.pluginId as string, entry]),
    );
    const routed = byId.get("dev.example.worker-routed");
    if (routed === undefined) {
      throw new Error("expected the worker-routed detector in pluginResults");
    }
    expect(routed.outcome).toBe("ok");
    expect(routed.findings.length).toBe(1);
    expect(byId.get("dev.brandklipparen.capability")?.outcome).toBe("ok");
  });
});
