import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Static XSS guard (K-507): contract-derived strings render as text only.
// No HTML sinks or script compilation may appear in the web sources.
const BANNED = ["dangerouslySetInnerHTML", "innerHTML", "outerHTML", "eval(", "new Function("];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      found.push(full);
    }
  }
  return found;
}

describe("xss static guard (K-507)", () => {
  test("k507_no_html_sinks_or_eval_in_web_sources", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcDir = join(here, "..");
    const violations: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const text = readFileSync(file, "utf8");
      for (const banned of BANNED) {
        if (text.includes(banned)) {
          violations.push(`${file}: ${banned}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
