import { describe, expect, test } from "vitest";
import { parseHash } from "./route.ts";

describe("hash routing (design review P1-13)", () => {
  test("design_review_parse_token_route", () => {
    expect(parseHash("#/token/0xabc")).toEqual({
      name: "token",
      address: "0xabc",
      view: { kind: "main" },
    });
    expect(parseHash("#/")).toEqual({ name: "start" });
    expect(parseHash("")).toEqual({ name: "start" });
  });

  test("design_review_malformed_encoding_falls_back_without_throwing", () => {
    expect(parseHash("#/token/%E0%A4%A")).toEqual({
      name: "token",
      address: "",
      view: { kind: "main" },
    });
  });
});

describe("plugin routes (UI v2 §1.3)", () => {
  const address = "0xabc";

  test("main token route keeps the legacy form", () => {
    expect(parseHash(`#/token/${address}`)).toEqual({
      name: "token",
      address,
      view: { kind: "main" },
    });
  });

  test("plugins board route", () => {
    expect(parseHash(`#/token/${address}/plugins`)).toEqual({
      name: "token",
      address,
      view: { kind: "plugins" },
    });
  });

  test("plugin detail route", () => {
    expect(parseHash(`#/token/${address}/plugins/blacklist`)).toEqual({
      name: "token",
      address,
      view: { kind: "plugin", slug: "blacklist" },
    });
  });

  test("decompiler detail route with a selector", () => {
    expect(parseHash(`#/token/${address}/plugins/decompiler/0x0ecb93c0`)).toEqual({
      name: "token",
      address,
      view: { kind: "plugin", slug: "decompiler", fn: "0x0ecb93c0" },
    });
  });

  test("full plugin id slug stays URL-encoded and decodes back", () => {
    const id = "dev.brandklipparen.third-party";
    expect(parseHash(`#/token/${address}/plugins/${encodeURIComponent(id)}`)).toEqual({
      name: "token",
      address,
      view: { kind: "plugin", slug: id },
    });
  });

  test("unknown token subpaths fall back to the main view", () => {
    expect(parseHash(`#/token/${address}/unknown`)).toEqual({
      name: "token",
      address,
      view: { kind: "main" },
    });
  });
});
