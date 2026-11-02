// Token page heading: the token symbol when known (analysis
// response first, live-list entry second), the short address otherwise.
// The name rides the h1 as a subtitle when known. The FULL contract
// address is an address block with the copy button immediately after
// the grouped value; DEX and age share a meta unit below. Static
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
import { tokenDisplayText } from "../lib/tokenIdentity.ts";
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
      <h1 className="token-sym" tabIndex={-1}>
        {identity.symbol === null
          ? shortAddress(address)
          : tokenDisplayText(identity.symbol, identity.symbolNonAscii)}
        {identity.symbolNonAscii ? <span className="token-nonascii">(non-ASCII)</span> : null}
        {identity.name === null ? null : (
          <span className="token-sub">
            {tokenDisplayText(identity.name, identity.nameNonAscii)}
            {identity.nameNonAscii ? <span className="token-nonascii">(non-ASCII)</span> : null}
          </span>
        )}
      </h1>
      <div className="token-addr">
        <span className="token-addr-label">
          <Pictogram name="contract" size={16} />
          <span>Contract</span>
        </span>
        <div className="token-addr-row">
          <span className="addr-full" data-testid="token-address-full">
            {groupAddressChunks(checksummed).map((chunk, index) => (
              <Fragment key={index}>
                {index === 0 ? null : <wbr />}
                <span className="addr-chunk">{chunk}</span>
              </Fragment>
            ))}
          </span>
          {"\u2060"}
          <CopyButton value={checksummed} label="Copy contract address" testId="copy-contract-address" />
        </div>
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
