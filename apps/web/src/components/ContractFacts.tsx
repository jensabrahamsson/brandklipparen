// Contract facts (UI v2 §3): every fact as icon + label + value with an
// always-visible one-line plain explanation. Short values sit
// right-aligned on one line; addresses and the code hash use the address
// block (label row with the copy icon, value below breaking only between
// 4-character groups). Proxy, model and block carry no copy control;
// contract, pair, implementation and the code hash copy the full values.
// The "Load on-chain reads" action appends live Owner / LP lock / Top
// holders rows, each tagged "Live read · not in score". Display text
// only: nothing here touches the score.
import { Fragment, useState, type JSX, type ReactNode } from "react";
import type { AnalyzeSuccess } from "../types.ts";
import { toChecksumAddress } from "../lib/checksumAddress.ts";
import { formatAgeCompact } from "../lib/liveTokens.ts";
import type { LiveTokenEntry } from "../lib/liveTokens.ts";
import { fetchOnchainFeatures, type OnchainFeaturesState } from "../lib/api.ts";
import type { Availability } from "../lib/capabilities.ts";
import { describeConcentration, describeLp } from "./OnchainPanel.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Pictogram } from "./Pictogram.tsx";
import type { PictogramName } from "../lib/pictograms.ts";
import { groupAddressChunks } from "./TokenHeader.tsx";
import { OwnerChip, type ProvenOwner } from "./plugins/OwnerChip.tsx";

export type FactCopyTarget = {
  readonly label: string;
  readonly value: string;
};

// The exact strings the fact copy buttons write: always the full
// unspaced EIP-55 value (or the full hash), never the grouped display.
// Proxy, model and block are intentionally absent: they have no button.
export function factCopyTargets(
  result: AnalyzeSuccess,
  liveEntry: LiveTokenEntry | null,
): readonly FactCopyTarget[] {
  const targets: FactCopyTarget[] = [
    { label: "Copy contract address", value: toChecksumAddress(result.target) },
  ];
  if (liveEntry !== null) {
    targets.push({ label: "Copy pair address", value: toChecksumAddress(liveEntry.pairAddress) });
  }
  if (result.proxy.kind !== "none" && typeof result.proxy.implementation === "string") {
    targets.push({
      label: "Copy implementation address",
      value: toChecksumAddress(result.proxy.implementation),
    });
  }
  targets.push({ label: "Copy code hash", value: result.codeHash });
  return targets;
}

