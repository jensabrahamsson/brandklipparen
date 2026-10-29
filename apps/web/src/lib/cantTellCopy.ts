// Can't-tell display copy (S-131): the envelope carries stable slugs
// such as "liquidity-locks"; the panel renders plain questions plus the
// data source they need. Unknown slugs degrade to a humanized question,
// never raw kebab-case, so future catalogue entries stay readable.
const QUESTIONS: Readonly<Record<string, string>> = {
  "liquidity-locks": "Is the liquidity locked?",
  "owner-shares": "How much of the supply do insiders hold?",
  "wallet-clusters": "Are many wallets controlled by one owner?",
  "team-identity": "Who is behind this token?",
  "code-intent": "What did the authors intend this code to do?",
  "external-contracts": "What do the linked contracts do?",
};

const NEEDS: Readonly<Record<string, string>> = {
  "liquidity-lock-registry": "a liquidity-lock registry",
  "holder-distribution-feed": "a holder-distribution feed",
  "wallet-cluster-index": "a wallet-cluster index",
  "team-disclosure": "a team disclosure",
  "code-audit-report": "a code audit report",
  "contract-analysis-queue": "a contract-analysis queue",
};

function humanizeSlug(slug: string): string {
  return slug.replace(/-/g, " ").trim();
}

export function cantTellQuestionText(question: string): string {
  const known = QUESTIONS[question];
  if (known !== undefined) {
    return known;
  }
  const human = humanizeSlug(question);
  if (human.length === 0) {
    return "What else can't the bytecode tell us?";
  }
  if (human.endsWith("?")) {
    return human;
  }
  return human.charAt(0).toUpperCase() + human.slice(1) + "?";
}

export function cantTellNeedsText(dataSource: string): string {
  const known = NEEDS[dataSource];
  if (known !== undefined) {
    return known;
  }
  const human = humanizeSlug(dataSource);
  if (human.length === 0) {
    return "more data";
  }
  return `a ${human}`;
}
