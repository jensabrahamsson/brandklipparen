import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("MCP launch documentation", () => {
  test("documented stdio command keeps npm banners off stdout", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("npm --silent run start:mcp");
    expect(readme).toContain('"args": ["--silent", "run", "start:mcp"]');
    expect(readme).not.toContain('"args": ["run", "start:mcp"]');
  });
});
