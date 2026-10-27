// Output encoding for untrusted contract strings (K-502, K-507, M-04, M-13).
// Pure domain module: every function is a total function of its input
// string and allocates a fresh result, so hostile input stays data through
// every interface. The escaping covers the HTML-significant characters,
// including both quote kinds and the backtick, so an escaped payload
// cannot terminate a quoted value, an attribute or a code span it is
// placed in. No thresholds, weights or limits live here; length caps stay
// with UntrustedText.quote in ./types.ts.
const REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#x27;",
  "`": "&#x60;",
});

// Renders contract-derived text as inert text for HTML and quoted
// contexts: every markup-significant character becomes its entity, so
// script-bearing data shows literally instead of executing.
export function escapeHtml(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] ?? "";
    out += REPLACEMENTS[char] ?? char;
  }
  return out;
}

// Counts raw (unescaped, unencoded) double-quote characters. Escaped
// output from escapeHtml carries none, so hostile input yields at most
// one raw quote in any quoted context it is placed in.
export function countRawDoubleQuotes(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\"") {
      count += 1;
    }
  }
  return count;
}
