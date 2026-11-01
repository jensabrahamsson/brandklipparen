// Citation targets for Muse sentences (round-3 review D-5): every
// coverage id shape maps to a chip label plus a navigation target, and
// unknown ids map to null so they never render as raw text.
import { describe, expect, test } from "vitest";
import { citationTarget } from "./citationTarget.ts";
import type { Signal } from "../types.ts";

const ADDRESS = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const SIGNALS: readonly Signal[] = [
  {
    kind: "capability",
    id: "owner-blacklist",
    risk: "honeypot",
    direction: "raises",
    severity: "high",
    evidence: [{ selector: "0x44337ea1", offset: 2623 }],
  },
  {
    kind: "capability",
    id: "mintable",
    risk: "rug-pull",
    direction: "raises",
    severity: "medium",
    evidence: [{ selector: "0x40c10f19", offset: 100 }],
  },
];

const ALL_IDS = [
  "dev.brandklipparen.pause",
  "dev.brandklipparen.blacklist",
  "dev.brandklipparen.mint",
  "dev.brandklipparen.decompiler",
];

function target(id: string) {
  return citationTarget(id, { signals: SIGNALS, address: ADDRESS, allIds: ALL_IDS });
}

const HONEYPOT_SIGNAL = ["0", "capability", "honeypot"].join("-");

describe("citationTarget", () => {
  test("signal id maps to the short plain title and the signal key", () => {
    expect(target("signal:owner-blacklist")).toEqual({
      kind: "signal",
      label: "Blacklist",
      lamp: "found",
      signalKey: HONEYPOT_SIGNAL,
    });
    expect(target("signal:mintable")).toEqual({
      kind: "signal",
      label: "Mint",
      lamp: "found",
      signalKey: "1-capability-rug-pull",
    });
  });

  test("signal id absent from the signals maps to null", () => {
    expect(target("signal:pausable")).toBeNull();
    expect(target("signal:")).toBeNull();
    expect(target("signal")).toBeNull();
  });

  test("check not-found maps to the plugin title plus not found", () => {
    expect(target("check:dev.brandklipparen.pause:not-found")).toEqual({
      kind: "plugin",
      label: "Pause · not found",
      lamp: "notfound",
      href: `#/token/${ADDRESS}/plugins/pause`,
    });
  });

  test("check could-not-check maps to the plugin title plus can't tell", () => {
    expect(target("check:dev.brandklipparen.pause:could-not-check")).toEqual({
      kind: "plugin",
      label: "Pause · can't tell",
      lamp: "canttell",
      href: `#/token/${ADDRESS}/plugins/pause`,
    });
  });

  test("check with an unknown shape or outcome maps to null", () => {
    expect(target("check:dev.brandklipparen.pause:found")).toBeNull();
    expect(target("check:pause:found")).toBeNull();
    expect(target("check::not-found")).toBeNull();
    expect(target("check:dev.brandklipparen.pause:")).toBeNull();
    expect(target("check:pause")).toBeNull();
    expect(target("check:")).toBeNull();
  });

  test("cant-tell maps a known question to a short label", () => {
    expect(target("cant-tell:liquidity-locks")).toEqual({
      kind: "cant-tell",
      label: "Liquidity lock · can't tell",
      lamp: "canttell",
    });
    expect(target("cant-tell:owner-shares")).toEqual({
      kind: "cant-tell",
      label: "Owner shares · can't tell",
      lamp: "canttell",
    });
  });

  test("cant-tell with an unknown or missing question maps to null", () => {
    expect(target("cant-tell:made-up-question")).toBeNull();
    expect(target("cant-tell:")).toBeNull();
    expect(target("cant-tell")).toBeNull();
  });

  test("analysis summary maps to what we checked on the plugin board", () => {
    expect(target("analysis:summary")).toEqual({
      kind: "plugin",
      label: "What we checked",
      lamp: "check",
      href: `#/token/${ADDRESS}/plugins`,
    });
  });

  test("analysis decompile-incomplete maps to the decompiler detail", () => {
    expect(target("analysis:decompile-incomplete")).toEqual({
      kind: "plugin",
      label: "Decompiler · partly read",
      lamp: "partial",
      href: `#/token/${ADDRESS}/plugins/decompiler`,
    });
  });

  test("anything else maps to null and never prints an id", () => {
    expect(target("analysis:other")).toBeNull();
    expect(target("analysis:")).toBeNull();
    expect(target("0x44337ea1")).toBeNull();
    expect(target("dev.brandklipparen.pause")).toBeNull();
    expect(target("")).toBeNull();
  });
});
