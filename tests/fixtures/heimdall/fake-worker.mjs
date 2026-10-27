// Fake extdecomp worker for tests (S-011, K-008, K-501).
// Test-only stand-in for the extdecomp binary: it reads one hex bytecode
// from argv and writes one JSON document to stdout, so the adapter test
// exercises real process isolation, timeouts and crash handling without the
// real binary installed. Modes are selected with --mode=<mode>:
// success prints functions linked to PUSH4 selectors found in the input,
// hang sleeps past every test timeout, crash exits non-zero, oversize
// prints past a small test cap, invalid prints non-JSON text.
const args = process.argv.slice(2);

function modeOf() {
  for (const arg of args) {
    if (arg.startsWith("--mode=")) {
      return arg.slice("--mode=".length);
    }
  }
  return "success";
}

function bytecodeOf() {
  const rest = args.filter((arg) => !arg.startsWith("--"));
  return rest[rest.length - 1] ?? "";
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
const bytecode = bytecodeOf();

if (mode === "hang") {
  setTimeout(() => {}, 120000);
} else if (mode === "crash") {
  process.stderr.write("fake worker: simulated crash\n");
  process.exit(1);
} else if (mode === "oversize") {
  process.stdout.write(`{"functions": [{"selector": "0x00000000", "snippet": {"text": "`);
  process.stdout.write("z".repeat(65536));
  process.stdout.write(`", "line": 0}}]}`);
} else if (mode === "invalid") {
  process.stdout.write("this is not decompiler output\n");
} else {
  const functions = findPush4Selectors(bytecode).map((selector, index) => ({
    selector,
    snippet: { text: `decompiled function for selector ${selector}`, line: index },
  }));
  process.stdout.write(JSON.stringify({ functions }));
}
