// Copy stub for the S-102 worker test: stands in for the real extdecomp
// binary by copying a recorded output directory into the `--output`
// directory the adapter passes, after an artificial delay. The delay makes
// the concurrency cap observable: with maxConcurrency 1 two overlapping
// runs take at least twice the delay. Test-only; never shipped.
import { cpSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);

function flagValue(name) {
  const at = args.indexOf(name);
  if (at !== -1 && at + 1 < args.length) {
    return args[at + 1];
  }
  const glued = args.find((arg) => arg.startsWith(`${name}=`));
  return glued === undefined ? null : glued.slice(name.length + 1);
}

const delayMs = Number.parseInt(flagValue("--delay-ms") ?? "800", 10);
const from = flagValue("--from");
const output = flagValue("--output");

if (from === null || output === null) {
  process.stderr.write("copy worker: --from and --output are required\n");
  process.exit(2);
}

mkdirSync(output, { recursive: true });
cpSync(`${from}/abi.json`, `${output}/abi.json`);
cpSync(`${from}/decompiled.sol`, `${output}/decompiled.sol`);
setTimeout(() => {
  process.exit(0);
}, Number.isSafeInteger(delayMs) && delayMs >= 0 ? delayMs : 800);
