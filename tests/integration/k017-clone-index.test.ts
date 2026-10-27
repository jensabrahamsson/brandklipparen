// Integration test for clone matching (K-017, S-014): the response names the
// bound index version, so hits stay reproducible per K-102. Written first per
// A-21 (red): the clone port and the service wiring do not exist yet.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createAppServices } from "../../src/application/analyzeToken.ts";
import { FileModelArtifactAdapter } from "../../src/adapters/model/fileArtifact.ts";
import { CloneIndexAdapter } from "../../src/adapters/clones/cloneIndex.ts";
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

const TEST_CLONE_MAPPING: CloneMapping = Object.freeze({
  risk: "honeypot",
  direction: "raises",
  severity: "high",
});

describe("k017 clone index version in the response", () => {
  test("k017_response_names_index_version", async () => {
    const target = mustOk(Address.parse("0x0102030405060708090a0b0c0d0e0f1011121314"));
    const block = mustOk(BlockNumber.of(24000000));
    const table = JSON.parse(
      readFileSync(join(repoRoot, "tests", "fixtures", "clones", "trap-templates.json"), "utf8"),
    ) as unknown;
    const created = CloneIndexAdapter.create(table);
    if (!created.ok) {
      throw new Error(`expected the fixture table to load: ${created.error.message}`);
    }
    const services = createAppServices({
      rpc: new FakeRpcAdapter(
        new Map<string, string>([[target as string, "0x8063a9059cbb14600a575bff00"]]),
        block,
      ),
      modelArtifacts: new FileModelArtifactAdapter(join(repoRoot, "model")),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
      cloneIndex: created.value,
    });
    const analysed = await services.analyzeToken({
      address: target,
      block,
      requestId: mustOk(RequestId.parse("123e4567-e89b-12d3-a456-426614174000")),
      deadline: mustOk(Timestamp.of(1700000005000)),
      modelVersion: mustOk(ModelVersion.parse("0.0.0-synthetic.1")),
      indexVersion: mustOk(IndexVersion.parse("9.9.9")),
      templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
      catalogue: TEST_CATALOGUE,
      cloneMapping: TEST_CLONE_MAPPING,
    });
    expect(analysed.ok).toBe(true);
    if (!analysed.ok || analysed.value.kind !== "assessed") {
      throw new Error("expected an assessed envelope");
    }
    expect(analysed.value.envelope.indexVersion as string).toBe("1.0.0");
  });
});
