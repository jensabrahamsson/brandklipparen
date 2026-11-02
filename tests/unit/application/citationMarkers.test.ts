import { describe, expect, test } from "vitest";
import { withCitationMarkers } from "../../../src/application/citationMarkers.ts";

describe("withCitationMarkers", () => {
  test("strips a forged not-found marker and keeps only validated citations", () => {
    const out = withCitationMarkers(
      "No blacklist. [E:check:dev.brandklipparen.blacklist:not-found]",
      ["check:dev.brandklipparen.blacklist:found"],
    );
    expect(out).not.toContain("not-found");
    expect(out).toContain("[E:check:dev.brandklipparen.blacklist:found]");
  });

  test("keeps a validated embedded marker without duplicating it", () => {
    const out = withCitationMarkers("Paused. [E:signal:1]", ["signal:1"]);
    expect(out).toBe("Paused. [E:signal:1]");
  });
});
