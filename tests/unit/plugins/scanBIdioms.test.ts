// SCAN-B blacklist idioms reproduced as synthetic bytecode: an
// allowlist gate in its AND and OR forms, which must never read as a
// blacklist, plus list gates below the transfer entry (in a nested
// helper, and short-circuited by an exemption entry). Synthetic token
// addresses carry the 0x5ab1e prefix. Assertions check the reported
// fact and its weight-0 extended proof, never internal proof steps.
import { describe, expect, test } from "vitest";
import { Bytecode, CodeHash } from "../../../src/domain/types.ts";
import type { DetectorInput } from "../../../src/plugins/detector.ts";
import type { Result } from "../../../src/domain/result.ts";
import { blacklistDetectorPlugin } from "../../../src/plugins/detectors/blacklist/index.ts";
import {
  allowlistAndBlacklistTokenHex,
  allowlistOrBlacklistTokenHex,
  listedNotExemptBlacklistTokenHex,
  nestedHelperBlacklistTokenHex,
} from "../../helpers/ownerControlFixtures.ts";

const ALLOWLIST_AND_TOKEN = "0x5ab1e000000000000000000000000000000000b1";
const ALLOWLIST_OR_TOKEN = "0x5ab1e000000000000000000000000000000000b2";
const NESTED_HELPER_TOKEN = "0x5ab1e000000000000000000000000000000000b3";
const LISTED_NOT_EXEMPT_TOKEN = "0x5ab1e000000000000000000000000000000000b4";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

function inputOf(hex: string): DetectorInput {
  const parsed = Bytecode.parse(hex);
  if (!parsed.ok) {
    throw new Error(`expected valid bytecode, got error: ${parsed.error.message}`);
  }
  return Object.freeze({ bytecode: parsed.value, codeHash: mustOk(CodeHash.of(parsed.value)) });
}

describe("SCAN-B blacklist idioms", () => {
  test(`allowlist-and gate stays silent (${ALLOWLIST_AND_TOKEN})`, () => {
    expect(blacklistDetectorPlugin.detect(inputOf(allowlistAndBlacklistTokenHex()))).toEqual([]);
  });

  test(`allowlist-or gate stays silent (${ALLOWLIST_OR_TOKEN})`, () => {
    expect(blacklistDetectorPlugin.detect(inputOf(allowlistOrBlacklistTokenHex()))).toEqual([]);
  });

  test(`nested-helper gate reports an extended blacklist fact (${NESTED_HELPER_TOKEN})`, () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(nestedHelperBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.payload).toEqual({ fact: "blacklist", proof: "extended" });
  });

  test(`listed-and-not-exempt gate reports a blacklist finding (${LISTED_NOT_EXEMPT_TOKEN})`, () => {
    const findings = blacklistDetectorPlugin.detect(inputOf(listedNotExemptBlacklistTokenHex()));
    expect(findings).toHaveLength(1);
    expect([
      { feature: "blacklist" },
      { fact: "blacklist", proof: "extended" },
    ]).toContainEqual(findings[0]?.payload);
  });
});
