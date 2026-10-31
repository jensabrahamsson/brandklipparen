// Hash routing with the plugin sub-level (UI v2 §1.3). The analysis
// fetch stays keyed on `address` only: moving between views never
// refetches, TokenPage stays mounted and the analysis state is kept.
// `<slug>` is the last dot segment of the plugin id when it is unique,
// otherwise the full id, URL-encoded.
export type TokenView =
  | { readonly kind: "main" }
  | { readonly kind: "plugins" }
  | { readonly kind: "plugin"; readonly slug: string; readonly fn?: string | undefined };

export type Route =
  | { readonly name: "start" }
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
  // Only the decompiler detail takes a third segment (the selector to
  // expand and focus); anything deeper falls back to the plugin view.
  if (slug === "decompiler" && parts.length === 3 && (parts[2] ?? "") !== "") {
    return { name: "token", address, view: { kind: "plugin", slug, fn: parts[2] } };
  }
  return { name: "token", address, view: { kind: "plugin", slug } };
}
