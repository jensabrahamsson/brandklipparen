// Vendor-name guard: fails listing file:line on any mention of a
// non-Meta AI vendor or tool name in tracked files. The word list below
// holds ONLY SHA-256 hashes of lowercase words (it is a list of non-Meta
// AI vendor/tool names); each scanned line is tokenised into lowercase
// alphanumeric words and compared by hash, so the script itself names no
// vendor. Exact-token matching keeps ordinary English ("together",
// "continue", "cursor") green; only unambiguous vendor names are listed.
// Usage: `npm run check:vendors` (wired into `npm run check` and CI).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const VENDOR_WORD_HASHES = new Set([
  "7d3194f79e645c42e4396dda38be04766810ec6a00d00aced3ffc2a0a1f1a9ef",
  "60965168ce762e949600281ba6d01fee136e5b6e8257b1f216f9025ed324474c",
  "053ea4804ef1bb33d4a3d6fb024a614b6d257cebc2bc7cd915da9c9522f37ffc",
  "5d72436256ada53828b51895a94bb8489e9f1ac4fe937a8024ef1594e7045ff6",
  "9058f79c893a1d7e20b13009b95b9cf3211478a91a47e2ad65bdfedad6fc98f4",
  "3ea125d0bff386e6754b3782b300016fc79a9cf8f8669c0a5c3db64467ddb681",
  "c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d",
  "c70eca6b0f88f44d81a41311647e50fda1ac454ec04ffd442b0eb4743a993131",
  "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
  "add92b9cde2bdbf3daaf65a0db79e9b1a7fa428b71b4d6ce38c742eb6dca0c1c",
  "6fcba5d96a4fadfdd63064cf21da843c31de9a702bbee7fe306d4754fc9dd262",
  "920510199770f4d65cb8aaa2cd12bdb2b8c37f5b3907c50a734a0e3409da2823",
  "6f7ac1823da81d2e52d1a1549ee69c85bbf8bb56d06682849e7c09da2785ce3b",
  "67f2d22514622d1be30c14ee9f3cb104503a159a33a656ca91a1953aa9616429",
  "45d780f82c9247fc1142f8b60c12b6c6cd3d9f23dd836cfa6e84c498d2f83292",
  "72e8088a05b38ae3cffbc126c1c2095046c7700edab31ce35867ce8ee3ac8932",
  "e12ce8285efc67c6d93d3a122e2589ed95089bcbb775ba5634d94e2b8385db07",
  "c9ad8f2cc1294afa0ef22fc2c019ff7243cdd272b2147ddca3f34c5036b05768",
  "d931372ba7f836a0bf8405601b0a293927ba20bf368f12b2cf3affc384c8a9da",
  "194cbf5c4433b278166f7eca3fbab6c639a862ea7dcb10250fdb7dc2c129693a",
  "a4c745facd3a921565e2c12d2db6a4021d4764f633a18400634d68df575ffb35",
  "d203a277f19a8f7d78fe8e9a621534b2cbd8ef1f0d809908ffc481e778858872",
  "0b79cf2de0ee6b8ee227d9ebfe69b91aa92b1d2509641c4b743518447dbc4c68",
  "77b30b8a88051252a94c391bf8a60d228a53fe85371a95dd7fa13350fbe59ca1",
  "0c32f6ed7ab6498676c7dbb1add1c11baa444e5d9290e532f67a2eaf3f60280e",
  "97f128115e33c7693db6156c493d1fcbe0ebf4a870b6b49cd4b6b865233f7725",
  "0ac0192d441f96da3a4a3174330c3a74e034a3a4704fded0e87515d1a97c19dc",
  "5d0c0ab127fdea24d94e7e3326b6ceb965ab82ad897f9de1bd6b1a9a23f87578",
  "ebde709e306badca2f843f1ef91c7fb216a99aa4417b32fe911e15acfff8bedd",
  "76e3c7bfe641ea125c0c2e1c5f89349e17b352ed128d528de2443794e7acf870",
]);

function sha256(word) {
  return createHash("sha256").update(word, "utf8").digest("hex");
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  return out.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function isText(path) {
  try {
    const bytes = readFileSync(path);
    if (bytes.includes(0)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function scanLines(files, read, extraHashes = []) {
  const fromEnv = (process.env.EXTRA_VENDOR_HASHES ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[0-9a-f]{64}$/.test(entry));
  const hashes = new Set([...VENDOR_WORD_HASHES, ...fromEnv, ...extraHashes]);
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const tokens = (lines[index] ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
      for (const token of tokens) {
        if (hashes.has(sha256(token))) {
          hits.push(`${file}:${index + 1}`);
          break;
        }
      }
    }
  }
  return hits;
}

const invokedDirectly = (process.argv[1] ?? "").endsWith("check-vendor-names.mjs");
if (invokedDirectly) {
  const extraFiles = process.argv.slice(2);
  if (extraFiles.length > 0) {
    // Test hook: scan the given files instead of the tracked tree.
    const hits = scanLines(extraFiles, (file) => readFileSync(file, "utf8"));
    for (const hit of hits) {
      console.log(hit);
    }
    process.exit(hits.length === 0 ? 0 : 1);
  } else {
    const files = trackedFiles().filter(isText);
    const hits = scanLines(files, (file) => readFileSync(file, "utf8"));
    for (const hit of hits) {
      console.log(hit);
    }
    if (hits.length > 0) {
      console.error(`${hits.length} vendor-name hit(s) in tracked files`);
      process.exit(1);
    }
  }
}
