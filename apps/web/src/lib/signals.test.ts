import { describe, expect, test } from "vitest";
import { signalTitle, strongestSignal } from "./signals.ts";
import type { Signal } from "../types.ts";

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
    severity: "low",
    evidence: [{ selector: "0x40c10f19", offset: null }],
  },
];

describe("signal descriptions (K-021)", () => {
  test("k021_strongest_signal_picks_highest_severity", () => {
    expect(strongestSignal(SIGNALS, "rug-pull")?.id).toBe("mintable");
    expect(strongestSignal(SIGNALS, "honeypot")?.id).toBe("owner-blacklist");
    expect(strongestSignal(SIGNALS, "bot-pump")).toBeUndefined();
  });

  test("k021_signal_title_is_plain_text", () => {
    expect(signalTitle(SIGNALS[0] as Signal)).toBe("Owner Blacklist");
  });
});