function proxyDisplay(kind: string): string {
  switch (kind) {
    case "none":
      return "None";
    case "eip1967":
      return "EIP-1967";
    case "uups":
      return "UUPS";
    case "eip1167":
      return "EIP-1167";
    case "eip7702":
      return "EIP-7702";
    default:
      return kind;
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function utcTitle(stamp: number): string {
  const date = new Date(stamp);
  const day = date.getUTCDate();
  const month = MONTHS[date.getUTCMonth()] ?? "";
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hours}:${minutes} UTC`;
}

function AddressValue({ value, testId }: { readonly value: string; readonly testId: string }): JSX.Element {
  return (
    <span className="addr-full" data-testid={testId}>
      {groupAddressChunks(value).map((chunk, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <wbr />}
          <span className="addr-chunk">{chunk}</span>
        </Fragment>
      ))}
    </span>
  );
}

function ShortFact({
  icon,
  label,
  value,
  why,
  nowrap = true,
}: {
  readonly icon: PictogramName;
  readonly label: string;
  readonly value: ReactNode;
  readonly why: ReactNode;
  readonly nowrap?: boolean | undefined;
}): JSX.Element {
  return (
    <div className="fact-row fact-short">
      <span className="fact-icon">
        <Pictogram name={icon} size={24} />
      </span>
      <dt className="fact-label">{label}</dt>
      <dd className="fact-value" data-nowrap={nowrap ? "true" : undefined}>
        {value}
      </dd>
      <dd className="fact-why">{why}</dd>
    </div>
  );
}

function AddressFact({
  icon,
  label,
  value,
  copyLabel,
  copyTestId,
  valueTestId,
  why,
  children,
}: {
  readonly icon: PictogramName;
  readonly label: string;
  readonly value: string;
  readonly copyLabel: string;
  readonly copyTestId: string;
  readonly valueTestId: string;
  readonly why: string;
  readonly children: JSX.Element;
}): JSX.Element {
  return (
    <div className="fact-row fact-long">
      <span className="fact-icon">
        <Pictogram name={icon} size={24} />
      </span>
      <dt className="fact-label">{label}</dt>
      <span className="fact-copy">
        <CopyButton value={value} label={copyLabel} testId={copyTestId} />
      </span>
      <dd className="fact-value" data-testid={valueTestId}>
        {children}
      </dd>
      <dd className="fact-why">{why}</dd>
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function toProvenOwner(feature: unknown): ProvenOwner | null {
  const record = asRecord(feature);
  if (record === null || record["status"] !== "ok") {
    return null;
  }
  const owner = asRecord(record["owner"]);
  if (owner === null) {
    return null;
  }
  const kind = owner["kind"];
  const address = typeof owner["address"] === "string" ? owner["address"] : null;
  if (kind === "renounced") {
    return { address: null, kind: "renounced" };
  }
  if (kind === "safe") {
    return { address, kind: "safe-multisig" };
  }
  if (kind === "contract") {
    return { address, kind: "contract" };
  }
  if (address !== null) {
    return { address, kind: "single-key" };
  }
  return null;
}

function LiveWhy({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <>
      {children} <span className="live-tag">Live read · not in score</span>
    </>
  );
}

function restOrigin(): string {
  if (typeof window !== "undefined" && window.location.origin !== "null") {
    return window.location.origin;
  }
  return "";
}

export function ContractFacts({
  result,
  expert,
  liveEntry = null,
  address,
  apiKey,
  availability,
}: {
  readonly result: AnalyzeSuccess;
  readonly expert: boolean;
  readonly liveEntry?: LiveTokenEntry | null | undefined;
  readonly address: string;
  readonly apiKey: string;
  readonly availability: Availability;
}): JSX.Element {
  const apiExample = `curl -H "x-api-key: $KEY" "${restOrigin()}/v1/analyze?address=${result.target}"`;
  const analyzeTool = `analyze { address: "${result.target}" }`;
  const assessmentTool = `request_assessment { address: "${result.target}" }`;
  const [onchain, setOnchain] = useState<OnchainFeaturesState | null>(null);
  const [pending, setPending] = useState(false);

  async function onLoadReads(): Promise<void> {
    setPending(true);
    const next = await fetchOnchainFeatures(address, apiKey.length === 0 ? null : apiKey);
    setPending(false);
    setOnchain(next);
  }

  const checksummed = toChecksumAddress(result.target);
  const fee = liveEntry !== null && typeof liveEntry.feeTier === "number" ? liveEntry.feeTier / 10000 : null;
  const proxyNone = result.proxy.kind === "none";
  const implementation =
    !proxyNone && typeof result.proxy.implementation === "string"
      ? toChecksumAddress(result.proxy.implementation)
      : null;
  const features =
    onchain !== null && onchain.status === "ready" ? asRecord(onchain.features) : null;
  const variants =
    features !== null && Array.isArray(features["variants"])
      ? (features["variants"] as readonly unknown[])
      : null;
  const variant = variants === null ? null : asRecord(variants[0] ?? null);
  // A ready payload without a first variant carries no rows: the action
  // stays and reads as a failed load with a retry.
  const liveRows = variant !== null;

  return (
    <aside aria-label="Contract facts">
      <section className="card contract-facts">
        <h2>Contract facts</h2>
        <dl className="facts contract-facts-list">
          <ShortFact
            icon="chain"
            label="Chain"
            value="Ethereum mainnet"
            why="The network this token lives on."
          />
          <AddressFact
            icon="contract"
            label="Contract"
            value={checksummed}
            copyLabel="Copy contract address"
            copyTestId="copy-facts-contract"
            valueTestId="fact-contract-address"
            why="The token contract we read."
          >
            <AddressValue value={checksummed} testId="fact-contract-address-value" />
          </AddressFact>
          {liveEntry === null ? null : (
            <AddressFact
              icon="pair"
              label="Pair"
              value={toChecksumAddress(liveEntry.pairAddress)}
              copyLabel="Copy pair address"
              copyTestId="copy-facts-pair"
              valueTestId="fact-pair-address"
              why="The trading pool where it was first listed."
            >
              <AddressValue
                value={toChecksumAddress(liveEntry.pairAddress)}
                testId="fact-pair-address-value"
              />
            </AddressFact>
          )}
          {liveEntry === null ? null : (
            <ShortFact
              icon="dex"
              label="DEX"
              value={fee === null ? liveEntry.dex : `${liveEntry.dex} · ${fee}%`}
              why={
                fee === null
                  ? "Where the pool trades."
                  : `Where the pool trades. ${fee}% is the pool's swap fee.`
              }
            />
          )}
          {liveEntry === null ? null : (
            <ShortFact
              icon="age"
              label="First seen"
              value={
                liveEntry.blockTimestampMs === null ? (
                  <span>{formatAgeCompact(liveEntry.ageSeconds)}</span>
                ) : (
                  <time
                    dateTime={new Date(liveEntry.blockTimestampMs).toISOString()}
                    title={utcTitle(liveEntry.blockTimestampMs)}
                  >
                    {formatAgeCompact(liveEntry.ageSeconds)}
                  </time>
                )
              }
              why={`When the pool first appeared, at block ${liveEntry.block}.`}
            />
          )}
          {liveEntry === null ? null : (
            <ShortFact
              icon="liquidity"
              label="Liquidity at launch"
              value={liveEntry.initialLiquidityWeth === null ? "Can't tell" : `${liveEntry.initialLiquidityWeth} WETH`}
              why="What was put in the pool at launch. Small pools move fast."
            />
          )}
          <ShortFact
            icon={proxyNone ? "direct" : "proxy"}
            label="Proxy"
            value={proxyDisplay(result.proxy.kind)}
            why={
              proxyNone
                ? "No proxy, so this code can't be swapped out."
                : "A proxy. Whoever controls it can swap the code."
            }
          />
          {implementation === null ? null : (
            <AddressFact
              icon="contract"
              label="Implementation"
              value={implementation}
              copyLabel="Copy implementation address"
              copyTestId="copy-facts-implementation"
              valueTestId="fact-implementation-address"
              why="The code the proxy runs today."
            >
              <AddressValue value={implementation} testId="fact-implementation-address-value" />
            </AddressFact>
          )}
          <AddressFact
            icon="hash"
            label="Code hash"
            value={result.codeHash}
            copyLabel="Copy code hash"
            copyTestId="copy-facts-code-hash"
            valueTestId="fact-code-hash"
            why="Fingerprint of the code. Same hash, same code."
          >
            {expert || result.codeHash.length <= 20 ? (
              <AddressValue value={result.codeHash} testId="fact-code-hash-value" />
            ) : (
              <span className="addr-full" title={result.codeHash} data-testid="fact-code-hash-value">
                <span className="sr-only">{result.codeHash}</span>
                <span aria-hidden="true">
                  {groupAddressChunks(result.codeHash.slice(0, 14)).map((chunk, index) => (
                    <Fragment key={index}>
                      {index === 0 ? null : <wbr />}
                      <span className="addr-chunk">{chunk}</span>
                    </Fragment>
                  ))}
                  {" … "}
                  {groupAddressChunks(result.codeHash.slice(-6)).map((chunk, index) => (
                    <Fragment key={index}>
                      {index === 0 ? null : <wbr />}
                      <span className="addr-chunk">{chunk}</span>
                    </Fragment>
                  ))}
                </span>
              </span>
            )}
          </AddressFact>
          <ShortFact
            icon="block"
            label="Block"
            value={String(result.block)}
            why="Chain height we read the code at."
          />
          <ShortFact
            icon="model"
            label="Model"
            value={result.modelVersion}
            why="Version of the scoring model."
          />
          {variant === null ? null : (
            <ShortFact
              icon="owner"
              label="Owner"
              nowrap={false}
              value={<OwnerChip owner={toProvenOwner(variant["owner"])} />}
              why={
                <LiveWhy>Who controls the token now, read live from the chain.</LiveWhy>
              }
            />
          )}
          {variant === null ? null : (
            <ShortFact
              icon="liquidity"
              label="LP lock"
              nowrap={false}
              value={describeLp(variant["lp"])}
              why={<LiveWhy>Where the pool tokens sit: burned, locked, or held.</LiveWhy>}
            />
          )}
          {variant === null ? null : (
            <ShortFact
              icon="limits"
              label="Top holders"
              nowrap={false}
              value={describeConcentration(variant["concentration"])}
              why={<LiveWhy>How much of the supply the largest wallets hold.</LiveWhy>}
            />
          )}
        </dl>
        {availability === "unavailable" && onchain === null ? (
          <p className="quiet" style={{ margin: "12px 0 0" }}>
            On-chain reads are not configured on this server.
          </p>
        ) : null}
        {availability === "available" && (onchain === null || onchain.status === "failed") ? (
          <div className="facts-action">
            {onchain === null ? null : (
              <p className="quiet" style={{ margin: "0 0 8px" }}>
                On-chain reads could not be loaded.
              </p>
            )}
            <button type="button" className="button-ghost" onClick={() => void onLoadReads()} disabled={pending}>
              {pending ? "Loading…" : onchain === null ? "Load on-chain reads" : "Retry"}
            </button>
          </div>
        ) : null}
        {onchain !== null && onchain.status === "not-configured" ? (
          <p className="quiet" style={{ margin: "12px 0 0" }}>
            On-chain reads are not configured on this server.
          </p>
        ) : null}
        {onchain !== null && onchain.status === "ready" && !liveRows ? (
          <div className="facts-action">
            <p className="quiet" style={{ margin: "0 0 8px" }}>
              On-chain reads could not be loaded.
            </p>
            <button type="button" className="button-ghost" onClick={() => void onLoadReads()} disabled={pending}>
              {pending ? "Loading…" : "Retry"}
            </button>
          </div>
        ) : null}
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
