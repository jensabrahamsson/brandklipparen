// Wiring test for S-006: the assessment envelope includes proxy
// information from the shared application service (K-002, K-005).
import { describe, expect, test } from "vitest";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  ArtifactChecksum,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import type { LoadedArtifact } from "../../../src/ports/modelArtifact.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { IMPLEMENTATION_SLOT, ADMIN_SLOT, ZOS_IMPLEMENTATION_SLOT, ZOS_ADMIN_SLOT } from "../../../src/domain/proxy.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

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

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const PROXY = "0x0102030405060708090a0b0c0d0e0f1011121314";
const IMPL = "0x1112131415161718191a1b1c1d1e1f2021222324";
const ADMIN = "0x3132333435363738393a3b3c3d3e3f4041424344";

function addressWord(raw: string): string {
  return `0x${"0".repeat(24)}${raw.slice(2).toLowerCase()}`;
}

describe("assessment envelope carries proxy information (K-002, K-005)", () => {
  test("envelope_reports_eip1967_proxy_and_implementation", async () => {
    const proxy = mustOk(Address.parse(PROXY));
    const block = mustOk(BlockNumber.of(24000000));
    const codes = new Map<string, string>([
      [proxy as string, "0x6001600a600b600c600d600e600f55"],
      [mustOk(Address.parse(IMPL)) as string, "0x6001600055"],
    ]);
    const storage = new Map<string, Map<string, string>>([
      [
        proxy as string,
        new Map<string, string>([
          [(IMPLEMENTATION_SLOT as string).toLowerCase(), addressWord(IMPL).toLowerCase()],
          [(ADMIN_SLOT as string).toLowerCase(), addressWord(ADMIN).toLowerCase()],
        ]),
      ],
    ]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, block, storage),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: proxy,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const proxyInfo = analysed.value.envelope.proxy;
    expect(proxyInfo.kind).toBe("eip1967");
    if (proxyInfo.kind !== "eip1967") {
      return;
    }
    expect(proxyInfo.implementation as string).toBe(mustOk(Address.parse(IMPL)) as string);
    expect(proxyInfo.block as number).toBe(24000000);
    expect(proxyInfo.upgradeAuthority.kind).toBe("single-key");
  });

  test("k002_signals_follow_implementation_bytecode", async () => {
    // K-002/K-003: a proxy whose implementation contains SELFDESTRUCT must
    // report that capability signal, even though the proxy bytecode itself
    // carries no SELFDESTRUCT. The response analyses the implementation.
    const proxy = mustOk(Address.parse(PROXY));
    const impl = mustOk(Address.parse(IMPL));
    const block = mustOk(BlockNumber.of(24000000));
    const codes = new Map<string, string>([
      [proxy as string, "0x6001600a600b600c600d600e600f55"],
      // Dispatcher jumps to a real body at 0x0c holding SELFDESTRUCT, so the
      // occurrence is attributable to the paired function (no guessing).
      [impl as string, "0x8063a9059cbb1461000c57005bff"],
    ]);
    const storage = new Map<string, Map<string, string>>([
      [
        proxy as string,
        new Map<string, string>([
          [(IMPLEMENTATION_SLOT as string).toLowerCase(), addressWord(IMPL).toLowerCase()],
          [(ADMIN_SLOT as string).toLowerCase(), addressWord(ADMIN).toLowerCase()],
        ]),
      ],
    ]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, block, storage),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: proxy,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const proxyInfo = analysed.value.envelope.proxy;
    expect(proxyInfo.kind).toBe("eip1967");
    const capabilitySignals = analysed.value.envelope.signals.filter(
      (signal) => signal.kind === "capability",
    );
    // The implementation's SELFDESTRUCT surfaces as a high-severity
    // rug-pull signal; the proxy bytecode's own storage write does not.
    expect(
      capabilitySignals.some(
        (signal) =>
          signal.kind === "capability" &&
          signal.risk === "rug-pull" &&
          signal.direction === "raises" &&
          signal.severity === "high",
      ),
    ).toBe(true);
    expect(
      capabilitySignals.some(
        (signal) => signal.kind === "capability" && signal.risk === "bot-pump",
      ),
    ).toBe(false);
  });

  test("envelope_reports_zos_proxy_and_analyses_implementation", async () => {
    const proxy = mustOk(Address.parse(PROXY));
    const impl = mustOk(Address.parse(IMPL));
    const block = mustOk(BlockNumber.of(24000000));
    const codes = new Map<string, string>([
      [proxy as string, "0x6001600a600b600c600d600e600f55"],
      [impl as string, "0x8063a9059cbb1461000c57005bff"],
      [mustOk(Address.parse(ADMIN)) as string, "0x6002600055"],
    ]);
    const storage = new Map<string, Map<string, string>>([
      [
        proxy as string,
        new Map<string, string>([
          [(ZOS_IMPLEMENTATION_SLOT as string).toLowerCase(), addressWord(IMPL).toLowerCase()],
          [(ZOS_ADMIN_SLOT as string).toLowerCase(), addressWord(ADMIN).toLowerCase()],
        ]),
      ],
    ]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, block, storage),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    }, mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: proxy,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(analysed.value.envelope.proxy.kind).toBe("zos");
    const proxyResults = analysed.value.envelope.pluginResults.filter(
      (entry) => (entry.pluginId as string) === "dev.brandklipparen.proxy-upgrade",
    );
    const factFindings = proxyResults.flatMap((entry) => entry.findings).filter(
      (finding) => (finding.payload as Record<string, unknown>)["fact"] === "proxy-upgrade",
    );
    expect(factFindings).toHaveLength(1);
    expect((factFindings[0]?.payload as Record<string, unknown>)["proxyKind"]).toBe("zos");
  });

  test("envelope_reports_no_proxy_for_plain_contracts", async () => {
    const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(24000000));
    const codes = new Map<string, string>([
      [target as string, "0x6001600a600b600c600d600e600f55"],
    ]);
    const services = createAppServices({
      rpc: new FakeRpcAdapter(codes, block),
      modelArtifacts: new FakeModelArtifactAdapter(placeholderLoadedArtifact()),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.1.0")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(analysed.value.envelope.proxy).toEqual({ kind: "none" });
  });
});
