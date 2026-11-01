// Unit test for the `npm run demo` pure helpers in scripts/demo.ts:
// default resolution (user env wins), `.env.local` parsing and
// precedence, secret file indirection, the generated per-run API key,
// Node version check and extdecomp discovery order with a mocked
// filesystem. Never starts real servers. All values are fakes.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/adapters/config/loader.ts";
import {
  applyEnvLocal,
  buildNode22LoopMessage,
  buildNode22MissingMessage,
  checkNodeVersion,
  decideNode22Startup,
  DEMO_ASSESSMENT_hosted_READY_LINE,
  DEMO_ASSESSMENT_META_PROVIDER,
  DEMO_ASSESSMENT_META_READY_LINE,
  DEMO_ASSESSMENT_OFF_LINE,
  DEMO_ASSESSMENT_generic_COMPATIBLE_READY_LINE,
  DEMO_DEFAULTS,
  DEMO_DEFAULT_RPC_URL,
  DEMO_INVESTIGATE_hosted_READY_LINE,
  DEMO_INVESTIGATE_META_PROVIDER,
  DEMO_INVESTIGATE_META_READY_LINE,
  DEMO_INVESTIGATE_OFF_LINE,
  DEMO_LP_FEED_OFF_LINE,
  DEMO_LP_FEED_READY_LINE,
  DEMO_MARKET_OFF_LINE,
  DEMO_MARKET_PROVIDER,
  DEMO_MARKET_READY_LINE,
  DEMO_SOURCE_OFF_LINE,
  DEMO_SOURCE_PROVIDER,
  DEMO_SOURCE_READY_LINE,
  DEMO_PERSONALIZE_META_PROVIDER,
  DEMO_REEXEC_MARKER,
  demoAssessmentStatus,
  demoInvestigateStatus,
  demoLpFeedStatus,
  demoMarketStatus,
  demoSourceStatus,
  discoverextdecompBinary,
  displayPathWithHome,
  ensureDemoApiKey,
  findNode22Binary,
  isNode22Version,
  maskKeyPreview,
  node22Candidates,
  parseEnvLocal,
  readEnvLocalFile,
  resolveSecretFileVars,
  withDemoAssessmentDefault,
  withDemoDefaults,
  withDemoInvestigateDefault,
  withDemoMarketDefault,
  withDemoPersonalizeDefault,
  withDemoSourceDefault,
} from "../../scripts/demo.ts";

function existing(paths: readonly string[]): (path: string) => boolean {
  const found = new Set(paths);
  return (path: string): boolean => found.has(path);
}

describe("demo defaults (npm run demo)", () => {
  test("fills every default where the environment is silent", () => {
    const { env, applied } = withDemoDefaults({});
    for (const [name, value] of Object.entries(DEMO_DEFAULTS)) {
      expect(env[name]).toBe(value);
    }
    expect(applied.length).toBe(Object.keys(DEMO_DEFAULTS).length);
  });

  test("the user environment wins over every default", () => {
    const { env, applied } = withDemoDefaults({
      BRANDKLIPPAREN_ENV: "ci",
      BRANDKLIPPAREN_HTTP_PORT: "9090",
      BRANDKLIPPAREN_RPC_URLS: "https://custom.example.invalid",
      BRANDKLIPPAREN_LOG_LEVEL: "debug",
    });
    expect(env["BRANDKLIPPAREN_ENV"]).toBe("ci");
    expect(env["BRANDKLIPPAREN_HTTP_PORT"]).toBe("9090");
    expect(env["BRANDKLIPPAREN_RPC_URLS"]).toBe("https://custom.example.invalid");
    expect(env["BRANDKLIPPAREN_LOG_LEVEL"]).toBe("debug");
    expect(applied.includes("BRANDKLIPPAREN_ENV")).toBe(false);
    expect(applied.includes("BRANDKLIPPAREN_HTTP_PORT")).toBe(false);
    expect(applied.includes("BRANDKLIPPAREN_RPC_URLS")).toBe(false);
    expect(applied.includes("BRANDKLIPPAREN_LOG_LEVEL")).toBe(false);
  });

  test("an empty value counts as unset", () => {
    const { env, applied } = withDemoDefaults({ BRANDKLIPPAREN_LOG_LEVEL: "" });
    expect(env["BRANDKLIPPAREN_LOG_LEVEL"]).toBe(DEMO_DEFAULTS["BRANDKLIPPAREN_LOG_LEVEL"]);
    expect(applied.includes("BRANDKLIPPAREN_LOG_LEVEL")).toBe(true);
  });

  test("defaulted local environment passes config validation", () => {
    const { env } = withDemoDefaults({});
    const loaded = loadConfig(env);
    expect(loaded.ok).toBe(true);
  });

  test("a user RPC override still passes config validation", () => {
    const { env } = withDemoDefaults({ BRANDKLIPPAREN_RPC_URLS: "https://custom.example.invalid" });
    expect(loadConfig(env).ok).toBe(true);
  });

  test("no keys and no model-assisted features by default", () => {
    for (const name of Object.keys(DEMO_DEFAULTS)) {
      expect(name.includes("API_KEY")).toBe(false);
      expect(name.includes("SECRET")).toBe(false);
      expect(name.includes("PEPPER")).toBe(false);
      expect(name.startsWith("BRANDKLIPPAREN_ASSESSMENT_")).toBe(false);
      expect(name.startsWith("BRANDKLIPPAREN_INVESTIGATE_")).toBe(false);
      // The key-free public RPC fallback for the live list is the only feed default.
      expect(name.startsWith("BRANDKLIPPAREN_FEED_") && name !== "BRANDKLIPPAREN_FEED_RPC_URL").toBe(false);
      expect(name).not.toBe("BK_WETH_ADDRESS");
      expect(name).not.toBe("ETHERSCAN_API_KEY");
    }
    const { env } = withDemoDefaults({});
    expect(env["BRANDKLIPPAREN_ASSESSMENT_PROVIDER"]).toBe(undefined);
    expect(env["BRANDKLIPPAREN_API_KEYS"]).toBe(undefined);
  });

  test("defaults carry the documented model artifact and key-free RPC", () => {
    expect(DEMO_DEFAULTS["BRANDKLIPPAREN_MODEL_VERSION"]).toBe("1.0.1");
    expect(DEMO_DEFAULTS["BRANDKLIPPAREN_MODEL_ARTIFACT_PATH"]).toBe("model/artifact-1.0.1.json");
    expect(DEMO_DEFAULT_RPC_URL).toBe("https://ethereum-rpc.publicnode.com");
    expect(DEMO_DEFAULTS["BRANDKLIPPAREN_RPC_URLS"]).toBe(DEMO_DEFAULT_RPC_URL);
  });

  test("defaults enable the key-free RPC fallback for the live token feed", () => {
    expect(DEMO_DEFAULTS["BRANDKLIPPAREN_FEED_RPC_URL"]).toBe(DEMO_DEFAULT_RPC_URL);
  });

  test("no absolute home directory in tracked defaults", () => {
    const homePrefix = `/${"Users"}/`;
    for (const value of Object.values(DEMO_DEFAULTS)) {
      expect(value.includes(homePrefix)).toBe(false);
    }
  });
});

