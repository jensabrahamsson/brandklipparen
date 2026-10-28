// English-only guard: fails listing file:line on å, ä or ö in tracked
// text files. The product name Brandklipparen carries none of them, so
// any hit is Swedish text to translate. Binary files are skipped by a NUL
// probe. Usage: `npm run check:english` (wired into `npm run check`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SWEDISH_LETTERS = /[åäöÅÄÖ]/;

function trackedFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

const hits = [];
for (const file of trackedFiles()) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    continue;
  }
  if (bytes.includes(0)) {
    continue;
  }
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (SWEDISH_LETTERS.test(lines[index] ?? "")) {
      hits.push(`${file}:${index + 1}`);
    }
  }
}
for (const hit of hits) {
  console.log(hit);
}
if (hits.length > 0) {
  console.error(`${hits.length} Swedish-letter hit(s) in tracked files`);
  process.exit(1);
}
