// Event topic0 naming tests (VS-B1). Every table row's topic matches
// keccak256 of its signature; known topics resolve, unknown topics stay
// null so the printer keeps the raw hex and never invents a name.
import { describe, expect, test } from "vitest";
import { keccak256HexOfUtf8 } from "../../../src/domain/types.ts";
import { EVENT_TABLE_VERSION, eventNameForTopic0, eventRows, topic0Of } from "../../../src/domain/eventNames.ts";

describe("event topic naming", () => {
  test("version_is_pinned", () => {
    expect(EVENT_TABLE_VERSION).toBe("1.0.0");
  });

  test("every_table_topic_matches_keccak_of_its_signature", () => {
    const rows = eventRows();
    expect(rows.length).toBeGreaterThan(9);
    for (const row of rows) {
      expect(topic0Of(row.signature)).toBe(keccak256HexOfUtf8(row.signature).toLowerCase());
    }
  });

  test("known_admin_event_topics_resolve", () => {
    expect(eventNameForTopic0(topic0Of("Transfer(address,address,uint256)"))).toBe("Transfer");
    expect(eventNameForTopic0(topic0Of("AddedBlackList(address)"))).toBe("AddedBlackList");
    expect(eventNameForTopic0(topic0Of("RemovedBlackList(address)"))).toBe("RemovedBlackList");
    expect(eventNameForTopic0(topic0Of("Issue(uint256)"))).toBe("Issue");
    expect(eventNameForTopic0(topic0Of("Redeem(uint256)"))).toBe("Redeem");
    expect(eventNameForTopic0(topic0Of("Params(uint256,uint256)"))).toBe("Params");
    expect(eventNameForTopic0(topic0Of("Paused(address)"))).toBe("Paused");
    expect(eventNameForTopic0(topic0Of("Upgraded(address)"))).toBe("Upgraded");
  });

  test("unknown_topic_stays_null_and_case_insensitive", () => {
    expect(eventNameForTopic0("0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")).toBe(null);
    expect(eventNameForTopic0(topic0Of("Transfer(address,address,uint256)").toUpperCase())).toBe("Transfer");
  });
});
