// Explanatory motion for code views (addendum §A4). One helper,
// `runSequence`, built on element.animate() with the allowed
// properties only (opacity, colour, glow). Every sequence is one-shot,
// finishes instantly on any user input, and under prefers-reduced-motion
// applies end states synchronously without ever creating an animation.
export type MotionStep = {
  // A null element skips the animation but still runs the end state.
  readonly element: Element | null;
  readonly keyframes: Keyframe[];
  readonly options?: KeyframeAnimationOptions | undefined;
  // The resting style the sequence leaves behind (a target class, a
  // correspondence background). Runs in every mode, including static.
  readonly endState?: (() => void) | undefined;
};

const running = new Set<Animation>();
let cancelInstalled = false;

function installCancelOnInput(): void {
  if (cancelInstalled || typeof window === "undefined") {
    return;
  }
  cancelInstalled = true;
  const finish = (): void => {
    finishAll();
  };
  window.addEventListener("keydown", finish, { passive: true });
  window.addEventListener("pointerdown", finish, { passive: true });
  window.addEventListener("wheel", finish, { passive: true });
}

// Reduced motion: the end state renders at once, exactly what the
// static equivalent teaches.
export function motionAllowed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    typeof window.matchMedia !== "function" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Finish every running animation at its end state now. Any input during
// a sequence calls this, so the visitor is never made to wait.
export function finishAll(): void {
  for (const animation of Array.from(running)) {
    try {
      animation.finish();
    } catch {
      // Already finished or cancelled: the end state below still runs.
    }
    running.delete(animation);
  }
}

function track(animation: Animation): Animation {
  running.add(animation);
  animation.onfinish = () => {
    running.delete(animation);
  };
  animation.oncancel = () => {
    running.delete(animation);
  };
  return animation;
}

// A newer sequence in the same function body finishes the older one
// first: sequences never overlap, so at most 2 ignites start per
// second and the page stays under 3 flashes/s (WCAG 2.3.1).
export async function runSequence(
  steps: readonly MotionStep[],
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<void> {
  installCancelOnInput();
  finishAll();
  if (options.signal?.aborted) {
    return;
  }
  if (!motionAllowed()) {
    for (const step of steps) {
      if (options.signal?.aborted) {
        return;
      }
      step.endState?.();
    }
    return;
  }
  for (const step of steps) {
    if (options.signal?.aborted) {
      return;
    }
    step.endState?.();
    if (step.element === null || step.element === undefined) {
      continue;
    }
    const target = step.element as Element & {
      animate?: (keyframes: Keyframe[], options?: KeyframeAnimationOptions) => Animation;
    };
    if (typeof target.animate !== "function") {
      continue;
    }
    try {
      const animation = track(target.animate(step.keyframes, { duration: 160, easing: "ease-out", ...step.options }));
      await animation.finished.catch(() => undefined);
    } catch {
      // A finished animation rejects: the end state already ran.
    }
  }
}

// E-1 read-along cited-line ignite: while a sentence types, its cited
// lines rise and hold until the next sentence starts, then settle to
// the faint cited background the `is-cited` class leaves behind. The
// shape matches the E-2 pulse (token glow only); the class, applied as
// the end state, carries the hold.
export function runCitedIgnite(
  elements: readonly (Element | null)[],
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<void> {
  return runSequence(
    elements.map((element) => ({
      element,
      keyframes: pulseKeyframes(),
      options: { duration: 160 },
    })),
    options,
  );
}

// E-7 notes open inline: each note callout opens with the approved X-1
// height expand (CSS `grid-template-rows`, never a transform), then its
// text powers on here (opacity 240 ms). Notes open top to bottom with
// a 120 ms stagger, max 6; turning notes off is instant (unmount, no
// exit animation). Static mode renders every note at rest with no
// animation and no stagger wait.
export async function runNotesIntro(
  elements: readonly (Element | null)[],
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<void> {
  const limited = elements.slice(0, 6);
  const animated = motionAllowed();
  for (const element of limited) {
    if (options.signal?.aborted) {
      return;
    }
    await runSequence(
      [
        {
          element,
          keyframes: [{ opacity: 0 }, { opacity: 1 }],
          options: { duration: 240 },
        },
      ],
      options,
    );
    if (animated && !options.signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 120);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

export type ProofWalkStep = {
  readonly element: Element | null;
  // The resting style the step leaves behind: a numbered chip beside
  // the line and the evidence rail. Runs in every mode, including
  // static.
  readonly endState?: (() => void) | undefined;
};

// E-3 proof path walk: steps light in order across functions (owner
// check, write, gate read, reverting require). Each step ignites
// (160 ms) and the walk paces at 450 ms per step, settling at the end.
// Total stays under 2.5 s for 4 steps; any input finishes it instantly
// through finishAll. Static mode lights every step with numbered chips
// and the synced checklist, no animation.
export async function runProofWalk(
  steps: readonly ProofWalkStep[],
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<void> {
  const animated = motionAllowed();
  for (const step of steps) {
    if (options.signal?.aborted) {
      return;
    }
    await runSequence(
      [
        {
          element: step.element,
          keyframes: pulseKeyframes(),
          options: { duration: 160 },
          endState: step.endState,
        },
      ],
      options,
    );
    if (animated && !options.signal?.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 290);
        options.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

// E-4 proof stop point: passed steps light exactly like E-3, then the
// failing step's code location (when known) gets a dashed amber-free
// rail and the "stopped here" note types in (M-4, component-level).
// The failed step never ignites: absence is not an event. Static mode
// renders passed chips plus the dashed rail and note text at once.
export async function runProofStop(
  passed: readonly ProofWalkStep[],
  failed: ProofWalkStep,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<void> {
  await runProofWalk(passed, options);
  if (options.signal?.aborted) {
    return;
  }
  // No ignite on the failed step: apply the resting style directly so
  // no animation is ever created for it, in any motion mode.
  failed.endState?.();
}

// E-2 chip-to-line pulse: one ignite (160 ms rise) settling to the
// target style in 600 ms. Exactly one pulse, never a loop.
export function pulseKeyframes(): Keyframe[] {
  return [
    { boxShadow: "var(--shadow-off)", opacity: 1 },
    {
      boxShadow: "var(--code-target-glow)",
      opacity: 1,
      offset: 0.21,
    },
    { boxShadow: "var(--code-target-rest)", opacity: 1 },
  ];
}
