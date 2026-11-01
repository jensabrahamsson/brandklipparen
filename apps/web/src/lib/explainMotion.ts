// Explanatory motion for code views (addendum §A4). One helper,
// `runSequence`, built on element.animate() with the allowed
// properties only (opacity, colour, glow). Every sequence is one-shot,
// finishes instantly on any user input, and under prefers-reduced-motion
// or data-motion="off" applies end states synchronously without ever
// creating an animation.
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

// Reduced motion or the Motion switch off: the end state renders at
// once, exactly what the static equivalent teaches.
export function motionAllowed(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  if (document.documentElement.dataset["motion"] === "off") {
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
