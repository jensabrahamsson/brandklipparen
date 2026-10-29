// Token identity resolution for the token page heading: the analysis
// response symbol/name wins when the chain answers, else the live-list
// entry the visitor came from, else nothing (the caller then shows the
// short address). The fields are display-only: they never steer scoring,
// evidence or navigation.
import { shortAddress } from "./liveTokens.ts";

export type TokenIdentitySource = {
  readonly tokenSymbol?: string | undefined;
  readonly tokenName?: string | undefined;
};

export type LiveIdentitySource = {
  readonly symbol: string | null;
  readonly name: string | null;
} | null;

export type TokenIdentity = {
  readonly symbol: string | null;
  readonly name: string | null;
};

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
  const symbol = clean(result.tokenSymbol) ?? clean(liveEntry?.symbol ?? null);
  const name = clean(result.tokenName) ?? clean(liveEntry?.name ?? null);
  return { symbol, name };
}

// Recently-analyzed row title (S-131): the symbol when the row carries
// one, else the short address, so rows never show a 42-char hex run.
export function recentRowTitle(symbol: string | null | undefined, address: string): string {
  return clean(symbol) ?? shortAddress(address);
}
