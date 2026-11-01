// Unit test for the shared decompiler summary line (R3 D-8): the tile
// body, the detail header sentence and the list summary are the same
// string for the same payloads. Behavior only: rendered strings, with a
// synthetic USDT-shaped fixture (32 functions, mixed causes).
import { describe, expect, test } from "vitest";
import { PLUGIN_COPY, ranStatusWord } from "./pluginCopy.ts";
import {
  decompilerSummaryLine,
  parseDecompilerFunctions,
  summarizeDecompilerFunctions,
} from "./decompilerView.ts";

function hexOf(index: number): string {
  return `0x${index.toString(16).padStart(8, "0")}`;
}

// 32 synthetic payloads: 21 named, 13 partly read. The 13 mix the old
// `unexpected-control-flow` shape with the routine `no-plain-return`
// transfer shape, and the guarded row carries the jump max.
function usdtPayloads(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let index = 0; index < 32; index += 1) {
    const selector = hexOf(index + 1);
    const named = index < 21;
    const partly = index < 13;
    const transfer = selector === "0xa9059cbb";
    out.push({
      selector,
      name: named ? `fn${index}` : `function_${selector.slice(2)}`,
      signature: named ? `fn${index}(address)` : "",
      entryPc: 100 + index,
      startPc: 100 + index,
      endPc: 200 + index,
      annotations: index === 0 ? ["token-pattern: guarded-state-update"] : [],
      cause: partly ? (transfer || index % 2 === 0 ? "no-plain-return" : "unexpected-control-flow") : null,
      unresolvedJumps: index === 0 ? 55 : 0,
    });
  }
  out.push({
    selector: "0xa9059cbb",
    name: "transfer",
    signature: "transfer(address,uint256)",
    entryPc: 45,
    startPc: 45,
    endPc: 120,
    annotations: [],
    cause: "no-plain-return",
    unresolvedJumps: 0,
  });
  return out;
}

describe("decompiler tile, header and list summary (R3 D-8)", () => {
  test("no-plain-return counts as partly read in one shared string", () => {
    const payloads = usdtPayloads();
    const transfer = payloads.filter(
      (entry) => (entry["selector"] as string) === "0xa9059cbb",
    );
    expect(PLUGIN_COPY["decompiler"]?.foundLine(transfer)).toBe("1 function · 1 named · 1 partly read (0 jumps not followed)");
  });

  test("tile line and list summary match for the USDT shape", () => {
    const payloads = usdtPayloads();
    const tileLine = PLUGIN_COPY["decompiler"]?.foundLine(payloads) ?? "";
    const listLine = decompilerSummaryLine(summarizeDecompilerFunctions(parseDecompilerFunctions(payloads)));
    expect(tileLine).toBe(listLine);
    expect(tileLine).toBe("33 functions · 22 named · 14 partly read (55 jumps not followed)");
  });

  test("u8_every_detector_has_its_own_cant_tell_sentence", () => {
    const lines = Object.values(PLUGIN_COPY).map((entry) => entry.cantTellLine);
    expect(new Set(lines).size).toBe(lines.length);
    expect(PLUGIN_COPY["ownership"]?.cantTellLine).toBe(
      "We found no stored owner the code compares with the caller.",
    );
    for (const line of lines) {
      expect(line).not.toBe("The code that matters here could not be fully read.");
    }
  });

  test("the tool status word names the decompiler function count", () => {
    const decompiler = PLUGIN_COPY["decompiler"];
    const capability = PLUGIN_COPY["capability"];
    if (decompiler === undefined || capability === undefined) {
      throw new Error("tool copy is missing");
    }
    expect(ranStatusWord(decompiler, 32)).toBe("Ran · 32 functions");
    expect(ranStatusWord(decompiler, 1)).toBe("Ran · 1 function");
    expect(ranStatusWord(capability, 3)).toBe("Ran");
  });
});
