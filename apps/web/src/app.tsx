import { useCallback, useEffect, useState, type JSX } from "react";
import { StartPage } from "./pages/StartPage.tsx";
import { TokenPage } from "./pages/TokenPage.tsx";

type Route = { readonly name: "start" } | { readonly name: "token"; readonly address: string };

function parseHash(hash: string): Route {
  const match = /^#\/token\/(.+)$/.exec(hash);
  if (match?.[1] !== undefined) {
    return { name: "token", address: decodeURIComponent(match[1]) };
  }
  return { name: "start" };
}

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

  return (
    <div>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="page topbar" style={{ paddingBottom: 0 }}>
        <a className="brand" href="#/">
          <img src="/logo.svg" alt="brandklipparen logo" />
          brandklipparen
        </a>
        <nav aria-label="Primary">
          <a href="#/" aria-current={route.name === "start" ? "page" : undefined}>
            Just deployed
          </a>
        </nav>
        <span className="spacer" />
        <span className="quiet numeric">bytecode only · deterministic</span>
      </header>
      <main id="main">
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
