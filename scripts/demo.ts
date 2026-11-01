// One-command local demo: `npm run demo` starts the REST API and the web
// dev server together with local defaults and an optional `.env.local`
// file. The process supervises both children: it waits for both to
// answer, prints the URL to open, forwards Ctrl-C/SIGTERM to both
// children and stops the other child when one of them dies. Precedence
// is user environment, then `.env.local`, then demo defaults, then a
// generated per-run local API key (so the UI can analyse with zero
// manual steps). Pure helpers (defaults, `.env.local` parsing, secret
// file indirection, key generation, Node check, extdecomp discovery) are
// exported for the unit test; only runDemo() spawns.
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_WEB_PORT = 5173;
export const DEMO_DEFAULT_REST_PORT = "8080";
export const DEMO_DEFAULT_RPC_URL = "https://ethereum-rpc.publicnode.com";
export const DEMO_NODE_MAJOR = 22;

// Hint printed when the running Node is wrong. $HOME keeps the message
// portable: no absolute home directory appears in tracked files.
const PORTABLE_NODE_HINT = 'PATH="$HOME/.local/node22/bin:$PATH" npm run demo';

// Local defaults, applied only where the variable is not already set in
// the environment (the user's env wins). No API keys of any kind: keyed
// features stay off and report not-configured unless their key file is
// set, in which case the Meta provider is defaulted for assessment and
// investigation. The model default matches the documented default
// artifact in model/README.md (calibration 1.0.1).
export const DEMO_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  BRANDKLIPPAREN_ENV: "local",
  BRANDKLIPPAREN_MODEL_VERSION: "1.0.1",
  BRANDKLIPPAREN_MODEL_ARTIFACT_PATH: "model/artifact-1.0.1.json",
  BRANDKLIPPAREN_CLONE_INDEX_VERSION: "1.0.0",
  BRANDKLIPPAREN_extdecomp_DEADLINE_MS: "60000",
  BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB: "512",
  BRANDKLIPPAREN_extdecomp_MAX_OUTPUT_BYTES: "1048576",
  BRANDKLIPPAREN_LOG_LEVEL: "info",
  BRANDKLIPPAREN_HTTP_PORT: DEMO_DEFAULT_REST_PORT,
  BRANDKLIPPAREN_CACHE_DIR: ".cache/brandklipparen",
  BRANDKLIPPAREN_RPC_URLS: DEMO_DEFAULT_RPC_URL,
  // Key-free RPC fallback for the live token feed when the log source is
  // rate limited, backing off or not configured.
  BRANDKLIPPAREN_FEED_RPC_URL: DEMO_DEFAULT_RPC_URL,
  BRANDKLIPPAREN_CHAIN_ID: "1",
  BRANDKLIPPAREN_RPC_DEADLINE_MS: "15000",
  BRANDKLIPPAREN_RPC_MAX_CONCURRENCY: "8",
  BRANDKLIPPAREN_RPC_RETRY_BUDGET: "2",
  BRANDKLIPPAREN_RPC_MAX_RESPONSE_BYTES: "1048576",
  BRANDKLIPPAREN_extdecomp_MAX_CONCURRENCY: "2",
  BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE: "60",
  BRANDKLIPPAREN_QUOTA_PER_KEY_PER_DAY: "1000",
  BRANDKLIPPAREN_GLOBAL_RATE_PER_MINUTE: "600",
});

// Parses an optional `.env.local` file (simple KEY=VALUE lines, `#`
// comments on their own lines, optional surrounding single or double
// quotes; no shell expansion, no inline comment stripping). Malformed
// lines are skipped. Later lines win on repeats. Pure: takes text.
export function parseEnvLocal(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      continue;
    }
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[name] = value;
  }
  return parsed;
}

// Applies parsed `.env.local` values for variables not already set in
// the environment (the user's env wins over `.env.local`). Empty counts
// as unset, mirroring withDemoDefaults. Returns the merged environment
// plus the applied names (names only, never values).
export function applyEnvLocal(
  env: Readonly<Record<string, string | undefined>>,
  parsed: Readonly<Record<string, string>>,
): { readonly env: Record<string, string | undefined>; readonly applied: readonly string[] } {
  const merged: Record<string, string | undefined> = { ...env };
  const applied: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    const current = merged[name];
    if (current === undefined || current === "") {
      merged[name] = value;
      applied.push(name);
    }
  }
  return { env: merged, applied: Object.freeze(applied.slice()) };
}

export type EnvLocalFileDeps = {
  readonly existsSync: (path: string) => boolean;
  readonly readFileSync: (path: string) => string;
};

// Reads and parses `.env.local` from the repo root. Absent or unreadable
// means no local file: returns empty, so the demo runs exactly as before.
export function readEnvLocalFile(
  rootDir: string,
  deps: EnvLocalFileDeps,
): Record<string, string> {
  const path = join(rootDir, ".env.local");
  let present = false;
  try {
    present = deps.existsSync(path);
  } catch {
    return {};
  }
  if (!present) {
    return {};
  }
  try {
    return parseEnvLocal(deps.readFileSync(path));
  } catch {
    return {};
  }
}

