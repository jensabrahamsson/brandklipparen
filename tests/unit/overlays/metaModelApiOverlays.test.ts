// Meta Model API wiring for the explain, chat and rug overlays: provider
// selection, the shared chat-completions transport, typed fallbacks and
// demo defaults. A fake transport replays recorded fixtures; no test
// touches the network. All keys, urls and model ids are fakes.
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../../src/adapters/config/loader.ts";
import {
  createChatServiceFromConfig,
  createExplainServiceFromConfig,
  createRugServiceFromConfig,
  selectChatBinding,
  selectExplainBinding,
  selectRugBinding,
} from "../../../src/composition/root.ts";
import { healthCapabilities } from "../../../src/interfaces/rest/healthCapabilities.ts";
import type { OverlayTransport } from "../../../src/adapters/overlays/metaModelApiOverlays.ts";
import { ChatInput } from "../../../src/ports/chatModel.ts";
import { ExplainInput } from "../../../src/ports/explainModel.ts";
import { RugInput } from "../../../src/ports/rugModel.ts";
import {
  DEMO_CHAT_META_READY_LINE,
  DEMO_CHAT_META_PROVIDER,
  DEMO_CHAT_OFF_LINE,
  DEMO_EXPLAIN_META_READY_LINE,
  DEMO_EXPLAIN_META_PROVIDER,
  DEMO_EXPLAIN_OFF_LINE,
  DEMO_RUG_META_READY_LINE,
  DEMO_RUG_META_PROVIDER,
  DEMO_RUG_OFF_LINE,
  demoChatStatus,
  demoExplainStatus,
  demoRugStatus,
  withDemoChatDefault,
  withDemoExplainDefault,
  withDemoRugDefault,
} from "../../../scripts/demo.ts";

type EnvInput = Record<string, string | undefined>;

function baseCiEnv(): EnvInput {
  return {
    BRANDKLIPPAREN_ENV: "ci",
    BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
    BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
    BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
    BRANDKLIPPAREN_extdecomp_DEADLINE_MS: "5000",
    BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB: "512",
    BRANDKLIPPAREN_extdecomp_MAX_OUTPUT_BYTES: "100000",
    BRANDKLIPPAREN_LOG_LEVEL: "info",
  };
}

function overlayEnv(feature: "EXPLAIN" | "CHAT" | "RUG", overrides: EnvInput = {}): EnvInput {
  return {
    ...baseCiEnv(),
    [`BRANDKLIPPAREN_${feature}_PROVIDER`]: "meta-model-api",
    [`BRANDKLIPPAREN_${feature}_META_API_KEY`]: "fake-meta-key-for-tests-only",
    [`BRANDKLIPPAREN_${feature}_META_BASE_URL`]: "https://meta.example.invalid",
    ...overrides,
  };
}

function loadOverlayEnv(feature: "EXPLAIN" | "CHAT" | "RUG", overrides: EnvInput = {}) {
  const loaded = loadConfig(overlayEnv(feature, overrides));
  if (!loaded.ok) {
    throw new Error(`expected valid config: ${loaded.error.variable}`);
  }
  return loaded.value;
}

type CapturedCall = { readonly url: string; readonly body: string };

function fakeTransport(calls: CapturedCall[], bodyText: string): OverlayTransport {
  return async (url, init) => {
    calls.push({ url, body: init.body });
    return { status: 200, bodyText };
  };
}

function chatEnvelope(assistant: unknown): string {
  return JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(assistant) } }],
  });
}

function explainInput() {
  const created = ExplainInput.create({
    codeHash: "code-hash-for-unit-suite",
    evidenceIds: ["signal:first"],
    promptVersion: "explain-1",
  });
  if (created === null) {
    throw new Error("expected valid explain input");
  }
  return created;
}

function chatInput() {
  const created = ChatInput.create({
    codeHash: "code-hash-for-unit-suite",
    evidenceIds: ["signal:first"],
    question: "Does the analysis report a capability?",
    promptVersion: "chat-1",
  });
  if (created === null) {
    throw new Error("expected valid chat input");
  }
  return created;
}

function rugInput() {
  const created = RugInput.create({
    codeHash: "code-hash-for-unit-suite",
    evidenceIds: ["signal:first"],
    topRisk: "rug-pull",
    promptVersion: "rug-1",
  });
  if (created === null) {
    throw new Error("expected valid rug input");
  }
  return created;
}

