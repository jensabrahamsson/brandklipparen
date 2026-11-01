// Syntax tokeniser for the code view (addendum §A1.5). A small regex
// lexer for the pseudo-Solidity and Solidity subset: no packages, and
// the renderer maps tokens to `<span class="tk-…">` React text, never
// HTML. Roles and colours stay inside the phosphor palette at AA
// contrast on both line backgrounds (see CODE_ROLE_COLORS).
export type CodeRole =
  | "keyword"
  | "builtin"
  | "name"
  | "literal"
  | "comment"
  | "punctuation"
  | "hidden"
  | "plain";

export type CodeToken = {
  readonly text: string;
  readonly role: CodeRole;
};

// Text colours per role. Keyword, builtin and literal share the hi
// phosphor; names use phosphor; comments and punctuation use dim.
// Every role measures at least 4.5:1 on --glass #03110A and on the
// evidence-line background #0C2618 (asserted in codeTokens.test.ts).
export const CODE_ROLE_COLORS: Record<CodeRole, string> = Object.freeze({
  keyword: "#D6FFE6",
  builtin: "#D6FFE6",
  name: "#8DFFB6",
  literal: "#D6FFE6",
  comment: "#4FB27A",
  punctuation: "#4FB27A",
  hidden: "#D6FFE6",
  plain: "#8DFFB6",
});

const KEYWORDS: ReadonlySet<string> = new Set([
  "function",
  "require",
  "if",
  "else",
  "return",
  "returns",
  "emit",
  "revert",
  "for",
  "while",
  "do",
  "break",
  "continue",
  "modifier",
  "mapping",
  "memory",
  "storage",
  "calldata",
  "public",
  "private",
  "internal",
  "external",
  "view",
  "pure",
  "payable",
  "constructor",
  "event",
  "error",
  "struct",
  "contract",
  "interface",
  "library",
  "using",
  "import",
  "pragma",
  "solidity",
  "new",
  "delete",
  "unchecked",
  "assembly",
  "true",
  "false",
]);

// Builtin value sources read from chain state. Dotted access on these
// roots renders as one builtin token (msg.sender, block.timestamp).
const BUILTIN_ROOTS: ReadonlySet<string> = new Set([
  "msg",
  "block",
  "tx",
  "abi",
]);

const BUILTIN_MEMBERS: ReadonlySet<string> = new Set([
  "sender",
  "value",
  "data",
  "sig",
  "gas",
  "timestamp",
  "number",
  "coinbase",
  "difficulty",
  "prevrandao",
  "gaslimit",
  "chainid",
  "basefee",
  "origin",
  "gasprice",
  "encode",
  "decode",
  "encodeWithSelector",
]);

// Bidirectional controls and zero-width characters (the Trojan Source
// trick, §A1.5): they never render invisibly. The tokeniser isolates
// each one so the renderer shows a visible ⟨U+…⟩ chip.
const HIDDEN_PATTERN = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/;

const TOKEN_PATTERN = new RegExp(
  [
    "(?<comment>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))",
    "(?<hex>0[xX][0-9a-fA-F]+)",
    "(?<number>\\b\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?\\b)",
    "(?<builtin>\\b(?:msg|block|tx|abi)\\.[A-Za-z_][A-Za-z0-9_]*)",
    "(?<word>\\b[A-Za-z_][A-Za-z0-9_]*\\b)",
    "(?<punct>[(){}\\[\\];,.:=<>!+\\-*\\/%&|^~?@]+)",
    "(?<space>\\s+)",
  ].join("|"),
  "g",
);

function roleOfWord(word: string): CodeRole {
  if (KEYWORDS.has(word)) {
    return "keyword";
  }
  return "name";
}

function roleOfBuiltin(access: string): CodeRole {
  const dot = access.indexOf(".");
  const root = access.slice(0, dot);
  const member = access.slice(dot + 1).split(".")[0] ?? "";
  if (BUILTIN_ROOTS.has(root) && BUILTIN_MEMBERS.has(member)) {
    return "builtin";
  }
  return "name";
}

// Tokenise one line of pseudo-Solidity or verified source. Hidden
// characters split their own single-character tokens; everything else
// follows the master pattern. Unknown bytes fall through as plain.
export function tokenizeCodeLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let rest = 0;
  const push = (text: string, role: CodeRole): void => {
    const last = tokens[tokens.length - 1];
    if (last !== undefined && last.role === role && (role === "plain" || role === "punctuation")) {
      tokens[tokens.length - 1] = { text: last.text + text, role };
      return;
    }
    tokens.push({ text, role });
  };
  while (rest < line.length) {
    const char = line[rest] ?? "";
    if (HIDDEN_PATTERN.test(char)) {
      push(char, "hidden");
      rest += 1;
      continue;
    }
    TOKEN_PATTERN.lastIndex = rest;
    const match = TOKEN_PATTERN.exec(line);
    if (match === null || match.index !== rest) {
      push(char, "plain");
      rest += 1;
      continue;
    }
    const groups = match.groups ?? {};
    const text = match[0];
    if (groups["comment"] !== undefined) {
      push(text, "comment");
    } else if (groups["hex"] !== undefined || groups["number"] !== undefined) {
      push(text, "literal");
    } else if (groups["builtin"] !== undefined) {
      push(text, roleOfBuiltin(text));
    } else if (groups["word"] !== undefined) {
      push(text, roleOfWord(text));
    } else if (groups["punct"] !== undefined) {
      push(text, "punctuation");
    } else {
      push(text, "plain");
    }
    rest += text.length;
  }
  TOKEN_PATTERN.lastIndex = 0;
  return tokens;
}

// Long hex literals (emit topics, over 18 characters) render
// shortened: the first 6 and last 4 hex characters with an ellipsis.
// The full value stays in `title`, `aria-label` and the copy output.
export const HEX_SHORTEN_AT = 18;

export function shortHex(value: string): string {
  const body = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (value.length <= HEX_SHORTEN_AT || body.length <= 10) {
    return value;
  }
  return `0x${body.slice(0, 6)}…${body.slice(-4)}`;
}

export function isLongHex(value: string): boolean {
  return /^0[xX][0-9a-fA-F]+$/.test(value) && value.length > HEX_SHORTEN_AT;
}

// Visible chip text for one hidden character, e.g. "⟨U+202E⟩".
export function hiddenChipText(char: string): string {
  const point = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
  return `⟨U+${point}⟩`;
}
