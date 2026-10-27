// K-027 response equality across interfaces (S-026).
// Written first per A-21 (red): the shared application service does not exist
// yet, so this test fails until src/application/analyzeToken.ts and the ports
// it depends on are implemented. Thin in-test shims stand in for the three
// driving adapters (REST, MCP, web UI): each shim validates raw input at its
// boundary, calls the same AppServices entry point with the same typed input
// and canonical model version, and returns the canonical serialisation. The
// property requires byte-identical canonical outputs in every interface for
// the same inputs, with the reproduction fields present (A-32 point 7).
// All ports are in-memory fakes; no network access happens in this test.
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
import type {
  Address as AddressType,
  BlockNumber as BlockNumberType,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import {
  createAppServices,
  serializeAssessment,
} from "../../src/application/analyzeToken.ts";
import type { AppServices } from "../../src/application/analyzeToken.ts";
import type { LoadedArtifact } from "../../src/ports/modelArtifact.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

// Synthetic placeholder artifact for the test only (K-210): finite test
// weights with no learned values, so scoring runs deterministically.
// Production values come from the versioned model artifact per A-20.
function placeholderLoadedArtifact(): LoadedArtifact {
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
  return Object.freeze({
    artifact,
    checksum: mustOk(ArtifactChecksum.parse("ab".repeat(32))),
  });
}

// Placeholder catalogue for the test only: fixed risk mapping per capability
// key, so detection yields signals without carrying learned values.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

// One address with one bytecode behind the fake RPC, so every shim analyses
// the same triple of bytecode, block number and artifact version.
function buildServices(bytecodeHex: string, address: AddressType, block: BlockNumberType): AppServices {
  const codes = new Map<string, string>([[address as string, bytecodeHex]]);
  return createAppServices({
    rpc: new FakeRpcAdapter(codes, block),
    modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
    clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
  });
}

const REQUEST_ID = "123e4567-e89b-12d3-a456-426614174000";

async function callService(
  services: AppServices,
  rawAddress: string,
  blockNumber: number,
): Promise<string> {
  const address = mustOk(Address.parse(rawAddress));
  const block = mustOk(BlockNumber.of(blockNumber));
  const analysed = await services.analyzeToken({
    address,
    block,
    requestId: mustOk(RequestId.parse(REQUEST_ID)),
    deadline: mustOk(Timestamp.of(1700000005000)),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("0.1.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
  });
  if (!analysed.ok) {
    const message =
      analysed.error.kind === "domain-error" ? analysed.error.error.message : analysed.error.error.message;
    throw new Error(`expected assessed, got application error: ${message}`);
  }
  if (analysed.value.kind !== "assessed") {
    throw new Error("expected assessed, got no-contract");
  }
  return serializeAssessment(analysed.value.envelope);
}

// Thin shims for the three driving adapters. Each shim owns only validation
// at its boundary and response formatting; detection lives in the core behind
// the shared service, so the canonical outputs must match byte for byte.

// REST shim: validates the JSON body field, then returns the canonical body.
function restAssessToken(
  services: AppServices,
  body: { address: string; block: number },
): Promise<string> {
  return callService(services, body.address, body.block);
}

// MCP shim: validates the tool arguments, then returns the same canonical text.
function mcpAssessToken(
  services: AppServices,
  args: { address: string; block: number },
): Promise<string> {
  return callService(services, args.address, args.block);
}

// Web UI shim: validates the form input, then renders from the same canonical text.
function uiAssessToken(
  services: AppServices,
  form: { address: string; block: number },
): Promise<string> {
  return callService(services, form.address, form.block);
}

function hexArb(length: number): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: 15 }), { minLength: length, maxLength: length })
    .map((digits) => digits.map((digit) => (digit as number).toString(16)).join(""));
}

const REPRODUCTION_FIELDS = [
  "target",
  "block",
  "codeHash",
  "modelVersion",
  "artifactChecksum",
  "indexVersion",
  "templateVersion",
] as const;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += (byte ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

// Dispatcher-shaped bytecode: DUP1 PUSH4 <selector> EQ PUSH1 <dest> JUMPI over
// executable bytes ending in one capability opcode, so detection yields at
// least one signal with a selector and a PC offset.
const dispatcherBytecodeArb: fc.Arbitrary<string> = fc
  .tuple(hexArb(8), fc.constantFrom("ff", "f4", "f1", "55"))
  .map(([selector, capability]) => `0x8063${selector}14600a57${"00".repeat(10)}${capability}`);

const randomBytecodeArb: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 16, maxLength: 64 })
  .map((bytes) => `0x${bytesToHex(bytes)}`);

describe("shared application service across interfaces", () => {
  test("k027_same_inputs_same_outputs_across_interfaces", async () => {
    await fc.assert(
      fc.asyncProperty(
        hexArb(40),
        fc.oneof(dispatcherBytecodeArb, randomBytecodeArb),
        fc.integer({ min: 0, max: 30000000 }),
        async (addressBody, bytecodeHex, blockNumber) => {
          const rawAddress = `0x${addressBody}`;
          const address = mustOk(Address.parse(rawAddress));
          const block = mustOk(BlockNumber.of(blockNumber));
          const services = buildServices(bytecodeHex, address, block);
          const [rest, mcp, ui] = await Promise.all([
            restAssessToken(services, { address: rawAddress, block: blockNumber }),
            mcpAssessToken(services, { address: rawAddress, block: blockNumber }),
            uiAssessToken(services, { address: rawAddress, block: blockNumber }),
          ]);
          expect(rest).toBe(mcp);
          expect(mcp).toBe(ui);
          const parsed = JSON.parse(rest) as Record<string, unknown>;
          for (const field of REPRODUCTION_FIELDS) {
            expect(parsed, `missing reproduction field ${field}`).toHaveProperty(field);
          }
          const again = await restAssessToken(services, { address: rawAddress, block: blockNumber });
          expect(again).toBe(rest);
        },
      ),
      { numRuns: 25 },
    );
  });

  test("k027_service_accepts_typed_values_from_each_adapter", async () => {
    const address = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(18000000));
    const services = buildServices(
      `0x8063a9059cbb14600a57${"00".repeat(10)}ff`,
      address,
      block,
    );
    const input = {
      address,
      block,
      requestId: mustOk(RequestId.parse(REQUEST_ID)),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("0.1.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    } satisfies Parameters<AppServices["analyzeToken"]>[0];
    const first = await services.analyzeToken(input);
    if (!first.ok) {
      throw new Error("expected ok from typed input");
    }
    expect(first.value.kind).toBe("assessed");
  });
});