describe("overlay provider selection", () => {
  test("unset providers leave every overlay disabled with zero calls", () => {
    const loaded = loadConfig(baseCiEnv());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    for (const select of [selectExplainBinding, selectChatBinding, selectRugBinding]) {
      const binding = select(loaded.value);
      expect(binding.ok).toBe(true);
      if (!binding.ok) {
        return;
      }
      expect(binding.value).toEqual({ kind: "disabled" });
    }
    const calls: CapturedCall[] = [];
    const transport = fakeTransport(calls, "{}");
    const explainBuilt = createExplainServiceFromConfig(loaded.value, { explainTransport: transport });
    expect(explainBuilt.ok).toBe(true);
    if (explainBuilt.ok) {
      expect(explainBuilt.value).toBeUndefined();
    }
    const chatBuilt = createChatServiceFromConfig(loaded.value, { chatTransport: transport });
    expect(chatBuilt.ok).toBe(true);
    if (chatBuilt.ok) {
      expect(chatBuilt.value).toBeUndefined();
    }
    const rugBuilt = createRugServiceFromConfig(loaded.value, { rugTransport: transport });
    expect(rugBuilt.ok).toBe(true);
    if (rugBuilt.ok) {
      expect(rugBuilt.value).toBeUndefined();
    }
    expect(calls.length).toBe(0);
    expect(healthCapabilities({})).toMatchObject({
      explain: { disabled: true },
      chat: { disabled: true },
      rug: { disabled: true },
    });
  });

  test("off disables the overlays like an unset provider", () => {
    const loaded = loadConfig(
      overlayEnv("EXPLAIN", {
        BRANDKLIPPAREN_EXPLAIN_PROVIDER: "off",
        BRANDKLIPPAREN_CHAT_PROVIDER: "off",
        BRANDKLIPPAREN_RUG_PROVIDER: "off",
      }),
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    expect(loaded.value.explainProvider).toBeUndefined();
    const calls: CapturedCall[] = [];
    const transport = fakeTransport(calls, "{}");
    const explainBuilt = createExplainServiceFromConfig(loaded.value, { explainTransport: transport });
    expect(explainBuilt.ok).toBe(true);
    if (explainBuilt.ok) {
      expect(explainBuilt.value).toBeUndefined();
    }
    const chatBuilt = createChatServiceFromConfig(loaded.value, { chatTransport: transport });
    expect(chatBuilt.ok).toBe(true);
    if (chatBuilt.ok) {
      expect(chatBuilt.value).toBeUndefined();
    }
    const rugBuilt = createRugServiceFromConfig(loaded.value, { rugTransport: transport });
    expect(rugBuilt.ok).toBe(true);
    if (rugBuilt.ok) {
      expect(rugBuilt.value).toBeUndefined();
    }
    expect(calls.length).toBe(0);
  });

  test("an invalid provider value is a typed startup error naming the variable", () => {
    for (const [feature, variable] of [
      ["EXPLAIN", "BRANDKLIPPAREN_EXPLAIN_PROVIDER"],
      ["CHAT", "BRANDKLIPPAREN_CHAT_PROVIDER"],
      ["RUG", "BRANDKLIPPAREN_RUG_PROVIDER"],
    ] as const) {
      const loaded = loadConfig(overlayEnv(feature, { [`BRANDKLIPPAREN_${feature}_PROVIDER`]: "unknown" }));
      expect(loaded.ok).toBe(false);
      if (loaded.ok) {
        return;
      }
      expect(loaded.error.variable).toBe(variable);
    }
  });

  test("a selected provider without its key stays disabled with zero calls", () => {
    const loaded = loadConfig(
      overlayEnv("EXPLAIN", {
        BRANDKLIPPAREN_EXPLAIN_META_API_KEY: "",
        BRANDKLIPPAREN_CHAT_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_CHAT_META_BASE_URL: "",
        BRANDKLIPPAREN_RUG_PROVIDER: "meta-model-api",
      }),
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) {
      return;
    }
    const calls: CapturedCall[] = [];
    const transport = fakeTransport(calls, "{}");
    const explainBuilt = createExplainServiceFromConfig(loaded.value, { explainTransport: transport });
    expect(explainBuilt.ok).toBe(true);
    if (explainBuilt.ok) {
      expect(explainBuilt.value).toBeUndefined();
    }
    const chatBuilt = createChatServiceFromConfig(loaded.value, { chatTransport: transport });
    expect(chatBuilt.ok).toBe(true);
    if (chatBuilt.ok) {
      expect(chatBuilt.value).toBeUndefined();
    }
    const rugBuilt = createRugServiceFromConfig(loaded.value, { rugTransport: transport });
    expect(rugBuilt.ok).toBe(true);
    if (rugBuilt.ok) {
      expect(rugBuilt.value).toBeUndefined();
    }
    expect(calls.length).toBe(0);
  });
});

describe("overlay Meta answers", () => {
  test("a configured explain answers with provider and model in health", async () => {
    const config = loadOverlayEnv("EXPLAIN");
    const calls: CapturedCall[] = [];
    const built = createExplainServiceFromConfig(config, {
      explainTransport: fakeTransport(
        calls,
        chatEnvelope({
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          sentences: [{ text: "The analysis reports a capability.", citations: ["signal:first"] }],
        }),
      ),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) {
      return;
    }
    const service = built.value;
    expect(service !== undefined && service.enabled).toBe(true);
    if (service === undefined) {
      return;
    }
    // The model id defaults to muse-spark-1.3 when the connection carries
    // no explicit model id.
    expect(service.provider).toBe("meta-model-api");
    expect(service.modelId).toBe("muse-spark-1.3");
    expect(healthCapabilities({ explainService: service })).toMatchObject({
      explain: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
      chat: { disabled: true },
      rug: { disabled: true },
    });
    const outcome = await service.explain(explainInput());
    expect(calls.length).toBe(1);
    if (outcome.kind !== "ok") {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(outcome.narrative).toEqual(["The analysis reports a capability."]);
    expect(outcome.droppedClaims).toBe(0);
    expect(outcome.provider).toBe("meta-model-api");
    expect(outcome.modelId).toBe("muse-spark-1.3");
  });

  test("a configured chat answers the quoted question with citations checked", async () => {
    const config = loadOverlayEnv("CHAT");
    const calls: CapturedCall[] = [];
    const built = createChatServiceFromConfig(config, {
      chatTransport: fakeTransport(
        calls,
        chatEnvelope({
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          answers: [{ text: "The analysis reports a capability.", citations: ["signal:first"] }],
        }),
      ),
    });
    expect(built.ok && built.value !== undefined).toBe(true);
    if (!built.ok || built.value === undefined) {
      return;
    }
    const outcome = await built.value.chat(chatInput());
    expect(calls.length).toBe(1);
    if (outcome.kind !== "ok") {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(outcome.answers).toEqual(["The analysis reports a capability."]);
    expect(outcome.droppedClaims).toBe(0);
    expect(healthCapabilities({ chatService: built.value })).toMatchObject({
      chat: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
    });
  });

  test("a configured rug narrates the top risk and keeps the frozen top risk", async () => {
    const config = loadOverlayEnv("RUG");
    const calls: CapturedCall[] = [];
    const built = createRugServiceFromConfig(config, {
      rugTransport: fakeTransport(
        calls,
        chatEnvelope({
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          sentences: [{ text: "The top risk capability is present.", citations: ["signal:first"] }],
        }),
      ),
    });
    expect(built.ok && built.value !== undefined).toBe(true);
    if (!built.ok || built.value === undefined) {
      return;
    }
    const outcome = await built.value.narrate(rugInput());
    expect(calls.length).toBe(1);
    if (outcome.kind !== "ok") {
      throw new Error(`expected ok, got ${outcome.kind}`);
    }
    expect(outcome.narrative).toEqual(["The top risk capability is present."]);
    expect(outcome.topRisk).toBe("rug-pull");
    expect(healthCapabilities({ rugService: built.value })).toMatchObject({
      rug: { provider: "meta-model-api", modelId: "muse-spark-1.3" },
    });
  });

  test("the request carries the shared completion budget and reasoning effort", async () => {
    const config = loadOverlayEnv("EXPLAIN");
    const calls: CapturedCall[] = [];
    const built = createExplainServiceFromConfig(config, {
      explainTransport: fakeTransport(
        calls,
        chatEnvelope({ provider: "meta-model-api", modelId: "muse-spark-1.3", sentences: [] }),
      ),
    });
    if (!built.ok || built.value === undefined) {
      throw new Error("expected a configured explain service");
    }
    await built.value.explain(explainInput());
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["model"]).toBe("muse-spark-1.3");
    expect(body["max_tokens"]).toBe(8192);
    expect(body["reasoning_effort"]).toBe("low");
    expect(calls[0]?.url).toBe("https://meta.example.invalid/chat/completions");
  });

  test("malformed model output falls back to invalid-output, never a throw", async () => {
    const explainCalls: CapturedCall[] = [];
    const explain = createExplainServiceFromConfig(loadOverlayEnv("EXPLAIN"), {
      explainTransport: fakeTransport(explainCalls, "not json"),
    });
    if (!explain.ok || explain.value === undefined) {
      throw new Error("expected a configured explain service");
    }
    expect(await explain.value.explain(explainInput())).toEqual({ kind: "invalid-output" });

    const chatCalls: CapturedCall[] = [];
    const chat = createChatServiceFromConfig(loadOverlayEnv("CHAT"), {
      chatTransport: fakeTransport(
        chatCalls,
        chatEnvelope({ provider: "someone-else", modelId: "muse-spark-1.3", answers: [] }),
      ),
    });
    if (!chat.ok || chat.value === undefined) {
      throw new Error("expected a configured chat service");
    }
    expect(await chat.value.chat(chatInput())).toEqual({ kind: "invalid-output" });

    const rugCalls: CapturedCall[] = [];
    const rug = createRugServiceFromConfig(loadOverlayEnv("RUG"), {
      rugTransport: fakeTransport(rugCalls, chatEnvelope({ provider: "meta-model-api", modelId: "muse-spark-1.3" })),
    });
    if (!rug.ok || rug.value === undefined) {
      throw new Error("expected a configured rug service");
    }
    expect(await rug.value.narrate(rugInput())).toEqual({ kind: "invalid-output" });
  });
});

describe("demo overlay provider defaults (meta-model-api)", () => {
  const ASSESSMENT_KEY_FILE = "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE";

  test("an unset provider with the assessment Meta key file defaults to meta-model-api", () => {
    expect(DEMO_EXPLAIN_META_PROVIDER).toBe("meta-model-api");
    expect(DEMO_CHAT_META_PROVIDER).toBe("meta-model-api");
    expect(DEMO_RUG_META_PROVIDER).toBe("meta-model-api");
    const { env: explained, defaulted: explainApplied } = withDemoExplainDefault({
      [ASSESSMENT_KEY_FILE]: "secrets/meta-key.txt",
      BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "fake-meta-model-1",
      BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "https://meta.example.invalid",
    });
    expect(explainApplied).toBe(true);
    expect(explained["BRANDKLIPPAREN_EXPLAIN_PROVIDER"]).toBe("meta-model-api");
    expect(explained["BRANDKLIPPAREN_EXPLAIN_META_API_KEY_FILE"]).toBe("secrets/meta-key.txt");
    expect(explained["BRANDKLIPPAREN_EXPLAIN_META_MODEL_ID"]).toBe("fake-meta-model-1");
    expect(explained["BRANDKLIPPAREN_EXPLAIN_META_BASE_URL"]).toBe("https://meta.example.invalid");
    const { env: chatted, defaulted: chatApplied } = withDemoChatDefault({
      [ASSESSMENT_KEY_FILE]: "secrets/meta-key.txt",
    });
    expect(chatApplied).toBe(true);
    expect(chatted["BRANDKLIPPAREN_CHAT_PROVIDER"]).toBe("meta-model-api");
    expect(chatted["BRANDKLIPPAREN_CHAT_META_API_KEY_FILE"]).toBe("secrets/meta-key.txt");
    const { env: rugged, defaulted: rugApplied } = withDemoRugDefault({
      [ASSESSMENT_KEY_FILE]: "secrets/meta-key.txt",
    });
    expect(rugApplied).toBe(true);
    expect(rugged["BRANDKLIPPAREN_RUG_PROVIDER"]).toBe("meta-model-api");
    expect(rugged["BRANDKLIPPAREN_RUG_META_API_KEY_FILE"]).toBe("secrets/meta-key.txt");
  });

  test("an explicit overlay provider always wins", () => {
    for (const explicit of ["off", "meta-model-api"]) {
      const { env: kept, defaulted: applied } = withDemoExplainDefault({
        BRANDKLIPPAREN_EXPLAIN_PROVIDER: explicit,
        [ASSESSMENT_KEY_FILE]: "secrets/meta-key.txt",
      });
      expect(applied).toBe(false);
      expect(kept["BRANDKLIPPAREN_EXPLAIN_PROVIDER"]).toBe(explicit);
      expect(kept["BRANDKLIPPAREN_EXPLAIN_META_API_KEY_FILE"]).toBe(undefined);
    }
    const { env: kept } = withDemoChatDefault({
      [ASSESSMENT_KEY_FILE]: "secrets/assessment-key.txt",
      BRANDKLIPPAREN_CHAT_META_API_KEY_FILE: "secrets/chat-key.txt",
    });
    expect(kept["BRANDKLIPPAREN_CHAT_PROVIDER"]).toBe("meta-model-api");
    expect(kept["BRANDKLIPPAREN_CHAT_META_API_KEY_FILE"]).toBe("secrets/chat-key.txt");
  });

  test("no assessment Meta key file means no overlay default", () => {
    expect(withDemoExplainDefault({}).defaulted).toBe(false);
    expect(withDemoExplainDefault({})).toMatchObject({ env: {} });
    expect(withDemoChatDefault({}).defaulted).toBe(false);
    expect(withDemoRugDefault({}).defaulted).toBe(false);
    const directKeyOnly = withDemoExplainDefault({
      BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "fake-meta-key-for-tests-only",
    });
    expect(directKeyOnly.defaulted).toBe(false);
    expect(directKeyOnly.env["BRANDKLIPPAREN_EXPLAIN_PROVIDER"]).toBe(undefined);
  });

  test("status lines name the provider only with a loaded key", () => {
    expect(
      demoExplainStatus({
        BRANDKLIPPAREN_EXPLAIN_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_EXPLAIN_META_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_EXPLAIN_META_READY_LINE);
    expect(DEMO_EXPLAIN_META_READY_LINE).toBe("explain provider: meta-model-api (key loaded)");
    expect(demoExplainStatus({})).toBe(DEMO_EXPLAIN_OFF_LINE);
    expect(DEMO_EXPLAIN_OFF_LINE).toBe("explain: off");
    expect(demoExplainStatus({ BRANDKLIPPAREN_EXPLAIN_PROVIDER: "meta-model-api" })).toBe(DEMO_EXPLAIN_OFF_LINE);
    expect(
      demoChatStatus({
        BRANDKLIPPAREN_CHAT_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_CHAT_META_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_CHAT_META_READY_LINE);
    expect(DEMO_CHAT_META_READY_LINE).toBe("chat provider: meta-model-api (key loaded)");
    expect(demoChatStatus({})).toBe(DEMO_CHAT_OFF_LINE);
    expect(DEMO_CHAT_OFF_LINE).toBe("chat: off");
    expect(
      demoRugStatus({
        BRANDKLIPPAREN_RUG_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_RUG_META_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_RUG_META_READY_LINE);
    expect(DEMO_RUG_META_READY_LINE).toBe("rug provider: meta-model-api (key loaded)");
    expect(demoRugStatus({})).toBe(DEMO_RUG_OFF_LINE);
    expect(DEMO_RUG_OFF_LINE).toBe("rug: off");
  });
});

describe("overlay meanings and meta-statement guard", () => {
  const synthMeaning = {
    id: "signal:synth-owner",
    pluginId: "synth.owner",
    kind: "capability",
    severity: "high",
    direction: "can-change",
    meaning: "The owner can block sales.",
    temporality: "it can change",
    selectors: [{ selector: "0x12345678", name: null }],
  };

  function requestBody(call: CapturedCall): { system: string; user: Record<string, unknown> } {
    const body = JSON.parse(call.body) as Record<string, unknown>;
    const messages = body["messages"] as { role: string; content: string }[];
    return {
      system: messages[0]?.content ?? "",
      user: JSON.parse(messages[1]?.content ?? "{}") as Record<string, unknown>,
    };
  }

  test("explain prompt carries meanings and the non-expert instruction", async () => {
    const config = loadOverlayEnv("EXPLAIN");
    const calls: CapturedCall[] = [];
    const built = createExplainServiceFromConfig(config, {
      explainTransport: fakeTransport(
        calls,
        chatEnvelope({
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          sentences: [{ text: "The owner can block sales.", citations: ["signal:first"] }],
        }),
      ),
    });
    if (!built.ok || built.value === undefined) {
      throw new Error("expected a configured explain service");
    }
    const created = ExplainInput.create({
      codeHash: "code-hash-for-unit-suite",
      evidenceIds: ["signal:first"],
      promptVersion: "explain-2",
      meanings: [synthMeaning],
    });
    if (created === null) {
      throw new Error("expected valid explain input");
    }
    await built.value.explain(created);
    expect(calls.length).toBe(1);
    const { system, user } = requestBody(calls[0] as CapturedCall);
    expect(system).toContain("non-expert buyer");
    expect(system).toContain("NOT known");
    expect(system).toContain("not in score");
    expect(system).toContain("meta-statements");
    const meanings = user["meanings"] as Record<string, unknown>[];
    expect(meanings[0]).toMatchObject({
      id: "signal:synth-owner",
      pluginId: "synth.owner",
      kind: "capability",
      severity: "high",
      direction: "can-change",
    });
  });

  test("chat prompt carries meanings and the non-expert instruction", async () => {
    const config = loadOverlayEnv("CHAT");
    const calls: CapturedCall[] = [];
    const built = createChatServiceFromConfig(config, {
      chatTransport: fakeTransport(
        calls,
        chatEnvelope({
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          answers: [{ text: "The owner can block sales.", citations: ["signal:first"] }],
        }),
      ),
    });
    if (!built.ok || built.value === undefined) {
      throw new Error("expected a configured chat service");
    }
    const created = ChatInput.create({
      codeHash: "code-hash-for-unit-suite",
      evidenceIds: ["signal:first"],
      question: "What can the owner do to my tokens?",
      promptVersion: "chat-2",
      meanings: [synthMeaning],
    });
    if (created === null) {
      throw new Error("expected valid chat input");
    }
    await built.value.chat(created);
    expect(calls.length).toBe(1);
    const { system, user } = requestBody(calls[0] as CapturedCall);
    expect(system).toContain("non-expert buyer");
    expect(system).toContain("meta-statements");
    const meanings = user["meanings"] as Record<string, unknown>[];
    expect(meanings[0]).toMatchObject({ id: "signal:synth-owner" });
  });

  test("rug prompt carries meanings and the non-expert instruction", async () => {
    const config = loadOverlayEnv("RUG");
    const calls: CapturedCall[] = [];
    const built = createRugServiceFromConfig(config, {
      rugTransport: fakeTransport(
        calls,
        chatEnvelope({
          provider: "meta-model-api",
          modelId: "muse-spark-1.3",
          sentences: [{ text: "The owner can block sales.", citations: ["signal:first"] }],
        }),
      ),
    });
    if (!built.ok || built.value === undefined) {
      throw new Error("expected a configured rug service");
    }
    const created = RugInput.create({
      codeHash: "code-hash-for-unit-suite",
      evidenceIds: ["signal:first"],
      topRisk: "rug-pull",
      promptVersion: "rug-2",
      meanings: [synthMeaning],
    });
    if (created === null) {
      throw new Error("expected valid rug input");
    }
    await built.value.narrate(created);
    expect(calls.length).toBe(1);
    const { system, user } = requestBody(calls[0] as CapturedCall);
    expect(system).toContain("non-expert buyer");
    expect(system).toContain("meta-statements");
    const meanings = user["meanings"] as Record<string, unknown>[];
    expect(meanings[0]).toMatchObject({ id: "signal:synth-owner" });
  });

  test("meta-statement sentences drop and count into droppedClaims", async () => {
    const { checkExplainCitations } = await import("../../../src/application/explainService.ts");
    const { checkChatCitations } = await import("../../../src/application/chatService.ts");
    const { checkRugCitations } = await import("../../../src/application/rugService.ts");
    const meta = "This statement is grounded in the frozen evidence signals listed.";
    const ids = new Set(["signal:first"]);
    const explained = checkExplainCitations(
      [
        { text: meta, citations: ["signal:first"] },
        { text: "The owner can block sales.", citations: ["signal:first"] },
      ],
      ids,
    );
    expect(explained.narrative).toEqual(["The owner can block sales."]);
    expect(explained.droppedClaims).toBe(1);
    const chatted = checkChatCitations(
      [
        { text: meta, citations: ["signal:first"] },
        { text: "The owner can block sales.", citations: ["signal:first"] },
      ],
      ids,
    );
    expect(chatted.answers).toEqual(["The owner can block sales."]);
    expect(chatted.droppedClaims).toBe(1);
    const rugged = checkRugCitations(
      [
        { text: meta, citations: ["signal:first"] },
        { text: "The owner can block sales.", citations: ["signal:first"] },
      ],
      ids,
    );
    expect(rugged.narrative).toEqual(["The owner can block sales."]);
    expect(rugged.droppedClaims).toBe(1);
  });
});