describe("demo Node version check", () => {
  test("accepts Node 22.x", () => {
    expect(checkNodeVersion("22.0.0").ok).toBe(true);
    expect(checkNodeVersion("22.23.4").ok).toBe(true);
  });

  test("rejects other majors with the portable hint", () => {
    for (const version of ["20.10.0", "21.7.1", "23.0.0", "18.0.0"]) {
      const checked = checkNodeVersion(version);
      expect(checked.ok).toBe(false);
      if (!checked.ok) {
        expect(checked.message).toContain(version);
        expect(checked.message).toContain('PATH="$HOME/.local/node22/bin:$PATH" npm run demo');
        expect(checked.message.includes(`/${"Users"}/`)).toBe(false);
      }
    }
  });
});

describe("demo .env.local parsing", () => {
  test("parses KEY=VALUE lines with comments and quotes", () => {
    const parsed = parseEnvLocal(
      [
        "# a comment line",
        "",
        "BRANDKLIPPAREN_LOG_LEVEL=debug",
        "BRANDKLIPPAREN_CACHE_DIR=\"cache/local dir\"",
        "BRANDKLIPPAREN_ENV='local'",
        "   # indented comment",
        "NOT A PAIR",
        "1BAD=value",
        "=noname",
      ].join("\n"),
    );
    expect(parsed["BRANDKLIPPAREN_LOG_LEVEL"]).toBe("debug");
    expect(parsed["BRANDKLIPPAREN_CACHE_DIR"]).toBe("cache/local dir");
    expect(parsed["BRANDKLIPPAREN_ENV"]).toBe("local");
    expect(parsed["NOT A PAIR"]).toBe(undefined);
    expect(parsed["1BAD"]).toBe(undefined);
    expect(Object.keys(parsed).length).toBe(3);
  });

  test("keeps equals signs and inline hashes inside values", () => {
    const parsed = parseEnvLocal("BRANDKLIPPAREN_RPC_URLS=https://fake.example.invalid?a=b#c\n");
    expect(parsed["BRANDKLIPPAREN_RPC_URLS"]).toBe("https://fake.example.invalid?a=b#c");
  });

  test("later lines win on repeats", () => {
    const parsed = parseEnvLocal("BRANDKLIPPAREN_LOG_LEVEL=info\nBRANDKLIPPAREN_LOG_LEVEL=debug\n");
    expect(parsed["BRANDKLIPPAREN_LOG_LEVEL"]).toBe("debug");
  });

  test("reads a temp .env.local file with fake values only", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-env-local-"));
    writeFileSync(
      join(dir, ".env.local"),
      "# fake local overrides for tests only\nBRANDKLIPPAREN_LOG_LEVEL=debug\n",
      "utf8",
    );
    const parsed = readEnvLocalFile(dir, {
      existsSync: (path) => {
        try {
          readFileSync(path);
          return true;
        } catch {
          return false;
        }
      },
      readFileSync: (path) => readFileSync(path, "utf8"),
    });
    expect(parsed["BRANDKLIPPAREN_LOG_LEVEL"]).toBe("debug");
  });

  test("an absent .env.local reads as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-env-local-"));
    expect(readEnvLocalFile(dir, { existsSync: () => false, readFileSync: () => "" })).toEqual({});
  });
});

