// ASK-1 chat citation markers: kept answers carry the `[E:<id>]` markers
// the web turns into evidence chips, built from the validated citations
// list. Uncited and uncollected answers keep dropping as before.
import { describe, expect, test } from "vitest";
import { checkChatCitations } from "../../../src/application/chatService.ts";

const COLLECTED = new Set(["signal:owner-blacklist", "signal:pausable"]);

describe("chat citation markers (ASK-1)", () => {
  test("ask1_kept_answer_without_marker_gains_one_per_validated_citation", () => {
    const checked = checkChatCitations(
      [
        {
          text: "Yes. The owner can stop you selling by blocking your wallet or pausing transfers.",
          citations: ["signal:owner-blacklist", "signal:pausable"],
        },
      ],
      COLLECTED,
    );
    expect(checked.answers).toEqual([
      "Yes. The owner can stop you selling by blocking your wallet or pausing transfers. [E:signal:owner-blacklist] [E:signal:pausable]",
    ]);
    expect(checked.droppedClaims).toBe(0);
  });

  test("ask1_answer_already_carrying_a_marker_is_not_duplicated", () => {
    const checked = checkChatCitations(
      [
        {
          text: "The owner can block your wallet. [E:signal:owner-blacklist]",
          citations: ["signal:owner-blacklist"],
        },
        {
          text: "Trading can be paused. [e: signal:pausable]",
          citations: ["signal:pausable"],
        },
      ],
      COLLECTED,
    );
    expect(checked.answers).toEqual([
      "The owner can block your wallet. [E:signal:owner-blacklist]",
      "Trading can be paused. [e: signal:pausable]",
    ]);
    expect(checked.droppedClaims).toBe(0);
  });

  test("ask1_uncited_and_uncollected_answers_still_drop", () => {
    const checked = checkChatCitations(
      [
        { text: "The owner can stop you selling.", citations: [] },
        { text: "The owner can mint new tokens.", citations: ["signal:mintable"] },
        {
          text: "The owner can block your wallet.",
          citations: ["signal:owner-blacklist"],
        },
      ],
      COLLECTED,
    );
    expect(checked.answers).toEqual(["The owner can block your wallet. [E:signal:owner-blacklist]"]);
    expect(checked.droppedClaims).toBe(2);
  });
});
