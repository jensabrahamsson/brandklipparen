// Stream view (S-100, K-020, K-101): one explicit fetch of the SSE
// analysis body, rendered analysis-first. The streamed analysis renders
// above the deepening status line in DOM order, so the fast path is seen
// ahead of the deepening line. Display only: nothing here re-scores or
// rewrites the page result.
import { useState, type JSX } from "react";
import { fetchAnalyzeStream } from "../lib/api.ts";
import type { AnalyzeStream } from "../lib/api.ts";

export function StreamView({
  address,
  apiKey,
}: {
  readonly address: string;
  readonly apiKey: string;
}): JSX.Element {
  const [stream, setStream] = useState<AnalyzeStream | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onStream(): Promise<void> {
    setPending(true);
    setFailed(false);
    const next = await fetchAnalyzeStream(address, apiKey);
    setPending(false);
    if (next === null) {
      setFailed(true);
      return;
    }
    setStream(next);
  }

  return (
    <section className="card" aria-label="Stream" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20 }}>Stream</h2>
      <button type="button" className="button-ghost" onClick={() => void onStream()} disabled={pending}>
        {pending ? "Streaming…" : "Stream"}
      </button>
      {failed ? <p role="alert">Stream failed.</p> : null}
      {stream === null ? null : (
        <div data-testid="stream-analysis" style={{ marginTop: 12 }}>
          <p className="quiet numeric" style={{ margin: 0 }}>
            Streamed analysis kind {stream.analysis.kind}
            {typeof stream.analysis.score === "number" ? ` · score ${stream.analysis.score}` : ""}
          </p>
          <p className="quiet" data-testid="stream-deepening" style={{ margin: "8px 0 0" }}>
            Deepening: {stream.deepening}
          </p>
        </div>
      )}
    </section>
  );
}
