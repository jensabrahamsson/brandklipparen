// Token page heading: the token symbol when known (analysis
// response first, live-list entry second), the short address otherwise.
// The name rides as secondary text when known, the FULL contract
// address always rides as secondary meta with a copy button, and DEX
// plus human age join it when the live entry is known. Static markup:
// no motion, no transforms.
import type { JSX } from "react";
import { formatAge, shortAddress } from "../lib/liveTokens.ts";
import type { LiveTokenEntry } from "../lib/liveTokens.ts";
import type { TokenIdentity } from "../lib/tokenIdentity.ts";
import { CopyButton } from "./CopyButton.tsx";

export function TokenHeader({
  address,
  identity,
  liveEntry,
}: {
  readonly address: string;
  readonly identity: TokenIdentity;
  readonly liveEntry: LiveTokenEntry | null;
}): JSX.Element {
  return (
    <header style={{ display: "grid", gap: 4 }}>
      <h1 className="token-sym">{identity.symbol ?? shortAddress(address)}</h1>
      <p className="token-meta">
        {identity.name === null ? null : (
          <>
            <b>{identity.name}</b>
            {" · "}
          </>
        )}
        <span className="addr-full" data-testid="token-address-full">
          {address}
        </span>{" "}
        <CopyButton value={address} label="Copy contract address" testId="copy-contract-address" />
        {liveEntry === null ? null : (
          <>
            {" · "}
            {`${liveEntry.dex}${typeof liveEntry.feeTier === "number" ? ` · ${liveEntry.feeTier / 10000}%` : ""} · ${formatAge(liveEntry.ageSeconds)}`}
          </>
        )}
      </p>
    </header>
  );
}
