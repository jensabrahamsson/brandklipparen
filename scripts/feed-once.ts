// One-shot new-LP-pairs poll (E-11, K-039): `npm run feed:once`.
// Reads the validated configuration, polls the configured log source
// (Etherscan primary, JSON-RPC eth_getLogs fallback) once per enabled
// factory over the trailing blocks, runs the liquidity gate with the
// same-transaction fast path, and prints the candidates as JSON to
// stdout. The command performs one poll and exits; it runs no daemon,
// no watch mode, and no timer survives the run. Pending entries do not
// persist across runs: a scheduler keeps its own block cursor and
// re-polls about once a minute (see docs/lp-pairs-feed.md).
// Usage:
//   npm run feed:once
//   npm run feed:once -- --fromBlock 21600000 --toBlock 21600002
import { loadConfig } from "../src/adapters/config/loader.ts";
import { formatConfigError } from "../src/ports/config.ts";
import type { AppConfig } from "../src/ports/config.ts";
import {
  ETHERSCAN_LOGS_BASE_URL,
  createEtherscanLogsAdapter,
} from "../src/adapters/lpFeed/etherscanLogsAdapter.ts";
import { createRpcLogsAdapter } from "../src/adapters/lpFeed/rpcLogsAdapter.ts";
import {
  FEED_FACTORIES,
  LP_FEED_PENDING_TTL_MS,
  LP_FEED_REORG_WINDOW_BLOCKS,
  QUOTE_TOKENS,
} from "../src/domain/lpFeed.ts";
import { processFeedPoll } from "../src/application/lpFeedService.ts";
import type { FeedLog, LpFeedPort } from "../src/ports/lpFeed.ts";

type Args = {
  readonly fromBlock: number | null;
  readonly toBlock: number | null;
};

function parseArgs(argv: readonly string[]): Args {
  let fromBlock: number | null = null;
  let toBlock: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const raw = argv[index + 1];
    if ((flag === "--fromBlock" || flag === "--toBlock") && raw !== undefined) {
      const value = Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${flag} must be a non-negative integer block number`);
      }
      if (flag === "--fromBlock") {
        fromBlock = value;
      } else {
        toBlock = value;
      }
      index += 1;
    }
  }
  return { fromBlock, toBlock };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function latestBlockNumberEtherscan(apiKey: string): Promise<number> {
  const url =
    `${ETHERSCAN_LOGS_BASE_URL}?chainid=1&module=proxy&action=eth_blockNumber` +
    `&apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url);
  const body = (await response.json()) as { result?: unknown };
  const parsed = typeof body.result === "string" ? parseInt(body.result, 16) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("the feed could not read the latest block number");
  }
  return parsed;
}

async function latestBlockNumberRpc(url: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const body = (await response.json()) as { result?: unknown };
  const parsed = typeof body.result === "string" ? parseInt(body.result, 16) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("the feed could not read the latest block number");
  }
  return parsed;
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid feed:once arguments");
    process.exit(2);
    return;
  }
  const loaded = loadConfig(process.env as Record<string, string | undefined>);
  if (!loaded.ok) {
    console.error(formatConfigError(loaded.error));
    process.exit(2);
    return;
  }
  const config: AppConfig = loaded.value;
  const weth = config.feedWethAddress ?? null;
  if (weth === null) {
    console.error("WETH quote not configured: set BK_WETH_ADDRESS to resolve the WETH side");
    process.exit(2);
  }
  const quotes = {
    usdc: QUOTE_TOKENS.usdc,
    usdt: QUOTE_TOKENS.usdt,
    dai: QUOTE_TOKENS.dai,
    weth,
    allowNativeZero: false,
  };
  let source: LpFeedPort;
  let latest: () => Promise<number>;
  if (config.feedEtherscanApiKey !== undefined) {
    const apiKey = config.feedEtherscanApiKey;
    source = createEtherscanLogsAdapter({ apiKey });
    latest = () => latestBlockNumberEtherscan(apiKey.reveal());
  } else if (config.feedRpcUrl !== undefined) {
    const url = config.feedRpcUrl;
    source = createRpcLogsAdapter({ url });
    latest = () => latestBlockNumberRpc(url.reveal());
  } else {
    console.log(JSON.stringify({ status: "not-configured", candidates: [] }));
    return;
  }
  let fromBlock = args.fromBlock;
  let toBlock = args.toBlock;
  if (fromBlock === null || toBlock === null) {
    const head = await latest().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "the feed could not read the latest block");
      process.exit(1);
      throw error;
    });
    toBlock = head;
    fromBlock = Math.max(0, head - (LP_FEED_REORG_WINDOW_BLOCKS - 1));
  }
  const ctx = { requestId: `feed-once-${Date.now()}`, deadlineMs: Date.now() + 120000 };
  const logs: FeedLog[] = [];
  const errors: { factory: string; message: string }[] = [];
  for (const factory of FEED_FACTORIES) {
    if (!factory.enabledByDefault) {
      continue;
    }
    const input = {
      factory: factory.address,
      fromBlock: fromBlock as number,
      toBlock: toBlock as number,
    };
    const first = await source.pollLogs(input, ctx);
    if (first.ok) {
      logs.push(...first.value.logs);
      continue;
    }
    if (first.error.kind === "rate-limited") {
      await sleep(Math.min(first.error.retryAfterMs, 10000));
      const retry = await source.pollLogs(input, ctx);
      if (retry.ok) {
        logs.push(...retry.value.logs);
        continue;
      }
      errors.push({ factory: factory.dex, message: retry.error.message });
      continue;
    }
    errors.push({ factory: factory.dex, message: first.error.message });
  }
  const output = processFeedPoll({
    logs,
    quotes,
    pending: [],
    seenKeys: new Set<string>(),
    blockHashByKey: new Map<string, string>(),
    nowMs: Date.now(),
    ttlMs: LP_FEED_PENDING_TTL_MS,
  });
  console.log(
    JSON.stringify({
      status: "ok",
      fromBlock,
      toBlock,
      candidates: output.candidates,
      skipped: output.skipped,
      pending: output.pending,
      errors,
    }),
  );
}

await main();
