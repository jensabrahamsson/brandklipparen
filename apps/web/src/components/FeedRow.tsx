// Shared feed row (DX-1 §A3.2): one three-line design for both the
// on-chain New pairs list and the DexScreener market list, at every
// width. Line 1 carries the lamp, the symbol link, the name, the compact
// age, the owner-power chip and the score; line 2 carries DEX, liquidity
// and volume; line 3 carries the full EIP-55 token address with a copy
// icon. The whole row is a link stretched over the row; the copy button
// sits above it (stopPropagation in CopyButton) so a copy click never
// navigates. Nothing here moves: insertion flashes run once through the
// existing arrive glow, static under reduced motion.
import { Fragment, type JSX, type ReactNode } from "react";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { groupAddressChunks } from "./TokenHeader.tsx";
import { CopyButton } from "./CopyButton.tsx";

export function FeedRow({
  href,
  symbol,
  tokenAddress,
  name,
  ageLabel,
  ageDateTime,
  ageTitle,
  marker,
  lamp,
  chip,
  score,
  meta,
  copyLabel,
  tokenTestId,
  isNew,
  isScored,
}: {
  // Token page target for the stretched row link.
  readonly href: string;
  // Symbol, or null when the feed reported none (falls back to short form).
  readonly symbol: string | null;
  // Raw token address (any hex case); displayed checksummed, copied exact.
  readonly tokenAddress: string;
  readonly name: string | null;
  // Compact age text ("12m", "3h") with machine-readable ISO and tooltip.
  readonly ageLabel: string;
  readonly ageDateTime: string | null;
  readonly ageTitle: string;
  // Fresh-row "new" marker (plain static text, CSS uppercase only).
  readonly marker: ReactNode;
  // Status lamp, owner-power chip and score slot (each optional).
  readonly lamp: ReactNode;
  readonly chip: ReactNode;
  readonly score: ReactNode;
  // Line 2 segments (DEX, liquidity, volume, market enrichment).
  readonly meta: ReactNode;
  readonly copyLabel: string;
  readonly tokenTestId: string;
  readonly isNew: boolean;
  readonly isScored: boolean;
}): JSX.Element {
  const checksummed = toChecksumAddress(tokenAddress);
  const shown = symbol ?? `${checksummed.slice(0, 6)}…${checksummed.slice(-4)}`;
  const classes = ["feed-row"];
  if (isNew) {
    classes.push("is-new");
  }
  if (isScored) {
    classes.push("is-scored");
  }
  return (
    <li className={classes.join(" ")}>
      <div className="feed-line1">
        {lamp}
        <a className="feed-link" href={href} title={name ?? checksummed}>
          {shown}
        </a>
        {marker}
        {name === null || name.length === 0 ? null : <span className="feed-name">{name}</span>}
        {ageDateTime === null ? (
          <span className="feed-age numeric quiet" title={ageTitle} data-nowrap>
            {ageLabel}
          </span>
        ) : (
          <time className="feed-age numeric" dateTime={ageDateTime} title={ageTitle} data-nowrap>
            {ageLabel}
          </time>
        )}
        {chip}
        {score}
        <span className="feed-go" aria-hidden="true">
          ›
        </span>
      </div>
      <div className="feed-line2">{meta}</div>
      <div className="feed-line3">
        <span className="addr-full numeric" data-testid={tokenTestId}>
          {groupAddressChunks(checksummed).map((chunk, index) => (
            <Fragment key={index}>
              {index === 0 ? null : <wbr />}
              <span className="addr-chunk">{chunk}</span>
            </Fragment>
          ))}
        </span>{" "}
        <CopyButton value={checksummed} label={copyLabel} />
      </div>
    </li>
  );
}
