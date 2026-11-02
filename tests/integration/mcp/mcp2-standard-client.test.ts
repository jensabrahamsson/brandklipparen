// MCP-2 standard client compatibility: env key fallback, protocol
// negotiation and MCP demo defaults. Stdio frames end to end, no network.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { loadConfig } from "../../../src/adapters/config/loader.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  createMcpServer,
} from "../../../src/interfaces/mcp/server.ts";
import type { McpServer } from "../../../src/interfaces/mcp/server.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { withMcpDefaults } from "../../../scripts/demo.ts";
import { loadMcpAppConfig } from "../../../src/main.ts";

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const ENV_KEY = "test-mcp-env-key-only";
const FRAME_KEY = "test-mcp-frame-key-only";
const WRONG_KEY = "test-mcp-wrong-key-only";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function placeholderServices(): AppServices {
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
  const codes = new Map<string, string>([
    [mustOk(Address.parse(TEST_ADDRESS)) as string, "0x6001600201"],
  ]);
  return createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(18000000))),
      modelArtifacts: new FakeModelArtifactAdapter(
        Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("ef".repeat(32))) }),
      ),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
}

function serverOptions() {
  return {
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: Object.freeze({
      selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
      delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
      call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
      "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
    }) as CapabilityCatalogue,
  };
}

function frame(method: string, params: unknown, id: number, extra?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params, ...(extra ?? {}) });
}

function keyedServer(extra?: Record<string, unknown>): McpServer {
  return createMcpServer({
    detectors: mustDefaultDetectorSet(),
    services: placeholderServices(),
    ...serverOptions(),
    apiKeys: [new SecretString(ENV_KEY), new SecretString(FRAME_KEY)],
    envApiKey: new SecretString(ENV_KEY),
    ...(extra ?? {}),
  } as Parameters<typeof createMcpServer>[0]);
}

describe("MCP-2 protocol negotiation", () => {
  test("supported versions are negotiated, unsupported falls back to latest", async () => {
    expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toContain("2025-06-18");
    expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toContain("2025-03-26");
    expect(SUPPORTED_MCP_PROTOCOL_VERSIONS).toContain("2024-11-05");
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
    const mcp = keyedServer();
    for (const version of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const opened = JSON.parse(
        await mcp.handleJsonRpc(
          frame("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "c", version: "0" } }, 1),
        ),
      ) as { result?: { protocolVersion?: unknown }; error?: unknown };
      expect(opened.error).toBeUndefined();
      expect(opened.result?.protocolVersion).toBe(version);
    }
    for (const params of [{ protocolVersion: "1999-01-01" }, { protocolVersion: "2026-01-01" }, {}, { protocolVersion: 42 }]) {
      const opened = JSON.parse(await mcp.handleJsonRpc(frame("initialize", params, 2))) as {
        result?: { protocolVersion?: unknown; serverInfo?: unknown };
        error?: unknown;
      };
      expect(opened.error).toBeUndefined();
      expect(opened.result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(opened.result?.serverInfo).toMatchObject({ name: "brandklipparen-mcp" });
    }
  });
});

describe("MCP-2 env key fallback (stdio frames)", () => {
  test("frame without auth uses env key, frame auth wins", async () => {
    const mcp = keyedServer();
    // No auth field: standard client shape, env key supplies the key.
    const noAuth = JSON.parse(
      await mcp.handleJsonRpc(frame("tools/call", { name: "assess_token", arguments: { address: TEST_ADDRESS } }, 1)),
    ) as { result?: unknown; error?: { data?: { code?: unknown } } };
    expect(noAuth.error).toBeUndefined();
    expect(noAuth.result).toBeDefined();

    // Frame auth wins over env key: wrong frame key fails even though env is valid.
    const wrongFrame = JSON.parse(
      await mcp.handleJsonRpc(
        frame("tools/call", { name: "assess_token", arguments: { address: TEST_ADDRESS } }, 2, { auth: WRONG_KEY }),
      ),
    ) as { error?: { data?: { code?: unknown } } };
    expect(wrongFrame.error?.data?.code).toBe("invalid-api-key");

    // Frame auth wins the other way: valid frame key works when env key is wrong.
    const wrongEnv = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services: placeholderServices(),
      ...serverOptions(),
      apiKeys: [new SecretString(ENV_KEY), new SecretString(FRAME_KEY)],
      envApiKey: new SecretString(WRONG_KEY),
    } as Parameters<typeof createMcpServer>[0]);
    const frameWins = JSON.parse(
      await wrongEnv.handleJsonRpc(
        frame("tools/call", { name: "assess_token", arguments: { address: TEST_ADDRESS } }, 3, { auth: FRAME_KEY }),
      ),
    ) as { result?: unknown; error?: unknown };
    expect(frameWins.error).toBeUndefined();
    expect(frameWins.result).toBeDefined();
    // And without frame auth the wrong env key is rejected, not silently passed.
    const envWrong = JSON.parse(
      await wrongEnv.handleJsonRpc(frame("tools/call", { name: "assess_token", arguments: { address: TEST_ADDRESS } }, 4)),
    ) as { error?: { data?: { code?: unknown } } };
    expect(envWrong.error?.data?.code).toBe("invalid-api-key");
  });

  test("callTool without options uses env key and per-key caps still apply", async () => {
    const mcp = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services: placeholderServices(),
      ...serverOptions(),
      apiKeys: [new SecretString(ENV_KEY)],
      envApiKey: new SecretString(ENV_KEY),
      rateLimit: { perKeyPerMinute: 1, perKeyPerDay: 100, globalPerMinute: 100 },
      rateLimitNowMs: () => 1700000000000,
    } as Parameters<typeof createMcpServer>[0]);
    const first = await mcp.callTool("assess_token", { address: TEST_ADDRESS });
    expect(first.ok).toBe(true);
    const second = await mcp.callTool("assess_token", { address: TEST_ADDRESS });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("rate-limited");
    }
  });

  test("no env key and no frame auth still gives missing-api-key", async () => {
    const mcp = createMcpServer({
      detectors: mustDefaultDetectorSet(),
      services: placeholderServices(),
      ...serverOptions(),
      apiKeys: [new SecretString(ENV_KEY)],
    });
    const parsed = JSON.parse(
      await mcp.handleJsonRpc(frame("tools/call", { name: "assess_token", arguments: { address: TEST_ADDRESS } }, 1)),
    ) as { error?: { data?: { code?: unknown } } };
    expect(parsed.error?.data?.code).toBe("missing-api-key");
  });
});

