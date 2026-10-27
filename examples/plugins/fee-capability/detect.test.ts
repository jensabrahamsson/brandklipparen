// Unit and golden tests for the example fee-capability detector
// (S-051). The detector reports a finding per known fee-setter selector on
// frozen bytecode fixtures. Written first (red) per A-21: manifest.ts and
// detect.ts do not exist yet, so the imports fail until the example lands.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import { runDetectorPluginContract } from "../../../tests/contract/detector.contract.ts";
import { feeCapabilityManifest } from "./manifest.ts";
import { detectFeeCapability } from "./detect.ts";
import type { DetectorPlugin } from "../../../src/plugins/detector.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const plugin: DetectorPlugin = Object.freeze({
  manifest: feeCapabilityManifest,
  detect: detectFeeCapability,
});

function makeInput(bytecodeHex: string): DetectorInput {
  const bytecode = mustOk(Bytecode.parse(bytecodeHex));
  return Object.freeze({
    bytecode,
    codeHash: mustOk(CodeHash.of(bytecode)),
    cloneMatch: null,
    decompilerCause: null,
  });
}

// Dispatcher exposing setFee(uint256) = 0x69fe0e2d beside a transfer.
const FEE_CODE = "0x806369fe0e2d14600a578063a9059cbb1461005a57ff00";
const NO_FEE_CODE = "0x8063a9059cbb14600a575b00";

runDetectorPluginContract("dev.brandklipparen.example-fee-capability", plugin, () =>
  makeInput(FEE_CODE),
);

describe("example fee-capability detector", () => {
  test("reports one finding per known fee selector on the frozen fixture", () => {
    const findings = detectFeeCapability(makeInput(FEE_CODE));
    expect(findings.length).toBe(1);
    expect(findings[0]?.pluginId).toBe("dev.brandklipparen.example-fee-capability");
    expect(findings[0]?.payload).toEqual({ selector: "0x69fe0e2d", name: "setFee(uint256)" });
  });

  test("reports no findings when no known fee selector is present", () => {
    expect(detectFeeCapability(makeInput(NO_FEE_CODE))).toEqual([]);
  });
});
