// Child entry point for S-050 detector isolation (K-515, K-501). The
// parent in `pluginWorker.ts` spawns one dedicated `node` process on this
// script per untrusted detector run: argv carries the absolute detector
// module path, stdin carries the input JSON, stdout carries one envelope
// JSON document. The runner dynamically imports the detector module —
// that import lives here in the isolated child, never in `src/plugins`
// or the composition root, so the static-registration gate in P-07 and
// the `k514_registry_has_no_dynamic_loading` check stay green. A detector
// that throws maps to a `worker-error` envelope; a detector that never
// returns is killed by the parent deadline and never answers at all.
import { pathToFileURL } from "node:url";

type Envelope =
  | { readonly kind: "ok"; readonly findings: string }
  | { readonly kind: "worker-error"; readonly message: string };

function respond(envelope: Envelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`, () => {
    process.exit(0);
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => {
      resolve(text);
    });
    process.stdin.on("error", (error: unknown) => {
      reject(error instanceof Error ? error : new Error("failed to read detector input"));
    });
  });
}

// Transport revival for the worker boundary (S-105): the host encodes
// bytecode as `0x` hex because stdio carries JSON only. The runner revives
// that one field to bytes before calling `detect`, so the detector
// observes the same value shape as an in-process run. Every other field
// travels JSON-safe and passes through untouched.
function reviveDetectorInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const record = input as { readonly [field: string]: unknown };
  const bytecode = record["bytecode"];
  if (typeof bytecode !== "string" || !bytecode.startsWith("0x")) {
    return input;
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(bytecode.slice(2), "hex"));
  } catch {
    return input;
  }
  return Object.freeze({ ...record, bytecode: bytes });
}

async function main(): Promise<void> {
  const modulePath = process.argv[2];
  if (typeof modulePath !== "string" || modulePath.length === 0) {
    respond({ kind: "worker-error", message: "detector runner needs a module path" });
    return;
  }
  let input: unknown;
  try {
    input = JSON.parse(await readStdin()) as unknown;
  } catch {
    respond({ kind: "worker-error", message: "detector runner needs input JSON on stdin" });
    return;
  }
  let exported: unknown;
  try {
    exported = (await import(pathToFileURL(modulePath).href)) as unknown;
  } catch {
    respond({ kind: "worker-error", message: "detector module failed to load" });
    return;
  }
  const detect = (exported as { detect?: unknown }).detect;
  if (typeof detect !== "function") {
    respond({ kind: "worker-error", message: "detector module carries no detect function" });
    return;
  }
  try {
    const findings = (await (detect as (input: unknown) => unknown)(
      reviveDetectorInput(input),
    )) as unknown;
    respond({ kind: "ok", findings: JSON.stringify(findings) });
  } catch {
    respond({ kind: "worker-error", message: "detector threw inside its worker" });
  }
}

void main();
