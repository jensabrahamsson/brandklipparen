// Fixture detector for the S-105 composition test: a non-first-party
// detector that only runs inside the plugin worker. It returns one fixed
// finding; the in-registry stub throws so an in-process run would record
// `threw` instead of `ok`.
export function detect(input: unknown): Array<Record<string, unknown>> {
  const codeHash = (input as { codeHash?: unknown }).codeHash;
  return [
    {
      id: "dev.example.worker-routed:quick-1",
      pluginId: "dev.example.worker-routed",
      title: "Worker-routed example finding",
      evidence: [{ selector: "0xa9059cbb" }],
      payload: { marker: `routed:${String(codeHash ?? "none")}` },
    },
  ];
}
