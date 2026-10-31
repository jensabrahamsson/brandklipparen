// Server capability mapping (S-123). The token page fetches /health once
// and decides every AI feature state up front: no enabled button may fire
// a request that answers not-configured. Unknown fields (older servers)
// keep the previous explicit-request behaviour.
import type { HealthState } from "../types.ts";
import type { FeatureCapability, OnchainCapability } from "../types.ts";

export type Availability = "available" | "unavailable";

export function toAvailability(
  capability: FeatureCapability | OnchainCapability | undefined,
): Availability {
  if (capability === undefined) {
    return "available";
  }
  return "disabled" in capability ? "unavailable" : "available";
}

export type AiFeatureAvailability = {
  readonly investigation: Availability;
  readonly explain: Availability;
  readonly chat: Availability;
  readonly rug: Availability;
  readonly onchain: Availability;
};

export function toAiAvailability(health: HealthState | null): AiFeatureAvailability {
  if (health === null) {
    return {
      investigation: "available",
      explain: "available",
      chat: "available",
      rug: "available",
      onchain: "available",
    };
  }
  return {
    investigation: toAvailability(health.investigation),
    explain: toAvailability(health.explain),
    chat: toAvailability(health.chat),
    rug: toAvailability(health.rug),
    onchain: toAvailability(health.onchain),
  };
}
