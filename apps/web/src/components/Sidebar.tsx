import { useState, type JSX } from "react";
import type { AnalyzeSuccess } from "../types.ts";

// Sidebar with contract facts and example API calls. Everything renders
// as text; addresses and hashes use the mono style. Long hex values show
// middle-truncated with the full value in the title attribute (design
// review P1-11). Copy confirmations announce through a polite live region.
function shortenHex(value: string): string {
  if (/^0x[0-9a-fA-F]+$/.test(value) && value.length > 18) {
    return `${value.slice(0, 10)}…${value.slice(-8)}`;
  }
  return value;
}

function Copyable({ label, value }: { readonly label: string; readonly value: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is a convenience only; the text stays selectable.
    }
  };
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="quiet">{label}</div>
      <div className="mono numeric" style={{ fontSize: 13, overflowWrap: "anywhere" }} title={value}>
        {shortenHex(value)}{" "}
        <button type="button" className="button-ghost" onClick={() => void copy()} aria-label={`Copy ${label}`}>
          Copy
        </button>
        <span aria-live="polite" className="quiet" style={{ marginLeft: 8 }}>
          {copied ? "Copied." : ""}
        </span>
      </div>
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
}: {
  readonly result: AnalyzeSuccess;
  readonly expert: boolean;
}): JSX.Element {
  const apiExample = `curl -H "x-api-key: $KEY" "${restOrigin()}/v1/analyze?address=${result.target}"`;
  const analyzeTool = `analyze { address: "${result.target}" }`;
  const assessmentTool = `request_assessment { address: "${result.target}" }`;
  return (
    <aside aria-label="Contract facts">
      <section className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 17 }}>Contract facts</h2>
        <Copyable label="Address" value={result.target} />
        <Copyable label="Proxy" value={proxyLabel(result)} />
        {result.proxy.kind !== "none" && result.proxy.implementation !== undefined ? (
          <Copyable label="Implementation" value={result.proxy.implementation} />
        ) : null}
        <Copyable label="Code hash" value={result.codeHash} />
        <Copyable label="Model version" value={result.modelVersion} />
        <div className="quiet numeric">Analyzed block {result.block}</div>
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
