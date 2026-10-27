// Example third-party-style fee-capability detector (S-051): detect.
// Written after the failing tests per A-21. A pure function from the
// frozen detector input to a frozen finding list: no Promise, no port, no
// clock (P-03). The detector reads the declared `bytecode` input and
// derives selectors with the domain helper, reporting one finding per
// known fee-setter selector with selector and PC-offset evidence. The id
// namespaces every finding under the manifest id. Findings report at
// weight 0: the weight arrives only through the calibrated model artifact
// (P-05), so scoring never reads them.
import { extractSelectors } from "../../../src/domain/selectors.ts";
import { Evidence } from "../../../src/domain/evidence.ts";
import type { Evidence as EvidenceType, NonEmpty } from "../../../src/domain/evidence.ts";
import type { DetectorInput, PluginFinding } from "../../../src/plugins/detector.ts";
import { feeCapabilityManifest } from "./manifest.ts";

// Curated fee-setter selectors observed on ERC-20 tokens with adjustable
// fees: setFee(uint256), setTaxFeePercent(uint256),
// setLiquidityFeePercent(uint256) and setSellFee(uint256). The values are
// the first four bytes of the function selector hash, documented in
// PLUGIN.md beside this module.
const FEE_SELECTORS: Readonly<Record<string, string>> = Object.freeze({
  "0x69fe0e2d": "setFee(uint256)",
  "0x061c82d0": "setTaxFeePercent(uint256)",
  "0x8ee88c53": "setLiquidityFeePercent(uint256)",
  "0x8b4cee08": "setSellFee(uint256)",
});

function toNonEmpty(items: EvidenceType[]): NonEmpty<EvidenceType> | null {
  const first = items[0];
  if (first === undefined) {
    return null;
  }
  return Object.freeze([first, ...items.slice(1)]) as NonEmpty<EvidenceType>;
}

export function detectFeeCapability(input: DetectorInput): readonly PluginFinding[] {
  const out: PluginFinding[] = [];
  for (const entry of extractSelectors(input.bytecode)) {
    const name = FEE_SELECTORS[entry.selector as string];
    if (name === undefined) {
      continue;
    }
    const created =
      entry.kind === "paired"
        ? Evidence.create({ selector: entry.selector, offset: entry.target })
        : Evidence.create({ selector: entry.selector });
    if (!created.ok) {
      continue;
    }
    const evidence = toNonEmpty([created.value]);
    if (evidence === null) {
      continue;
    }
    out.push(
      Object.freeze({
        id: `${feeCapabilityManifest.id}:${entry.selector as string}`,
        pluginId: feeCapabilityManifest.id,
        title: `Contract exposes the fee setter ${name}`,
        evidence,
        payload: Object.freeze({ selector: entry.selector as string, name }),
      }),
    );
  }
  out.sort((left, right) => {
    if (left.id < right.id) {
      return -1;
    }
    if (left.id > right.id) {
      return 1;
    }
    return 0;
  });
  return Object.freeze(out);
}
