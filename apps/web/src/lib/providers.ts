// Provider display names for AI feature badges (S-123). The REST API
// reports machine provider ids; the badges show the product display
// name. Unknown ids pass through unchanged, so older servers keep
// their previous label.
export function providerDisplayName(provider: string): string {
  if (provider === "meta-model-api") {
    return "Meta Model API";
  }
  return provider;
}
