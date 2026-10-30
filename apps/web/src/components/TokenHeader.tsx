// Token page heading: the token symbol when known (analysis
// response first, live-list entry second), the short address otherwise.
// The name rides as secondary text when known, the FULL contract
// address always rides as secondary meta with a copy button, and DEX
// plus human age join it when the live entry is known. Static markup:
// no motion, no transforms.
//
// The meta line wraps only between items on narrow screens: each small
// item is one unbreakable unit. DEX, fee tier and age ride one shared
// unit with interior separators, and every other boundary draws its
// separator through CSS, clipped when the item starts a new line, so a
// separator never strands at a line edge and "2 min ago" never splits.
// The address item alone may wrap.
import type { JSX } from "react";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
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
  const checksummed = toChecksumAddress(address);
  return (
    <header style={{ display: "grid", gap: 4 }}>
      <h1 className="token-sym">{identity.symbol ?? shortAddress(address)}</h1>
      <p className="token-meta">
        {identity.name === null ? null : (
          <span className="meta-item">
            <b>{identity.name}</b>
          </span>
        )}
        <span className="meta-item meta-addr">
          <span className="addr-full" data-testid="token-address-full">
            {checksummed}
          </span>{" "}
          <CopyButton value={checksummed} label="Copy contract address" testId="copy-contract-address" />
        </span>
        {liveEntry === null ? null : (
          <span className="meta-item">
            {liveEntry.dex}
            {typeof liveEntry.feeTier !== "number" ? null : ` · ${liveEntry.feeTier / 10000}%`}
            {" · "}
            <span data-testid="token-meta-age">{formatAge(liveEntry.ageSeconds)}</span>
          </span>
        )}
      </p>
    </header>
  );
}
