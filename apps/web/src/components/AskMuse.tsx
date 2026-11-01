// Ask field (UI v2 §1.4, W-8, Option A): the one question field in the
// Muse console. The question doubles as the priorities text (same
// `brandklipparen-user-priorities:v1` key, K-035): typing only edits the
// local text and re-runs the deterministic tile match, with zero network.
// Pressing Ask sends one `/v1/chat` request; the button keeps focus and
// uses `aria-disabled` with a hint instead of `disabled`, so the empty
// state reads as not-yet-ready rather than broken. The consent is one
// line, and the clear icon empties the field and removes the stored key.
import type { FormEvent, JSX } from "react";

export function AskMuse({
  question,
  onQuestionChange,
  onQuestionClear,
  onAsk,
  pending,
  modelLabel,
}: {
  readonly question: string;
  readonly onQuestionChange: (text: string) => void;
  readonly onQuestionClear: () => void;
  readonly onAsk: () => void;
  readonly pending: boolean;
  readonly modelLabel: string;
}): JSX.Element {
  const empty = question.trim().length === 0;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (empty || pending) {
      return;
    }
    onAsk();
  };
  return (
    <form
      className="muse-ask"
      onSubmit={submit}
    >
      <label htmlFor="muse-ask-input">Ask about this token</label>
      <div className="muse-ask-row">
        <input
          id="muse-ask-input"
          data-testid="ask-field"
          className="input"
          type="text"
          value={question}
          maxLength={500}
          placeholder="Can the owner stop me selling?"
          autoComplete="off"
          onChange={(event) => onQuestionChange(event.target.value)}
        />
        <button
          type="button"
          className="icon-btn"
          data-testid="ask-clear"
          aria-label="Clear question"
          title="Clear question"
          onClick={() => {
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
        <button
          type="submit"
          className="button"
          data-testid="ask-submit"
          aria-disabled={empty || pending}
          aria-busy={pending}
          aria-describedby={empty ? "ask-hint" : undefined}
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
      <p
        id="ask-hint"
        className="quiet"
        data-testid="ask-hint"
        style={empty ? undefined : { visibility: "hidden" }}
        aria-hidden={empty ? undefined : true}
      >
        Type your question above to enable.
      </p>
      <p className="quiet" style={{ margin: "4px 0 0" }}>
        Sends your question to {modelLabel}. Not the address.
      </p>
    </form>
  );
}