describe("MCP-2 BRANDKLIPPAREN_MCP_API_KEY_FILE config", () => {
  function baseCiEnv(): Record<string, string | undefined> {
    return {
      BRANDKLIPPAREN_ENV: "ci",
      BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
      BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
      BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
      BRANDKLIPPAREN_LOG_LEVEL: "info",
    };
  }

  test("pointer file resolves with the same *_FILE rules", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp2-key-"));
    const path = join(dir, "mcp-key.txt");
    writeFileSync(path, `${ENV_KEY}\n`, "utf8");
    const loaded = loadConfig(
      { ...baseCiEnv(), BRANDKLIPPAREN_MCP_API_KEY_FILE: path },
      { readSecretFile: (p) => readFileSync(p, "utf8") },
    );
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const cfg = loaded.value as unknown as { mcpApiKey?: SecretString; envApiKey?: SecretString };
      const key = cfg.mcpApiKey ?? cfg.envApiKey;
      expect(key?.reveal()).toBe(ENV_KEY);
      expect(JSON.stringify(loaded.value).includes(ENV_KEY)).toBe(false);
    }
    // Both forms set is an error naming the target, without values.
    const both = loadConfig(
      { ...baseCiEnv(), BRANDKLIPPAREN_MCP_API_KEY: ENV_KEY, BRANDKLIPPAREN_MCP_API_KEY_FILE: path },
      { readSecretFile: (p) => readFileSync(p, "utf8") },
    );
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.error.variable).toBe("BRANDKLIPPAREN_MCP_API_KEY");
    }
    // Unreadable pointer is an error naming the pointer.
    const missing = loadConfig(
      { ...baseCiEnv(), BRANDKLIPPAREN_MCP_API_KEY_FILE: join(dir, "absent.txt") },
      { readSecretFile: (p) => readFileSync(p, "utf8") },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.variable).toBe("BRANDKLIPPAREN_MCP_API_KEY_FILE");
    }
    // Direct value also loads.
    const direct = loadConfig({ ...baseCiEnv(), BRANDKLIPPAREN_MCP_API_KEY: ENV_KEY });
    expect(direct.ok).toBe(true);
    if (direct.ok) {
      const cfg = direct.value as unknown as { mcpApiKey?: SecretString };
      expect(cfg.mcpApiKey?.reveal()).toBe(ENV_KEY);
    }
  });
});

describe("MCP-2 start:mcp defaults", () => {
  test("only RPC URL (and optional key pointers) are needed after defaults", () => {
    const minimal = { BRANDKLIPPAREN_RPC_URLS: "https://rpc.example.invalid" };
    const { env } = withMcpDefaults(minimal);
    // User value wins, everything else is the safe demo default.
    expect(env["BRANDKLIPPAREN_RPC_URLS"]).toBe("https://rpc.example.invalid");
    const loaded = loadConfig(env);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.rateLimitPerKeyPerMinute).toBeDefined();
      expect(loaded.value.quotaPerKeyPerDay).toBeDefined();
      expect(loaded.value.globalRatePerMinute).toBeDefined();
      expect(loaded.value.modelVersion).toBeDefined();
      expect(loaded.value.rpcUrls?.[0]?.reveal()).toBe("https://rpc.example.invalid");
    }
    // Even with no RPC override the defaults load (key-free public RPC).
    const bare = loadConfig(withMcpDefaults({}).env);
    expect(bare.ok).toBe(true);
  });

  test("loadMcpAppConfig applies defaults and resolves the MCP key pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp2-main-"));
    const path = join(dir, "mcp-key.txt");
    writeFileSync(path, `${ENV_KEY}\n`, "utf8");
    const config = loadMcpAppConfig(
      {
        BRANDKLIPPAREN_RPC_URLS: "https://rpc.example.invalid",
        BRANDKLIPPAREN_API_KEYS: `${ENV_KEY},${FRAME_KEY}`,
        BRANDKLIPPAREN_MCP_API_KEY_FILE: path,
      },
      (p) => readFileSync(p, "utf8"),
    );
    expect(config.rpcUrls?.[0]?.reveal()).toBe("https://rpc.example.invalid");
    expect(config.mcpApiKey?.reveal()).toBe(ENV_KEY);
    expect(config.rateLimitPerKeyPerMinute).toBeDefined();
  });
});
