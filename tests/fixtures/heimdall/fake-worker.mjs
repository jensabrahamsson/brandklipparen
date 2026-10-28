// Fake extdecomp worker for tests (S-011, K-008, K-501; file output since
// S-102). Test-only stand-in for the extdecomp binary: it reads one hex
// bytecode from argv and writes the decompile-subcommand output files
// (`abi.json` plus `decompiled.sol`) into the `--output` directory, so the
// adapter test exercises real process isolation, timeouts, crash handling
// and file parsing without the real binary installed.
// Modes are selected with --mode=<mode>:
// success prints functions linked to PUSH4 selectors found in the input,
// hang sleeps past every test timeout, crash exits non-zero, oversize
// writes past a small test cap, invalid writes non-JSON output.
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);

function modeOf() {
  for (const arg of args) {
    if (arg.startsWith("--mode=")) {
      return arg.slice("--mode=".length);
    }
  }
  return "success";
}

function flagValue(name) {
  const at = args.indexOf(name);
  if (at !== -1 && at + 1 < args.length) {
    return args[at + 1];
  }
  const glued = args.find((arg) => arg.startsWith(`${name}=`));
  return glued === undefined ? null : glued.slice(name.length + 1);
}

function bytecodeOf() {
  const hexes = args.filter((arg) => /^0x[0-9a-fA-F]*$/.test(arg));
  return hexes[hexes.length - 1] ?? "";
}

function findPush4Selectors(hex) {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  const seen = new Set();
  const out = [];
  for (const match of body.matchAll(/63([0-9a-fA-F]{8})14/g)) {
    const selector = `0x${match[1].toLowerCase()}`;
    if (!seen.has(selector)) {
      seen.add(selector);
      out.push(selector);
    }
  }
  return out;
}

const mode = modeOf();
const output = flagValue("--output");

if (output !== null) {
  mkdirSync(output, { recursive: true });
}

function writeFiles(abi, sol) {
  if (output === null) {
    process.stderr.write("fake worker: --output is required\n");
    process.exit(2);
  }
  writeFileSync(`${output}/abi.json`, abi, "utf8");
  writeFileSync(`${output}/decompiled.sol`, sol, "utf8");
}

if (mode === "hang") {
  setTimeout(() => {}, 120000);
} else if (mode === "crash") {
  process.stderr.write("fake worker: simulated crash\n");
  process.exit(1);
} else if (mode === "oversize") {
  const selector = "0x00000000";
  writeFiles(
    JSON.stringify({ functions: [{ selector, name: "oversized" }] }),
    `// function ${selector}\n${"z".repeat(65536)}\n`,
  );
} else if (mode === "invalid") {
  writeFiles("this is not decompiler output\n", "// function 0x00000000\nempty\n");
} else {
  const selectors = findPush4Selectors(bytecodeOf());
  const abi = { functions: selectors.map((selector) => ({ selector, name: `fn_${selector.slice(2)}` })) };
  const sol = selectors
    .map((selector) => `// function ${selector}\ndecompiled function for selector ${selector}\n`)
    .join("\n");
  writeFiles(JSON.stringify(abi), `${sol}\n`);
}
