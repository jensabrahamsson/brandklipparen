import { describe, expect, test } from "vitest";
import { parseHash } from "./route.ts";

describe("hash routing (design review P1-13)", () => {
  test("design_review_parse_token_route", () => {
    expect(parseHash("#/token/0xabc")).toEqual({ name: "token", address: "0xabc" });
    expect(parseHash("#/")).toEqual({ name: "start" });
    expect(parseHash("")).toEqual({ name: "start" });
  });

  test("design_review_malformed_encoding_falls_back_without_throwing", () => {
    expect(parseHash("#/token/%E0%A4%A")).toEqual({ name: "token", address: "" });
  });
});
