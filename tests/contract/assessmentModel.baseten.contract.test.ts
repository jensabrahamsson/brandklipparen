// Shared contract suite against the hosted open-weights adapter (S-037,
// K-305, K-309). Written first per A-21: the adapter runs the same
// suite as the fake and the Meta adapter over a recorded transport, so a
// provider swap changes nothing but the label. No live calls, no real
// keys: every scenario replays a fixture or a steered transport double.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretString } from "../../src/ports/config.ts";
import { ModelId, Selector, SignalId } from "../../src/domain/types.ts";
import type { CodeHash } from "../../src/domain/types.ts";
import {
  hosted_OPEN_WEIGHTS_MODEL_ID,
  hostedOpenWeightsAdapter,
} from "../../src/adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import type {
  hostedOpenWeightsTransport,
  hostedOpenWeightsTransportResponse,
} from "../../src/adapters/assessment/hostedOpenWeights/hostedOpenWeightsAdapter.ts";
import type { AssessmentModelPort } from "../../src/ports/assessmentModel.ts";
import type { AssessmentContractScenario } from "./assessmentModel.contract.ts";
import { runAssessmentModelPortContract } from "./assessmentModel.contract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "assessment");

function mustModelId(raw: string): ModelId {
  const parsed = ModelId.parse(raw);
  if (!parsed.ok) {
    throw new Error(`test model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

function fileTransport(name: string): hostedOpenWeightsTransport {
  const bodyText = readFileSync(join(fixtureDir, name), "utf8");
  return async (): Promise<hostedOpenWeightsTransportResponse> => ({
    status: 200,
    bodyText,
  });
}

// Request-aware replay of the recorded success payload: the fixture
// carries the canonical text and labels, and the double re-points the
// claim links to the request's first evidence entry so the shared
// property (generated evidence lists) proves link validity and request
// immutability. Schema shape, labels and text still come from the
// recorded bytes, and validation still runs for real.
function successTransport(): hostedOpenWeightsTransport {
  const template = readFileSync(join(fixtureDir, "hosted-success.json"), "utf8");
  return async (
    _url: string,
    init: { body: string; signal: AbortSignal },
  ): Promise<hostedOpenWeightsTransportResponse> => {
    const request = JSON.parse(init.body) as {
      evidence: { codeHash: string; entries: ReadonlyArray<{ selector: string }> };
    };
    const first = request.evidence.entries[0];
    if (first === undefined) {
      throw new Error("recorded success transport needs at least one evidence entry");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(request.evidence.codeHash)) {
      throw new Error("recorded success transport received an invalid code hash");
    }
    const codeHash = request.evidence.codeHash as CodeHash;
    const selector = Selector.parse(first.selector);
    if (!selector.ok) {
      throw new Error("recorded success transport received invalid evidence");
    }
    const link = SignalId.of(codeHash, selector.value);
    if (!link.ok) {
      throw new Error("recorded success transport cannot derive a signal link");
    }
    const payload = JSON.parse(template) as {
      claims: Array<{ signalLinks: string[] }>;
    };
    for (const claim of payload.claims) {
      claim.signalLinks = [link.value as string];
    }
    return { status: 200, bodyText: JSON.stringify(payload) };
  };
}

function statusTransport(status: number, bodyText: string): hostedOpenWeightsTransport {
  return async (): Promise<hostedOpenWeightsTransportResponse> => ({ status, bodyText });
}

function hangingTransport(): hostedOpenWeightsTransport {
  return async (
    _url: string,
    init: { signal: AbortSignal },
  ): Promise<hostedOpenWeightsTransportResponse> => {
    await new Promise<void>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new Error("recorded transport aborted"));
      });
    });
    return { status: 200, bodyText: "{}" };
  };
}

function failingTransport(): hostedOpenWeightsTransport {
  return async (): Promise<hostedOpenWeightsTransportResponse> => {
    throw new Error("recorded transport unavailable");
  };
}

function makeAdapter(scenario: AssessmentContractScenario): AssessmentModelPort {
  const base = {
    endpoint: "https://hosted.example.invalid/assessment",
    apiKey: new SecretString("fake-hosted-key-for-tests-only"),
    modelId: mustModelId(hosted_OPEN_WEIGHTS_MODEL_ID),
  };
  switch (scenario) {
    case "success":
      return new hostedOpenWeightsAdapter({ ...base, transport: successTransport() });
    case "timeout":
      return new hostedOpenWeightsAdapter({
        ...base,
        transport: hangingTransport(),
        timeoutMs: 50,
      });
    case "rate-limited":
      return new hostedOpenWeightsAdapter({
        ...base,
        transport: statusTransport(429, "rate limited"),
      });
    case "invalid-output":
      return new hostedOpenWeightsAdapter({
        ...base,
        transport: fileTransport("hosted-invalid-output.json"),
      });
    case "output-too-large":
      return new hostedOpenWeightsAdapter({
        ...base,
        transport: fileTransport("hosted-output-too-large.json"),
      });
    case "unavailable":
      return new hostedOpenWeightsAdapter({ ...base, transport: failingTransport() });
    case "provider-mismatch":
      return new hostedOpenWeightsAdapter({
        ...base,
        transport: fileTransport("hosted-provider-mismatch.json"),
      });
  }
}

runAssessmentModelPortContract("hosted-open-weights recorded transport", makeAdapter);
