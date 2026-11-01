// Explanatory motion unit test (addendum §A4): sequences run end
// states synchronously under reduced motion or Motion off without
// creating animations, and a newer sequence finishes the older one
// first. Node environment: the window, document and animated elements
// are stubs, matching the motion.test.ts pattern.
import { afterEach, describe, expect, test, vi } from "vitest";
import { finishAll, motionAllowed, pulseKeyframes, runSequence } from "./explainMotion.ts";

type FakeElement = {
  animate: (...args: unknown[]) => FakeAnimation;
};

type FakeAnimation = {
  finished: Promise<void>;
  finish: () => void;
  onfinish: null | (() => void);
  oncancel: null | (() => void);
};

function stubViewer(options: { reduce: boolean; motionOff: boolean }): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: options.reduce && String(query).includes("reduce"),
      media: query,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("document", {
    documentElement: { dataset: options.motionOff ? { motion: "off" } : {} },
  });
}

function fakeElement(calls: FakeAnimation[], resolveOnStart: boolean): FakeElement {
  return {
    animate: () => {
      let resolveFinished = (): void => undefined;
      const animation: FakeAnimation = {
        finished: new Promise<void>((resolve) => {
          resolveFinished = resolve;
        }),
        finish: () => {
          resolveFinished();
        },
        onfinish: null,
        oncancel: null,
      };
      calls.push(animation);
      if (resolveOnStart) {
        resolveFinished();
      }
      return animation;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("explanatory motion", () => {
  test("reduced motion applies end states with no animations", async () => {
    stubViewer({ reduce: true, motionOff: false });
    expect(motionAllowed()).toBe(false);
    const calls: FakeAnimation[] = [];
    let settled = false;
    await runSequence([
      {
        element: fakeElement(calls, true) as unknown as Element,
        keyframes: pulseKeyframes(),
        endState: () => (settled = true),
      },
    ]);
    expect(settled).toBe(true);
    expect(calls).toEqual([]);
  });

  test("motion off applies end states with no animations", async () => {
    stubViewer({ reduce: false, motionOff: true });
    expect(motionAllowed()).toBe(false);
    const calls: FakeAnimation[] = [];
    let settled = false;
    await runSequence([
      {
        element: fakeElement(calls, true) as unknown as Element,
        keyframes: pulseKeyframes(),
        endState: () => (settled = true),
      },
    ]);
    expect(settled).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a newer sequence finishes the older one first", async () => {
    stubViewer({ reduce: false, motionOff: false });
    expect(motionAllowed()).toBe(true);
    const calls: FakeAnimation[] = [];
    const target = fakeElement(calls, false) as unknown as Element;
    const order: string[] = [];
    const first = runSequence([
      { element: target, keyframes: pulseKeyframes(), endState: () => order.push("first") },
    ]);
    const second = runSequence([{ element: null, keyframes: [], endState: () => order.push("second") }]);
    await Promise.all([first, second]);
    finishAll();
    expect(calls).toHaveLength(1);
    expect(order).toEqual(["first", "second"]);
  });

  test("pulse keyframes use token glow only", () => {
    for (const frame of pulseKeyframes()) {
      for (const value of Object.values(frame)) {
        if (typeof value === "string" && value.includes("0 0") && !value.includes("var(--")) {
          expect.unreachable(`raw glow value ${value}`);
        }
      }
    }
  });
});
