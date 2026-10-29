// Can't-tell display copy (S-131): the envelope carries stable slugs
// ("liquidity-locks"); the panel speaks plain questions. Unknown slugs
// degrade to a humanized question, never raw kebab-case.
import { describe, expect, it } from "vitest";
import { cantTellNeedsText, cantTellQuestionText } from "./cantTellCopy.ts";

const KNOWN_QUESTIONS: Readonly<Record<string, string>> = {
  "liquidity-locks": "Is the liquidity locked?",
  "owner-shares": "How much of the supply do insiders hold?",
  "wallet-clusters": "Are many wallets controlled by one owner?",
  "team-identity": "Who is behind this token?",
  "code-intent": "What did the authors intend this code to do?",
  "external-contracts": "What do the linked contracts do?",
};

const KNOWN_NEEDS: Readonly<Record<string, string>> = {
  "liquidity-lock-registry": "a liquidity-lock registry",
  "holder-distribution-feed": "a holder-distribution feed",
  "wallet-cluster-index": "a wallet-cluster index",
  "team-disclosure": "a team disclosure",
  "code-audit-report": "a code audit report",
  "contract-analysis-queue": "a contract-analysis queue",
};

describe("cantTellQuestionText", () => {
  for (const [slug, question] of Object.entries(KNOWN_QUESTIONS)) {
    it(`asks a plain question for ${slug}`, () => {
      const text = cantTellQuestionText(slug);
      expect(text).toBe(question);
      expect(text.endsWith("?")).toBe(true);
      expect(text).not.toContain(slug);
    });
  }

  it("humanizes an unknown slug into a question", () => {
    const text = cantTellQuestionText("some-future-signal");
    expect(text.endsWith("?")).toBe(true);
    expect(text).not.toContain("-");
    expect(text).not.toContain("some-future-signal");
  });

  it("leaves an already-asked question alone", () => {
    expect(cantTellQuestionText("Who holds the liquidity?")).toBe("Who holds the liquidity?");
  });

  it("falls back to a generic question for an empty slug", () => {
    expect(cantTellQuestionText("").endsWith("?")).toBe(true);
  });
});

describe("cantTellNeedsText", () => {
  for (const [slug, needs] of Object.entries(KNOWN_NEEDS)) {
    it(`names the data source for ${slug}`, () => {
      expect(cantTellNeedsText(slug)).toBe(needs);
    });
  }

  it("prefixes an unknown data source plainly", () => {
    const text = cantTellNeedsText("some-future-feed");
    expect(text.startsWith("a ")).toBe(true);
    expect(text).not.toContain("-");
  });
});
