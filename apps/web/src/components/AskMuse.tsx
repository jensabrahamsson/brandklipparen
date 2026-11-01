// Ask field (UI v2 §1.2, R2-8): the one question field in the Muse
// console. The question doubles as the priorities text (same
// `brandklipparen-user-priorities:v1` key, K-035): typing only edits the
// local text and re-runs the deterministic tile match, with zero network.
// Pressing Ask sends one `/v1/chat` request. The button always looks
// enabled: an empty submit focuses the field and shows the error hint
// through `aria-describedby` only then. The consent is one line, and the
// clear icon renders only when the field is non-empty.
import { useState, type FormEvent, type JSX } from "react";

export function exampleQuestionsForSlugs(foundSlugs: readonly string[] | ReadonlySet<string>): readonly string[] {
  const found = new Set<string>(foundSlugs);
  const examples: string[] = [];
  if (found.has("blacklist")) {
    examples.push("Can the owner block my wallet?");
  }
  if (found.has("pause")) {
    examples.push("Can the owner freeze trading?");
  }
  examples.push("Who controls this token?");
  return examples;
}

export function AskMuse({
  question,
  onQuestionChange,
  onQuestionClear,
  onAsk,
  pending,
  modelLabel,
  examples = ["Who controls this token?"],
}: {
  readonly question: string;
  readonly onQuestionChange: (text: string) => void;
  readonly onQuestionClear: () => void;
  readonly onAsk: () => void;
  readonly pending: boolean;
  readonly modelLabel: string;
  readonly examples?: readonly string[];
}): JSX.Element {
  const [showError, setShowError] = useState(false);
  const empty = question.trim().length === 0;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (pending) {
      return;
    }
    if (empty) {
      setShowError(true);
      document.getElementById("muse-ask-input")?.focus();
      return;
    }
    setShowError(false);
    onAsk();
  };
  return (
    <form
      className="muse-ask"
      onSubmit={submit}
    >
      <label htmlFor="muse-ask-input">Ask about this token</label>
      <div className="muse-ask-row">
        <div className={empty ? "muse-ask-field" : "muse-ask-field has-value"}>
          <input
            id="muse-ask-input"
            data-testid="ask-field"
            className="input"
            type="text"
            value={question}
            maxLength={500}
            placeholder="Type your question"
            autoComplete="off"
            aria-invalid={showError && empty ? true : undefined}
            aria-describedby={showError && empty ? "ask-hint ask-consent" : "ask-consent"}
            onChange={(event) => {
              if (event.target.value.trim().length > 0) {
                setShowError(false);
              }
              onQuestionChange(event.target.value);
            }}
          />
          {empty ? null : (
            <button
              type="button"
              className="muse-ask-clear"
              data-testid="ask-clear"
              aria-label="Clear question"
              title="Clear question"
              onClick={() => {
                setShowError(false);
                onQuestionClear();
                document.getElementById("muse-ask-input")?.focus();
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  d="m7 7 10 10M17 7 7 17"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
        <button
          type="submit"
          className="button"
          data-testid="ask-submit"
          aria-busy={pending}
        >
          {pending ? (
            <>
              Asking<b className="cursor" aria-hidden="true" />…
            </>
          ) : (
            "Ask"
          )}
        </button>
      </div>
      {showError && empty ? (
        <p
          id="ask-hint"
          className="muse-ask-hint"
          data-testid="ask-hint"
          role="alert"
        >
          Type a question first, then press Ask.
        </p>
      ) : null}
      <p id="ask-consent" className="quiet muse-ask-consent" style={{ margin: "4px 0 0" }}>
        Sends your question to {modelLabel}. Not the address.
      </p>
      {examples.length === 0 ? null : (
        <div className="muse-examples" role="group" aria-label="Example questions">
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="muse-chip"
              data-testid="ask-example"
              onClick={() => {
                setShowError(false);
                onQuestionChange(example);
                document.getElementById("muse-ask-input")?.focus();
              }}
            >
              {example}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}
