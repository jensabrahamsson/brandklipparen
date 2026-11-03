// Process entry point for the served app (S-105, K-101, K-104).
// `npm run start:rest` serves the versioned REST API; `npm run start:mcp`
// serves the MCP server over stdio. Both modes build the app through the
// single composition function `buildApp` (config to adapters to services
// to REST/MCP), which requires rate limiting and routes non-first-party
// detectors through the plugin worker behind the allowlist. The process
// starts no daemon, no watch mode and no timer: REST binds one listener
// and MCP reads stdin until it closes. Ethereum mainnet only.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withMcpDefaults } from "../scripts/demo.ts";
import { loadConfig } from "./adapters/config/loader.ts";
import { InternalDecompilerAdapter } from "./adapters/decompiler/internalDecompilerAdapter.ts";
import {
  DEFAULT_CHAIN_RECHECK_INTERVAL_MS,
  fetchRpcTransport,
  verifyMainnetChainId,
} from "./adapters/rpc/jsonRpcAdapter.ts";
import { InMemoryCacheAdapter } from "./adapters/cache/inMemoryCache.ts";
import { FileModelArtifactAdapter } from "./adapters/model/fileArtifact.ts";
import { createRpcAdapterFromConfig } from "./adapters/rpc/jsonRpcAdapter.ts";
import { buildApp } from "./composition/app.ts";
import { createRestServer } from "./interfaces/rest/server.ts";
import { createMcpServer, serveStdio } from "./interfaces/mcp/server.ts";
import { Timestamp } from "./domain/types.ts";
import type { Timestamp as TimestampType } from "./domain/types.ts";
import { formatConfigError } from "./ports/config.ts";
import type { ClockPort } from "./ports/clock.ts";
import type { Allowlist } from "./adapters/pluginAllowlist/allowlist.ts";
import type { AnalyzeTokenPorts } from "./application/analyzeToken.ts";
import type { AppConfig } from "./ports/config.ts";

// Wall-clock reader for the served app (A-05, K-102): production passes
// the real clock while tests inject fakes. The range check is
// unreachable for a live clock; it fails fast instead of serving a
// degraded timestamp.
function systemClock(): ClockPort {
  return Object.freeze({
    now: (): TimestampType => {
      const parsed = Timestamp.of(Date.now());
      if (!parsed.ok) {
        throw new Error("the wall clock is outside the valid timestamp range");
      }
      return parsed.value;
    },
  });
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function usage(): never {
  fail("usage: start:rest | start:mcp [--allowlist <path>]");
}

// Allowlist for separately published detectors (S-049, S-105): an
// optional JSON file carrying the signed allowlist value. Without it the
// default first-party registry needs no admission and the builder fails
// closed on any non-first-party entry.
function loadAllowlist(path: string | null): Allowlist | undefined {
  if (path === null) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    fail(`the allowlist file at ${path} is not readable JSON`);
  }
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { entries?: unknown }).entries)) {
    fail(`the allowlist file at ${path} holds no allowlist entries`);
  }
  return raw as Allowlist;
}

function allowlistFlag(argv: readonly string[]): string | null {
  const flag = argv.indexOf("--allowlist");
  if (flag === -1) {
    return null;
  }
  const path = argv[flag + 1];
  if (path === undefined || path.length === 0) {
    fail("--allowlist needs a file path");
  }
  return path;
}

