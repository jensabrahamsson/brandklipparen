// Fixture detector for S-050 isolation tests: returns one finding
// immediately. Test-only values, never learned model values.
export function detect(input: unknown): Array<Record<string, unknown>> {
  const marker = (input as { marker?: unknown }).marker;
  return [
    {
      id: "dev.example.isolated:quick-finding",
      pluginId: "dev.example.isolated",
      title: `quick-finding for ${String(marker)}`,
      evidence: [{ selector: "0x12345678", offset: 1 }],
    },
  ];
}
