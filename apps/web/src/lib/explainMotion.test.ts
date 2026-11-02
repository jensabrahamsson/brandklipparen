// Explanatory motion unit test (addendum §A4): sequences run end
// states synchronously under reduced motion without creating
// animations, and a newer sequence finishes the older one first. Node
// environment: the window and animated elements are stubs, matching
// the motion.test.ts pattern.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  finishAll,
  motionAllowed,
  pulseKeyframes,
  runCitedIgnite,
  runNotesIntro,
  runProofStop,
  runProofWalk,
  runSequence,
} from "./explainMotion.ts";

type FakeElement = {
  animate: (...args: unknown[]) => FakeAnimation;
};

type FakeAnimation = {
  finished: Promise<void>;
  finish: () => void;
  onfinish: null | (() => void);
  oncancel: null | (() => void);
};

function stubViewer(options: { reduce: boolean }): void {
  vi.stubGlobal("window", {
    matchMedia: (query: string) => ({
      matches: options.reduce && String(query).includes("reduce"),
      media: query,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
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
    stubViewer({ reduce: true });
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
    stubViewer({ reduce: false });
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

  test("cited ignite creates no animations when static", async () => {
    stubViewer({ reduce: true });
    const calls: FakeAnimation[] = [];
    await runCitedIgnite([
      fakeElement(calls, true) as unknown as Element,
      null,
      fakeElement(calls, true) as unknown as Element,
    ]);
    expect(calls).toEqual([]);
  });

  test("notes intro creates no animations when static", async () => {
    stubViewer({ reduce: true });
    const calls: FakeAnimation[] = [];
    const elements = Array.from({ length: 8 }, () => fakeElement(calls, true) as unknown as Element);
    await runNotesIntro(elements);
    expect(calls).toEqual([]);
  });

  test("proof walk lights steps in order", async () => {
    stubViewer({ reduce: false });
    const calls: FakeAnimation[] = [];
    const order: string[] = [];
    await runProofWalk([
      { element: fakeElement(calls, true) as unknown as Element, endState: () => order.push("owner-check") },
      { element: fakeElement(calls, true) as unknown as Element, endState: () => order.push("write") },
      { element: null, endState: () => order.push("gate") },
    ]);
    expect(order).toEqual(["owner-check", "write", "gate"]);
    expect(calls).toHaveLength(2);
  });

  test("proof stop never animates the failed step", async () => {
    stubViewer({ reduce: false });
    const calls: FakeAnimation[] = [];
    const order: string[] = [];
    await runProofStop(
      [{ element: fakeElement(calls, true) as unknown as Element, endState: () => order.push("passed") }],
      { element: fakeElement(calls, true) as unknown as Element, endState: () => order.push("stopped") },
    );
    // Absence is not an event: only the passed step ignites.
    expect(order).toEqual(["passed", "stopped"]);
    expect(calls).toHaveLength(1);
  });

  test("proof sequences apply every end state with no animations when static", async () => {
    stubViewer({ reduce: true });
    const calls: FakeAnimation[] = [];
    const order: string[] = [];
    await runProofWalk([
      { element: fakeElement(calls, true) as unknown as Element, endState: () => order.push("one") },
      { element: fakeElement(calls, true) as unknown as Element, endState: () => order.push("two") },
    ]);
    await runProofStop([], {
      element: fakeElement(calls, true) as unknown as Element,
      endState: () => order.push("stopped"),
    });
    expect(order).toEqual(["one", "two", "stopped"]);
    expect(calls).toEqual([]);
  });
});
