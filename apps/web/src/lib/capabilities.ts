// Server capability mapping (S-123). The token page fetches /health once
// and decides every AI feature state up front: no enabled button may fire
// a request that answers not-configured. Unknown fields (older servers)
// keep the previous explicit-request behaviour.
import type { HealthState } from "../types.ts";
import type { FeatureCapability, MarketCapability, OnchainCapability } from "../types.ts";

export type Availability = "available" | "unavailable";

export function toAvailability(
  capability: FeatureCapability | OnchainCapability | MarketCapability | undefined,
): Availability {
  if (capability === undefined) {
    return "available";
  }
  return "disabled" in capability ? "unavailable" : "available";
}

// DexScreener market listing (DX-1): present only while /health reports
// the market feed as configured. A missing field, a disabled feed or a
// failed health fetch hides the column and the tabs instead of flashing
// a wrong layout; New pairs then takes the full width.
export function toMarketAvailability(health: HealthState | null): Availability {
  if (health === null || health.market === undefined) {
    return "unavailable";
  }
  return toAvailability(health.market);
}

export type AiFeatureAvailability = {
  readonly investigation: Availability;
  readonly explain: Availability;
  readonly chat: Availability;
  readonly rug: Availability;
  readonly explainCode: Availability;
  readonly onchain: Availability;
};

// Per-function code explanation (addendum §A2.1, VS-2): absent when
// /health reports the code-explain feature unavailable, so there is no
// dead button. Unknown fields (older servers) keep the previous
// explicit-request behaviour.
export function toExplainCodeAvailability(health: HealthState | null): Availability {
  if (health === null) {
    return "available";
  }
  return toAvailability(health.explainCode);
}

export function toAiAvailability(health: HealthState | null): AiFeatureAvailability {
  if (health === null) {
    return {
      investigation: "available",
      explain: "available",
      chat: "available",
      rug: "available",
      explainCode: "available",
      onchain: "available",
    };
  }
  return {
    investigation: toAvailability(health.investigation),
    explain: toAvailability(health.explain),
    chat: toAvailability(health.chat),
    rug: toAvailability(health.rug),
    explainCode: toExplainCodeAvailability(health),
    onchain: toAvailability(health.onchain),
  };
}
