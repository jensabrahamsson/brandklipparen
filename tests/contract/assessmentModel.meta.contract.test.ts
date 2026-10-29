// Shared contract suite against the Meta Model API adapter (S-036,
// K-305, K-309). Written first per A-21: the adapter runs the same
// suite as the fake over a recorded transport, so a provider swap
// changes nothing but the label. No live calls, no real keys: every
// scenario replays a fixture or a steered transport double.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretString } from "../../src/ports/config.ts";
import { ModelId, Selector, SignalId } from "../../src/domain/types.ts";
import type { CodeHash } from "../../src/domain/types.ts";
import {
  MetaModelApiAdapter,
} from "../../src/adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import type {
  MetaModelApiTransport,
  MetaModelApiTransportResponse,
} from "../../src/adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
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

const TEST_MODEL_ID = "meta-muse-spark-test-1";

function fileTransport(name: string): MetaModelApiTransport {
  const bodyText = readFileSync(join(fixtureDir, name), "utf8");
  return async (): Promise<MetaModelApiTransportResponse> => ({
    status: 200,
    bodyText,
  });
}

// Request-aware replay of the recorded success payload: the fixture is a
// chat-completions envelope whose content carries the canonical text and
// labels, and the double re-points the claim links to the request's first
// evidence entry (read from the user message) so the shared property
// (generated evidence lists) proves link validity and request
// immutability. Schema shape, labels and text still come from the
// recorded bytes, and validation still runs for real.
function successTransport(): MetaModelApiTransport {
  const template = readFileSync(join(fixtureDir, "meta-success.json"), "utf8");
  return async (
    _url: string,
    init: { body: string; signal: AbortSignal },
  ): Promise<MetaModelApiTransportResponse> => {
    const outgoing = JSON.parse(init.body) as {
      messages: ReadonlyArray<{ role: string; content: string }>;
    };
    if (outgoing.messages.length !== 2 || outgoing.messages[0]?.role !== "system" || outgoing.messages[1]?.role !== "user") {
      throw new Error("recorded success transport needs system + user messages");
    }
    const request = JSON.parse(outgoing.messages[1]?.content ?? "") as {
      codeHash: string;
      entries: ReadonlyArray<{ selector: string }>;
    };
    const first = request.entries[0];
    if (first === undefined) {
      throw new Error("recorded success transport needs at least one evidence entry");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(request.codeHash)) {
      throw new Error("recorded success transport received an invalid code hash");
    }
    const codeHash = request.codeHash as CodeHash;
    const selector = Selector.parse(first.selector);
    if (!selector.ok) {
      throw new Error("recorded success transport received invalid evidence");
    }
    const link = SignalId.of(codeHash, selector.value);
    if (!link.ok) {
      throw new Error("recorded success transport cannot derive a signal link");
    }
    const envelope = JSON.parse(template) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = envelope.choices[0]?.message.content;
    if (content === undefined) {
      throw new Error("recorded success fixture carries no message content");
    }
    const payload = JSON.parse(content) as {
      claims: Array<{ signalLinks: string[] }>;
    };
    for (const claim of payload.claims) {
      claim.signalLinks = [link.value as string];
    }
    const replay = {
      ...envelope,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(payload) }, finish_reason: "stop" }],
    };
    return { status: 200, bodyText: JSON.stringify(replay) };
  };
}

function statusTransport(status: number, bodyText: string): MetaModelApiTransport {
  return async (): Promise<MetaModelApiTransportResponse> => ({ status, bodyText });
}

function hangingTransport(): MetaModelApiTransport {
  return async (
    _url: string,
    init: { signal: AbortSignal },
  ): Promise<MetaModelApiTransportResponse> => {
    await new Promise<void>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new Error("recorded transport aborted"));
      });
    });
    return { status: 200, bodyText: "{}" };
  };
}

function failingTransport(): MetaModelApiTransport {
  return async (): Promise<MetaModelApiTransportResponse> => {
    throw new Error("recorded transport unavailable");
  };
}

function makeAdapter(scenario: AssessmentContractScenario): AssessmentModelPort {
  const base = {
    endpoint: "https://meta-api.example.invalid",
    apiKey: new SecretString("fake-meta-key-for-tests-only"),
    modelId: mustModelId(TEST_MODEL_ID),
  };
  switch (scenario) {
    case "success":
      return new MetaModelApiAdapter({ ...base, transport: successTransport() });
    case "timeout":
      return new MetaModelApiAdapter({
        ...base,
        transport: hangingTransport(),
        timeoutMs: 50,
      });
    case "rate-limited":
      return new MetaModelApiAdapter({
        ...base,
        transport: statusTransport(429, "rate limited"),
      });
    case "invalid-output":
      return new MetaModelApiAdapter({
        ...base,
        transport: fileTransport("meta-invalid-output.json"),
      });
    case "output-too-large":
      return new MetaModelApiAdapter({
        ...base,
        transport: fileTransport("meta-output-too-large.json"),
      });
    case "unavailable":
      return new MetaModelApiAdapter({ ...base, transport: failingTransport() });
    case "provider-mismatch":
      return new MetaModelApiAdapter({
        ...base,
        transport: fileTransport("meta-provider-mismatch.json"),
      });
  }
}

runAssessmentModelPortContract("meta-model-api recorded transport", makeAdapter);
