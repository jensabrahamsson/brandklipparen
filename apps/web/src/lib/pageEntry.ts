// Page entry (UI-7): a change to a different page scrolls to the top at
// once and moves focus to the page H1, so screen readers announce the
// new page and a visitor who opened a token from a long list lands at
// its top. Moving between plugin views of one token keeps the page
// identity, so those views keep their own scroll and focus handling.
import type { Route } from "./route.ts";

// Identity of the page a route renders. Token views share the token's
// identity; a different token or a different top-level page is a new page.
export function pageIdentity(route: Route): string {
  return route.name === "token" ? `token:${route.address}` : route.name;
}

// Whether entering the route moves focus to the page H1. Plugin views
// focus their own heading (the board and the detail H1), and a deep-linked
// function row keeps focus on the row the route names.
export function entryFocusesHeading(route: Route): boolean {
  return route.name !== "token" || route.view.kind === "main";
}

// Moves focus to the first H1 under `main`. Token pages render their H1
// only after the analysis resolves, so focus waits for it. Focus moves
// only while nothing holds it (the body), so a visitor who has already
// tabbed elsewhere keeps their place. Returns a stop function.
export function focusHeadingWhenRendered(main: HTMLElement, timeoutMs = 15000): () => void {
  let observer: MutationObserver | null = null;
  let timer: number | undefined;
  const stop = (): void => {
    observer?.disconnect();
    observer = null;
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  };
  const tryFocus = (): boolean => {
    const heading = main.querySelector("h1");
    if (heading === null) {
      return false;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) {
      heading.focus({ preventScroll: true });
    }
    return true;
  };
  if (!tryFocus()) {
    observer = new MutationObserver(() => {
      if (tryFocus()) {
        stop();
      }
    });
    observer.observe(main, { childList: true, subtree: true });
    timer = window.setTimeout(stop, timeoutMs);
  }
  return stop;
}
