// Token identity resolution for the token page heading: the analysis
// response symbol/name wins when the chain answers, else the live-list
// entry the visitor came from, else nothing (the caller then shows the
// short address). The fields are display-only: they never steer scoring,
// evidence or navigation.
import { shortAddress } from "./liveTokens.ts";

export type TokenIdentitySource = {
  readonly tokenSymbol?: string | undefined;
  readonly tokenName?: string | undefined;
  readonly tokenSymbolNonAscii?: boolean | undefined;
  readonly tokenNameNonAscii?: boolean | undefined;
};

export type LiveIdentitySource = {
  readonly symbol: string | null;
  readonly name: string | null;
} | null;

export type TokenIdentity = {
  readonly symbol: string | null;
  readonly name: string | null;
  readonly symbolNonAscii: boolean;
  readonly nameNonAscii: boolean;
};

// Safe display form for a flagged non-ASCII token text (SCAN-2): every
// non-ASCII code point becomes its escape sequence, so a homoglyph can
// never render as the Latin lookalike it imitates. Unflagged text rides
// unchanged.
export function tokenDisplayText(text: string, nonAscii: boolean): string {
  if (!nonAscii) {
    return text;
  }
  let out = "";
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (char === "\\") {
      out += "\\\\";
    } else if (point > 0x7e) {
      out +=
        point <= 0xffff
          ? `\\u${point.toString(16).padStart(4, "0")}`
          : `\\u{${point.toString(16)}}`;
    } else {
      out += char;
    }
  }
  return out;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveTokenIdentity(
  result: TokenIdentitySource,
  liveEntry: LiveIdentitySource,
): TokenIdentity {
  const analysisSymbol = clean(result.tokenSymbol);
  const analysisName = clean(result.tokenName);
  const symbol = analysisSymbol ?? clean(liveEntry?.symbol ?? null);
  const name = analysisName ?? clean(liveEntry?.name ?? null);
  return {
    symbol,
    name,
    symbolNonAscii: analysisSymbol !== null && result.tokenSymbolNonAscii === true,
    nameNonAscii: analysisName !== null && result.tokenNameNonAscii === true,
  };
}

// Recently-analyzed row title (S-131, S-134): the symbol when the row
// carries one, else the short address. The title may stay short; the
// full address always rides next to it in the row meta line.
export function recentRowTitle(symbol: string | null | undefined, address: string): string {
  return clean(symbol) ?? shortAddress(address);
}
