// Contract suite against the deterministic fake (S-011, K-008).
// Runs the shared DecompilerPort suite against the fake, so the fake
// proves the same outcomes the worker adapter must keep in its own run.
import { FakeDecompilerAdapter } from "../fakes/fakeDecompiler.ts";
import type { DecompilerPort } from "../../src/ports/decompiler.ts";
import type { DecompilerContractScenario } from "./decompiler.contract.ts";
import { runDecompilerPortContract } from "./decompiler.contract.ts";

function makeFake(scenario: DecompilerContractScenario): DecompilerPort {
  return new FakeDecompilerAdapter({ scenario });
}

runDecompilerPortContract("fake decompiler", makeFake);
