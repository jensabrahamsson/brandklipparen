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

// Human model label: the raw id stays available to callers for a
// title/tooltip, but the UI reads as a product name.
export function modelDisplayLabel(modelId: string): string {
  if (modelId === "muse-spark-1.3") {
    return "Muse Spark 1.3 · Meta";
  }
  return modelId;
}
