// On-chain features panel (session A): the opt-in serving-mode read at
// the current block over the shared on-chain service. Display data only:
// nothing here touches the score. Every feature value renders as inert
// React text (never HTML), and every missing value renders as an explicit
// can't-tell with its reason, never a guessed zero.
import { useState, type JSX } from "react";
import { fetchOnchainFeatures } from "../lib/api.ts";
import type { OnchainFeaturesState } from "../lib/api.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function shareText(share: unknown): string {
  if (typeof share !== "number" || !Number.isFinite(share)) {
    return "n/a";
  }
  return `${(share * 100).toFixed(1)}%`;
}

function statusText(feature: unknown): string {
  const record = asRecord(feature);
  if (record === null) {
    return "can't tell: missing feature";
  }
  if (record["status"] === "cant-tell" || record["kind"] === "cant-tell") {
    const reason = typeof record["reason"] === "string" ? record["reason"] : "unknown reason";
    return `can't tell: ${reason}`;
  }
  return "ok";
}

export function describeOwner(feature: unknown): string {
  const record = asRecord(feature);
  if (record === null || record["status"] !== "ok") {
    return statusText(feature);
  }
  const owner = asRecord(record["owner"]);
  if (owner === null || typeof owner["kind"] !== "string") {
    return statusText(feature);
  }
  const kind = owner["kind"] as string;
  if (kind === "renounced") {
    return "renounced";
  }
  if (kind === "safe") {
    return "Safe multisig";
  }
  return kind;
}

export function describeLp(feature: unknown): string {
  const record = asRecord(feature);
  if (record === null || record["status"] !== "ok") {
    return statusText(feature);
  }
  return (
    `burned ${shareText(record["burnedShare"])} · locker ${shareText(record["lockerShare"])} · ` +
    `deployer ${shareText(record["deployerShare"])} · owner ${shareText(record["ownerShare"])} · ` +
    `other ${shareText(record["otherShare"])}`
  );
}

export function describeConcentration(feature: unknown): string {
  const record = asRecord(feature);
  if (record === null || record["kind"] !== "ok") {
    return statusText(feature);
  }
  return (
    `top-1 ${shareText(record["top1Share"])} · top-10 ${shareText(record["top10Share"])} · ` +
    `deployer ${shareText(record["deployerShare"])} · owner ${shareText(record["ownerShare"])}`
  );
}

export function describeLiquidity(feature: unknown): string {
  const record = asRecord(feature);
  if (record === null || record["status"] !== "ok") {
    return statusText(feature);
  }
  const amount = typeof record["quoteAmount"] === "string" ? record["quoteAmount"] : "n/a";
  const weth = typeof record["wethAmount"] === "string" ? ` (${record["wethAmount"]} WETH)` : "";
  return `${amount}${weth}`;
}

export function describeVariantHead(variant: unknown): string {
  const record = asRecord(variant);
  if (record === null) {
    return "missing variant";
  }
  const window = typeof record["window"] === "number" ? record["window"] : null;
  const block = typeof record["analysisBlock"] === "number" ? record["analysisBlock"] : null;
  const age = typeof record["tokenAgeBlocks"] === "number" ? `${record["tokenAgeBlocks"]} blocks old` : "age can't tell";
  return `W+${window === null ? "?" : window} · block ${block === null ? "n/a" : block} · ${age}`;
}

export function OnchainPanel({
  address,
  apiKey,
}: {
  readonly address: string;
  readonly apiKey: string;
}): JSX.Element {
  const [state, setState] = useState<OnchainFeaturesState | null>(null);
  const [pending, setPending] = useState(false);

  async function onRequest(): Promise<void> {
    setPending(true);
    const next = await fetchOnchainFeatures(address, apiKey);
    setPending(false);
    setState(next);
  }

  const features = state !== null && state.status === "ready" ? asRecord(state.features) : null;
  const variants = features !== null && Array.isArray(features["variants"]) ? features["variants"] : [];

  return (
    <section className="card" aria-label="On-chain features panel" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>On-chain features</h2>
      <p className="quiet" style={{ margin: "0 0 8px" }}>
        Point-in-time chain reads at the current block. Advisory only: the score stands.
      </p>
      <button type="button" className="button-ghost" onClick={() => void onRequest()} disabled={pending}>
        {pending ? "Loading…" : "Load on-chain features"}
      </button>
      {state === null ? null : state.status === "not-configured" ? (
        <p data-testid="onchain-not-configured" style={{ margin: "12px 0 0" }}>
          On-chain features are not configured.
        </p>
      ) : state.status === "failed" ? (
        <p data-testid="onchain-failed" style={{ margin: "12px 0 0" }}>
          On-chain features could not be read.
        </p>
      ) : features === null ? null : (
        <div data-testid="onchain-features" style={{ marginTop: 12 }}>
          <p style={{ margin: "0 0 8px" }}>
            Deployment block {typeof features["deploymentBlock"] === "number" ? features["deploymentBlock"] : "can't tell"}
            {" · "}T0 {typeof features["t0"] === "number" ? features["t0"] : "no pool"}
            {" · "}status {typeof features["status"] === "string" ? features["status"] : "unknown"}
          </p>
          {variants.map((variant, index) => {
            const record = asRecord(variant);
            if (record === null) {
              return null;
            }
            return (
              <div key={index} style={{ marginBottom: 8 }}>
                <p style={{ margin: "0 0 4px", fontWeight: 600 }}>{describeVariantHead(record)}</p>
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  <li>Owner: {describeOwner(record["owner"])}</li>
                  <li>LP: {describeLp(record["lp"])}</li>
                  <li>Concentration: {describeConcentration(record["concentration"])}</li>
                  <li>Liquidity: {describeLiquidity(record["liquidity"])}</li>
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
