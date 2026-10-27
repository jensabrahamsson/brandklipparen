// K-026 read-only property (S-028, K-508, M-15): any sequence of tool calls
// leaves chain state and project data unchanged, apart from log and quota
// metering. Written first per A-21 (red): src/interfaces/mcp does not exist
// yet. All ports are in-memory fakes; the MCP server is driven in-process.
// No outbound network happens in this test.
import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { parseModelArtifact } from "../../src/domain/risk.ts";
import type { Result } from "../../src/domain/result.ts";
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
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import type { AppServices } from "../../src/application/analyzeToken.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { createMcpServer } from "../../src/interfaces/mcp/server.ts";
import type { McpServer } from "../../src/interfaces/mcp/server.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const KNOWN_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const KNOWN_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const ABSENT_ADDRESS = "0x1212121212121212121212121212121212121212";
const HEAD_BLOCK = 18000000;

function buildStack(): { mcp: McpServer; rpc: FakeRpcAdapter; artifacts: FakeModelArtifactAdapter } {
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
  const rpc = new FakeRpcAdapter(
    new Map<string, string>([[mustOk(Address.parse(KNOWN_ADDRESS)) as string, KNOWN_BYTECODE]]),
    mustOk(BlockNumber.of(HEAD_BLOCK)),
  );
  const artifacts = new FakeModelArtifactAdapter(
    Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("ef".repeat(32))) }),
  );
  const services: AppServices = createAppServices({
    rpc,
    modelArtifacts: artifacts,
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
  });
  const mcp = createMcpServer({
    services,
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  });
  return { mcp, rpc, artifacts };
}

// Observable data state behind the fake ports: the chain view (bytecode and
// head block for probe addresses), the loaded artifact and the clock value.
// Call-count metering is deliberately excluded: request logging and quota
// metering may move while data must not (K-026).
async function snapshotData(rpc: FakeRpcAdapter, artifacts: FakeModelArtifactAdapter): Promise<string> {
  const ctx = {
    requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
    deadline: mustOk(Timestamp.of(1700000005000)),
    block: mustOk(BlockNumber.of(HEAD_BLOCK)),
  };
  const parts: string[] = [];
  for (const raw of [KNOWN_ADDRESS, ABSENT_ADDRESS]) {
    const fetched = await rpc.getCode(mustOk(Address.parse(raw)), ctx);
    parts.push(
      fetched.ok
        ? `code:${raw}:${Buffer.from(fetched.value.bytecode).toString("hex")}:${fetched.value.block as number}`
        : `error:${raw}:${fetched.error.kind}`,
    );
  }
  const head = await rpc.getBlockNumber();
  parts.push(head.ok ? `head:${head.value as number}` : `head-error:${head.error.kind}`);
  const loaded = artifacts.load(mustOk(ModelVersion.parse("0.1.0")));
  parts.push(loaded.ok ? `artifact:${loaded.value.checksum as string}` : `artifact-error:${loaded.error.kind}`);
  return parts.join("|");
}

type ToolCommand =
  | { readonly kind: "assess"; readonly address: string }
  | { readonly kind: "assess-block"; readonly address: string; readonly block: number }
  | { readonly kind: "unknown" }
  | { readonly kind: "list" }
  | { readonly kind: "raw"; readonly text: string };

const addressArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(KNOWN_ADDRESS),
  fc.constant(ABSENT_ADDRESS),
  fc.constant("not-an-address"),
  fc.constant(""),
  fc.constant(`0x${"ab".repeat(1500)}`),
  fc
    .array(fc.integer({ min: 0, max: 15 }), { minLength: 0, maxLength: 60 })
    .map((digits) => `0x${digits.map((digit) => (digit as number).toString(16)).join("")}`),
);

const commandArb: fc.Arbitrary<ToolCommand> = fc.oneof(
  addressArb.map((address) => ({ kind: "assess", address }) as ToolCommand),
  fc
    .tuple(addressArb, fc.integer({ min: 0, max: 30000000 }))
    .map(([address, block]) => ({ kind: "assess-block", address, block }) as ToolCommand),
  fc.constant({ kind: "unknown" } as ToolCommand),
  fc.constant({ kind: "list" } as ToolCommand),
  fc
    .oneof(
      fc.constant(""),
      fc.constant("{broken"),
      fc.json(),
      fc.string({ maxLength: 200 }),
    )
    .map((text) => ({ kind: "raw", text }) as ToolCommand),
);

async function runCommand(mcp: McpServer, command: ToolCommand): Promise<void> {
  switch (command.kind) {
    case "assess":
      await mcp.callTool("assess_token", { address: command.address });
      break;
    case "assess-block":
      await mcp.callTool("assess_token", { address: command.address, block: command.block });
      break;
    case "unknown":
      await mcp.callTool("no_such_tool", { address: KNOWN_ADDRESS });
      break;
    case "list":
      mcp.listTools();
      break;
    case "raw":
      await mcp.handleJsonRpc(command.text);
      break;
  }
}

describe("MCP tools leave state unchanged (K-026)", () => {
  test("k026_tools_leave_state_unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(commandArb, { minLength: 1, maxLength: 20 }), async (commands) => {
        const { mcp, rpc, artifacts } = buildStack();
        const before = await snapshotData(rpc, artifacts);
        for (const command of commands) {
          // Every command maps to a value; nothing escapes as an exception.
          await runCommand(mcp, command);
        }
        const after = await snapshotData(rpc, artifacts);
        expect(after).toBe(before);
      }),
      { numRuns: 25 },
    );
  });
});
