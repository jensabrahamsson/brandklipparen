import { describe, expect, test } from "vitest";
import { ringOutOfView, truncateHash } from "./summaryStrip.ts";

describe("summary strip visibility helper", () => {
  test("ring_out_of_view_follows_intersection", () => {
    expect(ringOutOfView(true)).toBe(false);
    expect(ringOutOfView(false)).toBe(true);
  });

  test("ring_out_of_view_hides_strip_without_entry", () => {
    expect(ringOutOfView(undefined)).toBe(false);
  });
});

describe("summary strip hash truncation", () => {
  test("truncate_hash_keeps_short_hashes_whole", () => {
    expect(truncateHash("0xabc")).toBe("0xabc");
  });

  test("truncate_hash_shortens_long_hashes_with_ellipsis", () => {
    const full = `0x${"ab".repeat(32)}`;
    const short = truncateHash(full);
    expect(short.length).toBeLessThan(full.length);
    expect(short).toContain("…");
    expect(short.startsWith("0xab")).toBe(true);
    expect(short.endsWith(full.slice(-4))).toBe(true);
  });
});
