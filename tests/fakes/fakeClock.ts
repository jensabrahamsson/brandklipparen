// Fake ClockPort for tests (A-23, K-102): returns one frozen timestamp, so
// analyses stay bit-identical across runs and interfaces.
import type { Timestamp as TimestampType } from "../../src/domain/types.ts";
import type { ClockPort } from "../../src/ports/clock.ts";

export class FakeClockAdapter implements ClockPort {
  constructor(private readonly at: TimestampType) {}

  now(): TimestampType {
    return this.at;
  }
}
