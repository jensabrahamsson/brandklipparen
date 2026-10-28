// Deterministic plugin audit CLI (S-053, K-516, P-13): `plugin audit`
// as `npm run audit:plugins`. Developer tooling, not the analysis path:
// it reads plugin directories, runs the deterministic static checks from
// `src/plugins/audit.ts`, prints the three states on separate lines and
// writes the report JSON to `audits/<pluginId>.json`. A deterministic
// failure exits non-zero and blocks the AI phase; with `--ai` and a
// configured hosted key the advisory AI phase runs after a deterministic
// pass. Human review arrives as a sidecar file
// `audits/reviews/<pluginId>.json` maintained by reviewers; its presence
// records the review, its absence leaves `missing`. Usage:
//   node --experimental-strip-types scripts/plugin-audit.ts --all
//   node --experimental-strip-types scripts/plugin-audit.ts --plugin <id> [--ai]
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUDITS_DIR = join(repoRoot, "audits");
const REVIEWS_DIR = join(AUDITS_DIR, "reviews");

// Static plugin directory map (reviewed dev tooling): plugin id to its
// directory. New plugins add one line here in the same reviewed change;
// the registry path itself never reads this map.
const PLUGIN_DIRS: Readonly<Record<string, string>> = Object.freeze({
  "dev.brandklipparen.capability": "src/plugins/detectors/capability",
  "dev.brandklipparen.clone-match": "src/plugins/detectors/clone-match",
  "dev.brandklipparen.hard-to-analyze": "src/plugins/detectors/hard-to-analyze",
  "dev.brandklipparen.example-fee-capability": "examples/plugins/fee-capability",
});

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function listSourceFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules") {
          continue;
        }
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push({ path: full.slice(repoRoot.length + 1), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(join(repoRoot, dir));
  out.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return out;
}

function sanitizeId(pluginId: string): string {
  return pluginId.replace(/[^A-Za-z0-9]+/g, "_");
}

async function auditOne(pluginId: string, withAi: boolean): Promise<boolean> {
  const dir = PLUGIN_DIRS[pluginId];
  if (dir === undefined) {
    console.error(`unknown plugin id: ${pluginId}`);
    return false;
  }
  const { buildPluginRegistry, DEFAULT_DETECTOR_PLUGINS } = await import("../src/plugins/registry.ts");
  const built = buildPluginRegistry(DEFAULT_DETECTOR_PLUGINS);
  if (!built.ok) {
    console.error(`registry failed validation: ${built.error.kind}`);
    return false;
  }
  const entry = built.value.entries.find((candidate) => candidate.manifest.id === pluginId);
  if (entry === undefined) {
    console.error(`plugin ${pluginId} is not registered; example plugins audit from their directory manifest`);
  }
  const sources = listSourceFiles(dir);
  const docsPath = join(repoRoot, dir, "PLUGIN.md");
  const docsMarkdown = existsSync(docsPath) ? readFileSync(docsPath, "utf8") : undefined;

  // Manifest resolution: registry entry first, else the directory's
  // manifest export (example plugins).
  let manifest: unknown = entry?.manifest;
  if (manifest === undefined) {
    const manifestModule = await import(join(repoRoot, dir, "manifest.ts"));
    const exported = Object.values(manifestModule).find(
      (value) => value !== null && typeof value === "object" && (value as { kind?: unknown }).kind === "detector",
    );
    manifest = exported;
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    (manifest as { kind?: unknown }).kind !== "detector"
  ) {
    console.error(`no detector manifest resolves for ${pluginId}`);
    return false;
  }
  const { auditDeterministic } = await import("../src/plugins/audit.ts");
  const deterministic = auditDeterministic(
    manifest as Parameters<typeof auditDeterministic>[0],
    sources,
    docsMarkdown,
  );
  const reviewPath = join(REVIEWS_DIR, `${sanitizeId(pluginId)}.json`);
  const humanReview = existsSync(reviewPath) ? "recorded" : "missing";

  type AiState =
    | { kind: "advisory"; findings: readonly unknown[]; provider: string; modelId: string }
    | { kind: "not-run" }
    | { kind: "not-configured" }
    | { kind: "invalid-output" };
  let ai: AiState = { kind: "not-run" };
  if (deterministic.passed && withAi) {
    const { runPluginAudit } = await import("../src/plugins/audit.ts");
    const { createhostedAuditAdapterFromConfig } = await import(
      "../src/adapters/audit/hostedAuditAdapter.ts"
    );
    const { SecretString } = await import("../src/ports/config.ts");
    const { ModelId, PromptVersion, RequestId, Timestamp } = await import("../src/domain/types.ts");
    const { randomUUID } = await import("node:crypto");
    const baseUrl = process.env["BRANDKLIPPAREN_AUDIT_hosted_BASE_URL"];
    const key = process.env["BRANDKLIPPAREN_AUDIT_hosted_API_KEY"];
    const model = process.env["BRANDKLIPPAREN_AUDIT_hosted_MODEL_ID"];
    const builtAdapter = createhostedAuditAdapterFromConfig({
      audithostedBaseUrl: baseUrl,
      audithostedApiKey: key === undefined ? undefined : new SecretString(key),
      audithostedModelId:
        model === undefined
          ? undefined
          : (() => {
              const parsed = ModelId.parse(model);
              if (!parsed.ok) {
                throw new Error("audit model id is invalid");
              }
              return parsed.value;
            })(),
    });
    if (!builtAdapter.ok) {
      console.error(`audit adapter failed: ${builtAdapter.error.kind}`);
      return false;
    }
    const promptVersion = PromptVersion.parse("1.0.0");
    if (!promptVersion.ok) {
      throw new Error("audit prompt version is invalid");
    }
    const requestId = RequestId.parse(randomUUID());
    if (!requestId.ok) {
      throw new Error("audit request id is invalid");
    }
    const deadline = Timestamp.of(Date.now() + 60000);
    if (!deadline.ok) {
      throw new Error("audit deadline is invalid");
    }
    const report = await runPluginAudit(
      {
        manifest: manifest as Parameters<typeof runPluginAudit>[0]["manifest"],
        sources,
        docsMarkdown,
        auditFiles: [
          ...sources.map((file) => ({ path: file.path, sha256: sha256(file.text), quotedContent: file.text })),
          ...(docsMarkdown === undefined
            ? []
            : [{ path: `${dir}/PLUGIN.md`, sha256: sha256(docsMarkdown), quotedContent: docsMarkdown }]),
        ],
        promptVersion: promptVersion.value,
        humanReview: humanReview as "recorded" | "missing",
      },
      {
        adapter: builtAdapter.value,
        ctx: {
          requestId: requestId.value,
          deadline: deadline.value,
          block: "latest",
        },
      },
    );
    ai = report.ai as AiState;
  }

  const reportJson = {
    pluginId,
    version: (manifest as { version?: unknown }).version ?? "unknown",
    deterministic:
      deterministic.passed
        ? { kind: "pass" }
        : { kind: "fail", failures: deterministic.failures },
    ai,
    humanReview,
  };
  mkdirSync(AUDITS_DIR, { recursive: true });
  writeFileSync(join(AUDITS_DIR, `${sanitizeId(pluginId)}.json`), `${JSON.stringify(reportJson, null, 2)}\n`);
  // The three states print on separate lines so no single line reads as
  // an approval on its own (P-13).
  console.log(`deterministic: ${deterministic.passed ? "pass" : "fail"}`);
  console.log(`ai: ${ai.kind}`);
  console.log(`human-review: ${humanReview}`);
  if (!deterministic.passed) {
    for (const failure of deterministic.failures) {
      console.log(`failure: ${failure.kind} ${failure.message}`);
    }
  }
  return deterministic.passed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const withAi = args.includes("--ai");
  let ids: string[];
  if (args.includes("--all")) {
    ids = Object.keys(PLUGIN_DIRS);
  } else {
    const flag = args.indexOf("--plugin");
    const id = flag === -1 ? undefined : args[flag + 1];
    if (id === undefined) {
      console.error("usage: plugin-audit.ts --all | --plugin <id> [--ai]");
      process.exit(2);
    }
    ids = [id];
  }
  let failed = false;
  for (const id of ids) {
    console.log(`plugin: ${id}`);
    const passed = await auditOne(id, withAi);
    if (!passed) {
      failed = true;
    }
  }
  if (failed) {
    process.exit(1);
  }
}

await main();
