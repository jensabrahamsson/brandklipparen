// Tampered artifact rejected before analysis (K-512, M-17). The checksum
// verification behind this test already exists in the domain verifier and
// the file adapter (covered by k211_wrong_checksum_rejected_before_analysis);
// this named test pins the M-17 behaviour from the threat-model table:
// a replaced artifact file in a test environment gives the same typed
// startup error, and scoring refuses to run. Fakes and frozen fixtures
// only; no network, no secrets.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { verifyArtifactFile } from "../../src/domain/artifact.ts";
import type { Result } from "../../src/domain/result.ts";
import {
  Address,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import { FileModelArtifactAdapter } from "../../src/adapters/model/fileArtifact.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const frozenFile = join(repoRoot, "model", "artifact-0.0.0-synthetic.1.json");
const MODEL_VERSION = "0.0.0-synthetic.1";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function mustVersion(): ModelVersion {
  return mustOk(ModelVersion.parse(MODEL_VERSION));
}

// Placeholder catalogue for the test only: fixed risk mapping per
// capability key, so detection yields signals without learned values.
const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

describe("tampered artifact rejected before analysis (K-512, M-17)", () => {
  test("k512_tampered_artifact_rejected_before_analysis", async () => {
    const committed = readFileSync(frozenFile, "utf8");
    // Replace the artifact file in a scratch environment with a single
    // flipped byte, the same way a replaced file would arrive on disk.
    const bytes = Buffer.from(committed, "utf8");
    const flipAt = bytes.indexOf(0x32);
    expect(flipAt).toBeGreaterThanOrEqual(0);
    bytes[flipAt] = bytes[flipAt] === 0x32 ? 0x33 : 0x32;
    const tampered = bytes.toString("utf8");
    expect(tampered).not.toBe(committed);
    const scratch = mkdtempSync(join(tmpdir(), "brandklipparen-tamper-"));
    writeFileSync(join(scratch, `artifact-${MODEL_VERSION}.json`), tampered, "utf8");
    const tamperedAdapter = new FileModelArtifactAdapter(scratch);
    const loaded = tamperedAdapter.load(mustVersion());
    expect(loaded.ok).toBe(false);
    if (loaded.ok) {
      throw new Error("expected a typed startup error for the tampered artifact");
    }
    expect(["checksum-mismatch", "artifact-malformed", "unknown-version"]).toContain(
      loaded.error.kind,
    );
    // Scoring refuses to run on the tampered artifact: the service
    // answers a typed model-artifact error instead of scores.
    const codes = new Map<string, string>([
      [mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314")) as string, "0x600160005506"],
    ]);
    const block = mustOk(BlockNumber.of(24000000));
    const refused = createAppServices({
      rpc: new FakeRpcAdapter(codes, block),
      modelArtifacts: tamperedAdapter,
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
  mustDefaultDetectorSet());
    const denied = await refused.analyzeToken({
      address: mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314")),
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-42d3-a456-426614174002")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustVersion(),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.kind).toBe("model-artifact-error");
    }
    // Control: the intact file verifies in the same environment.
    const intact = verifyArtifactFile(JSON.parse(committed) as unknown);
    expect(intact.ok).toBe(true);
  });
});
