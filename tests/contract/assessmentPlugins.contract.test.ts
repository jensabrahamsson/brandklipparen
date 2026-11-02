// Assessment adapters as registered assessment plugins (S-045, K-030
// proposed, K-305, K-309). Written first (red) per A-21: every registered
// assessment plugin resolves to an AssessmentModelPort implementation
// that passes the shared contract suite over a recorded transport, and
// the fake passes the same suite. No live calls, no real keys.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretString } from "../../src/ports/config.ts";
import { ModelId, Selector, SignalId } from "../../src/domain/types.ts";
import type { CodeHash, ModelId as ModelIdValue } from "../../src/domain/types.ts";
import {
  MetaModelApiAdapter,
} from "../../src/adapters/assessment/metaModelApi/metaModelApiAdapter.ts";
import { FakeAssessmentModelAdapter } from "../fakes/fakeAssessmentModel.ts";
import type { AssessmentModelPort } from "../../src/ports/assessmentModel.ts";
import { ASSESSMENT_PLUGINS } from "../../src/plugins/registry.ts";
import type { AssessmentContractScenario } from "./assessmentModel.contract.ts";
import { runAssessmentModelPortContract } from "./assessmentModel.contract.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "fixtures", "assessment");

function mustModelId(raw: string): ModelIdValue {
  const parsed = ModelId.parse(raw);
  if (!parsed.ok) {
    throw new Error(`test model id is invalid: ${parsed.error.message}`);
  }
  return parsed.value;
}

type RecordedTransport = (url: string, init: { body: string; signal: AbortSignal }) => Promise<{
  status: number;
  bodyText: string;
}>;

function fileTransport(name: string): RecordedTransport {
  const bodyText = readFileSync(join(fixtureDir, name), "utf8");
  return async () => ({ status: 200, bodyText });
}

// Request-aware replay of the recorded success payload: the fixture is a
// chat-completions envelope whose content carries the canonical text and
// labels, and the double re-points the claim links to the request's first
// evidence entry (read from the user message) so the shared property
// (generated evidence lists) proves link validity and request
// immutability. Schema shape, labels and text still come from the
// recorded bytes, and validation still runs for real.
function successTransport(fixtureName: string): RecordedTransport {
  const template = readFileSync(join(fixtureDir, fixtureName), "utf8");
  return async (_url: string, init: { body: string; signal: AbortSignal }) => {
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

function statusTransport(status: number, bodyText: string): RecordedTransport {
  return async () => ({ status, bodyText });
}

function hangingTransport(): RecordedTransport {
  return async (_url: string, init: { signal: AbortSignal }) => {
    await new Promise<void>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new Error("recorded transport aborted"));
      });
    });
    return { status: 200, bodyText: "{}" };
  };
}

function failingTransport(): RecordedTransport {
  return async () => {
    throw new Error("recorded transport unavailable");
  };
}

// Every registered assessment plugin resolves to its AssessmentModelPort
// implementation over a recorded transport: the registry entry selects
// the adapter by provider, and the shared suite proves the swap changes
// nothing but the label.
function makeAdapterForPlugin(
  pluginId: string,
  scenario: AssessmentContractScenario,
): AssessmentModelPort {
  const plugin = ASSESSMENT_PLUGINS.find((entry) => entry.manifest.id === pluginId);
  if (plugin === undefined) {
    throw new Error(`unregistered assessment plugin: ${pluginId}`);
  }
  if (plugin.provider === "meta-model-api") {
    const base = {
      endpoint: "https://meta-api.example.invalid",
      apiKey: new SecretString("fake-meta-key-for-tests-only"),
      modelId: mustModelId("meta-muse-spark-test-1"),
    };
    switch (scenario) {
      case "success":
        return new MetaModelApiAdapter({ ...base, transport: successTransport("meta-success.json") });
      case "timeout":
        return new MetaModelApiAdapter({ ...base, transport: hangingTransport(), timeoutMs: 50 });
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
  throw new Error(`unsupported assessment provider: ${plugin.provider}`);
}

for (const plugin of ASSESSMENT_PLUGINS) {
  runAssessmentModelPortContract(
    `registered assessment plugin ${plugin.manifest.id}`,
    (scenario) => makeAdapterForPlugin(plugin.manifest.id, scenario),
  );
}

runAssessmentModelPortContract(
  "fake assessment model",
  (scenario) =>
    new FakeAssessmentModelAdapter({
      provider: "meta-model-api",
      modelId: "fake-meta-spark-1",
      promptVersion: "1.0.0",
      scenario,
    }),
);