describe("demo .env.local precedence", () => {
  test("the user environment wins over .env.local, which wins over defaults", () => {
    const { env } = applyEnvLocal(
      { BRANDKLIPPAREN_LOG_LEVEL: "warn", BRANDKLIPPAREN_ENV: undefined },
      { BRANDKLIPPAREN_LOG_LEVEL: "debug", BRANDKLIPPAREN_ENV: "local" },
    );
    expect(env["BRANDKLIPPAREN_LOG_LEVEL"]).toBe("warn");
    expect(env["BRANDKLIPPAREN_ENV"]).toBe("local");
  });

  test("an empty user value counts as unset", () => {
    const { env, applied } = applyEnvLocal(
      { BRANDKLIPPAREN_LOG_LEVEL: "" },
      { BRANDKLIPPAREN_LOG_LEVEL: "debug" },
    );
    expect(env["BRANDKLIPPAREN_LOG_LEVEL"]).toBe("debug");
    expect(applied).toEqual(["BRANDKLIPPAREN_LOG_LEVEL"]);
  });

  test("end to end: temp file values fill defaults but never beat the user env", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-env-local-"));
    writeFileSync(
      join(dir, ".env.local"),
      "BRANDKLIPPAREN_LOG_LEVEL=debug\nBRANDKLIPPAREN_HTTP_PORT=9090\n",
      "utf8",
    );
    const parsed = readEnvLocalFile(dir, {
      existsSync: () => true,
      readFileSync: (path) => readFileSync(path, "utf8"),
    });
    const { env: withLocal } = applyEnvLocal({ BRANDKLIPPAREN_HTTP_PORT: "7070" }, parsed);
    const { env } = withDemoDefaults(withLocal);
    expect(env["BRANDKLIPPAREN_LOG_LEVEL"]).toBe("debug");
    expect(env["BRANDKLIPPAREN_HTTP_PORT"]).toBe("7070");
    expect(loadConfig(env).ok).toBe(true);
  });
});

describe("demo secret file indirection", () => {
  const KEY = "BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY";

  function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "demo-secret-file-"));
    mkdirSync(join(dir, "secrets"), { recursive: true });
    return dir;
  }

  test("reads a relative pointer file and trims it", () => {
    const dir = tempRoot();
    writeFileSync(join(dir, "secrets", "fake-key.txt"), "  fake-local-key-for-tests-only\n", "utf8");
    const { env, loaded, failed } = resolveSecretFileVars(
      { [`${KEY}_FILE`]: join("secrets", "fake-key.txt") },
      dir,
      (path) => readFileSync(path, "utf8"),
    );
    expect(env[KEY]).toBe("fake-local-key-for-tests-only");
    expect(loaded).toEqual([KEY]);
    expect(failed).toEqual([]);
  });

  test("a configured key wins over its pointer file", () => {
    let reads = 0;
    const { env, loaded } = resolveSecretFileVars(
      { [KEY]: "fake-direct-key-for-tests-only", [`${KEY}_FILE`]: "secrets/fake-key.txt" },
      tempRoot(),
      () => {
        reads += 1;
        return "fake-file-key-for-tests-only";
      },
    );
    expect(env[KEY]).toBe("fake-direct-key-for-tests-only");
    expect(loaded).toEqual([]);
    expect(reads).toBe(0);
  });

  test("a missing or empty file leaves the target unset with a name-only failure", () => {
    const missing = resolveSecretFileVars(
      { [`${KEY}_FILE`]: "secrets/absent.txt" },
      tempRoot(),
      () => {
        throw new Error("no such file");
      },
    );
    expect(missing.env[KEY]).toBe(undefined);
    expect(missing.loaded).toEqual([]);
    expect(missing.failed).toEqual([KEY]);
    const dir = tempRoot();
    writeFileSync(join(dir, "secrets", "blank.txt"), "  \n", "utf8");
    const blank = resolveSecretFileVars(
      { [`${KEY}_FILE`]: join("secrets", "blank.txt") },
      dir,
      (path) => readFileSync(path, "utf8"),
    );
    expect(blank.env[KEY]).toBe(undefined);
    expect(blank.failed).toEqual([KEY]);
  });
});

