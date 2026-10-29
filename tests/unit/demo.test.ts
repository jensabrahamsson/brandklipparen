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
  DEMO_ASSESSMENT_OFF_LINE,
  DEMO_ASSESSMENT_READY_LINE,
  DEMO_DEFAULTS,
  DEMO_DEFAULT_RPC_URL,
  DEMO_LP_FEED_OFF_LINE,
  DEMO_LP_FEED_READY_LINE,
  DEMO_REEXEC_MARKER,
  demoAssessmentStatus,
  demoLpFeedStatus,
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
  withDemoDefaults,
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
  test("reports the loaded provider line only with provider and key", () => {
    expect(
      demoAssessmentStatus({
        BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "generic-compatible",
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_ASSESSMENT_READY_LINE);
    expect(DEMO_ASSESSMENT_READY_LINE).toBe("assessment provider: generic-compatible (key loaded)");
  });

  test("reports off without a file, without a provider, or without a key", () => {
    expect(demoAssessmentStatus({})).toBe(DEMO_ASSESSMENT_OFF_LINE);
    expect(DEMO_ASSESSMENT_OFF_LINE).toBe("assessment: off");
    expect(
      demoAssessmentStatus({ BRANDKLIPPAREN_ASSESSMENT_PROVIDER: "generic-compatible" }),
    ).toBe(DEMO_ASSESSMENT_OFF_LINE);
    expect(
      demoAssessmentStatus({
        BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY: "fake-key-for-tests-only",
      }),
    ).toBe(DEMO_ASSESSMENT_OFF_LINE);
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
