// Unit tests for the REST API key store (S-027, K-510, M-10).
// Written first per A-21 (red): src/interfaces/rest/apiKeys.ts does not
// exist yet. Keys arrive as SecretString values from the validated config;
// the store keeps solely salted hashes and compares in constant time.
import { describe, expect, test } from "vitest";
import { SecretString } from "../../../../src/ports/config.ts";
import { loadConfig } from "../../../../src/adapters/config/loader.ts";
import { createApiKeyStore } from "../../../../src/interfaces/rest/apiKeys.ts";

const PEPPER = new SecretString("test-pepper-for-unit-suite-only");

describe("REST API key store (K-510)", () => {
  test("k510_valid_key_accepted_unknown_key_rejected", () => {
    const store = createApiKeyStore({
      keys: [new SecretString("alpha-test-key"), new SecretString("beta-test-key")],
      pepper: PEPPER,
    });
    expect(store.verify("alpha-test-key")).toBe(true);
    expect(store.verify("beta-test-key")).toBe(true);
    expect(store.verify("gamma-test-key")).toBe(false);
    expect(store.verify("")).toBe(false);
  });

  test("k510_store_keeps_hashes_never_raw_keys", () => {
    const raw = "raw-key-that-must-never-persist";
    const store = createApiKeyStore({ keys: [new SecretString(raw)], pepper: PEPPER });
    const dumped = JSON.stringify(store);
    expect(dumped).not.toContain(raw);
    expect(dumped).not.toContain("test-pepper-for-unit-suite-only");
  });

  test("k510_key_lookup_returns_stable_non_secret_id", () => {
    const store = createApiKeyStore({ keys: [new SecretString("alpha-test-key")], pepper: PEPPER });
    const first = store.keyId("alpha-test-key");
    expect(first).not.toBeNull();
    expect(store.keyId("alpha-test-key")).toBe(first);
    expect(store.keyId("unknown-key")).toBeNull();
    expect(String(first)).not.toContain("alpha-test-key");
  });

  test("k510_keys_read_from_config_as_secrets", () => {
    const loaded = loadConfig({
      BRANDKLIPPAREN_ENV: "ci",
      BRANDKLIPPAREN_MODEL_VERSION: "0.1.0",
      BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-0.1.0.json",
      BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
      BRANDKLIPPAREN_LOG_LEVEL: "info",
      BRANDKLIPPAREN_API_KEYS: "first-test-key,second-test-key",
    });
    if (!loaded.ok) {
      throw new Error("expected valid config");
    }
    const keys = loaded.value.apiKeys ?? [];
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toBeInstanceOf(SecretString);
      expect(JSON.stringify(key)).not.toContain(key.reveal());
    }
  });
});