// Resolves `<NAME>_FILE` secret indirection (local development only): for
// every `<NAME>_FILE` variable with a non-empty value whose `<NAME>` is
// still unset, reads the file (absolute, or relative to the repo root),
// trims it and sets `<NAME>`. A configured `<NAME>` always wins, so the
// file is only read when needed. Returns the merged environment plus the
// resolved and failed target names (names only, never values or file
// contents). Pure apart from the injected file reader.
export function resolveSecretFileVars(
  env: Readonly<Record<string, string | undefined>>,
  rootDir: string,
  readFile: (path: string) => string,
): {
  readonly env: Record<string, string | undefined>;
  readonly loaded: readonly string[];
  readonly failed: readonly string[];
} {
  const merged: Record<string, string | undefined> = { ...env };
  const loaded: string[] = [];
  const failed: string[] = [];
  const suffix = "_FILE";
  for (const [name, pointer] of Object.entries(merged)) {
    if (!name.endsWith(suffix) || name.length <= suffix.length) {
      continue;
    }
    const raw = (pointer ?? "").trim();
    if (raw === "") {
      continue;
    }
    const target = name.slice(0, -suffix.length);
    const current = merged[target];
    if (current !== undefined && current !== "") {
      continue;
    }
    const path = isAbsolute(raw) ? raw : join(rootDir, raw);
    let secret = "";
    try {
      secret = readFile(path).trim();
    } catch {
      failed.push(target);
      continue;
    }
    if (secret === "") {
      failed.push(target);
      continue;
    }
    merged[target] = secret;
    loaded.push(target);
  }
  return {
    env: merged,
    loaded: Object.freeze(loaded.slice()),
    failed: Object.freeze(failed.slice()),
  };
}

// Masked preview of a generated key for logs: a short prefix plus an
// ellipsis, never the full key.
export function maskKeyPreview(key: string): string {
  return `${key.slice(0, 4)}...`;
}

// Ensures the REST child has an API key: a configured
// BRANDKLIPPAREN_API_KEYS (user env or `.env.local`) is kept as is,
// otherwise a random per-run local key is generated via the injected
// maker. Returns the merged environment, whether a key was generated,
// and the single key the web child hands to the UI (the generated key,
// or the first configured one). The preview carries a masked prefix of
// a generated key only, never a full key.
export function ensureDemoApiKey(
  env: Readonly<Record<string, string | undefined>>,
  makeKey: () => string,
): {
  readonly env: Record<string, string | undefined>;
  readonly generated: boolean;
  readonly webKey: string;
  readonly preview: string;
} {
  const configured = env["BRANDKLIPPAREN_API_KEYS"] ?? "";
  if (configured !== "") {
    const first = configured
      .split(",")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
    return { env: { ...env }, generated: false, webKey: first, preview: "" };
  }
  const key = makeKey();
  return {
    env: { ...env, BRANDKLIPPAREN_API_KEYS: key },
    generated: true,
    webKey: key,
    preview: maskKeyPreview(key),
  };
}

// Single assessment status line for the demo log: exactly one line
// naming the selected provider, never a value or file contents.
export const DEMO_ASSESSMENT_OFF_LINE = "assessment: off";
export const DEMO_ASSESSMENT_META_READY_LINE = "assessment provider: meta-model-api (key loaded)";
export const DEMO_ASSESSMENT_hosted_READY_LINE = "assessment provider: hosted-open-weights (key loaded)";
export const DEMO_ASSESSMENT_generic_COMPATIBLE_READY_LINE =
  "assessment provider: generic-compatible (key loaded)";

