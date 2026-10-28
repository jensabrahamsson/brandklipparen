// Fixture detector for S-050 isolation tests: never returns, so the
// worker deadline must kill it and record the typed timeout outcome.
export function detect(): Array<Record<string, unknown>> {
  for (;;) {
    // Runaway on purpose: the parent terminates this worker at deadline.
  }
}
