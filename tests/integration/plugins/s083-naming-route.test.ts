// S-083 suggested-names route (K-038, D-11). POST /v1/naming answers the
// display-only overlay envelope: `ok` with validated names from the wired
// port, `not-configured` without one, `invalid-output` for unparsable
// model output, and a 400 validation error for malformed selectors. The
// route runs no analysis: scores, evidence and emitted structure are
// untouched. Written against the new route; the fake adapter keeps every
// call offline.
import { describe, expect, test } from "vitest";
import {
  Address,
  BlockNumber,
  IndexVersion,
  ModelVersion,
  TemplateVersion,
  Timestamp,
} from "../../../src/domain/types.ts";
import type { Result } from "../../../src/domain/result.ts";
import type { CapabilityCatalogue } from "../../../src/domain/signals.ts";
import { createAppServices } from "../../../src/application/analyzeToken.ts";
import type { AppServices } from "../../../src/application/analyzeToken.ts";
import { createDecompilerNamingService } from "../../../src/application/decompilerNaming.ts";
import { SecretString } from "../../../src/ports/config.ts";
import { mustDefaultDetectorSet } from "../../helpers/detectorSets.ts";
import { FakeClockAdapter } from "../../fakes/fakeClock.ts";
import { FakeDecompilerNamingAdapter } from "../../fakes/fakeDecompilerNaming.ts";
import { FakeModelArtifactAdapter } from "../../fakes/fakeModelArtifact.ts";
import { FakeRpcAdapter } from "../../fakes/fakeRpc.ts";
import { parseModelArtifact } from "../../../src/domain/risk.ts";
import { ArtifactChecksum } from "../../../src/domain/types.ts";
import { createRestServer } from "../../../src/interfaces/rest/server.ts";

function mustOk<T, E extends { message: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected ok, got error: ${result.error.message}`);
  }
  return result.value;
}

const TEST_CATALOGUE: CapabilityCatalogue = Object.freeze({
  selfdestruct: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  delegatecall: Object.freeze({ risk: "rug-pull", direction: "raises", severity: "high" }),
  call: Object.freeze({ risk: "honeypot", direction: "raises", severity: "medium" }),
  "storage-write": Object.freeze({ risk: "bot-pump", direction: "raises", severity: "low" }),
});

const TEST_ADDRESS = "0x0102030405060708090a0b0c0d0e0f1011121314";
const TEST_BYTECODE = `0x8063a9059cbb14600a57${"00".repeat(10)}ff`;
const TEST_BLOCK = 18000000;
const TEST_KEY = "test-key-for-naming-route-only";
const TEST_PEPPER = "test-pepper-for-naming-route-only";

function placeholderArtifacts(): FakeModelArtifactAdapter {
  const artifact = mustOk(
    parseModelArtifact({
      version: "0.1.0",
      severityWeights: { low: 0.2, medium: 0.5, high: 1.0 },
      causeWeights: { timeout: 0.4, "resource-limit": 0.4, "decompiler-error": 0.6, "obfuscated-structure": 0.6 },
      biases: { "rug-pull": 0.0, honeypot: 0.0, "bot-pump": 0.0 },
      calibration: {
        "rug-pull": { slope: 1.0, intercept: 0.0 },
        honeypot: { slope: 1.0, intercept: 0.0 },
        "bot-pump": { slope: 1.0, intercept: 0.0 },
      },
      scoreWeights: { "rug-pull": 1.0, honeypot: 1.0, "bot-pump": 1.0 },
    }),
  );
  return new FakeModelArtifactAdapter(
    Object.freeze({ artifact, checksum: mustOk(ArtifactChecksum.parse("cd".repeat(32))) }),
  );
}

function testServices(): AppServices {
  const codes = new Map<string, string>([[mustOk(Address.parse(TEST_ADDRESS)) as string, TEST_BYTECODE]]);
  return createAppServices(
    {
      rpc: new FakeRpcAdapter(codes, mustOk(BlockNumber.of(TEST_BLOCK))),
      modelArtifacts: placeholderArtifacts(),
      clock: new FakeClockAdapter(mustOk(Timestamp.of(1700000000000))),
    },
    mustDefaultDetectorSet(),
  );
}

function baseOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    services: testServices(),
    apiKeys: [new SecretString(TEST_KEY)] as readonly SecretString[],
    apiKeyPepper: new SecretString(TEST_PEPPER),
    modelVersion: mustOk(ModelVersion.parse("0.1.0")),
    indexVersion: mustOk(IndexVersion.parse("1.0.0")),
    templateVersion: mustOk(TemplateVersion.parse("1.0.0")),
    catalogue: TEST_CATALOGUE,
    detectors: mustDefaultDetectorSet(),
    ...extra,
  };
}

async function postNaming(
  base: string,
  body: Record<string, unknown>,
  key: string | null = TEST_KEY,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) {
    headers["x-api-key"] = key;
  }
  const response = await fetch(`${base}/v1/naming`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as unknown };
}

describe("POST /v1/naming suggested-names route", () => {
  test("a wired fake answers the ok envelope with validated names", async () => {
    const fake = new FakeDecompilerNamingAdapter("ok", new Map([["0xa9059cbb", "transferTokens"]]));
    const rest = createRestServer(
      baseOptions({ namingService: createDecompilerNamingService(fake) }) as never,
    );
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status, json } = await postNaming(base, { selectors: ["0xa9059cbb"] });
      expect(status).toBe(200);
      const body = json as { naming?: { kind?: unknown; names?: { selector?: unknown; suggestedName?: unknown }[] } };
      expect(body.naming?.kind).toBe("ok");
      expect(body.naming?.names).toEqual([{ selector: "0xa9059cbb", suggestedName: "transferTokens" }]);
      expect(fake.calls.length).toBe(1);
    } finally {
      await rest.close();
    }
  });

  test("a missing service answers not-configured with no analysis", async () => {
    const rest = createRestServer(baseOptions() as never);
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status, json } = await postNaming(base, { selectors: ["0xa9059cbb"] });
      expect(status).toBe(200);
      expect((json as { naming?: { kind?: unknown } }).naming?.kind).toBe("not-configured");
    } finally {
      await rest.close();
    }
  });

  test("an invalid-output port answers invalid-output, and malformed selectors fail validation", async () => {
    const fake = new FakeDecompilerNamingAdapter("invalid-output");
    const rest = createRestServer(
      baseOptions({ namingService: createDecompilerNamingService(fake) }) as never,
    );
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const invalid = await postNaming(base, { selectors: ["0xa9059cbb"] });
      expect(invalid.status).toBe(200);
      expect((invalid.json as { naming?: { kind?: unknown } }).naming?.kind).toBe("invalid-output");

      const malformed = await postNaming(base, { selectors: ["nope"] });
      expect(malformed.status).toBe(400);
    } finally {
      await rest.close();
    }
  });

  test("a missing key is rejected before any naming call", async () => {
    const fake = new FakeDecompilerNamingAdapter("ok", new Map());
    const rest = createRestServer(
      baseOptions({ namingService: createDecompilerNamingService(fake) }) as never,
    );
    const base = await rest.listen("127.0.0.1", 0);
    try {
      const { status } = await postNaming(base, { selectors: ["0xa9059cbb"] }, null);
      expect(status).toBe(401);
      expect(fake.calls.length).toBe(0);
    } finally {
      await rest.close();
    }
  });
});
