// Owner chip for the plugin detail header (UI v2 §5.2): who controls
// the contract when proven, or an honest dashed "Owner unknown"
// chip when not. The address is full EIP-55 and wraps by group; the
// chip never invents an address (plugin-plan RC-3).
import { Fragment, type JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";
import { CopyButton } from "../CopyButton.tsx";
import { toChecksumAddress } from "../../lib/checksumAddress.ts";
import { groupAddressChunks } from "../TokenHeader.tsx";

export type OwnerKind = "safe-multisig" | "single-key" | "contract" | "renounced";

export type ProvenOwner = {
  readonly address: string | null;
  readonly kind: OwnerKind;
};

const KIND_LABEL: Record<OwnerKind, string> = Object.freeze({
  "safe-multisig": "Safe multisig",
  "single-key": "Single wallet",
  contract: "Contract",
  renounced: "Renounced. No owner.",
});

export function OwnerChip({ owner }: { readonly owner: ProvenOwner | null }): JSX.Element {
  if (owner === null) {
    return (
      <span className="owner-chip is-unknown">
        <Pictogram name="canttell" size={20} />
        <span className="status-word">Owner unknown</span>
      </span>
    );
  }
  if (owner.kind === "renounced") {
    return (
      <span className="owner-chip is-renounced">
        <Pictogram name="renounced" size={20} />
        <span className="status-word">Renounced. No owner.</span>
      </span>
    );
  }
  const checksummed = owner.address === null ? null : toChecksumAddress(owner.address);
  return (
    <span className="owner-chip">
      <Pictogram name="owner" size={20} />
      <span className="owner-control">Owner</span>{" "}
      {checksummed === null ? null : (
        <span className="addr-full">
          {groupAddressChunks(checksummed).map((chunk, index) => (
            <Fragment key={index}>
              {index === 0 ? null : <wbr />}
              <span className="addr-chunk">{chunk}</span>
            </Fragment>
          ))}
        </span>
      )}{" "}
      {checksummed === null ? null : (
        <CopyButton value={checksummed} label="Copy owner address" testId="copy-owner-address" />
      )}
      <span className="owner-kind">{KIND_LABEL[owner.kind]}</span>
    </span>
  );
}
