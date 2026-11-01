// Explain panel unit test (addendum §A2, VS-2): the request button
// links its consent line, the live region announces the ready counts,
// typed sentences keep the full text in the tree, and every failure
// state names the cause with a retry. Behavior only: rendered text,
// roles and accessible names.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { entryChips, ExplainCodeButton, ExplainViewResults, type ExplainRuntime, type TypedEntry } from "./ExplainCode.tsx";

function noop(): void {}

function summaryEntry(overrides: Partial<TypedEntry> = {}): TypedEntry {
  return {
    key: "summary-0",
    kind: "summary",
    text: "Only the owner can call this.",
    shown: "Only the owner can call this.",
    done: true,
    mounted: true,
    note: null,
    cites: [],
    lines: [],
    ...overrides,
  };
}

function noteEntry(key: string, from: number, to: number, text: string): TypedEntry {
  return {
    key,
    kind: "note",
    text,
    shown: text,
    done: true,
    mounted: true,
    note: { lines: [from, to], from, to, text, cites: [] },
    cites: [],
    lines: [from, to],
  };
}

function runtime(overrides: Partial<ExplainRuntime> = {}): ExplainRuntime {
  return {
    status: "ready",
    provider: "meta-model-api",
    modelId: "muse-spark-1.3",
    dropped: 0,
    entries: [
      summaryEntry(),
      noteEntry("note-0", 3, 4, "The owner check happens here."),
      noteEntry("note-1", 4, 4, "The block list gains one wallet."),
      noteEntry("note-2", 6, 6, "This emits the change."),
    ],
    liveLines: new Set(),
    citedLines: new Set([3, 4, 6]),
    readyMessage: "Muse explanation ready: 1 summary, 3 notes.",
    request: noop,
    retry: noop,
    askAgain: noop,
    ...overrides,
  };
}

describe("explain code panel", () => {
  test("the button links its consent line and names the busy state", () => {
    const idle = renderToString(
      <ExplainCodeButton label="Explain this code" consentId="consent-1" busy={false} testId="explain" onPress={noop} />,
    );
    expect(idle).toContain('aria-describedby="consent-1"');
    expect(idle).toContain("Explain this code");
    const busy = renderToString(
      <ExplainCodeButton label="Explain this code" consentId="consent-1" busy={true} testId="explain" onPress={noop} />,
    );
    expect(busy).toContain("Explaining…");
    expect(busy).toContain('aria-busy="true"');
  });

  test("the live region announces the ready counts and the footer stands", () => {
    const html = renderToString(
      <ExplainViewResults runtime={runtime()} title="addBlackList(address)" lineCount={6} chipsFor={() => null} />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Muse explanation ready: 1 summary, 3 notes.");
    expect(html).toContain("What this function does");
    expect(html).toContain("Muse · ");
    expect(html).toContain("muse-spark-1.3");
    expect(html).toContain("AI explanation · does not change the score");
    expect(html).toContain("Ask again");
  });

  test("a dropped note is named in plain words", () => {
    const html = renderToString(
      <ExplainViewResults
        runtime={runtime({ dropped: 1 })}
        title="addBlackList(address)"
        lineCount={6}
        chipsFor={() => null}
      />,
    );
    expect(html).toContain("1 note removed: it cited lines that don&#x27;t exist.");
  });

  test("a typing sentence keeps the full text in the accessibility tree", () => {
    const html = renderToString(
      <ExplainViewResults
        runtime={runtime({
          readyMessage: null,
          entries: [summaryEntry({ shown: "Only the owner", done: false })],
        })}
        title="addBlackList(address)"
        lineCount={6}
        chipsFor={() => null}
      />,
    );
    expect(html).toContain('aria-hidden="true">Only the owner');
    expect(html).toContain('<span class="sr-only">Only the owner can call this.</span>');
  });

  test("invalid output names the cause with no notes rendered", () => {
    const html = renderToString(
      <ExplainViewResults
        runtime={runtime({ status: "invalid-output", entries: [], readyMessage: null })}
        title="addBlackList(address)"
        lineCount={6}
        chipsFor={() => null}
      />,
    );
    expect(html).toContain("cited code that isn&#x27;t there");
    expect(html).toContain("Try again");
    expect(html).toContain("AI explanation · does not change the score");
    expect(html).not.toContain("muse-note");
  });

  test("capped and failed states name the cause with a retry", () => {
    const capped = renderToString(
      <ExplainViewResults
        runtime={runtime({ status: "capped", entries: [], readyMessage: null })}
        title="addBlackList(address)"
        lineCount={6}
        chipsFor={() => null}
      />,
    );
    expect(capped).toContain("Daily Muse limit reached. Try again tomorrow.");
    const failed = renderToString(
      <ExplainViewResults
        runtime={runtime({ status: "failed", entries: [], readyMessage: null })}
        title="addBlackList(address)"
        lineCount={6}
        chipsFor={() => null}
      />,
    );
    expect(failed).toContain("Muse didn&#x27;t answer. The code and evidence are unchanged.");
    expect(failed).toContain("Try again");
  });

  test("a source note at absolute file lines chips its absolute range", () => {
    const maps = {
      lines: new Set([120, 121, 122]),
      functions: new Map<string, string>(),
      evidence: new Map<string, string>(),
    };
    const handlers = { onLine: noop, onFunction: noop, onEvidence: noop };
    const html = renderToString(
      <>
        {entryChips(
          {
            kind: "note",
            cites: [],
            note: { lines: [121, 122], from: 121, to: 122, text: "The owner check happens here.", cites: [] },
            lines: [121, 122],
          },
          { selector: "0xa9059cbb", view: "source" },
          maps,
          handlers,
        )}
      </>,
    );
    expect(html).toContain("L121–122");
    expect(html).toContain('aria-label="Muse note for line 121"');
    expect(html).toContain("<button");
  });

  test("a stale relative line in an absolute pane renders as plain text", () => {
    const maps = {
      lines: new Set([120, 121, 122]),
      functions: new Map<string, string>(),
      evidence: new Map<string, string>(),
    };
    const handlers = { onLine: noop, onFunction: noop, onEvidence: noop };
    const html = renderToString(
      <>
        {entryChips(
          {
            kind: "note",
            cites: [],
            note: { lines: [2, 3], from: 2, to: 3, text: "The owner check happens here.", cites: [] },
            lines: [2, 3],
          },
          { selector: "0xa9059cbb", view: "source" },
          maps,
          handlers,
        )}
      </>,
    );
    expect(html).toContain("L2–3");
    expect(html).toContain('class="cite-chip is-unknown"');
    expect(html).not.toContain("<button");
  });

  test("the pending line names the function being read", () => {
    const html = renderToString(
      <ExplainViewResults
        runtime={runtime({ status: "pending", entries: [], readyMessage: null })}
        title="addBlackList(address)"
        lineCount={6}
        chipsFor={() => null}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Muse is reading");
    expect(html).toContain("addBlackList(address)");
  });
});
