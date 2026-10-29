// Token page heading: the token symbol when known (analysis
// response first, live-list entry second), the short address otherwise.
// The name rides as secondary text when known, the FULL contract
// address always rides as secondary meta with a copy button, and DEX
// plus human age join it when the live entry is known. Static markup:
// no motion, no transforms.
//
// The meta line wraps only between items on narrow screens: each small
// item (name, DEX, fee tier, age) is one unbreakable unit that carries
// its own leading separator, so a separator never dangles at a line
// edge and "2 min ago" never splits. The address item alone may wrap.
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
          {identity.name === null ? null : (
            <span aria-hidden="true" className="meta-sep">
              {" · "}
            </span>
          )}
          <span className="addr-full" data-testid="token-address-full">
            {checksummed}
          </span>{" "}
          <CopyButton value={checksummed} label="Copy contract address" testId="copy-contract-address" />
        </span>
        {liveEntry === null ? null : (
          <>
            <span className="meta-item">
              <span aria-hidden="true" className="meta-sep">
                {" · "}
              </span>
              {liveEntry.dex}
            </span>
            {typeof liveEntry.feeTier !== "number" ? null : (
              <span className="meta-item">
                <span aria-hidden="true" className="meta-sep">
                  {" · "}
                </span>
                {`${liveEntry.feeTier / 10000}%`}
              </span>
            )}
            <span className="meta-item" data-testid="token-meta-age">
              <span aria-hidden="true" className="meta-sep">
                {" · "}
              </span>
              {formatAge(liveEntry.ageSeconds)}
            </span>
          </>
        )}
      </p>
    </header>
  );
}
