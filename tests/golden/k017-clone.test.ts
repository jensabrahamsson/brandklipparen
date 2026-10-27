// Golden test for clone matching (K-017, S-014): a hit reports similarity,
// group and count, and scoring still runs on the frozen checksummed
// placeholder artifact. Written first per A-21 (red): the clone port, the
// domain module and the service wiring do not exist yet, so this test fails
// until the implementation lands. All bytecode is small hand-assembled
// synthetic sequences; risk mappings are placeholders and the artifact is
// the frozen synthetic placeholder in model/.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import { FileModelArtifactAdapter } from "../../src/adapters/model/fileArtifact.ts";
import { CloneIndexAdapter } from "../../src/adapters/clones/cloneIndex.ts";
import { canonicalSerialize } from "../../src/domain/serialize.ts";
import {
  Address,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  RequestId,
  TemplateVersion,
  Timestamp,
} from "../../src/domain/types.ts";
import type { Result } from "../../src/domain/result.ts";
import type { CapabilityCatalogue } from "../../src/domain/signals.ts";
import type { CloneMapping } from "../../src/domain/clones.ts";
import { FakeClockAdapter } from "../fakes/fakeClock.ts";
import { FakeRpcAdapter } from "../fakes/fakeRpc.ts";
import { mustDefaultDetectorSet } from "../helpers/detectorSets.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

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

// Placeholder clone signal mapping for the tests only; production values
// come from the versioned model artifact per K-210 and A-20.
const TEST_CLONE_MAPPING: CloneMapping = Object.freeze({
  risk: "honeypot",
  direction: "raises",
  severity: "high",
});

const TARGET = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEMPLATE_A_CODE = "0x8063a9059cbb14600a575bff00";
const MISS_CODE = "0x8063deadbeef14600a575b00";

function fixtureTable(): unknown {
  return JSON.parse(
    readFileSync(join(repoRoot, "tests", "fixtures", "clones", "trap-templates.json"), "utf8"),
  ) as unknown;
}

function mustCloneIndex(): CloneIndexAdapter {
  const created = CloneIndexAdapter.create(fixtureTable());
  if (!created.ok) {
    throw new Error(`expected the fixture table to load: ${created.error.message}`);
  }
  return created.value;
}

describe("k017 clone matching golden", () => {
  test("k017_clone_hit_reports_similarity_group_and_count", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(
        new Map<string, string>([[target as string, TEMPLATE_A_CODE]]),
        block,
      ),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      cloneIndex: mustCloneIndex(),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      cloneMapping: TEST_CLONE_MAPPING,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const envelope = analysed.value.envelope;
    const clones = envelope.signals.filter((signal) => signal.kind === "clone-match");
    expect(clones.length).toBe(1);
    const hit = clones[0];
    if (hit === undefined || hit.kind !== "clone-match") {
      throw new Error("expected a clone-match signal");
    }
    expect(hit.similarity as number).toBe(1);
    expect(hit.group as string).toBe("trap-fixed-fee");
    expect(hit.priorCount).toBe(3);
    expect(hit.evidence.length).toBeGreaterThan(0);
    // The golden file pins the hit with its mandatory evidence (group id
    // and count travel on the signal) beside the frozen-artifact score, so a
    // changed output is reviewed as a behaviour change per K-017.
    const golden = {
      similarity: hit.similarity as number,
      group: hit.group as string,
      priorCount: hit.priorCount,
      evidence: hit.evidence.map((entry) => ({
        selector: entry.selector as string,
        offset: (entry.offset as number | undefined) ?? null,
      })),
      score: envelope.score as number,
      probabilities: {
        "bot-pump": envelope.probabilities["bot-pump"] as number,
        honeypot: envelope.probabilities.honeypot as number,
        "rug-pull": envelope.probabilities["rug-pull"] as number,
      },
      modelVersion: envelope.modelVersion as string,
      artifactChecksum: envelope.artifactChecksum as string,
      indexVersion: envelope.indexVersion as string,
    };
    const actual = Buffer.from(canonicalSerialize(golden), "utf8");
    const expected = readFileSync(join(here, "..", "fixtures", "golden", "k017-clone-hit.expected.json"));
    expect(actual.equals(expected), "golden clone hit differs").toBe(true);
  });

  test("k017_clone_miss_yields_no_clone_signal", async () => {
    const target = mustOk(Address.parse(TARGET));
    const block = mustOk(BlockNumber.of(24000000));
    const services = createAppServices({
      rpc: new FakeRpcAdapter(new Map<string, string>([[target as string, MISS_CODE]]), block),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      cloneIndex: mustCloneIndex(),
    },
  mustDefaultDetectorSet());
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
      indexVersion: mustOk(IndexVersion.parse("1.0.0")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      cloneMapping: TEST_CLONE_MAPPING,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    const clones = analysed.value.envelope.signals.filter((signal) => signal.kind === "clone-match");
    expect(clones).toEqual([]);
  });
});