describe("demo per-run local API key", () => {
  test("generates a key when none is configured", () => {
    const first = ensureDemoApiKey({}, () => "fake-generated-key-1");
    const second = ensureDemoApiKey({}, () => "fake-generated-key-2");
    expect(first.generated).toBe(true);
    expect(first.env["BRANDKLIPPAREN_API_KEYS"]).toBe("fake-generated-key-1");
    expect(first.webKey).toBe("fake-generated-key-1");
    expect(second.env["BRANDKLIPPAREN_API_KEYS"]).toBe("fake-generated-key-2");
  });

  test("keeps a configured key and hands its first entry to the UI", () => {
    const kept = ensureDemoApiKey({ BRANDKLIPPAREN_API_KEYS: "fake-key-a, fake-key-b" }, () => {
      throw new Error("must not generate when configured");
    });
    expect(kept.generated).toBe(false);
    expect(kept.env["BRANDKLIPPAREN_API_KEYS"]).toBe("fake-key-a, fake-key-b");
    expect(kept.webKey).toBe("fake-key-a");
    expect(kept.preview).toBe("");
  });

  test("the masked preview never carries the full key", () => {
    const key = "fake-generated-key-for-tests-only";
    const preview = maskKeyPreview(key);
    expect(preview.length).toBeLessThan(key.length);
    expect(key.startsWith(preview.slice(0, 4))).toBe(true);
    expect(preview.includes(key)).toBe(false);
    expect(key.includes(preview)).toBe(false);
  });

  test("a generated key passes config validation", () => {
    const { env } = withDemoDefaults({});
    const keyed = ensureDemoApiKey(env, () => "fake-generated-key-for-tests-only");
    expect(loadConfig(keyed.env).ok).toBe(true);
  });
});

