import { useCallback, useEffect, useState, type JSX, type MouseEvent } from "react";
import { parseHash, type Route } from "./lib/route.ts";
import { StartPage } from "./pages/StartPage.tsx";
import { TokenPage } from "./pages/TokenPage.tsx";

function loadApiKey(): string {
  try {
    return sessionStorage.getItem("brandklipparen-api-key") ?? "";
  } catch {
    return "";
  }
}

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [chain, setChain] = useState("ethereum");
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
      <header className="page topbar" style={{ paddingBottom: 0 }}>
        <a className="brand" href="#/">
          <img src="/logo.svg" alt="brandklipparen logo" />
          brandklipparen
        </a>
        <span className="spacer" />
        <span className="quiet numeric topbar-tagline">bytecode only · deterministic</span>
      </header>
      <main id="main" tabIndex={-1}>
        {route.name === "start" ? (
          <StartPage
            chain={chain}
            apiKey={apiKey}
            onChainChange={setChain}
            onApiKeyChange={storeApiKey}
            onAnalyze={goToken}
          />
        ) : (
          <TokenPage address={route.address} apiKey={apiKey} onHome={goHome} />
        )}
      </main>
    </div>
  );
}
