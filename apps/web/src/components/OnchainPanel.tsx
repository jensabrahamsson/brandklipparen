// On-chain feature text (UI v2 §3, W-7): the point-in-time serving-mode
// read at the current block renders as appended ContractFacts rows behind
// the "Load on-chain reads" action, so the separate On-chain panel is
// gone. Display data only: nothing here touches the score. Every value
// renders as inert text, and every missing value reads as an explicit
// can't-tell with its reason, never a guessed zero.
export function asOnchainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function shareText(share: unknown): string {
  if (typeof share !== "number" || !Number.isFinite(share)) {
    return "n/a";
  }
  return `${(share * 100).toFixed(1)}%`;
}

function statusText(feature: unknown): string {
  const record = asOnchainRecord(feature);
  if (record === null) {
    return "can't tell: missing feature";
  }
  if (record["status"] === "cant-tell" || record["kind"] === "cant-tell") {
    const reason = typeof record["reason"] === "string" ? record["reason"] : "unknown reason";
    return `can't tell: ${reason}`;
  }
  return "ok";
}

export function describeOwner(feature: unknown): string {
  const record = asOnchainRecord(feature);
  if (record === null || record["status"] !== "ok") {
    return statusText(feature);
  }
  const owner = asOnchainRecord(record["owner"]);
  if (owner === null || typeof owner["kind"] !== "string") {
    return statusText(feature);
  }
  const kind = owner["kind"] as string;
  if (kind === "renounced") {
    return "renounced";
  }
  if (kind === "safe") {
    return "Safe multisig";
  }
  return kind;
}

export function describeLp(feature: unknown): string {
  const record = asOnchainRecord(feature);
  if (record === null || record["status"] !== "ok") {
    return statusText(feature);
  }
  return (
    `burned ${shareText(record["burnedShare"])} · locker ${shareText(record["lockerShare"])} · ` +
    `deployer ${shareText(record["deployerShare"])} · owner ${shareText(record["ownerShare"])} · ` +
    `other ${shareText(record["otherShare"])}`
  );
}

export function describeConcentration(feature: unknown): string {
  const record = asOnchainRecord(feature);
  if (record === null || record["kind"] !== "ok") {
    return statusText(feature);
  }
  return (
    `top-1 ${shareText(record["top1Share"])} · top-10 ${shareText(record["top10Share"])} · ` +
    `deployer ${shareText(record["deployerShare"])} · owner ${shareText(record["ownerShare"])}`
  );
}

export function describeLiquidity(feature: unknown): string {
  const record = asOnchainRecord(feature);
  if (record === null || record["status"] !== "ok") {
    return statusText(feature);
  }
  const amount = typeof record["quoteAmount"] === "string" ? record["quoteAmount"] : "n/a";
  const weth = typeof record["wethAmount"] === "string" ? ` (${record["wethAmount"]} WETH)` : "";
  return `${amount}${weth}`;
}

export function describeVariantHead(variant: unknown): string {
  const record = asOnchainRecord(variant);
  if (record === null) {
    return "missing variant";
  }
  const window = typeof record["window"] === "number" ? record["window"] : null;
  const block = typeof record["analysisBlock"] === "number" ? record["analysisBlock"] : null;
  const age = typeof record["tokenAgeBlocks"] === "number" ? `${record["tokenAgeBlocks"]} blocks old` : "age can't tell";
  return `W+${window === null ? "?" : window} · block ${block === null ? "n/a" : block} · ${age}`;
}
