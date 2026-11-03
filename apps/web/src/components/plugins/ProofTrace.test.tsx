// Proof trace rendering (UI v2 §5.5, W-11): the stopped-step
// headline, the "stopped here" row, the screen-reader status words,
// and the Expert-only server detail. Behavior only: rendered text,
// roles and heading order.
import { describe, expect, test } from "vitest";
import { renderToString } from "react-dom/server";
import { ProofTrace } from "./ProofTrace.tsx";
import type { ProofStep } from "../../lib/api.ts";

function pauseSteps(): ProofStep[] {
  return [
    { step: "owner-slot", ok: true, detail: "owner slot 0 proven beside a caller guard" },
    { step: "writer-regions", ok: true, detail: "3 functions write settings" },
    { step: "candidate-slots", ok: true, detail: "candidate flag slots: 0" },
    { step: "transfer-gate", ok: false, detail: "no gate on transfer 0xa9059cbb" },
    { step: "same-slot-and-bit", ok: false, detail: "not evaluated: no gate" },
    { step: "reverting-jumpi", ok: false, detail: "not evaluated: no gate" },
    { step: "packed-write-proof", ok: false, detail: "not evaluated: no gate" },
  ];
}

describe("proof trace", () => {
  test("a failing transfer gate names the stopped step", () => {
    const html = renderToString(<ProofTrace steps={pauseSteps()} expert={false} />);
    expect(html).toContain("<h2>Proof</h2>");
    expect(html).toContain("We stopped at step 4 of 7");
    expect(html).toContain("← failed here");
  });

  test("the screen reader text names failed and skipped steps", () => {
    const html = renderToString(<ProofTrace steps={pauseSteps()} expert={false} />);
    expect(html).toContain("failed");
    expect(html).toContain("skipped");
    expect(html).not.toContain("owner slot 0 proven beside a caller guard");
  });

  test("expert shows the server detail beside each step", () => {
    const html = renderToString(<ProofTrace steps={pauseSteps()} expert={true} />);
    expect(html).toContain("owner slot 0 proven beside a caller guard");
    expect(html).toContain("no gate on transfer 0xa9059cbb");
  });

  test("every step ok reads all steps proven", () => {
    const steps = pauseSteps().map((entry) => ({ ...entry, ok: true }));
    const html = renderToString(<ProofTrace steps={steps} expert={false} />);
    expect(html).toContain("All steps proven");
    expect(html).not.toContain("stopped here");
  });

  test("the failed row carries the plain failure sentence", () => {
    const html = renderToString(<ProofTrace steps={pauseSteps()} expert={false} />);
    expect(html).toContain("Transfer never reads it.");
  });
});
