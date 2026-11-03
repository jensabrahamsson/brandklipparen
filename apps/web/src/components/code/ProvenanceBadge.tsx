// Provenance badges for the code view (addendum §A1.3). Each pane
// header carries a badge, never colour-only: a pictogram plus words,
// with a one-line explanation under it. The badge lamp ignites once
// when the lookup resolves (E-9); reduced motion shows it at rest.
import type { JSX } from "react";
import { Pictogram } from "../Pictogram.tsx";

export type ProvenanceKind =
  | "verified-full"
  | "verified-partial"
  | "explorer"
  | "decompiled"
  | "none"
  | "unavailable";

export function ProvenanceBadge({ kind }: { readonly kind: ProvenanceKind }): JSX.Element {
  if (kind === "decompiled") {
    return (
      <p className="code-badge">
        <span className="code-badge-lamp" aria-hidden="true">
          <Pictogram name="decompiler" size={20} />
        </span>{" "}
        <strong className="code-badge-word">Decompiled from bytecode</strong>
        <span className="code-badge-line">Rebuilt from bytes. Names are guesses.</span>
      </p>
    );
  }
  if (kind === "verified-full") {
    return (
      <p className="code-badge is-verified">
        <span className="code-badge-lamp" aria-hidden="true">
          <Pictogram name="verified" size={20} />
        </span>{" "}
        <strong className="code-badge-word">Verified source · Sourcify full match</strong>
        <span className="code-badge-line">Author's code. Matches what runs.</span>
      </p>
    );
  }
  if (kind === "verified-partial") {
    return (
      <p className="code-badge is-verified">
        <span className="code-badge-lamp" aria-hidden="true">
          <Pictogram name="verified" size={20} />
        </span>{" "}
        <strong className="code-badge-word">Verified source · partial match</strong>
        <span className="code-badge-line">Matches what runs. Comments may differ.</span>
      </p>
    );
  }
  if (kind === "explorer") {
    return (
      <p className="code-badge is-verified">
        <span className="code-badge-lamp" aria-hidden="true">
          <Pictogram name="verified" size={20} />
        </span>{" "}
        <strong className="code-badge-word">Verified source · Etherscan</strong>
        <span className="code-badge-line">Verified on Etherscan.</span>
      </p>
    );
  }
  if (kind === "unavailable") {
    return (
      <p className="code-badge is-missing">
        <span className="code-badge-lamp" aria-hidden="true">
          <Pictogram name="notrun" size={20} />
        </span>{" "}
        <strong className="code-badge-word">Verified source · unavailable</strong>
        <span className="code-badge-line">Lookup failed. Source status unknown.</span>
      </p>
    );
  }
  return (
    <p className="code-badge is-missing">
      <span className="code-badge-lamp" aria-hidden="true">
        <Pictogram name="notrun" size={20} />
      </span>{" "}
      <strong className="code-badge-word">Verified source · none</strong>
      <span className="code-badge-line">No source published.</span>
    </p>
  );
}
