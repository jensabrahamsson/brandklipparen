// System clock and timers for the live list's poll loop (LiveTokensTimers).
// Lives in the adapter layer so the application stays free of the system
// clock and timers (A-05).
import type { LiveTokensTimers } from "../../ports/liveTokens.ts";

export const systemLiveTokensTimers: LiveTokensTimers = Object.freeze({
  now: (): number => Date.now(),
  every: (intervalMs: number, task: () => void): (() => void) => {
    const handle = setInterval(task, intervalMs);
    return (): void => {
      clearInterval(handle);
    };
  },
  sleep: (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
});
