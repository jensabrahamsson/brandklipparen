// Source client unit test (addendum §A1, VS-B2): parsing keeps
// verified, none and unavailable distinct, and helpers slice the
// function's own lines. Synthetic fixtures only.
import { describe, expect, test } from "vitest";
import {
  findSourceFile,
  findSourceFunction,
  sourceFunctionLines,
  toSourceResult,
} from "./source.ts";

function body(status: string): Record<string, unknown> {
  return {
    status: "ok",
    apiVersion: "v1",
    codeHash: "0xabc",
    source: {
      status,
      provider: "Sourcify",
      match: "full",
      compiler: "v0.8.20",
      files: [
        {
          path: "contracts/Token.sol",
          content: ["// first", "contract Token {", "  function addBlackList(address a) {", "    flag[a] = true;", "  }", "}"].join("\n"),
        },
      ],
      functions: [
        {
          selector: "0x0ecb93c0",
          signature: "addBlackList(address)",
          name: "addBlackList",
          file: "contracts/Token.sol",
          startLine: 3,
          endLine: 5,
        },
      ],
      pcToLine: { "200": { file: "contracts/Token.sol", line: 4 } },
    },
  };
}

describe("verified source", () => {
  test("verified parses files, functions and the pc map", () => {
    const result = toSourceResult(body("verified"));
    expect(result?.status).toBe("verified");
    expect(result?.provider).toBe("Sourcify");
    expect(result?.match).toBe("full");
    expect(result?.files).toHaveLength(1);
    expect(result?.functions).toHaveLength(1);
    expect(result?.pcToLine["200"]).toEqual({ file: "contracts/Token.sol", line: 4 });
  });

  test("none and unavailable stay distinct", () => {
    expect(toSourceResult(body("none"))?.status).toBe("none");
    expect(toSourceResult(body("unavailable"))?.status).toBe("unavailable");
    expect(toSourceResult(body("bogus"))).toBeNull();
  });

  test("function lines slice 1-based and clamp to the file", () => {
    const result = toSourceResult(body("verified"));
    const file = findSourceFile(result!, "contracts/Token.sol");
    const fn = findSourceFunction(result!, "0x0ECB93C0");
    expect(fn?.name).toBe("addBlackList");
    expect(sourceFunctionLines(file!, fn!)).toEqual([
      "  function addBlackList(address a) {",
      "    flag[a] = true;",
      "  }",
    ]);
    expect(findSourceFunction(result!, "0xdeadbeef")).toBeNull();
  });
});