describe("demo assessment status line", () => {
  test("reports the selected provider line truthfully with provider and key", () => {
    expect(
      demoAssessmentStatus({
        BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_ASSESSMENT_META_READY_LINE);
    expect(DEMO_ASSESSMENT_META_READY_LINE).toBe("assessment provider: meta-model-api (key loaded)");
    expect(
      demoAssessmentStatus({
        BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "hosted-open-weights",
        BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_ASSESSMENT_hosted_READY_LINE);
    expect(DEMO_ASSESSMENT_hosted_READY_LINE).toBe(
      "assessment provider: hosted-open-weights (key loaded)",
    );
    expect(
      demoAssessmentStatus({
        BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "generic-compatible",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_ASSESSMENT_generic_COMPATIBLE_READY_LINE);
    expect(DEMO_ASSESSMENT_generic_COMPATIBLE_READY_LINE).toBe(
      "assessment provider: generic-compatible (key loaded)",
    );
  });

  test("reports off without a provider, without a key, or on a key mismatch", () => {
    expect(demoAssessmentStatus({})).toBe(DEMO_ASSESSMENT_OFF_LINE);
    expect(DEMO_ASSESSMENT_OFF_LINE).toBe("assessment: off");
    expect(
      demoAssessmentStatus({ BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "meta-model-api" }),
    ).toBe(DEMO_ASSESSMENT_OFF_LINE);
    expect(
      demoAssessmentStatus({
        BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_ASSESSMENT_OFF_LINE);
    expect(
      demoAssessmentStatus({
        BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_ASSESSMENT_OFF_LINE);
  });
});

describe("demo assessment provider default (meta-model-api)", () => {
  const META_KEY = "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY";
  const META_KEY_FILE = "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE";
  const PROVIDER = "BRANDKLIPPAREN_ASSESSMENT_PROVIDER";
  const FAKE_KEY = "fake-meta-key-for-tests-only";

  test("an unset provider with a configured Meta key defaults to meta-model-api", () => {
    expect(DEMO_ASSESSMENT_META_PROVIDER).toBe("meta-model-api");
    for (const env of [{ [META_KEY]: FAKE_KEY }, { [META_KEY_FILE]: "secrets/meta-key.txt" }]) {
      const { env: defaulted, defaulted: applied } = withDemoAssessmentDefault(env);
      expect(applied).toBe(true);
      expect(defaulted[PROVIDER]).toBe("meta-model-api");
    }
    const { env: emptyDefaulted } = withDemoAssessmentDefault({ [PROVIDER]: "", [META_KEY]: FAKE_KEY });
    expect(emptyDefaulted[PROVIDER]).toBe("meta-model-api");
  });

  test("an explicit provider value always wins over the Meta key", () => {
    for (const explicit of ["off", "generic-compatible", "meta-model-api", "hosted-open-weights"]) {
      const { env: kept, defaulted: applied } = withDemoAssessmentDefault({
        [PROVIDER]: explicit,
        [META_KEY]: FAKE_KEY,
        [META_KEY_FILE]: "secrets/meta-key.txt",
      });
      expect(applied).toBe(false);
      expect(kept[PROVIDER]).toBe(explicit);
    }
  });

  test("no Meta key means no assessment default", () => {
    const { env: kept, defaulted: applied } = withDemoAssessmentDefault({});
    expect(applied).toBe(false);
    expect(kept[PROVIDER]).toBe(undefined);
    const blank = withDemoAssessmentDefault({ [META_KEY]: "", [META_KEY_FILE]: "" });
    expect(blank.defaulted).toBe(false);
    expect(blank.env[PROVIDER]).toBe(undefined);
  });

  test("a defaulted provider passes config validation with the Meta triple", () => {
    const { env } = withDemoDefaults({
      BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: FAKE_KEY,
      BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "fake-meta-model-1",
      BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "https://meta.example.invalid",
    });
    const { env: defaulted } = withDemoAssessmentDefault(env);
    expect(defaulted[PROVIDER]).toBe("meta-model-api");
    expect(loadConfig(defaulted).ok).toBe(true);
  });
});

describe("demo investigate status line", () => {
  test("reports the selected provider line truthfully with provider and key", () => {
    expect(
      demoInvestigateStatus({
        BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_INVESTIGATE_META_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_INVESTIGATE_META_READY_LINE);
    expect(DEMO_INVESTIGATE_META_READY_LINE).toBe("investigate provider: meta-model-api (key loaded)");
    expect(
      demoInvestigateStatus({
        BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "hosted-open-weights",
        BRANDKLIPPAREN_INVESTIGATE_hosted_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_INVESTIGATE_hosted_READY_LINE);
  });

  test("reports off without a provider, without a key, or on a key mismatch", () => {
    expect(demoInvestigateStatus({})).toBe(DEMO_INVESTIGATE_OFF_LINE);
    expect(DEMO_INVESTIGATE_OFF_LINE).toBe("investigate: off");
    expect(
      demoInvestigateStatus({ BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "meta-model-api" }),
    ).toBe(DEMO_INVESTIGATE_OFF_LINE);
    expect(
      demoInvestigateStatus({
        BRANDKLIPPAREN_INVESTIGATE_META_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_INVESTIGATE_OFF_LINE);
    expect(
      demoInvestigateStatus({
        BRANDKLIPPAREN_INVESTIGATE_PROVIDER: "meta-model-api",
        BRANDKLIPPAREN_INVESTIGATE_hosted_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_INVESTIGATE_OFF_LINE);
  });
});

describe("demo investigate provider default (meta-model-api)", () => {
  const ASSESSMENT_KEY_FILE = "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE";
  const PROVIDER = "BRANDKLIPPAREN_INVESTIGATE_PROVIDER";
  const META_KEY_FILE = "BRANDKLIPPAREN_INVESTIGATE_META_API_KEY_FILE";
  const META_MODEL_ID = "BRANDKLIPPAREN_INVESTIGATE_META_MODEL_ID";
  const META_BASE_URL = "BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL";

  test("an unset provider with the assessment Meta key file defaults to meta-model-api", () => {
    expect(DEMO_INVESTIGATE_META_PROVIDER).toBe("meta-model-api");
    const { env: defaulted, defaulted: applied } = withDemoInvestigateDefault({
      [ASSESSMENT_KEY_FILE]: "secrets/meta-key.txt",
      BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "fake-meta-model-1",
      BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "https://meta.example.invalid",
    });
    expect(applied).toBe(true);
    expect(defaulted[PROVIDER]).toBe("meta-model-api");
    expect(defaulted[META_KEY_FILE]).toBe("secrets/meta-key.txt");
    expect(defaulted[META_MODEL_ID]).toBe("fake-meta-model-1");
    expect(defaulted[META_BASE_URL]).toBe("https://meta.example.invalid");
  });

  test("an explicit investigate provider or pointer always wins", () => {
    for (const explicit of ["off", "hosted-open-weights", "meta-model-api"]) {
      const { env: kept, defaulted: applied } = withDemoInvestigateDefault({
        [PROVIDER]: explicit,
        [ASSESSMENT_KEY_FILE]: "secrets/meta-key.txt",
      });
      expect(applied).toBe(false);
      expect(kept[PROVIDER]).toBe(explicit);
      expect(kept[META_KEY_FILE]).toBe(undefined);
    }
    const { env: kept } = withDemoInvestigateDefault({
      [ASSESSMENT_KEY_FILE]: "secrets/assessment-key.txt",
      [META_KEY_FILE]: "secrets/investigate-key.txt",
    });
    expect(kept[PROVIDER]).toBe("meta-model-api");
    expect(kept[META_KEY_FILE]).toBe("secrets/investigate-key.txt");
  });

  test("no assessment Meta key file means no investigate default", () => {
    const { env: kept, defaulted: applied } = withDemoInvestigateDefault({});
    expect(applied).toBe(false);
    expect(kept[PROVIDER]).toBe(undefined);
    const directKeyOnly = withDemoInvestigateDefault({
      BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: "fake-meta-key-for-tests-only",
    });
    expect(directKeyOnly.defaulted).toBe(false);
    expect(directKeyOnly.env[PROVIDER]).toBe(undefined);
  });
});

describe("demo Node 22 re-exec", () => {
  const home = "/home/demo-user";

  function probes(
    versions: Readonly<Record<string, string | undefined>>,
    present: readonly string[] = Object.keys(versions),
    executable: readonly string[] = present,
  ) {
    const presentSet = new Set(present);
    const executableSet = new Set(executable);
    return {
      existsSync: (path: string): boolean => presentSet.has(path),
      isExecutable: (path: string): boolean => executableSet.has(path),
      getVersion: (bin: string): string | undefined => {
        if (!(bin in versions)) {
          throw new Error("no such binary");
        }
        return versions[bin];
      },
    };
  }

  test("accepts 22 with or without a v prefix, rejects other majors", () => {
    expect(isNode22Version("22.0.0")).toBe(true);
    expect(isNode22Version("v22.23.4")).toBe(true);
    expect(isNode22Version("26.0.0")).toBe(false);
    expect(isNode22Version("v20.10.0")).toBe(false);
    expect(isNode22Version("")).toBe(false);
  });

  test("candidates check NODE22_BIN first, then the portable home path", () => {
    expect(node22Candidates("/opt/node22/bin/node", home)).toEqual([
      "/opt/node22/bin/node",
      `${home}/.local/node22/bin/node`,
    ]);
    expect(node22Candidates(undefined, home)).toEqual([`${home}/.local/node22/bin/node`]);
    expect(node22Candidates("  ", home)).toEqual([`${home}/.local/node22/bin/node`]);
    expect(node22Candidates(undefined, "")).toEqual([]);
  });

  test("a non-22, missing or non-executable binary does not count", () => {
    const candidates = ["/first/node", "/second/node"];
    expect(
      findNode22Binary(
        candidates,
        probes({ "/first/node": "v20.10.0", "/second/node": "v22.23.4" }),
      ),
    ).toBe("/second/node");
    expect(
      findNode22Binary(candidates, probes({ "/second/node": "v22.23.4" }, ["/second/node"])),
    ).toBe("/second/node");
    expect(
      findNode22Binary(
        candidates,
        probes({ "/first/node": "v20.10.0" }, ["/first/node", "/second/node"]),
      ),
    ).toBe(undefined);
    expect(
      findNode22Binary(
        candidates,
        probes({ "/first/node": "v22.1.0" }, ["/second/node"]),
      ),
    ).toBe(undefined);
    expect(findNode22Binary(candidates, probes({}))).toBe(undefined);
  });

  test("the loop marker fails instead of spawning again", () => {
    const decided = decideNode22Startup({
      runningVersion: "26.0.0",
      markerSet: true,
      found: { bin: "/opt/node22/bin/node", version: "v22.23.4" },
    });
    expect(decided.kind).toBe("fail");
    if (decided.kind === "fail") {
      expect(decided.message).toContain(DEMO_REEXEC_MARKER);
      expect(decided.message).toContain("26.0.0");
    }
  });

  test("Node 22 continues, otherwise a found binary re-execs", () => {
    expect(
      decideNode22Startup({ runningVersion: "22.23.4", markerSet: true, found: undefined }).kind,
    ).toBe("continue");
    const reexec = decideNode22Startup({
      runningVersion: "26.0.0",
      markerSet: false,
      found: { bin: "/opt/node22/bin/node", version: "v22.23.4" },
    });
    expect(reexec).toEqual({
      kind: "reexec",
      bin: "/opt/node22/bin/node",
      version: "v22.23.4",
    });
  });

  test("no Node 22 anywhere fails naming NODE22_BIN and both fallbacks", () => {
    const decided = decideNode22Startup({
      runningVersion: "26.0.0",
      markerSet: false,
      found: undefined,
    });
    expect(decided.kind).toBe("fail");
    const message = buildNode22MissingMessage("26.0.0");
    expect(message).toContain("NODE22_BIN");
    expect(message).toContain("$HOME/.local/node22/bin/node");
    expect(message).toContain('PATH="$HOME/.local/node22/bin:$PATH" npm run demo');
    expect(message).toContain("26.0.0");
    expect(message.includes(`/${"Users"}/`)).toBe(false);
    if (decided.kind === "fail") {
      expect(decided.message).toBe(message);
    }
    expect(buildNode22LoopMessage("26.0.0").includes(`/${"Users"}/`)).toBe(false);
  });

  test("home-prefixed paths display with a tilde", () => {
    expect(displayPathWithHome(`${home}/.local/node22/bin/node`, home)).toBe(
      "~/.local/node22/bin/node",
    );
    expect(displayPathWithHome("/opt/node22/bin/node", home)).toBe("/opt/node22/bin/node");
  });
});

describe("demo personalize provider default (meta-model-api)", () => {
  const META_KEY = "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY";
  const META_KEY_FILE = "BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE";
  const PROVIDER = "BRANDKLIPPAREN_PERSONALIZE_PROVIDER";
  const FAKE_KEY = "fake-meta-key-for-tests-only";

  test("an unset provider with a configured Meta key defaults to meta-model-api", () => {
    expect(DEMO_PERSONALIZE_META_PROVIDER).toBe("meta-model-api");
    for (const env of [{ [META_KEY]: FAKE_KEY }, { [META_KEY_FILE]: "secrets/meta-key.txt" }]) {
      const { env: defaulted, defaulted: applied } = withDemoPersonalizeDefault(env);
      expect(applied).toBe(true);
      expect(defaulted[PROVIDER]).toBe("meta-model-api");
    }
    const { env: emptyDefaulted } = withDemoPersonalizeDefault({ [PROVIDER]: "", [META_KEY]: FAKE_KEY });
    expect(emptyDefaulted[PROVIDER]).toBe("meta-model-api");
  });

  test("an explicit provider value always wins over the Meta key", () => {
    for (const explicit of ["off", "generic-compatible", "meta-model-api", "hosted-open-weights"]) {
      const { env: kept, defaulted: applied } = withDemoPersonalizeDefault({
        [PROVIDER]: explicit,
        [META_KEY]: FAKE_KEY,
        [META_KEY_FILE]: "secrets/meta-key.txt",
      });
      expect(applied).toBe(false);
      expect(kept[PROVIDER]).toBe(explicit);
    }
  });

  test("no Meta key means no personalize default", () => {
    const { env: kept, defaulted: applied } = withDemoPersonalizeDefault({});
    expect(applied).toBe(false);
    expect(kept[PROVIDER]).toBe(undefined);
    const blank = withDemoPersonalizeDefault({ [META_KEY]: "", [META_KEY_FILE]: "" });
    expect(blank.defaulted).toBe(false);
    expect(blank.env[PROVIDER]).toBe(undefined);
  });

  test("a defaulted provider passes config validation with the Meta triple", () => {
    const { env } = withDemoDefaults({
      BRANDKLIPPAREN_ASSESSMENT_META_API_KEY: FAKE_KEY,
      BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID: "fake-meta-model-1",
      BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL: "https://meta.example.invalid",
    });
    const { env: defaulted } = withDemoPersonalizeDefault(env);
    expect(defaulted[PROVIDER]).toBe("meta-model-api");
    expect(loadConfig(defaulted).ok).toBe(true);
  });
});

describe("demo LP feed status line", () => {
  test("reports the etherscan ready line only with a key", () => {
    expect(demoLpFeedStatus({ ETHERSCAN_API_KEY: "fake-key-for-tests-only" })).toBe(
      DEMO_LP_FEED_READY_LINE,
    );
    expect(DEMO_LP_FEED_READY_LINE).toBe("lp feed: etherscan (key loaded)");
  });

  test("reports off without a key", () => {
    expect(demoLpFeedStatus({})).toBe(DEMO_LP_FEED_OFF_LINE);
    expect(DEMO_LP_FEED_OFF_LINE).toBe("lp feed: off (set ETHERSCAN_API_KEY)");
    expect(demoLpFeedStatus({ ETHERSCAN_API_KEY: "" })).toBe(DEMO_LP_FEED_OFF_LINE);
  });
});

describe("demo ETHERSCAN_API_KEY_FILE indirection", () => {
  const TARGET = "ETHERSCAN_API_KEY";
  const FAKE_KEY = "fake-etherscan-key-for-tests-only";

  function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "demo-etherscan-file-"));
    mkdirSync(join(dir, "secrets"), { recursive: true });
    return dir;
  }

  test("the generic loader sets ETHERSCAN_API_KEY for the REST child", () => {
    const dir = tempRoot();
    writeFileSync(join(dir, "secrets", "fake-etherscan.txt"), `  ${FAKE_KEY}\n`, "utf8");
    const { env, loaded, failed } = resolveSecretFileVars(
      { [`${TARGET}_FILE`]: join("secrets", "fake-etherscan.txt") },
      dir,
      (path) => readFileSync(path, "utf8"),
    );
    expect(env[TARGET]).toBe(FAKE_KEY);
    expect(loaded).toEqual([TARGET]);
    expect(failed).toEqual([]);
    // The status line names the variable and never carries the value.
    const line = demoLpFeedStatus(env);
    expect(line).toBe(DEMO_LP_FEED_READY_LINE);
    expect(line.includes(FAKE_KEY)).toBe(false);
  });

  test("a configured key wins and a missing file fails by name only", () => {
    let reads = 0;
    const kept = resolveSecretFileVars(
      { [TARGET]: "fake-direct-key-for-tests-only", [`${TARGET}_FILE`]: "secrets/fake.txt" },
      tempRoot(),
      () => {
        reads += 1;
        return "fake-file-key-for-tests-only";
      },
    );
    expect(kept.env[TARGET]).toBe("fake-direct-key-for-tests-only");
    expect(kept.loaded).toEqual([]);
    expect(reads).toBe(0);
    const missing = resolveSecretFileVars(
      { [`${TARGET}_FILE`]: "secrets/absent.txt" },
      tempRoot(),
      () => {
        throw new Error("no such file");
      },
    );
    expect(missing.env[TARGET]).toBe(undefined);
    expect(missing.failed).toEqual([TARGET]);
    expect(demoLpFeedStatus(missing.env)).toBe(DEMO_LP_FEED_OFF_LINE);
  });
});

describe("demo extdecomp discovery order", () => {
  test("extdecomp_BIN wins over everything", () => {
    const found = discoverextdecompBinary({
      extdecompBin: "/custom/dir/extdecomp",
      pathEnv: "/usr/local/bin:/usr/bin",
      homeDir: "/home/demo",
      existsSync: existing(["/usr/local/bin/extdecomp", "/home/demo/.bifrost/bin/extdecomp"]),
    });
    expect(found).toBe("/custom/dir/extdecomp");
  });

  test("PATH comes before the home fallback, first hit wins", () => {
    const found = discoverextdecompBinary({
      extdecompBin: undefined,
      pathEnv: "/first/bin:/second/bin",
      homeDir: "/home/demo",
      existsSync: existing(["/second/bin/extdecomp", "/home/demo/.bifrost/bin/extdecomp"]),
    });
    expect(found).toBe("/second/bin/extdecomp");
  });

  test("falls back to $HOME/.bifrost/bin/extdecomp", () => {
    const found = discoverextdecompBinary({
      extdecompBin: "",
      pathEnv: "/usr/bin",
      homeDir: "/home/demo",
      existsSync: existing(["/home/demo/.bifrost/bin/extdecomp"]),
    });
    expect(found).toBe("/home/demo/.bifrost/bin/extdecomp");
  });

  test("returns undefined when nothing is found", () => {
    expect(
      discoverextdecompBinary({
        extdecompBin: undefined,
        pathEnv: "/usr/bin",
        homeDir: "/home/demo",
        existsSync: existing([]),
      }),
    ).toBe(undefined);
    expect(
      discoverextdecompBinary({
        extdecompBin: undefined,
        pathEnv: undefined,
        homeDir: undefined,
        existsSync: existing([]),
      }),
    ).toBe(undefined);
  });
});

describe("demo market provider default (dexscreener)", () => {
  const PROVIDER = "BRANDKLIPPAREN_MARKET_PROVIDER";

  test("an unset or empty provider defaults to dexscreener", () => {
    expect(DEMO_MARKET_PROVIDER).toBe("dexscreener");
    const { env: defaulted, defaulted: applied } = withDemoMarketDefault({});
    expect(applied).toBe(true);
    expect(defaulted[PROVIDER]).toBe("dexscreener");
    const { env: emptyDefaulted } = withDemoMarketDefault({ [PROVIDER]: "" });
    expect(emptyDefaulted[PROVIDER]).toBe("dexscreener");
  });

  test("an explicit provider value always wins", () => {
    for (const explicit of ["off", "dexscreener"]) {
      const { env: kept, defaulted: applied } = withDemoMarketDefault({ [PROVIDER]: explicit });
      expect(applied).toBe(false);
      expect(kept[PROVIDER]).toBe(explicit);
    }
  });

  test("the market status line names the provider truthfully", () => {
    expect(demoMarketStatus({ [PROVIDER]: "dexscreener" })).toBe(DEMO_MARKET_READY_LINE);
    expect(DEMO_MARKET_READY_LINE).toBe("market provider: dexscreener");
    expect(demoMarketStatus({})).toBe(DEMO_MARKET_OFF_LINE);
    expect(demoMarketStatus({ [PROVIDER]: "off" })).toBe(DEMO_MARKET_OFF_LINE);
    expect(demoMarketStatus({ [PROVIDER]: "" })).toBe(DEMO_MARKET_OFF_LINE);
  });

  test("a defaulted provider passes config validation", () => {
    const { env } = withDemoDefaults({});
    const { env: defaulted } = withDemoMarketDefault(env);
    expect(defaulted[PROVIDER]).toBe("dexscreener");
    expect(loadConfig(defaulted).ok).toBe(true);
  });
});

describe("demo source provider default (sourcify)", () => {
  const PROVIDER = "BRANDKLIPPAREN_SOURCE_PROVIDER";

  test("an unset or empty provider defaults to sourcify", () => {
    expect(DEMO_SOURCE_PROVIDER).toBe("sourcify");
    const { env: defaulted, defaulted: applied } = withDemoSourceDefault({});
    expect(applied).toBe(true);
    expect(defaulted[PROVIDER]).toBe("sourcify");
    const { env: emptyDefaulted } = withDemoSourceDefault({ [PROVIDER]: "" });
    expect(emptyDefaulted[PROVIDER]).toBe("sourcify");
  });

  test("an explicit provider value always wins", () => {
    for (const explicit of ["off", "sourcify"]) {
      const { env: kept, defaulted: applied } = withDemoSourceDefault({ [PROVIDER]: explicit });
      expect(applied).toBe(false);
      expect(kept[PROVIDER]).toBe(explicit);
    }
  });

  test("the source status line names the provider truthfully", () => {
    expect(demoSourceStatus({ [PROVIDER]: "sourcify" })).toBe(DEMO_SOURCE_READY_LINE);
    expect(DEMO_SOURCE_READY_LINE).toBe("source provider: sourcify");
    expect(demoSourceStatus({})).toBe(DEMO_SOURCE_OFF_LINE);
    expect(demoSourceStatus({ [PROVIDER]: "off" })).toBe(DEMO_SOURCE_OFF_LINE);
    expect(demoSourceStatus({ [PROVIDER]: "" })).toBe(DEMO_SOURCE_OFF_LINE);
  });

  test("a defaulted provider passes config validation", () => {
    const { env } = withDemoDefaults({});
    const { env: defaulted } = withDemoSourceDefault(env);
    expect(defaulted[PROVIDER]).toBe("sourcify");
    expect(loadConfig(defaulted).ok).toBe(true);
  });
});