// One `eth_chainId` check per process start (S-108, K-001): the endpoint
// must answer mainnet before the process builds or serves anything.
export async function startupPorts(config: AppConfig): Promise<AnalyzeTokenPorts> {
  const rpc = createRpcAdapterFromConfig({
    rpcUrls: config.rpcUrls,
    rpcDeadlineMs: config.rpcDeadlineMs,
    rpcMaxResponseBytes: config.rpcMaxResponseBytes,
    rpcMaxConcurrency: config.rpcMaxConcurrency,
    // SEC-1 S-3: re-check mainnet at most once every 10 minutes.
    chainRecheckIntervalMs: DEFAULT_CHAIN_RECHECK_INTERVAL_MS,
  });
  if (!rpc.ok) {
    fail(formatConfigError(rpc.error));
  }
  const firstUrl = config.rpcUrls?.[0];
  const verified = await verifyMainnetChainId(
    firstUrl === undefined ? "" : firstUrl.reveal(),
    fetchRpcTransport,
    config.rpcDeadlineMs ?? 15000,
  );
  if (!verified.ok) {
    fail(
      verified.error.kind === "chain-mismatch"
        ? "the RPC endpoint is not Ethereum mainnet (chainId 1 required)"
        : `the chain id check failed: ${verified.error.message}`,
    );
  }
  // The internal decompiler is always bound: it runs in-process with
  // no binary to discover and no setup where it stays unset.
  return Object.freeze({
    rpc: rpc.value,
    // The config value names the artifact file (docs/infrastructure.md); the
    // adapter resolves `artifact-<version>.json` inside its directory.
    modelArtifacts: new FileModelArtifactAdapter(dirname(config.modelArtifactPath)),
    clock: systemClock(),
    decompiler: new InternalDecompilerAdapter(),
    cache: new InMemoryCacheAdapter(),
  });
}

export { withMcpDefaults };

export function loadAppConfig(): AppConfig {
  // `start:rest` and `start:mcp` honour `<NAME>_FILE` secret pointers
  // (C-28, F-29): the real file reader is injected here, so the loader
  // itself performs no I/O.
  const loaded = loadConfig(process.env, { readSecretFile: (path) => readFileSync(path, "utf8") });
  if (!loaded.ok) {
    fail(formatConfigError(loaded.error));
  }
  return loaded.value;
}

// MCP config (MCP-2): the same safe defaults as `npm run demo`, reusing
// the demo default helper, so a standard client config only needs the
// RPC URL and optional key pointers. Names only are logged, on stderr,
// never values, and stdout stays the JSON-RPC channel.
export function loadMcpAppConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  readSecretFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AppConfig {
  const { env: defaulted, applied } = withMcpDefaults(env);
  if (applied.length > 0) {
    process.stderr.write(`brandklipparen mcp: defaults applied for: ${applied.join(", ")}\n`);
  }
  const loaded = loadConfig(defaulted, { readSecretFile });
  if (!loaded.ok) {
    fail(formatConfigError(loaded.error));
  }
  return loaded.value;
}

export const loadMcpConfig = loadMcpAppConfig;

async function startRest(allowlistPath: string | null): Promise<void> {
  const config = loadAppConfig();
  const built = buildApp(config, {
    ports: await startupPorts(config),
    allowlist: loadAllowlist(allowlistPath),
  });
  if (!built.ok) {
    fail(
      built.error.kind === "missing-variable" || built.error.kind === "invalid-value"
        ? formatConfigError(built.error)
        : `detector registry failed to build: ${built.error.kind}`,
    );
  }
  const server = createRestServer(built.value.rest);
  // The live new-tokens feed runs only under the REST/demo runtime: the
  // service polls after start() and stops cleanly on shutdown, so tests
  // and CLI one-shots that never call start() stay idle with no timers.
  built.value.liveTokens.start();
  const port = config.httpPort ?? 8080;
  const baseUrl = await server.listen("127.0.0.1", port);
  process.stdout.write(`brandklipparen rest listening on ${baseUrl}\n`);
  const shutdown = (): void => {
    built.value.liveTokens.stop();
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startMcp(allowlistPath: string | null): Promise<void> {
  const config = loadMcpAppConfig();
  const built = buildApp(config, {
    ports: await startupPorts(config),
    allowlist: loadAllowlist(allowlistPath),
  });
  if (!built.ok) {
    fail(
      built.error.kind === "missing-variable" || built.error.kind === "invalid-value"
        ? formatConfigError(built.error)
        : `detector registry failed to build: ${built.error.kind}`,
    );
  }
  const server = createMcpServer(built.value.mcp);
  const running = serveStdio(server);
  process.stderr.write("brandklipparen mcp serving on stdio\n");
  const shutdown = (): void => {
    running.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const allowlistPath = allowlistFlag(argv);
  if (mode === "rest") {
    await startRest(allowlistPath);
    return;
  }
  if (mode === "mcp") {
    await startMcp(allowlistPath);
    return;
  }
  usage();
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void main().catch((error: unknown) => {
    fail(error instanceof Error ? error.message : "the server failed to start");
  });
}
