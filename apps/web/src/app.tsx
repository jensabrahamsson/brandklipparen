import { useCallback, useEffect, useState, type JSX, type MouseEvent } from "react";
import { parseHash, type Route } from "./lib/route.ts";
import { initialApiKey } from "./lib/initialApiKey.ts";
import { Pictogram } from "./components/Pictogram.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { StartPage } from "./pages/StartPage.tsx";
import { TokenPage } from "./pages/TokenPage.tsx";

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
          <b>BK</b>
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
        {route.name === "start" ? (
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
