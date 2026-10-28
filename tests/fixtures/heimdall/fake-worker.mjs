// Fake extdecomp worker for tests (S-011, K-008, K-501; file output since
// S-102). Test-only stand-in for the extdecomp binary: it reads one hex
// bytecode from argv and writes the decompile-subcommand output file
// (`abi.json`) into the `--output` directory, so the adapter test
// exercises real process isolation, timeouts, crash handling and file
// parsing without the real binary installed. The emitted shape mirrors
// real extdecomp 0.9.1: a standard ABI array (`[{type, name, inputs,
// outputs, stateMutability}, ...]`) with `Unresolved_<hex>` names for
// unknown selectors and resolved names with typed inputs for known ones,
// plus one event entry that the adapter must skip.
// Modes are selected with --mode=<mode>:
// success prints real-format entries for PUSH4 selectors found in the
// input, hang sleeps past every test timeout, crash exits non-zero,
// oversize writes past a small test cap, invalid writes non-JSON output,
// bad-entry writes a JSON array holding a malformed function entry.
// The worker also enforces the local-only CLI surface the adapter must
// pass to the real binary (`--skip-resolving`, `-d`, `--color never`
// beside `--output`): a run missing any of them exits non-zero, so every
// adapter test through this worker proves the flags are present.
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

// Resolved names with canonical input types for well-known selectors, so
// the adapter derives the same selector back through the signature hash.
// Selectors outside this table are emitted as `Unresolved_<hex>`, exactly
// like the real binary with `--skip-resolving`.
const RESOLVED = {
  "0x06fdde03": { name: "name", inputs: [] },
  "0x095ea7b3": { name: "approve", inputs: [{ type: "address" }, { type: "uint256" }] },
  "0x18160ddd": { name: "totalSupply", inputs: [] },
  "0x23b872dd": {
    name: "transferFrom",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }],
  },
  "0x313ce567": { name: "decimals", inputs: [] },
  "0x70a08231": { name: "balanceOf", inputs: [{ type: "address" }] },
  "0x95d89b41": { name: "symbol", inputs: [] },
  "0xa9059cbb": { name: "transfer", inputs: [{ type: "address" }, { type: "uint256" }] },
  "0xdd62ed3e": {
    name: "allowance",
    inputs: [{ type: "address" }, { type: "address" }],
  },
};

function functionEntryFor(selector) {
  const bare = selector.slice(2).toUpperCase();
  const known = RESOLVED[selector];
  if (known === undefined) {
    return {
      type: "function",
      name: `Unresolved_${bare}`,
      inputs: [],
      outputs: [],
      stateMutability: "nonpayable",
    };
  }
  return {
    type: "function",
    name: known.name,
    inputs: known.inputs,
    outputs: [],
    stateMutability: "nonpayable",
  };
}

function transferEventEntry() {
  return {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
    anonymous: false,
  };
}

const mode = modeOf();
const output = flagValue("--output");

// The adapter always passes its local-only flags; a run without them does
// not mirror a real invocation and is turned away here.
function cliParityOk() {
  if (!args.includes("--skip-resolving")) {
    return false;
  }
  if (!args.includes("-d") && !args.includes("--default")) {
    return false;
  }
  return flagValue("--color") === "never";
}

if (!cliParityOk()) {
  process.stderr.write("fake worker: local-only extdecomp flags are required\n");
  process.exit(2);
}

if (output !== null) {
  mkdirSync(output, { recursive: true });
}

function writeFiles(abi) {
  if (output === null) {
    process.stderr.write("fake worker: --output is required\n");
    process.exit(2);
  }
  writeFileSync(`${output}/abi.json`, abi, "utf8");
}

if (mode === "hang") {
  setTimeout(() => {}, 120000);
} else if (mode === "crash") {
  process.stderr.write("fake worker: simulated crash\n");
  process.exit(1);
} else if (mode === "oversize") {
  const padding = "z".repeat(65536);
  writeFiles(JSON.stringify([{ type: "function", name: `Unresolved_${padding}`, inputs: [] }]));
} else if (mode === "invalid") {
  writeFiles("this is not decompiler output\n");
} else if (mode === "bad-entry") {
  writeFiles(JSON.stringify([{ type: "function", name: 42, inputs: [] }]));
} else {
  const selectors = findPush4Selectors(bytecodeOf());
  const abi = [...selectors.map((selector) => functionEntryFor(selector)), transferEventEntry()];
  writeFiles(JSON.stringify(abi));
}
