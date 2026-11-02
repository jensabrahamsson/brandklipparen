import type { JSX } from "react";

export function PageFooter(): JSX.Element {
  return (
    <footer className="page-foot">
      <span>Scan before you swap</span>{" "}<span aria-hidden="true">·</span>{" "}
      <a href="#/about">About</a>{" "}<span aria-hidden="true">·</span>{" "}
      <a href="https://github.com/jensabrahamsson/brandklipparen">GitHub</a>
    </footer>
  );
}
