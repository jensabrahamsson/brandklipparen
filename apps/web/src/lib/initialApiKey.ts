// Initial REST API key for the demo UI (S-029).
// The demo dev server passes its per-run local key as VITE_DEMO_API_KEY.
// That variable exists only in `vite dev` started by `npm run demo`; a
// production build never sets it, so it can never leak into shipped
// bundles. The value is used solely as the initial API key field value,
// and only when running in dev without a key the visitor already entered
// or stored. A stored or entered key always wins; production (dev false)
// never reads the demo variable.
export function initialApiKey(
  stored: string | null,
  dev: boolean,
  demoKey: string | undefined,
): string {
  if (stored !== null && stored !== "") {
    return stored;
  }
  if (dev && typeof demoKey === "string" && demoKey !== "") {
    return demoKey;
  }
  return "";
}
