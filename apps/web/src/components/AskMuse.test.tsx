// Ask field unit tests (UI v2 §1.2, R2-8): one question field with the
// one-line consent. The Ask button always looks enabled; an empty submit
// focuses the field and shows the error hint only then. The clear icon
// renders only when the field is non-empty. Behavior based: rendered
// text, roles and accessible names only.
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

describe("ask field (R2-8)", () => {
  test("empty_question_shows_no_hint_and_no_clear_with_enabled_ask", () => {
    const html = renderAsk("");
    expect(html).toContain("Ask about this token");
    expect(html).toContain('data-testid="ask-field"');
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('data-testid="ask-submit"');
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain("Sends your question to");
    expect(html).toContain("muse-spark-1.3");
    expect(html).toContain("Not the address.");
    expect(html).not.toContain("<button disabled");
    expect(html).not.toContain('data-testid="ask-clear"');
    expect(html).not.toContain('data-testid="ask-hint"');
    expect(html).not.toContain("Type your question above to enable.");
  });

  test("filled_question_shows_clear_and_keeps_ask_enabled", () => {
    const html = renderAsk("Can the owner stop me selling?");
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain('value="Can the owner stop me selling?"');
    expect(html).toContain('data-testid="ask-clear"');
    expect(html).toContain('aria-label="Clear question"');
    expect(html).not.toContain('data-testid="ask-hint"');
  });

  test("pending_ask_announces_itself_as_busy", () => {
    const html = renderAsk("Can the owner stop me selling?", true);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain("Asking");
  });

  test("placeholder_stays_short_with_a_longer_example_below", () => {
    const html = renderAsk("");
    expect(html).toContain('placeholder="Ask about this token"');
    expect(html).toContain("Example: Can the owner stop me selling?");
  });
});
