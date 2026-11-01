// Token page heading: the token symbol when known (analysis
// response first, live-list entry second), the short address otherwise.
// The name rides the h1 as a subtitle when known. The FULL contract
// address is an address block: row 1 is the label row carrying the copy
// button, row 2 is the grouped value full width, and DEX plus human age
// ride one shared meta unit below when the live entry is known. Static
// markup: no motion, no transforms.
//
// Wrapping: the name shares the h1 line and the DEX unit never breaks
// inside, so no meta separator can strand or sit raised after the name.
// The address value alone may wrap, and only between its visual
// 4-character groups (spans with a CSS margin gap, <wbr> between them,
// no space characters) so the element textContent, the accessible text and a
// mouse selection stay the exact EIP-55 string; the copy button copies
// it unchanged.
import { Fragment } from "react";
import type { JSX } from "react";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { formatAge, shortAddress } from "../lib/liveTokens.ts";
import type { LiveTokenEntry } from "../lib/liveTokens.ts";
import type { TokenIdentity } from "../lib/tokenIdentity.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Pictogram } from "./Pictogram.tsx";

export function groupAddressChunks(checksummed: string): readonly string[] {
  // Keep "0x" glued to the first hex group: an address renders as
  // "0x" + 4 hex + nine more groups of 4 (ten groups, never an orphan
  // 2-character tail), and a hash renders as "0x" + 4 hex + fifteen
  // more groups. Slices without a prefix simply chunk in fours.
  const prefixed = checksummed.startsWith("0x") || checksummed.startsWith("0X");
  const prefix = prefixed ? checksummed.slice(0, 2) : "";
  const body = prefixed ? checksummed.slice(2) : checksummed;
  const chunks: string[] = [];
  const first = body.slice(0, 4);
  if (first.length > 0) {
    chunks.push(prefix + first);
  }
  for (let index = 4; index < body.length; index += 4) {
    chunks.push(body.slice(index, index + 4));
  }
  return chunks;
}

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
      <h1 className="token-sym">
        {identity.symbol ?? shortAddress(address)}
        {identity.name === null ? null : <span className="token-sub">{identity.name}</span>}
      </h1>
      <div className="token-addr">
        <div className="token-addr-top">
          <span className="token-addr-label">
            <Pictogram name="contract" size={16} />
            <span>Contract</span>
          </span>
          <CopyButton value={checksummed} label="Copy contract address" testId="copy-contract-address" />
        </div>
        <span className="addr-full" data-testid="token-address-full">
          {groupAddressChunks(checksummed).map((chunk, index) => (
            <Fragment key={index}>
              {index === 0 ? null : <wbr />}
              <span className="addr-chunk">{chunk}</span>
            </Fragment>
          ))}
        </span>
      </div>
      {liveEntry === null ? null : (
        <p className="token-meta">
          <span className="meta-item">
            {liveEntry.dex}
            {typeof liveEntry.feeTier !== "number" ? null : ` · ${liveEntry.feeTier / 10000}%`}
            {" · "}
            <span data-testid="token-meta-age">{formatAge(liveEntry.ageSeconds)}</span>
          </span>
        </p>
      )}
    </header>
  );
}
