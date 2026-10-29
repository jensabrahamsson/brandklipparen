// Token page heading: the token symbol when known (analysis response
// first, live-list entry second), the short address otherwise. The name
// rides as secondary text when known, the short address always rides as
// secondary meta, and DEX plus human age join it when the live entry is
// known. Static markup: no motion, no transforms.
import type { JSX } from "react";
import { formatAge, shortAddress } from "../lib/liveTokens.ts";
import type { LiveTokenEntry } from "../lib/liveTokens.ts";
import type { TokenIdentity } from "../lib/tokenIdentity.ts";

export function TokenHeader({
  address,
  identity,
  liveEntry,
}: {
  readonly address: string;
  readonly identity: TokenIdentity;
  readonly liveEntry: LiveTokenEntry | null;
}): JSX.Element {
  const meta: string[] = [];
  if (identity.name !== null) {
    meta.push(identity.name);
  }
  meta.push(shortAddress(address));
  if (liveEntry !== null) {
    const fee = typeof liveEntry.feeTier === "number" ? ` · ${liveEntry.feeTier / 10000}%` : "";
    meta.push(`${liveEntry.dex}${fee} · ${formatAge(liveEntry.ageSeconds)}`);
  }
  return (
    <header style={{ display: "grid", gap: 4 }}>
      <h1 style={{ fontSize: 28, margin: 0, overflowWrap: "anywhere" }}>
        {identity.symbol ?? shortAddress(address)}
      </h1>
      <p className="muted" style={{ margin: 0 }}>
        {meta.join(" · ")}
      </p>
    </header>
  );
}
