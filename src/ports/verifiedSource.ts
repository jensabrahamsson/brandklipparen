// Verified-source port behind GET /v1/source (VS-B2). The port is owned
// by the core: adapters fetch published contract sources and the
// application service maps them to the served shape. Scoring, signals,
// evidence and the analyze envelope stay untouched: this port feeds a
// separate read route only. Two adapters implement this port: the open
// source-verification API (primary) and the block explorer source
// endpoint (fallback through the existing explorer key, only when it is
// configured). Tests inject recorded synthetic fixtures and never reach
// the network. Ports import the domain only.
import type { Result } from "../domain/result.ts";

// Verified-source providers. The primary names the open
// source-verification API; the fallback names the block explorer source
// endpoint behind the existing explorer key.
export type VerifiedSourceProvider = "sourcify" | "etherscan";

// Full or partial verification match from the primary; the fallback
// carries no match notion and reports null.
export type VerifiedSourceMatch = "full" | "partial";

// One published source file: the provider path plus the file text as
// published. Hidden characters are marked visible by the application
// service before serving, never here.
export type VerifiedSourceRawFile = {
  readonly path: string;
  readonly content: string;
};

// Raw provider answer: the file set plus the contract ABI entries the
// application service maps to selectors. `none` means the provider was
// reached and holds nothing for the address; transport trouble is the
// error branch, never `none`.
export type VerifiedSourceRaw = {
  readonly status: "verified" | "none";
  readonly provider: VerifiedSourceProvider;
  readonly match: VerifiedSourceMatch | null;
  readonly compiler: string | null;
  readonly files: readonly VerifiedSourceRawFile[];
  readonly abi: readonly unknown[];
};

export type VerifiedSourceFetchError = {
  readonly kind: "unavailable" | "invalid-response";
  readonly message: string;
};

// Driven fetch for one EIP-55 address string. Synchronous input,
// asynchronous transport: the caller supplies the checksummed address
// and the adapter returns the raw provider answer.
export type VerifiedSourcePort = {
  readonly fetchVerifiedSource: (
    address: string,
  ) => Promise<Result<VerifiedSourceRaw, VerifiedSourceFetchError>>;
};
