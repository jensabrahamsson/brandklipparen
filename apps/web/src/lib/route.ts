export type Route = { readonly name: "start" } | { readonly name: "token"; readonly address: string };

// Hash routing parser (design review P1-13): a malformed percent-encoding
// in the hash falls back to the invalid-address view instead of throwing.
// An empty token address fails isValidAddress, which renders that view.
export function parseHash(hash: string): Route {
  const match = /^#\/token\/(.+)$/.exec(hash);
  if (match?.[1] === undefined) {
    return { name: "start" };
  }
  try {
    return { name: "token", address: decodeURIComponent(match[1]) };
  } catch {
    return { name: "token", address: "" };
  }
}
