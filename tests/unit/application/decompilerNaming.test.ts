// Suggested-name resolution (S-083, K-038, K-519, D-11). Written first
// (red) per A-21: `src/application/decompilerNaming.ts` does not exist
// yet. Muse Spark Open suggests display names only, behind an explicit
// opt-in: without a wired port the service answers `not-configured` with
// zero provider calls and the deterministic pseudo-Solidity stands. Any
// unparsable model output is discarded whole (no partial overlay), and the
// suggestions never enter the analysis.
import { describe, expect, test } from "vitest";
import { Bytecode } from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import { decompileContract } from "../../../src/domain/evmSsa.ts";
import { canonicalSerialize } from "../../../src/domain/serialize.ts";
import {
  createDecompilerNamingService,
  resolveSuggestedNames,
} from "../../../src/application/decompilerNaming.ts";
import type { DecompilerNamingOutcome } from "../../../src/ports/decompilerNaming.ts";
import type { DecompilerNamingPort } from "../../../src/ports/decompilerNaming.ts";
import { FakeDecompilerNamingAdapter } from "../../fakes/fakeDecompilerNaming.ts";

const KNOWN = "0xa9059cbb";
const OTHER = "0x70a08231";

describe("d11_naming_without_key_reports_not_configured_and_sends_nothing", () => {
  test("a service without a port is disabled and answers not-configured", async () => {
    const service = createDecompilerNamingService(null);
    expect(service.enabled).toBe(false);
    const outcome = await service.resolve([KNOWN]);
    expect(outcome).toEqual({ kind: "not-configured" });
  });

  test("malformed requests never reach the port", async () => {
    const fake = new FakeDecompilerNamingAdapter("ok", new Map([[KNOWN, "transferTokens"]]));
    expect(await resolveSuggestedNames(fake, [])).toEqual({ kind: "invalid-output" });
    expect(await resolveSuggestedNames(fake, new Array(65).fill(KNOWN) as string[])).toEqual({
      kind: "invalid-output",
    });
    expect(await resolveSuggestedNames(fake, ["not-a-selector"])).toEqual({ kind: "invalid-output" });
    expect(fake.calls.length).toBe(0);
  });

  test("a not-configured port stays not-configured", async () => {
    const fake = new FakeDecompilerNamingAdapter("not-configured");
    expect(await resolveSuggestedNames(fake, [KNOWN])).toEqual({ kind: "not-configured" });
  });
});

describe("d11 suggested names are display-only and validated", () => {
  test("canned names resolve on the requested selectors only", async () => {
    const fake = new FakeDecompilerNamingAdapter("ok", new Map([[KNOWN, "transferTokens"]]));
    const outcome = await resolveSuggestedNames(fake, [KNOWN, OTHER]);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") {
      throw new Error("expected ok names");
    }
    expect(outcome.names.map((entry) => entry.selector).sort()).toEqual([KNOWN, OTHER].sort());
    expect(fake.calls.length).toBe(1);
  });

  test("markup, unknown selectors and partial overlays are discarded whole", async () => {
    const hostile = new FakeDecompilerNamingAdapter("ok", new Map([[KNOWN, "<script>alert(1)</script>"]]));
    expect(await resolveSuggestedNames(hostile, [KNOWN])).toEqual({ kind: "invalid-output" });

    const invalidMode = new FakeDecompilerNamingAdapter("invalid-output");
    expect(await resolveSuggestedNames(invalidMode, [KNOWN])).toEqual({ kind: "invalid-output" });

    const extra: DecompilerNamingPort = {
      suggestNames: async (): Promise<DecompilerNamingOutcome> =>
        Object.freeze({
          kind: "ok",
          names: Object.freeze([{ selector: KNOWN, suggestedName: "transferTokens" }]),
        }),
    };
    expect(await resolveSuggestedNames(extra, [KNOWN, OTHER])).toEqual({ kind: "invalid-output" });
  });
});

describe("d11_suggested_names_never_affect_analysis", () => {
  test("resolving names leaves the deterministic pipeline output untouched", async () => {
    const parsed: Result<Bytecode, { message: string }> = Bytecode.parse("0x608060405234808063a9059cbb1461002d57806370a0823114610047575b60006000fd5b00");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const before = canonicalSerialize(decompileContract(parsed.value) as never);
    const fake = new FakeDecompilerNamingAdapter("ok", new Map([[KNOWN, "transferTokens"]]));
    const outcome = await resolveSuggestedNames(fake, [KNOWN]);
    expect(outcome.kind).toBe("ok");
    const after = canonicalSerialize(decompileContract(parsed.value) as never);
    expect(after).toBe(before);
    expect(decompileContract(parsed.value).text).not.toContain("transferTokens");
  });
});
