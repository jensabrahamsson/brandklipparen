// Hash routing with the plugin sub-level (UI v2 §1.3). The analysis
// fetch stays keyed on `address` only: moving between views never
// refetches, TokenPage stays mounted and the analysis state is kept.
// `<slug>` is the last dot segment of the plugin id when it is unique,
// otherwise the full id, URL-encoded.
export type CodePaneView = "decompiled" | "source";

export type TokenView =
  | { readonly kind: "main" }
  | { readonly kind: "plugins" }
  | {
      readonly kind: "plugin";
      readonly slug: string;
      readonly fn?: string | undefined;
      readonly view?: CodePaneView | undefined;
      readonly pc?: number | undefined;
    };

export type Route =
  | { readonly name: "start" }
  | { readonly name: "settings" }
  | { readonly name: "token"; readonly address: string; readonly view: TokenView };

function mainView(address: string): Route {
  return { name: "token", address, view: { kind: "main" } };
}

// Hash routing parser (design review P1-13): a malformed percent-encoding
// in the hash falls back to the invalid-address view instead of throwing.
// An empty token address fails isValidAddress, which renders that view.
export function parseHash(hash: string): Route {
  if (hash === "" || hash === "#/" || hash === "#") {
    return { name: "start" };
  }
  if (hash === "#/settings") {
    return { name: "settings" };
  }
  const match = /^#\/token\/(.+)$/.exec(hash);
  if (match?.[1] === undefined) {
    return { name: "start" };
  }
  const rest = match[1];
  const slash = rest.indexOf("/");
  const addressPart = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? "" : rest.slice(slash + 1);
  let address: string;
  try {
    address = decodeURIComponent(addressPart);
  } catch {
    return { name: "token", address: "", view: { kind: "main" } };
  }
  if (tail === "") {
    return mainView(address);
  }
  const segments = tail.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return null;
    }
  });
  if (segments.includes(null)) {
    return mainView(address);
  }
  const parts = segments as string[];
  if (parts[0] !== "plugins") {
    // Legacy form: anything after the address that is not a plugin path
    // renders the main view, exactly as `#/token/0x…` always did.
    return mainView(address);
  }
  if (parts.length === 1) {
    return { name: "token", address, view: { kind: "plugins" } };
  }
  const slug = parts[1] ?? "";
  if (slug === "") {
    return { name: "token", address, view: { kind: "plugins" } };
  }
  if (parts.length === 2) {
    return { name: "token", address, view: { kind: "plugin", slug } };
  }
  // The decompiler detail takes the selector to expand and focus,
  // then the optional code pane view and the optional offset whose line
  // to target (addendum §A1.1): `…/<selector>[/decompiled|source[/<pc>]]`.
  // Unknown trailing segments fall back to the function without view or
  // pc, so shared deep links stay honest about what they point at.
  if (slug === "decompiler" && parts.length >= 3 && (parts[2] ?? "") !== "") {
    const fn = parts[2] as string;
    if (parts.length === 3) {
      return { name: "token", address, view: { kind: "plugin", slug, fn } };
    }
    const maybeView = parts[3] ?? "";
    const view: CodePaneView | undefined = maybeView === "decompiled" || maybeView === "source" ? maybeView : undefined;
    const pcText = view === undefined ? maybeView : (parts[4] ?? "");
    if (parts.length === 4 && view !== undefined) {
      return { name: "token", address, view: { kind: "plugin", slug, fn, view } };
    }
    const pc = parsePcSegment(pcText);
    if (pc === null) {
      return view === undefined
        ? { name: "token", address, view: { kind: "plugin", slug, fn } }
        : { name: "token", address, view: { kind: "plugin", slug, fn, view } };
    }
    if ((view === undefined && parts.length === 4) || (view !== undefined && parts.length === 5)) {
      return view === undefined
        ? { name: "token", address, view: { kind: "plugin", slug, fn, pc } }
        : { name: "token", address, view: { kind: "plugin", slug, fn, view, pc } };
    }
    return view === undefined
      ? { name: "token", address, view: { kind: "plugin", slug, fn } }
      : { name: "token", address, view: { kind: "plugin", slug, fn, view } };
  }
  return { name: "token", address, view: { kind: "plugin", slug } };
}

function parsePcSegment(segment: string | undefined): number | null {
  if (segment === undefined || segment === "") {
    return null;
  }
  if (/^0x[0-9a-fA-F]+$/.test(segment)) {
    const value = Number.parseInt(segment, 16);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (/^[0-9]+$/.test(segment)) {
    const value = Number.parseInt(segment, 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  return null;
}

// Deep link to the code view (addendum §A1.1): the function expanded
// with the offset's line targeted. Honest about its target: view and
// pc ride along only when known.
export function codeHref(
  address: string,
  selector: string,
  view: CodePaneView = "decompiled",
  pc: number | null = null,
): string {
  const base = `#/token/${encodeURIComponent(address)}/plugins/decompiler/${encodeURIComponent(selector)}/${view}`;
  if (pc === null || !Number.isSafeInteger(pc) || (pc as number) < 0) {
    return base;
  }
  return `${base}/0x${(pc as number).toString(16)}`;
}
