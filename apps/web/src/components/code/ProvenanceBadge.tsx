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
        <span className="code-badge-line">Rebuilt by Brandklipparen from the code that runs. Names may be guesses; some parts may be missing.</span>
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
        <span className="code-badge-line">The author published this code, and it compiles to exactly what runs.</span>
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
        <span className="code-badge-line">The code compiles to what runs, but its metadata (comments, file names) may differ.</span>
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
        <span className="code-badge-line">The author published this code on a block explorer, which checked it compiles to what runs.</span>
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
        <span className="code-badge-line">The lookup did not answer, so this is not a statement about the source.</span>
      </p>
    );
  }
  return (
    <p className="code-badge is-missing">
      <span className="code-badge-lamp" aria-hidden="true">
        <Pictogram name="notrun" size={20} />
      </span>{" "}
      <strong className="code-badge-word">Verified source · none</strong>
      <span className="code-badge-line">This token&apos;s author published no source code. Most new tokens never do.</span>
    </p>
  );
}
