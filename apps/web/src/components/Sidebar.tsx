import type { JSX } from "react";
import type { AnalyzeSuccess } from "../types.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { formatAge } from "../lib/liveTokens.ts";
import type { LiveTokenEntry } from "../lib/liveTokens.ts";
import { CopyButton } from "./CopyButton.tsx";

// Sidebar with contract facts and example API calls. Everything renders
// as text; addresses and hashes use the mono style. Contract and pair
// addresses always show in full with a copy button (S-134). Copy
// confirmations announce through a polite live region.
function Copyable({ label, value, copyLabel }: { readonly label: string; readonly value: string; readonly copyLabel?: string | undefined }): JSX.Element {
  // Displayed addresses show EIP-55 mixed case and copy the same
  // string; labels and hashes pass through unchanged.
  const shown = toChecksumAddress(value);
  return (
    <div className="fact-row">
      <dt>{label}</dt>
      <span className="lead" aria-hidden="true" />
      <dd className="mono numeric" style={{ fontSize: 13 }} title={shown}>
        <span className="addr-full">{shown}</span>{" "}
        <CopyButton value={shown} label={copyLabel ?? `Copy ${label}`} />
      </dd>
    </div>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  return (
    <div className="fact-row">
      <dt>{label}</dt>
      <span className="lead" aria-hidden="true" />
      <dd className="mono numeric" style={{ fontSize: 13 }} title={value}>
        {value}
      </dd>
    </div>
  );
}

function restOrigin(): string {
  if (typeof window !== "undefined" && window.location.origin !== "null") {
    return window.location.origin;
  }
  return "";
}

// Contract facts aside: the deploy-time sentence and the bot/API blocks
// carry implementation detail, so Simple mode gets the plain sentence
// and Expert mode keeps the full wording (S-131).
export function Sidebar({
  result,
  expert,
  liveEntry = null,
}: {
  readonly result: AnalyzeSuccess;
  readonly expert: boolean;
  readonly liveEntry?: LiveTokenEntry | null | undefined;
}): JSX.Element {
  const apiExample = `curl -H "x-api-key: $KEY" "${restOrigin()}/v1/analyze?address=${result.target}"`;
  const analyzeTool = `analyze { address: "${result.target}" }`;
  const assessmentTool = `request_assessment { address: "${result.target}" }`;
  // Live-feed rows are display-only sightings from the new-pairs feed:
  // they never steer the score. Absent when the feed is off or silent.
  const fee = liveEntry !== null && typeof liveEntry.feeTier === "number" ? ` · ${liveEntry.feeTier / 10000}%` : "";
  return (
    <aside aria-label="Contract facts">
      <section className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Contract facts</h2>
        <dl className="facts">
          <Fact label="Chain" value="Ethereum mainnet" />
          <Copyable label="Address" value={result.target} copyLabel="Copy contract address" />
          {liveEntry === null ? null : (
            <>
              <Copyable label="Pair" value={liveEntry.pairAddress} copyLabel="Copy pair address" />
              <Fact label="DEX" value={`${liveEntry.dex}${fee}`} />
              <Fact label="First seen" value={`block ${liveEntry.block} · ${formatAge(liveEntry.ageSeconds)}`} />
              <Fact
                label="Initial liquidity"
                value={
                  liveEntry.initialLiquidityWeth === null
                    ? "can't tell"
                    : `${liveEntry.initialLiquidityWeth} WETH`
                }
              />
            </>
          )}
          <Copyable label="Proxy" value={proxyLabel(result)} />
          {result.proxy.kind !== "none" && result.proxy.implementation !== undefined ? (
            <Copyable label="Implementation" value={result.proxy.implementation} copyLabel="Copy implementation address" />
          ) : null}
          <Copyable label="Code hash" value={result.codeHash} />
          <Copyable label="Model version" value={result.modelVersion} />
          <Fact label="Analyzed block" value={String(result.block)} />
        </dl>
        <div className="quiet" style={{ marginTop: 8 }}>
          {expert
            ? "Deployed: not reported by the v1 REST API (contract gap), so no deploy time is shown."
            : "Deployed: not reported, so no deploy time is shown."}
        </div>
      </section>
      {expert ? (
      <details className="card bot-details">
        <summary style={{ cursor: "pointer", fontSize: 17, fontWeight: 600 }}>Use this result in your bot</summary>
        <div className="quiet" style={{ marginTop: 12 }}>
          API request
        </div>
        <pre className="code">{apiExample}</pre>
        <div className="quiet">Analyze tool</div>
        <pre className="code">{analyzeTool}</pre>
        <div className="quiet">Assessment tool</div>
        <pre className="code">{assessmentTool}</pre>
      </details>
      ) : null}
    </aside>
  );
}

function proxyLabel(result: AnalyzeSuccess): string {
  if (result.proxy.kind === "none") {
    return "No proxy (direct implementation)";
  }
  return result.proxy.kind;
}
