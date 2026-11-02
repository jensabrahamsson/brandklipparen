// C-15 (F-8) app level: an analysis under artifact 1.0.1 scores each
// fitted plugin once on both heads, while the signal list keeps one
// signal per feature finding for display.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { isFeaturePayload, parseModelArtifact } from "../../../src/domain/risk.ts";
import type { Result } from "../../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { FileModelArtifactAdapter } from "../../../src/adapters/model/fileArtifact.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import {
  ADD,
  CALLDATALOAD,
  PUSH0,
  SLOAD,
  STOP,
  ownerGuard,
  push1,
  sstoreConstSlot,
  tokenBytecode,
} from "../../helpers/ownerControlFixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

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

function tokenHex(): string {
  const bytecode = tokenBytecode([
    {
      selector: "0x715018a6",
      body: [...ownerGuard(0, 0), ...sstoreConstSlot(0, [PUSH0]), STOP],
    },
    {
      selector: "0xa9059cbb",
      body: [CALLDATALOAD, ...push1(1), SLOAD, ADD, ...sstoreConstSlot(2, [CALLDATALOAD]), STOP],
    },
  ]);
  return `0x${Buffer.from(bytecode).toString("hex")}`;
}

function round6(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}
function sigmoid(logit: number): number {
  const clamped = Math.min(60, Math.max(-60, logit));
  return 1 / (1 + Math.exp(-clamped));
}

describe("c15 fitted scoring (app, 1.0.1)", () => {
  test("c15_app_scores_each_fitted_plugin_once_on_both_heads", async () => {
    const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices(
      {
        rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, tokenHex()]]), block),
        modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
        clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      },
      mustDefaultDetectorSet(),
    );
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("1.0.1")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const envelope = analysed.value.envelope;

    const artifact = mustOk(
      parseModelArtifact(
        (JSON.parse(readFileSync(join(repoRoot, "model", "artifact-1.0.1.json"), "utf8")) as { artifact: unknown })
          .artifact,
      ),
    );

    // Fitted plugins that actually fired (feature findings only), once each.
    const fired = new Set<string>();
    let featureFindings = 0;
    for (const entry of envelope.pluginResults) {
      if (entry.outcome !== "ok") {
        continue;
      }
      for (const finding of entry.findings) {
        if (isFeaturePayload(finding.payload)) {
          featureFindings += 1;
          if (artifact.detectorHeadWeights?.[entry.pluginId as string] !== undefined) {
            fired.add(entry.pluginId as string);
          }
        }
      }
    }
    expect(fired.size).toBeGreaterThan(0);
    expect(fired.has("dev.brandklipparen.ownership")).toBe(true);

    const totals: Record<string, number> = {
      "rug-pull": artifact.biases["rug-pull"] ?? 0,
      honeypot: artifact.biases["honeypot"] ?? 0,
    };
    for (const plugin of fired) {
      const heads = artifact.detectorHeadWeights?.[plugin];
      if (heads === undefined) {
        continue;
      }
      totals["rug-pull"] = (totals["rug-pull"] ?? 0) + heads["rug-pull"];
      totals["honeypot"] = (totals["honeypot"] ?? 0) + heads["honeypot"];
    }
    for (const head of ["rug-pull", "honeypot"] as const) {
      const params = artifact.calibration[head];
      const expected = round6(sigmoid((params?.slope ?? 0) * (totals[head] ?? 0) + (params?.intercept ?? 0)));
      expect(envelope.probabilities[head] as number, head).toBe(expected);
    }

    // One signal per feature finding is kept for display/evidence.
    const featureSignals = envelope.signals.filter(
      (signal) => signal.kind === "capability" && signal.sourcePlugin !== undefined,
    );
    expect(featureSignals.length).toBe(featureFindings);
  });
});
