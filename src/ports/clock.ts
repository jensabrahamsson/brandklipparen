// ClockPort: current time as a value to the core (A-05, K-102, K-104).
// Value port: the core reads the current time solely from the passed-in
// Timestamp parameter, so analyses stay deterministic per A-32.
import type { Timestamp as TimestampType } from "../domain/types.ts";

export interface ClockPort {
  now(): TimestampType;
}
