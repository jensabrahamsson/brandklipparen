import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import { parseHash, type Route } from "./lib/route.ts";
import { entryFocusesHeading, focusHeadingWhenRendered, pageIdentity } from "./lib/pageEntry.ts";
import { initialApiKey } from "./lib/initialApiKey.ts";
import { Pictogram } from "./components/Pictogram.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { StartPage } from "./pages/StartPage.tsx";
import { TokenPage } from "./pages/TokenPage.tsx";
import { AboutPage } from "./pages/AboutPage.tsx";

function loadApiKey(): string {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem("brandklipparen-api-key");
  } catch {
    stored = null;
  }
  // Dev-only demo key (`npm run demo` sets VITE_DEMO_API_KEY for the dev
  // server): initial field value solely when import.meta.env.DEV is true
  // and the visitor has no entered or stored key. The branch is dead code
  // in a production build, where neither DEV nor the variable is set.
  const demoKey: unknown = import.meta.env.VITE_DEMO_API_KEY;
  return initialApiKey(stored, import.meta.env.DEV, typeof demoKey === "string" ? demoKey : undefined);
}

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [apiKey, setApiKey] = useState(loadApiKey);

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // UI-7 page entry: a change to another page scrolls to the top at once
  // (no smooth scrolling is set anywhere, so this is an instant jump) and
  // moves focus to the page H1. The first render only records the page.
  const pageId = pageIdentity(route);
  const focusesHeading = entryFocusesHeading(route);
  const seenPage = useRef<string | null>(null);
  const stopFocus = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const previous = seenPage.current;
    seenPage.current = pageId;
    if (previous === null || previous === pageId) {
      return;
    }
    stopFocus.current?.();
    stopFocus.current = null;
    window.scrollTo(0, 0);
    const main = document.getElementById("main");
    if (focusesHeading && main !== null) {
      stopFocus.current = focusHeadingWhenRendered(main);
    }
  }, [pageId, focusesHeading]);
  useLayoutEffect(() => () => stopFocus.current?.(), []);

  const storeApiKey = useCallback((key: string) => {
    setApiKey(key);
    try {
      sessionStorage.setItem("brandklipparen-api-key", key);
    } catch {
      // Session storage is a convenience only; the app works without it.
    }
  }, []);

  const goToken = useCallback((address: string) => {
    window.location.hash = `#/token/${encodeURIComponent(address)}`;
  }, []);

  const goHome = useCallback(() => {
    window.location.hash = "#/";
  }, []);

  // Design review P0-2: a plain "#main" link resets hash routing to the
  // start page. Prevent the default jump, keep the hash, move focus.
  const onSkip = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const main = document.getElementById("main");
    if (main !== null) {
      main.focus({ preventScroll: true });
      main.scrollIntoView();
    }
  }, []);

  return (
    <div>
      <a className="skip-link" href="#main" onClick={onSkip}>
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="#/">
          <img src="/logo.svg" alt="" />
          brandklipparen
        </a>
        <span className="bar-desc">contract risk scanner</span>
        <span className="spacer" />
        <span className="net">
          <Pictogram name="chain" size={20} />
          <span className="net-text">Ethereum mainnet</span>
        </span>
      </header>
      <main id="main" tabIndex={-1}>
        {route.name === "about" ? (
          <AboutPage />
        ) : route.name === "settings" ? (
          <SettingsPage apiKey={apiKey} onApiKeyChange={storeApiKey} />
        ) : route.name === "start" ? (
          <StartPage apiKey={apiKey} onApiKeyChange={storeApiKey} onAnalyze={goToken} />
        ) : (
          <ErrorBoundary key={route.address}>
            <TokenPage address={route.address} view={route.view} apiKey={apiKey} onHome={goHome} />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}