export function demoAssessmentStatus(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const provider = env["BRANDKLIPPAREN_ASSESSMENT_PROVIDER"] ?? "";
  if (provider === "meta-model-api" && (env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY"] ?? "") !== "") {
    return DEMO_ASSESSMENT_META_READY_LINE;
  }
  if (
    provider === "hosted-open-weights" &&
    (env["BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY"] ?? "") !== ""
  ) {
    return DEMO_ASSESSMENT_hosted_READY_LINE;
  }
  if (
    provider === "generic-compatible" &&
    (env["BRANDKLIPPAREN_ASSESSMENT_generic_COMPATIBLE_API_KEY"] ?? "") !== ""
  ) {
    return DEMO_ASSESSMENT_generic_COMPATIBLE_READY_LINE;
  }
  return DEMO_ASSESSMENT_OFF_LINE;
}

// Demo default for the assessment provider: when the provider is unset
// and a Meta key is configured (directly or via its pointer file), the
// demo defaults the provider to meta-model-api. An explicit value
// (including "off" and "generic-compatible") always wins. Pure: reads
// names and presence only, never key values or file contents.
export const DEMO_ASSESSMENT_META_PROVIDER = "meta-model-api";

export function withDemoAssessmentDefault(
  env: Readonly<Record<string, string | undefined>>,
): { readonly env: Record<string, string | undefined>; readonly defaulted: boolean } {
  const current = env["BRANDKLIPPAREN_ASSESSMENT_PROVIDER"] ?? "";
  if (current !== "") {
    return { env: { ...env }, defaulted: false };
  }
  const key = env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY"] ?? "";
  const keyFile = env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE"] ?? "";
  if (key === "" && keyFile === "") {
    return { env: { ...env }, defaulted: false };
  }
  return {
    env: { ...env, BRANDKLIPPAREN_ASSESSMENT_PROVIDER: DEMO_ASSESSMENT_META_PROVIDER },
    defaulted: true,
  };
}

// Single investigation status line for the demo log: exactly one line
// naming the selected provider, never a value or file contents.
export const DEMO_INVESTIGATE_OFF_LINE = "investigate: off";
export const DEMO_INVESTIGATE_META_READY_LINE = "investigate provider: meta-model-api (key loaded)";
export const DEMO_INVESTIGATE_hosted_READY_LINE =
  "investigate provider: hosted-open-weights (key loaded)";

export function demoInvestigateStatus(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const provider = env["BRANDKLIPPAREN_INVESTIGATE_PROVIDER"] ?? "";
  if (provider === "meta-model-api" && (env["BRANDKLIPPAREN_INVESTIGATE_META_API_KEY"] ?? "") !== "") {
    return DEMO_INVESTIGATE_META_READY_LINE;
  }
  if (
    provider === "hosted-open-weights" &&
    (env["BRANDKLIPPAREN_INVESTIGATE_hosted_API_KEY"] ?? "") !== ""
  ) {
    return DEMO_INVESTIGATE_hosted_READY_LINE;
  }
  return DEMO_INVESTIGATE_OFF_LINE;
}

// Demo default for the investigation loop: when the investigate provider
// is unset and the assessment Meta key file is set, the demo reuses that
// same single Meta key for all three features (assessment, personalize,
// investigation). Only pointer and connection names are copied, never
// key values; the generic secret-file indirection resolves the pointer
// later. Explicit investigate values always win, per field. Pure: reads
// names and presence only, never key values or file contents.
export const DEMO_INVESTIGATE_META_PROVIDER = "meta-model-api";

export function withDemoInvestigateDefault(
  env: Readonly<Record<string, string | undefined>>,
): { readonly env: Record<string, string | undefined>; readonly defaulted: boolean } {
  const current = env["BRANDKLIPPAREN_INVESTIGATE_PROVIDER"] ?? "";
  if (current !== "") {
    return { env: { ...env }, defaulted: false };
  }
  const assessmentKeyFile = env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE"] ?? "";
  if (assessmentKeyFile === "") {
    return { env: { ...env }, defaulted: false };
  }
  const next: Record<string, string | undefined> = {
    ...env,
    BRANDKLIPPAREN_INVESTIGATE_PROVIDER: DEMO_INVESTIGATE_META_PROVIDER,
  };
  if ((next["BRANDKLIPPAREN_INVESTIGATE_META_API_KEY_FILE"] ?? "") === "") {
    next["BRANDKLIPPAREN_INVESTIGATE_META_API_KEY_FILE"] = assessmentKeyFile;
  }
  const assessmentModelId = env["BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID"] ?? "";
  if (assessmentModelId !== "" && (next["BRANDKLIPPAREN_INVESTIGATE_META_MODEL_ID"] ?? "") === "") {
    next["BRANDKLIPPAREN_INVESTIGATE_META_MODEL_ID"] = assessmentModelId;
  }
  const assessmentBaseUrl = env["BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL"] ?? "";
  if (assessmentBaseUrl !== "" && (next["BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL"] ?? "") === "") {
    next["BRANDKLIPPAREN_INVESTIGATE_META_BASE_URL"] = assessmentBaseUrl;
  }
  return { env: next, defaulted: true };
}

// Demo default for one opt-in overlay (explain, chat, rug): when the
// overlay provider is unset and the assessment Meta key file is set, the
// demo reuses that same single Meta key for the overlay. Only pointer and
// connection names are copied, never key values; the generic secret-file
// indirection resolves the pointer later. Explicit overlay values always
// win, per field. Pure: reads names and presence only, never key values
// or file contents.
export const DEMO_EXPLAIN_META_PROVIDER = "meta-model-api";
export const DEMO_CHAT_META_PROVIDER = "meta-model-api";
export const DEMO_RUG_META_PROVIDER = "meta-model-api";

function withDemoOverlayDefault(
  env: Readonly<Record<string, string | undefined>>,
  providerName: string,
  keyFileName: string,
  modelIdName: string,
  baseUrlName: string,
): { readonly env: Record<string, string | undefined>; readonly defaulted: boolean } {
  const current = env[providerName] ?? "";
  if (current !== "") {
    return { env: { ...env }, defaulted: false };
  }
  const assessmentKeyFile = env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE"] ?? "";
  if (assessmentKeyFile === "") {
    return { env: { ...env }, defaulted: false };
  }
  const next: Record<string, string | undefined> = {
    ...env,
    [providerName]: "meta-model-api",
  };
  if ((next[keyFileName] ?? "") === "") {
    next[keyFileName] = assessmentKeyFile;
  }
  const assessmentModelId = env["BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID"] ?? "";
  if (assessmentModelId !== "" && (next[modelIdName] ?? "") === "") {
    next[modelIdName] = assessmentModelId;
  }
  const assessmentBaseUrl = env["BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL"] ?? "";
  if (assessmentBaseUrl !== "" && (next[baseUrlName] ?? "") === "") {
    next[baseUrlName] = assessmentBaseUrl;
  }
  return { env: next, defaulted: true };
}

export function withDemoExplainDefault(
  env: Readonly<Record<string, string | undefined>>,
): { readonly env: Record<string, string | undefined>; readonly defaulted: boolean } {
  return withDemoOverlayDefault(
    env,
    "BRANDKLIPPAREN_EXPLAIN_PROVIDER",
    "BRANDKLIPPAREN_EXPLAIN_META_API_KEY_FILE",
    "BRANDKLIPPAREN_EXPLAIN_META_MODEL_ID",
    "BRANDKLIPPAREN_EXPLAIN_META_BASE_URL",
  );
}

export function withDemoChatDefault(
  env: Readonly<Record<string, string | undefined>>,
): { readonly env: Record<string, string | undefined>; readonly defaulted: boolean } {
  return withDemoOverlayDefault(
    env,
    "BRANDKLIPPAREN_CHAT_PROVIDER",
    "BRANDKLIPPAREN_CHAT_META_API_KEY_FILE",
    "BRANDKLIPPAREN_CHAT_META_MODEL_ID",
    "BRANDKLIPPAREN_CHAT_META_BASE_URL",
  );
}

export function withDemoRugDefault(
  env: Readonly<Record<string, string | undefined>>,
): { readonly env: Record<string, string | undefined>; readonly defaulted: boolean } {
  return withDemoOverlayDefault(
    env,
    "BRANDKLIPPAREN_RUG_PROVIDER",
    "BRANDKLIPPAREN_RUG_META_API_KEY_FILE",
    "BRANDKLIPPAREN_RUG_META_MODEL_ID",
    "BRANDKLIPPAREN_RUG_META_BASE_URL",
  );
}

// Single overlay status lines for the demo log: exactly one line per
// feature naming the selected provider, never a value or file contents.
export const DEMO_EXPLAIN_OFF_LINE = "explain: off";
export const DEMO_EXPLAIN_META_READY_LINE = "explain provider: meta-model-api (key loaded)";
export const DEMO_CHAT_OFF_LINE = "chat: off";
export const DEMO_CHAT_META_READY_LINE = "chat provider: meta-model-api (key loaded)";
export const DEMO_RUG_OFF_LINE = "rug: off";
export const DEMO_RUG_META_READY_LINE = "rug provider: meta-model-api (key loaded)";

function demoOverlayStatus(
  env: Readonly<Record<string, string | undefined>>,
  providerName: string,
  keyName: string,
  readyLine: string,
  offLine: string,
): string {
  const provider = env[providerName] ?? "";
  if (provider === "meta-model-api" && (env[keyName] ?? "") !== "") {
    return readyLine;
  }
  return offLine;
}

export function demoExplainStatus(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return demoOverlayStatus(
    env,
    "BRANDKLIPPAREN_EXPLAIN_PROVIDER",
    "BRANDKLIPPAREN_EXPLAIN_META_API_KEY",
    DEMO_EXPLAIN_META_READY_LINE,
    DEMO_EXPLAIN_OFF_LINE,
  );
}

export function demoChatStatus(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return demoOverlayStatus(
    env,
    "BRANDKLIPPAREN_CHAT_PROVIDER",
    "BRANDKLIPPAREN_CHAT_META_API_KEY",
    DEMO_CHAT_META_READY_LINE,
    DEMO_CHAT_OFF_LINE,
  );
}

export function demoRugStatus(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return demoOverlayStatus(
    env,
    "BRANDKLIPPAREN_RUG_PROVIDER",
    "BRANDKLIPPAREN_RUG_META_API_KEY",
    DEMO_RUG_META_READY_LINE,
    DEMO_RUG_OFF_LINE,
  );
}

// Experimental AI personalize default for the demo (brief 42): when the
// personalize provider is unset and a Meta key is configured (directly
// or via its pointer file), the demo defaults the mapping provider to
// meta-model-api. An explicit value (including "off" and
// "generic-compatible") always wins. Pure: reads names and presence
// only, never key values or file contents.
export const DEMO_PERSONALIZE_META_PROVIDER = "meta-model-api";

export function withDemoPersonalizeDefault(
  env: Readonly<Record<string, string | undefined>>,
): { readonly env: Record<string, string | undefined>; readonly defaulted: boolean } {
  const current = env["BRANDKLIPPAREN_PERSONALIZE_PROVIDER"] ?? "";
  if (current !== "") {
    return { env: { ...env }, defaulted: false };
  }
  const key = env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY"] ?? "";
  const keyFile = env["BRANDKLIPPAREN_ASSESSMENT_META_API_KEY_FILE"] ?? "";
  if (key === "" && keyFile === "") {
    return { env: { ...env }, defaulted: false };
  }
  return {
    env: { ...env, BRANDKLIPPAREN_PERSONALIZE_PROVIDER: DEMO_PERSONALIZE_META_PROVIDER },
    defaulted: true,
  };
}

// Single LP feed status line for the demo log: the key name only, never
// the value. The generic `<NAME>_FILE` indirection resolves
// ETHERSCAN_API_KEY_FILE into ETHERSCAN_API_KEY before this runs.
export const DEMO_LP_FEED_OFF_LINE = "lp feed: off (set ETHERSCAN_API_KEY)";
export const DEMO_LP_FEED_READY_LINE = "lp feed: etherscan (key loaded)";

export function demoLpFeedStatus(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const key = env["ETHERSCAN_API_KEY"] ?? "";
  if (key !== "") {
    return DEMO_LP_FEED_READY_LINE;
  }
  return DEMO_LP_FEED_OFF_LINE;
}

// Demo default for the market listing (DX-B1): when the provider is unset
// or empty, the demo defaults it to dexscreener so the live demo serves
// the listing with zero manual steps. An explicit value (including "off")
// always wins. Pure: reads the provider name only, never key values.
export const DEMO_MARKET_PROVIDER = "dexscreener";

export function withDemoMarketDefault(
  env: Readonly<Record<string, string | undefined>>,
): { readonly env: Record<string, string | undefined>; readonly defaulted: boolean } {
  const current = env["BRANDKLIPPAREN_MARKET_PROVIDER"] ?? "";
  if (current !== "") {
    return { env: { ...env }, defaulted: false };
  }
  return {
    env: { ...env, BRANDKLIPPAREN_MARKET_PROVIDER: DEMO_MARKET_PROVIDER },
    defaulted: true,
  };
}

// Single market listing status line for the demo log: exactly one line
// naming the selected provider, never values or response bodies.
export const DEMO_MARKET_OFF_LINE = "market: off (set BRANDKLIPPAREN_MARKET_PROVIDER to dexscreener)";
export const DEMO_MARKET_READY_LINE = "market provider: dexscreener";

export function demoMarketStatus(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const provider = env["BRANDKLIPPAREN_MARKET_PROVIDER"] ?? "";
  if (provider === DEMO_MARKET_PROVIDER) {
    return DEMO_MARKET_READY_LINE;
  }
  return DEMO_MARKET_OFF_LINE;
}

// Demo default for verified contract sources (VS-B2): when the provider
// is unset or empty, the demo defaults it to sourcify so the live demo
// serves the source route with zero manual steps. An explicit value
// (including "off") always wins. Pure: reads the provider name only,
// never key values.
export const DEMO_SOURCE_PROVIDER = "sourcify";

export function withDemoSourceDefault(
  env: Readonly<Record<string, string | undefined>>,
): { readonly env: Record<string, string | undefined>; readonly defaulted: boolean } {
  const current = env["BRANDKLIPPAREN_SOURCE_PROVIDER"] ?? "";
  if (current !== "") {
    return { env: { ...env }, defaulted: false };
  }
  return {
    env: { ...env, BRANDKLIPPAREN_SOURCE_PROVIDER: DEMO_SOURCE_PROVIDER },
    defaulted: true,
  };
}

// Single verified-source status line for the demo log: exactly one line
// naming the selected provider, never values or response bodies.
export const DEMO_SOURCE_OFF_LINE = "source: off (set BRANDKLIPPAREN_SOURCE_PROVIDER to sourcify)";
export const DEMO_SOURCE_READY_LINE = "source provider: sourcify";

export function demoSourceStatus(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const provider = env["BRANDKLIPPAREN_SOURCE_PROVIDER"] ?? "";
  if (provider === DEMO_SOURCE_PROVIDER) {
    return DEMO_SOURCE_READY_LINE;
  }
  return DEMO_SOURCE_OFF_LINE;
}

export type NodeCheck = { readonly ok: true } | { readonly ok: false; readonly message: string };

// The demo needs Node 22.x. Anything else fails with the portable hint.
export function checkNodeVersion(version: string): NodeCheck {
  const major = version.split(".")[0] ?? "";
  if (major === String(DEMO_NODE_MAJOR)) {
    return { ok: true };
  }
  return {
    ok: false,
    message:
      `demo needs Node ${DEMO_NODE_MAJOR}.x but found ${version}. ` +
      `Run it with the portable Node 22: ${PORTABLE_NODE_HINT}`,
  };
}

// Marker set on the re-exec child environment so a failed re-exec cannot
// loop forever: when the marker is already set and the running Node is
// still not 22, the demo fails instead of spawning again.
export const DEMO_REEXEC_MARKER = "BRANDKLIPPAREN_DEMO_REEXEC";

// Accepts both `process.versions.node` (`22.1.0`) and `<bin> --version`
// output (`v22.1.0`).
export function isNode22Version(version: string): boolean {
  const cleaned = version.trim().replace(/^v/, "");
  const major = cleaned.split(".")[0] ?? "";
  return major === String(DEMO_NODE_MAJOR);
}

// Ordered Node 22 candidates: NODE22_BIN first, then
// $HOME/.local/node22/bin/node. Uses os.homedir(); no absolute home
// directory appears in tracked files.
export function node22Candidates(
  node22Bin: string | undefined,
  homeDir: string,
): readonly string[] {
  const candidates: string[] = [];
  const direct = (node22Bin ?? "").trim();
  if (direct.length > 0) {
    candidates.push(direct);
  }
  const trimmedHome = homeDir.trim();
  if (trimmedHome.length > 0) {
    const fallback = join(trimmedHome, ".local", "node22", "bin", "node");
    if (!candidates.includes(fallback)) {
      candidates.push(fallback);
    }
  }
  return Object.freeze(candidates.slice());
}

export type Node22ProbeDeps = {
  readonly existsSync: (path: string) => boolean;
  readonly isExecutable: (path: string) => boolean;
  // Runs `<bin> --version`; returns the raw output, or undefined when
  // the binary cannot be executed.
  readonly getVersion: (bin: string) => string | undefined;
};

// A candidate counts only when it exists, is executable, and reports
// Node 22.x. Returns the first candidate that qualifies, in order.
export function findNode22Binary(
  candidates: readonly string[],
  deps: Node22ProbeDeps,
): string | undefined {
  for (const candidate of candidates) {
    let present = false;
    try {
      present = deps.existsSync(candidate);
    } catch {
      continue;
    }
    if (!present) {
      continue;
    }
    let executable = false;
    try {
      executable = deps.isExecutable(candidate);
    } catch {
      continue;
    }
    if (!executable) {
      continue;
    }
    let reported: string | undefined;
    try {
      reported = deps.getVersion(candidate);
    } catch {
      continue;
    }
    if (reported === undefined || !isNode22Version(reported)) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

// Shows a path with a $HOME prefix as ~/..., so logs stay portable.
export function displayPathWithHome(path: string, homeDir: string): string {
  const trimmedHome = homeDir.trim();
  if (trimmedHome.length > 0 && (path === trimmedHome || path.startsWith(`${trimmedHome}/`))) {
    return `~${path.slice(trimmedHome.length)}`;
  }
  return path;
}

// Error printed when no Node 22 binary is found: names NODE22_BIN, the
// portable install path and the PATH prefix alternative.
export function buildNode22MissingMessage(foundVersion: string): string {
  return (
    `demo needs Node ${DEMO_NODE_MAJOR}.x but found ${foundVersion} and no Node 22 binary was found. ` +
    `Set NODE22_BIN to a Node 22 binary, or install Node 22 at $HOME/.local/node22/bin/node, ` +
    `or run with the portable PATH prefix: ${PORTABLE_NODE_HINT}`
  );
}

// Error printed when the re-exec marker is already set but the running
// Node is still not 22: spawning again would loop forever.
export function buildNode22LoopMessage(foundVersion: string): string {
  return (
    `demo needs Node ${DEMO_NODE_MAJOR}.x but found ${foundVersion} even after re-executing ` +
    `under Node 22 (${DEMO_REEXEC_MARKER} is set). ` +
    `Check that NODE22_BIN or $HOME/.local/node22/bin/node points at a Node 22 binary.`
  );
}

export type Node22Decision =
  | { readonly kind: "continue" }
  | { readonly kind: "reexec"; readonly bin: string; readonly version: string }
  | { readonly kind: "fail"; readonly message: string };

// Pure startup decision: continue on Node 22, fail when a previous
// re-exec did not help (loop marker set), re-exec when a Node 22 binary
// was found, otherwise fail with the missing-binary error.
export function decideNode22Startup(options: {
  readonly runningVersion: string;
  readonly markerSet: boolean;
  readonly found: { readonly bin: string; readonly version: string } | undefined;
}): Node22Decision {
  if (isNode22Version(options.runningVersion)) {
    return { kind: "continue" };
  }
  if (options.markerSet) {
    return { kind: "fail", message: buildNode22LoopMessage(options.runningVersion) };
  }
  if (options.found !== undefined) {
    return { kind: "reexec", bin: options.found.bin, version: options.found.version };
  }
  return { kind: "fail", message: buildNode22MissingMessage(options.runningVersion) };
}

// Real `<bin> --version` probe with a short timeout, for startup only
// (never in the unit test, which injects a fake).
export function probeNode22Version(bin: string): string | undefined {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
}

function isExecutablePath(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Copy the environment with DEMO_DEFAULTS filled in where the variable is
// unset or empty. Returns the merged environment plus the names that were
// defaulted, so the caller can log names without printing values.
export function withDemoDefaults(
  env: Readonly<Record<string, string | undefined>>,
): { readonly env: Record<string, string | undefined>; readonly applied: readonly string[] } {
  const merged: Record<string, string | undefined> = { ...env };
  const applied: string[] = [];
  for (const [name, value] of Object.entries(DEMO_DEFAULTS)) {
    const current = merged[name];
    if (current === undefined || current === "") {
      merged[name] = value;
      applied.push(name);
    }
  }
  return { env: merged, applied: Object.freeze(applied.slice()) };
}

export type extdecompDiscoveryDeps = {
  // Value of extdecomp_BIN, when set.
  readonly extdecompBin: string | undefined;
  // Value of PATH for the `extdecomp` lookup.
  readonly pathEnv: string | undefined;
  // Value of $HOME for the ~/.bifrost/bin/extdecomp lookup.
  readonly homeDir: string | undefined;
  readonly existsSync: (path: string) => boolean;
};

// extdecomp discovery order: extdecomp_BIN first, then `extdecomp` on PATH,
// then $HOME/.bifrost/bin/extdecomp. Returns undefined when none is found,
// leaving the binary path unset so the decompiler reports that it cannot
// tell. Only existence is probed: no config file under ~/.bifrost is read.
export function discoverextdecompBinary(deps: extdecompDiscoveryDeps): string | undefined {
  const direct = (deps.extdecompBin ?? "").trim();
  if (direct.length > 0) {
    return direct;
  }
  const pathValue = deps.pathEnv ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) {
      continue;
    }
    const candidate = `${dir}/extdecomp`;
    let found = false;
    try {
      found = deps.existsSync(candidate);
    } catch {
      // A failing probe counts as absent; keep looking.
    }
    if (found) {
      return candidate;
    }
  }
  const home = (deps.homeDir ?? "").trim();
  if (home.length > 0) {
    const candidate = `${home}/.bifrost/bin/extdecomp`;
    let found = false;
    try {
      found = deps.existsSync(candidate);
    } catch {
      // A failing probe counts as absent.
    }
    if (found) {
      return candidate;
    }
  }
  return undefined;
}

function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        return true;
      }
    } catch {
      // Not up yet; retry until the deadline.
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(500);
  }
}

