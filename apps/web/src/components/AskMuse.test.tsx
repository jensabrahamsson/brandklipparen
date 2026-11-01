// Ask field unit tests (UI v2 §1.4, W-8, K-519): one question field with
// the one-line consent, a clear icon, and an Ask button that stays
// focusable with `aria-disabled` plus a hint while empty. Behavior based:
// rendered text, roles and accessible names only.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { AskMuse } from "./AskMuse.tsx";

function renderAsk(question: string, pending = false): string {
  return renderToString(
    <AskMuse
      question={question}
      onQuestionChange={() => undefined}
      onQuestionClear={() => undefined}
      onAsk={() => undefined}
      pending={pending}
      modelLabel="muse-spark-1.3"
    />,
  );
}

describe("ask field (W-8)", () => {
  test("empty_question_keeps_ask_focusable_with_hint_and_consent", () => {
    const html = renderAsk("");
    expect(html).toContain("Ask about this token");
    expect(html).toContain('data-testid="ask-field"');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('data-testid="ask-submit"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Type your question above to enable.");
    expect(html).toContain("Sends your question to");
    expect(html).toContain("muse-spark-1.3");
    expect(html).toContain("Not the address.");
    expect(html).not.toContain("<button disabled");
    expect(html).toContain('aria-label="Clear question"');
  });

  test("filled_question_enables_ask_and_hides_the_hint", () => {
    const html = renderAsk("Can the owner stop me selling?");
    expect(html).toContain('aria-disabled="false"');
    expect(html).toContain('value="Can the owner stop me selling?"');
    expect(html).toContain("visibility:hidden");
  });

  test("pending_ask_announces_itself_as_busy", () => {
    const html = renderAsk("Can the owner stop me selling?", true);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Asking");
  });
});
