// Child-process runner for k102_two_runs_across_processes_bit_identical.
// Reads one golden fixture input path from argv, runs the pure domain core
// (canonical serialization) and writes the canonical bytes to stdout.
// This runner lives in the test layer: src/domain holds no process access.
import { readFileSync } from "node:fs";
import { canonicalSerialize } from "../../src/domain/serialize.ts";
import { reviveCanonical } from "./k102-fixtures.ts";

const inputPath = process.argv[2];
if (inputPath === undefined || inputPath.length === 0) {
  process.stderr.write("usage: k102-run-canonical <input-path>\n");
  process.exit(1);
}
const raw = readFileSync(inputPath, "utf8");
const value = reviveCanonical(JSON.parse(raw) as unknown);
process.stdout.write(canonicalSerialize(value));