const KILL_GRACE_MS = 5000;
const READY_TIMEOUT_MS = 120000;

// Re-executes this script under the given Node 22 binary with the same
// arguments, then never returns: signals go to the child and the parent
// exits with the child exit code (or signal).
function reexecUnderNode22(bin: string, version: string): void {
  const shown = displayPathWithHome(bin, homedir());
  process.stdout.write(`demo: re-running under Node 22 (${version}) from ${shown}\n`);
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(bin, ["--experimental-strip-types", scriptPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      [DEMO_REEXEC_MARKER]: "1",
      PATH: `${dirname(bin)}${delimiter}${process.env["PATH"] ?? ""}`,
    },
  });
  process.on("SIGINT", () => {
    try {
      child.kill("SIGINT");
    } catch {
      // The child already exited; its exit handler finishes the parent.
    }
  });
  process.on("SIGTERM", () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child already exited; its exit handler finishes the parent.
    }
  });
  child.on("exit", (code, signal) => {
    if (signal !== null) {
      try {
        process.kill(process.pid, signal);
      } catch {
        // Falling through to a non-zero exit when self-signal fails.
      }
      process.exit(1);
      return;
    }
    process.exit(code ?? 1);
  });
}

async function runDemo(): Promise<void> {
  const runningVersion = process.versions.node;
  if (!isNode22Version(runningVersion)) {
    if (process.env[DEMO_REEXEC_MARKER] === "1") {
      fail(buildNode22LoopMessage(runningVersion));
    }
    const home = homedir();
    const bin = findNode22Binary(node22Candidates(process.env["NODE22_BIN"], home), {
      existsSync,
      isExecutable: isExecutablePath,
      getVersion: probeNode22Version,
    });
    if (bin === undefined) {
      fail(buildNode22MissingMessage(runningVersion));
    }
    reexecUnderNode22(bin, probeNode22Version(bin) ?? "v22.x");
    // The re-exec parent only forwards signals until the child exits.
    await new Promise<never>(() => undefined);
  }
  const root = repoRoot();
  if (!existsSync(join(root, "node_modules"))) {
    fail("missing dependencies: run `npm install`, then `npm run demo` again.");
  }
  if (!existsSync(join(root, "apps", "web", "node_modules"))) {
    fail("missing web dependencies: run `npm --prefix apps/web install`, then `npm run demo` again.");
  }

  // Precedence: the user environment wins over `.env.local`, which wins
  // over the demo defaults; the generated per-run key is the last
  // fallback. Only names are logged, never values.
  const localParsed = readEnvLocalFile(root, {
    existsSync,
    readFileSync: (path) => readFileSync(path, "utf8"),
  });
  const { env: withLocal, applied: localApplied } = applyEnvLocal(process.env, localParsed);
  if (localApplied.length > 0) {
    process.stdout.write(`.env.local: applied ${localApplied.length} variable(s): ${localApplied.join(", ")}\n`);
  }
  const { env: defaultedEnv, applied } = withDemoDefaults(withLocal);
  if (applied.length > 0) {
    process.stdout.write(`demo defaults applied for: ${applied.join(", ")}\n`);
  }
  // Meta provider defaults run before secret-file indirection: the
  // investigate default copies the assessment Meta key file pointer, so
  // the single resolution pass below fills both keys.
  const assessed = withDemoAssessmentDefault(defaultedEnv);
  if (assessed.defaulted) {
    process.stdout.write("assessment provider: defaulted to meta-model-api (key file set)\n");
  }
  const investigated = withDemoInvestigateDefault(assessed.env);
  if (investigated.defaulted) {
    process.stdout.write("investigate provider: defaulted to meta-model-api (key file set)\n");
  }
  // Opt-in overlays default to the same single Meta key file, per field;
  // explicit overlay values always win.
  const explained = withDemoExplainDefault(investigated.env);
  if (explained.defaulted) {
    process.stdout.write("explain provider: defaulted to meta-model-api (key file set)\n");
  }
  const chatted = withDemoChatDefault(explained.env);
  if (chatted.defaulted) {
    process.stdout.write("chat provider: defaulted to meta-model-api (key file set)\n");
  }
  const rugged = withDemoRugDefault(chatted.env);
  if (rugged.defaulted) {
    process.stdout.write("rug provider: defaulted to meta-model-api (key file set)\n");
  }
  const resolved = resolveSecretFileVars(rugged.env, root, (path) => readFileSync(path, "utf8"));
  for (const name of resolved.failed) {
    process.stdout.write(`warning: unreadable secret file for ${name}; leaving it unset.\n`);
  }
  const personalized = withDemoPersonalizeDefault(resolved.env);
  if (personalized.defaulted) {
    process.stdout.write("personalize provider: defaulted to meta-model-api (key loaded)\n");
  }
  const marketed = withDemoMarketDefault(personalized.env);
  if (marketed.defaulted) {
    process.stdout.write("market provider: defaulted to dexscreener\n");
  }
  const sourced = withDemoSourceDefault(marketed.env);
  if (sourced.defaulted) {
    process.stdout.write("source provider: defaulted to sourcify\n");
  }
  const keyed = ensureDemoApiKey(sourced.env, () => `demo-local-${randomBytes(16).toString("hex")}`);
  const demoEnv = keyed.env;
  if (keyed.generated) {
    process.stdout.write(`demo api key: generated per-run local key ${keyed.preview} (full key never printed).\n`);
  } else {
    process.stdout.write("demo api key: using configured BRANDKLIPPAREN_API_KEYS.\n");
  }
  process.stdout.write(`${demoAssessmentStatus(demoEnv)}\n`);
  process.stdout.write(`${demoInvestigateStatus(demoEnv)}\n`);
  process.stdout.write(`${demoExplainStatus(demoEnv)}\n`);
  process.stdout.write(`${demoChatStatus(demoEnv)}\n`);
  process.stdout.write(`${demoRugStatus(demoEnv)}\n`);
  process.stdout.write(`${demoLpFeedStatus(demoEnv)}\n`);
  process.stdout.write(`${demoMarketStatus(demoEnv)}\n`);
  process.stdout.write(`${demoSourceStatus(demoEnv)}\n`);
  const extdecomp = discoverextdecompBinary({
    extdecompBin: process.env["extdecomp_BIN"],
    pathEnv: process.env["PATH"],
    homeDir: process.env["HOME"],
    existsSync,
  });
  if (extdecomp === undefined) {
    process.stdout.write(
      "extdecomp: none found (checked extdecomp_BIN, `extdecomp` on PATH and $HOME/.bifrost/bin/extdecomp); continuing without it.\n",
    );
  } else {
    demoEnv["BRANDKLIPPAREN_extdecomp_BINARY_PATH"] = extdecomp;
    process.stdout.write(`extdecomp: ${extdecomp}\n`);
  }

  const restPort = demoEnv["BRANDKLIPPAREN_HTTP_PORT"] ?? DEMO_DEFAULT_REST_PORT;
  const restBase = `http://127.0.0.1:${restPort}`;
  const webUrl = `http://localhost:${DEMO_WEB_PORT}`;

  // Same Node binary for both children, so the checked version above is
  // the one that runs them.
  const nodeBin = process.execPath;
  const rest = spawn(nodeBin, ["--experimental-strip-types", join(root, "src", "main.ts"), "rest"], {
    cwd: root,
    env: demoEnv,
    stdio: "inherit",
  });
  const webBin = join(root, "apps", "web", "node_modules", "vite", "bin", "vite.js");
  const web = spawn(nodeBin, [webBin, "--strictPort"], {
    cwd: join(root, "apps", "web"),
    // VITE_DEMO_API_KEY is dev-only: the web app reads it solely as the
    // initial API key field value when running under `vite dev`, and a
    // production build never sets it.
    env: { ...demoEnv, VITE_REST_ORIGIN: restBase, VITE_DEMO_API_KEY: keyed.webKey },
    stdio: "inherit",
  });
  const children: ReadonlyArray<{ readonly name: string; readonly child: ChildProcess }> =
    Object.freeze([
      { name: "rest", child: rest },
      { name: "web", child: web },
    ]);

  let shuttingDown = false;
  const waitForExit = (child: ChildProcess): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => {
        resolve();
      });
    });

  const shutdown = async (code: number, signal: NodeJS.Signals): Promise<never> => {
    if (shuttingDown) {
      await sleep(60000);
      process.exit(code);
    }
    shuttingDown = true;
    for (const { child } of children) {
      try {
        child.kill(signal);
      } catch {
        // The child already exited; the wait below observes it.
      }
    }
    await Promise.race([Promise.all(children.map(({ child }) => waitForExit(child))), sleep(KILL_GRACE_MS)]);
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child exited between the check and the kill.
        }
      }
    }
    await Promise.all(children.map(({ child }) => waitForExit(child)));
    process.exit(code);
  };

  for (const { name, child } of children) {
    child.on("exit", (code, signal) => {
      if (shuttingDown) {
        return;
      }
      const detail = code !== null ? `exited with code ${code}` : `died on ${String(signal)}`;
      process.stderr.write(`demo: ${name} ${detail}; stopping the other process.\n`);
      void shutdown(1, "SIGTERM");
    });
  }
  process.on("SIGINT", () => {
    void shutdown(0, "SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown(0, "SIGTERM");
  });

  process.stdout.write(`demo starting: rest ${restBase}, web ${webUrl} ...\n`);
  const [restUp, webUp] = await Promise.all([
    waitForHttp(`${restBase}/health`, READY_TIMEOUT_MS),
    waitForHttp(webUrl, READY_TIMEOUT_MS),
  ]);
  if (!restUp || !webUp) {
    const missing = [!restUp ? "rest" : null, !webUp ? "web" : null].filter(
      (part): part is string => part !== null,
    );
    process.stderr.write(`demo: ${missing.join(" and ")} did not answer in time; stopping.\n`);
    await shutdown(1, "SIGTERM");
  }
  process.stdout.write(`demo ready: open ${webUrl} (REST ${restBase})\n`);
  // Run until a signal or a child exit triggers shutdown above.
  await new Promise<never>(() => undefined);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  void runDemo().catch((error: unknown) => {
    fail(`demo failed: ${error instanceof Error ? error.message : "unknown error"}`);
  });
}
