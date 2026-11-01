// Production guard for the demo REST key (SEC-1 S-1): the Vite dev
// server may receive VITE_DEMO_API_KEY for the local demo, but a
// production build must never contain a REST key. The guard is pure so
// the build config and the tests share exactly one rule.
export function demoApiKeyForBuild(mode: string, value: string | undefined): string {
  if (mode === "production") {
    if (value !== undefined && value !== "") {
      throw new Error(
        "VITE_DEMO_API_KEY must not be set for a production build: a REST key must never ship in a web bundle. Unset it and rebuild.",
      );
    }
    return "";
  }
  return value ?? "";
}

export function demoApiKeyDefine(mode: string, value: string | undefined): Record<string, string> {
  if (mode !== "production") {
    return {};
  }
  return {
    "import.meta.env.VITE_DEMO_API_KEY": JSON.stringify(demoApiKeyForBuild(mode, value)),
  };
}
