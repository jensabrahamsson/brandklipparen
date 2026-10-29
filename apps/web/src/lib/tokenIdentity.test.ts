// Recent-row titles (S-131): the symbol when the chain answered, else
// the short address, so rows never show a 42-char hex run.
import { describe, expect, it } from "vitest";
import { recentRowTitle } from "./tokenIdentity.ts";

const ADDRESS = "0x5ab1e0000000000000000000000000000000a001";

describe("recentRowTitle", () => {
  it("prefers the symbol", () => {
    expect(recentRowTitle("SYNTH", ADDRESS)).toBe("SYNTH");
  });

  it("falls back to the short address without a long hex run", () => {
    const title = recentRowTitle(null, ADDRESS);
    expect(title).toBe("0x5ab1…a001");
    expect(title).not.toMatch(/[0-9a-fA-F]{14,}/);
  });

  it("treats a blank symbol as absent", () => {
    expect(recentRowTitle("   ", ADDRESS)).toBe("0x5ab1…a001");
  });
});
