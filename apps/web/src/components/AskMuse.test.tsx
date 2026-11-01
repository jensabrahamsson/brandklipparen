// Ask field unit tests (UI v2 §1.2, R2-8): one question field with the
// one-line consent. The Ask button always looks enabled; an empty submit
// focuses the field and shows the error hint only then. The clear icon
// renders only when the field is non-empty. Behavior based: rendered
// text, roles and accessible names only.
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { AskMuse, exampleQuestionsForSlugs } from "./AskMuse.tsx";

const cssDir = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(cssDir, "..", "styles.css"), "utf8");
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

function renderAsk(question: string, pending = false, examples?: readonly string[]): string {
  return renderToString(
    <AskMuse
      question={question}
      onQuestionChange={() => undefined}
      onQuestionClear={() => undefined}
      onAsk={() => undefined}
      pending={pending}
      modelLabel="muse-spark-1.3"
      examples={examples}
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

  test("placeholder_stays_short_with_tappable_examples_below", () => {
    const html = renderAsk("");
    expect(html).toContain('placeholder="Type your question"');
    expect(html).not.toContain('placeholder="Ask about this token"');
    expect(html).toContain('aria-label="Example questions"');
    expect(html).toContain("Who controls this token?");
  });

  test("example_chips_fill_without_submitting", () => {
    const html = renderAsk("", false, ["Can the owner block my wallet?", "Who controls this token?"]);
    expect(html).toContain("Can the owner block my wallet?");
    expect(html).toContain("Who controls this token?");
    // Plain buttons inside the form: tapping one fills the field and
    // can never submit it, so no request leaves the page.
    expect(html).not.toContain('type="submit" data-testid="ask-example"');
    expect(html.match(/data-testid="ask-example"/g)).toHaveLength(2);
  });

  test("clear_reserve_padding_only_when_the_field_is_non_empty", () => {
    expect(renderAsk("")).toContain('class="muse-ask-field"');
    expect(renderAsk("")).not.toContain("muse-ask-field has-value");
    expect(renderAsk("Can the owner stop me selling?")).toContain('class="muse-ask-field has-value"');
    const reserved = code.match(/\.muse-ask-field\.has-value\s+\.input\s*\{[^}]*\}/)?.[0] ?? "";
    expect(reserved, "clear padding only with a value").toMatch(/padding-right:\s*44px/);
    const base = code.match(/\.muse-ask-field\s+\.input\s*\{[^}]*\}/)?.[0] ?? "";
    expect(base, "empty field keeps the full width").not.toMatch(/padding-right:\s*44px/);
  });

  test("examples_come_from_the_found_owner_powers", () => {
    expect(exampleQuestionsForSlugs(["blacklist", "pause"])).toEqual([
      "Can the owner block my wallet?",
      "Can the owner freeze trading?",
      "Who controls this token?",
    ]);
    expect(exampleQuestionsForSlugs(["pause"])).toEqual([
      "Can the owner freeze trading?",
      "Who controls this token?",
    ]);
    expect(exampleQuestionsForSlugs([])).toEqual(["Who controls this token?"]);
  });

  test("stacked_layout_and_chip_boxes_hold_below_480", () => {
    const stacked = code.match(/@media\s*\(max-width:\s*479px\)\s*\{[\s\S]*?\.muse-ask-row\s*\{[^}]*\}/)?.[0] ?? "";
    expect(stacked, "ask stacks below 480").toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    const chip = code.match(/(?:^|\n)\.muse-chip\s*\{[^}]*\}/)?.[0] ?? "";
    expect(chip, "example chips keep the 44 px box").toMatch(/min-height:\s*44px/);
    expect(chip).toMatch(/min-width:\s*44px/);
  });
});
