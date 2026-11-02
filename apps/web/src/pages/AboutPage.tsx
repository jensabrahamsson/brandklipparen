import type { JSX } from "react";
import { PageFooter } from "../components/PageFooter.tsx";

// About page (UI-4): short, human copy. Phosphor Console tokens and
// existing layout classes only; no motion, no new palette. Headings in
// order (h1 then h2), horse mark from the existing SVG, GitHub link to
// the public repo. Inline prose keeps its line height; the repo link
// and footer links carry a real 44 px box via styles.css.
export function AboutPage(): JSX.Element {
  return (
    <div className="page about">
      <section className="about-hero" aria-labelledby="about-title">
        <img src="/logo.svg" alt="Brandklipparen horse mark" width={96} height={96} className="about-mark" />
        <div>
          <h1 id="about-title" className="hero-title">
            Brandklipparen
          </h1>
          <p className="hero-sub">contract risk scanner — scan before you swap.</p>
        </div>
      </section>

      <section className="card about-card" aria-labelledby="about-what">
        <h2 id="about-what">What it does</h2>
        <p>
          Paste an Ethereum token address, get a risk score in seconds. It reads the contract bytecode
          itself — also for unverified contracts — and shows what the owner can do to holders: block
          wallets, pause trading, mint, change fees. Every finding links to the exact bytes as proof.
        </p>
      </section>

      <section className="card about-card" aria-labelledby="about-score">
        <h2 id="about-score">How the score works</h2>
        <p>
          Deterministic. Proven owner powers set a minimum (an active owner who can block holders
          means High). If ownership is renounced on chain, those powers no longer count. A
          calibrated pattern model adds a history-based estimate. Low never means safe.
        </p>
      </section>

      <section className="card about-card" aria-labelledby="about-ai">
        <h2 id="about-ai">Where AI fits</h2>
        <p>
          Meta&apos;s Muse model explains findings, answers questions in your own words and
          investigates step by step — it never changes the score or the evidence.
        </p>
      </section>

      <section className="card about-card" aria-labelledby="about-dev">
        <h2 id="about-dev">For developers</h2>
        <p>
          REST API under /v1 and an MCP server for AI agents; plugins are small, documented and
          auditable.
        </p>
        <p>
          <a className="about-repo" href="https://github.com/jensabrahamsson/brandklipparen">
            github.com/jensabrahamsson/brandklipparen
          </a>
        </p>
      </section>

      <section className="card about-card" aria-labelledby="about-horse">
        <h2 id="about-horse">The horse</h2>
        <p>
          Brandklipparen was a red-brown stallion ridden by Charles XI of Sweden, and later by
          Charles XII. {"David Kl\u00f6cker Ehrenstrahl"} painted him in &ldquo;Horse called
          Brandklipparen&rdquo;. A klippare was a small, tough Nordic horse of the 1600s–1700s:
          fast, enduring, and fine with poor fodder, hard cold, and long marches.
        </p>
        <p>
          Brand is Swedish for fire. The kings rode out in person to lead fire-fighting in
          Stockholm, and the horse kept for that work had to stand steady through smoke, flames,
          and alarm. A horse that never flinched at fire — this scanner looks at the dangerous
          parts of a contract the same way.
        </p>
      </section>

      <section className="card about-card" aria-labelledby="about-maker">
        <h2 id="about-maker">Who made it</h2>
        <p>
          Jens Abrahamsson is an AI aficionado who worked as a developer long ago and found a
          reborn passion for building software through AI.
        </p>
        <p>
          Built with the delegation approach in{" "}
          <a className="about-repo" href="https://github.com/jensabrahamsson/jstack">
            jstack
          </a>
          .
        </p>
      </section>

      <p>Not financial advice.</p>
      <PageFooter />
    </div>
  );
}
