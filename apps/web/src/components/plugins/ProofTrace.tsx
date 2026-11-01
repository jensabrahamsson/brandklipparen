// Proof trace ("How we checked", UI v2 §5.5). A terminal checklist of
// the ordered proof steps from GET /v1/proof: passed steps read with a
// check, the first failing step reads with a cross plus "← stopped
// here", later steps read "not checked". The plain sentence comes from
// the step map; the server detail string shows in Expert only. Motion
// is opacity and glow one-shots (M-7); reduced motion is static.
// Every contract string renders as React text only.
import type { CSSProperties, JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import type { ProofStep } from "../../lib/api.ts";
import { proofHeadline } from "../../lib/pluginState.ts";
import { proofStepCopy } from "../../lib/proofSteps.ts";

function stepStatus(index: number, firstFailed: number): "passed" | "failed" | "not-checked" {
  if (firstFailed === -1 || index < firstFailed) {
    return "passed";
  }
  if (index === firstFailed) {
    return "failed";
  }
  return "not-checked";
}

function Mark({ status }: { readonly status: "passed" | "failed" | "not-checked" }): JSX.Element {
  if (status === "passed") {
    return (
      <span className="proof-mark is-passed" aria-hidden="true">
        <Pictogram name="check" size={20} />
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="proof-mark is-failed" aria-hidden="true">
        <Pictogram name="cross" size={20} />
      </span>
    );
  }
  return (
    <span className="proof-mark is-skipped" aria-hidden="true">
      ·
    </span>
  );
}

const SR_WORD: Record<"passed" | "failed" | "not-checked", string> = {
  passed: "passed",
  failed: "failed",
  "not-checked": "not checked",
};

export function ProofTrace({
  steps,
  expert,
}: {
  readonly steps: readonly ProofStep[];
  readonly expert: boolean;
}): JSX.Element | null {
  if (steps.length === 0) {
    return null;
  }
  const firstFailed = steps.findIndex((entry) => !entry.ok);
  return (
    <section className="card detail-proof" aria-label="How we checked">
      <h2>How we checked</h2>
      <p className="proof-headline">{proofHeadline(steps)}</p>
      <ol className="proof-steps">
        {steps.map((entry, index) => {
          const copy = proofStepCopy(entry.step);
          const status = stepStatus(index, firstFailed);
          return (
            <li
              key={`${entry.step}:${String(index)}`}
              className={`proof-step is-${status}`}
              style={{ "--i": index } as CSSProperties}
            >
              <Mark status={status} />
              <span className="sr-only">{SR_WORD[status]}</span>
              <div className="proof-body">
                <p className="proof-topline">
                  <span className="proof-label">{copy.label}</span>
                  {status === "failed" ? (
                    <span className="proof-stopped">
                      <span aria-hidden="true">← stopped here</span>
                      <span className="sr-only">stopped here</span>
                    </span>
                  ) : null}
                </p>
                {status === "failed" ? <p className="proof-failure">{copy.failure}</p> : null}
                {status === "not-checked" ? <p className="proof-skipped">not checked</p> : null}
                {expert ? <p className="proof-detail">{entry.detail}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
