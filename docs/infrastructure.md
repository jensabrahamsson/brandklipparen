# Infrastructure Rules: Brandklipparen

Author: Jens Abrahamsson.
Status: Final version for the build 27/10–4/11 2026.
Reading guide: The requirements (K-IDs) live in `docs/requirements.md`.
The architecture rules (A-xx) live in `docs/architecture.md`. Threats with
countermeasures (H-xx, M-xx) live in `docs/threat-model.md`. This file owns
the infrastructure rules (I-xx) and the versioned operations configuration:
the limits for extdecomp and the ports under K-008 and A-17, the rate and
quota limits under K-504, and the cost caps under K-107.
The risk model's detection thresholds, weights and limits are learned and
calibrated from data and are versioned only in the calibration artifact
under K-210 and K-211. Each rule below is phrased positively and states
its K-, A- and M-IDs. Section 12 collects the traceability.

## 1. CI

**I-01 Green gate in CI with named jobs in fixed order.** The project
runs the gate in GitHub Actions on every push and every pull request.
The jobs run in the order in the table as a chain where each job starts
only after the previous job in the chain is green, and merging to the
main branch requires every blocking job to be green. Each job has a
time limit in the workflow file, and a new push to the same branch
cancels the older gate run on that branch through a `concurrency` group
per branch. Branch protection on the main branch lists the same jobs as
required status checks with the same names as the table.
(K-105, K-106, K-506, A-06, A-22, M-12)

| Nr | Job | Contents | Blocks merge |
|---|---|---|---|
| 1 | `lint` | Lint for TypeScript and Python in `offline/` and format check | Yes |
| 2 | `typecheck` | `tsc --noEmit` in strict mode under A-26 | Yes |
| 3 | `boundaries` | `dependency-cruiser` under A-06 with the configuration `.dependency-cruiser.cjs` | Yes |
| 4 | `test` | Unit, property, golden, contract, integration and e2e tests under A-22, only against fakes and frozen fixtures under A-23 and A-24 | Yes |
| 5 | `coverage` | Coverage measurement; core line coverage holds at least 90 % under K-105, and the report is saved as an artifact per run | Yes |
| 6 | `determinism` | Golden tests and bit-identity check under I-16 | Yes |
| 7 | `dependency-review` | Dependency review: the lockfile is current, dependencies are installed from the lockfile, vulnerability scanning of dependencies runs, and pinned references are checked under I-03–I-05 | Yes |
| 8 | `gitleaks` | Secret scanning of the change and, at release, of the full history under I-02 | Yes |
| 9 | `sast` | Static security analysis (SAST) of the TypeScript code; findings at the highest severity level turn the job red | Yes |
| 10 | `license-check` | License check of all dependencies against the allowlist under I-04 | Yes |
| 11 | `build` | Reproducible build of web UI, REST API, MCP server and extdecomp worker under I-04–I-06, with a build log stating versions and checksums | Yes |

Each job runs on an ephemeral runner with the checked-in lockfiles as
the only dependency source, and each job uploads its report (coverage,
scan results, build log) as a named artifact on the run.
The `test`, `coverage` and `determinism` jobs run with outbound network
disabled; fixtures and recorded responses carry all test content under
A-24. The `dependency-review` job runs dependency review against the
change's lockfile, the job's vulnerability scan reads the same lockfile,
and the `license-check` job reads the license allowlist in the repo
under I-04. The `sast` job runs the pinned SAST configuration in the repo
over the TypeScript code, and findings at the highest severity level
turn the job red.
A deliberately broken test, type error or boundary violation turns the
gate red in the respective job, so the gate's enforcement stays tested
itself under A-06 and A-21. (K-101, K-102, K-105)

Acceptance: The CI check `i01_required_jobs_block_merge` reads the
workflow file and branch protection and requires jobs 1–11 to be present
in the table's order as required status checks with a `needs` chain in
the same order; an introduced test failure, type error or boundary
violation turns the gate red in the corresponding job, and a change with
a red blocking job stays unmerged.

**I-02 Secret scanning in CI and before commit.** The project scans
with gitleaks in three modes: as a local pre-commit hook, as job 8 in
the gate under I-01 on every change, and over the full history before
every release and before publication under I-15. The hook and CI run
the same gitleaks version and the same rule configuration in the repo,
and the hook is installed from the repo's pinned tool manifest at clone
time under the run instructions in I-15, so local scanning and CI
scanning give the same result on the same change. (K-505, M-11)

Acceptance: The CI check `k505_gitleaks_clean_on_repo_and_history`
runs gitleaks over the repo and the full history with zero hits as the
green result; a local test with an inserted key pattern shows that the
pre-commit hook stops the commit, and the same pattern turns the
`gitleaks` job red in CI.

**I-03 Pinned Actions and least privilege.** The project pins
every GitHub Action to a full commit SHA (40 hex characters) with a
version comment alongside. Each workflow and each job declares an
explicit `permissions` block; `GITHUB_TOKEN` receives read permission
by default per the table, and write permission is given per job only
for the resource the job writes. Upgrading an Action happens as its
own change that swaps the SHA and the version comment together and
requires a green gate under I-01. Secrets from the secret store are
exposed only to the jobs that name them, and each job uses secrets
only for scanning and release, with analysis run against fakes under
I-01. (K-506, M-11, M-12)

| Job group under I-01 | `GITHUB_TOKEN` permission | Secrets from secret store |
|---|---|---|
| `lint`, `typecheck`, `boundaries`, `test`, `coverage`, `determinism` | `contents: read` | Only names from `.env.example` under I-08; the run uses fakes and fixtures |
| `dependency-review`, `gitleaks`, `sast`, `license-check` | `contents: read` | Scan-related secrets only in the job that names them |
| `build` | `contents: read`; `id-token: write` only when the build artifact is signed for the demo under I-11 | Deploy secret only in the demo release run under I-11 |

Acceptance: The CI check `i03_actions_pinned_and_least_privilege`
searches the workflow files for Action references and requires a full
commit SHA on every reference and an explicit `permissions` block per
job; a reference to a tag or branch and a job with a missing permission
block turn the job red.

## 2. Reproducible builds

**I-04 Locked dependencies and license allowlist.** The project installs
all dependencies reproducibly from lockfiles: `package.json` with a
lockfile for the TypeScript chain and `offline/pyproject.toml` with a
lockfile for the Python chain under A-28 and A-29. Installation in CI
and locally happens in locked mode, so the lockfile controls every
installed version exactly.
Each dependency's license is checked against the allowlist in the repo
in job 10 under I-01, and the vulnerability scan in job 7 blocks release
on a hit at the highest severity level. Dependency upgrades happen as
separate changes with a green gate and an updated lockfile in the same
change.
(K-506, A-29, M-12)

Acceptance: The CI check `k506_clean_clone_installs_from_lockfile`
installs from the lockfile in a clean environment and requires
bit-identical installed versions against the lockfile; the CI check
`k506_license_allowlist_blocks_release` requires a green license against
the allowlist, and an introduced dependency with a license outside the
allowlist or with a known vulnerability at the highest severity level
turns the job red.

**I-05 Pinned runtime, pinned tools and pinned extdecomp.**
The project pins the runtime, the package manager and every tool to an
exact version: Node.js and the package manager under A-29 in `.nvmrc` and
`package.json`, Python for `offline/` under A-29, and lint,
type checking, the test runner, `dependency-cruiser`, gitleaks and
the SAST tool in a lockfile or tool manifest in the repo. extdecomp
is pinned to an exact version and SHA-256 checksum in the manifest
`tools/extdecomp/manifest.json` in the repo; the manifest states version,
download source and checksum per platform. The build downloads the
binary, verifies the checksum against the manifest and writes the
version and checksum to the build log before every decompilation run,
and the start of the extdecomp worker verifies the same checksum before
the first decompilation under I-11. The same pinned versions hold
locally, in CI and in the demo under I-07.
(K-008, K-102, K-506, A-27, A-29, M-12)

Acceptance: The CI check
`k506_pinning_and_vulnerability_scan_block_release` requires the
build log to state the version and checksum for extdecomp and every
pinned tool; a changed byte in the extdecomp binary produces a checksum
mismatch and a red build before start.

**I-06 Digest-pinned images and frozen fixtures with code hash.**
The project pins every container image and every base image to a
digest (`@sha256:…`) in the build and operations definitions, and the
build log in job 11 under I-01 reports the base image digest, extdecomp's
version and checksum under I-05 and the lockfiles' versions, so every
demo build is reproducible from the log. Test fixtures are fetched
fresh from public on-chain sources by the project itself during the
hackathon and are frozen in `tests/fixtures/` with address, block
number, bytecode, code hash and source per fixture under A-24. Timing
tests, golden tests and the bit-identity check under I-16 run against
the frozen fixtures with the network disabled. (K-101, K-102, K-201,
K-404, A-24)

Acceptance: The review `k404_fixtures_fetched_fresh_with_provenance`
requires address, block number, bytecode, code hash and source on every
fixture; the integration test `i06_fixtures_replay_offline` replays
the golden suite with the network disabled and requires the same code
hash and the same expected output per fixture on replay.

## 3. Environments

**I-07 Three environments with documented differences.** The project runs
three environments with the same code, the same model version and the
same calibration artifact: local development, test/CI and public demo.
The differences sit in network, keys, data and scale per the table.
The demo states the model version and artifact checksum visibly
in the web UI and in every API response under K-102 and K-402. (K-102,
K-402)

| Environment | Network | Keys | Data | Scale |
|---|---|---|---|---|
| Local | Outbound calls only for explicit fixture fetching under A-24; tests run against recorded fixtures | Only names in `.env.example` under I-08; the developer's own keys in a local environment variable for live debugging | Frozen fixtures with code hash | One developer |
| Test/CI | Outbound network disabled in the test, coverage and determinism jobs under I-01 | CI secrets from the GitHub Actions secret store only for scanning and release under I-03 | Frozen fixtures with code hash | Ephemeral runners, one job per gate step |
| Demo | Outbound calls only to allowlisted RPC hosts and the selected assessment provider (Meta Model API or hosted) under I-11, I-13 and I-18 | Real keys in the platform secret store under I-09 | Fresh public on-chain data that the project fetches itself | Public, quota-limited under I-12 and I-14 |

Acceptance: The integration test `i07_test_suite_makes_no_network_calls`
runs the test suite with a network fake that counts every outbound call
and requires zero calls; the integration test
`k402_demo_shows_submission_model_version` requires the demo to state
the same model version as the submission in the UI and API responses.

## 4. Configuration

**I-08 Typed configuration validated at startup.** The project reads
all configuration from environment variables with the prefix
`BRANDKLIPPAREN_` and validates it at startup against a typed schema
through `ConfigPort` under A-05. The schema states per variable: name,
type, valid range or valid values, default value where one exists, and
in which environments the variable is required. Startup builds the typed
configuration value first and starts the services only with a valid value
in place; a missing or invalid variable produces a startup error within
seconds that names the variable with the values kept outside the error
text under K-505. The `.env.example` file in the repo carries the same
variable names as the schema, with a description per variable and empty
value fields. The table below is the schema in short form; the typed
schema in the code is normative and is kept in the same change as this
table. (K-008, K-503, K-505, A-05, A-15, M-07, M-11)

| Variable | Purpose | Secret | Required in |
|---|---|---|---|
| `BRANDKLIPPAREN_ENV` | Environment choice: `local`, `ci` or `demo` | No | All |
| `BRANDKLIPPAREN_HTTP_PORT` | Listen port for REST API and MCP locally and in the demo | No | Local, demo |
| `BRANDKLIPPAREN_RPC_URLS` | Allowlisted RPC endpoints for Ethereum mainnet, comma-separated; the key is carried in the URL or header at the provider | Yes | Demo |
| `BRANDKLIPPAREN_CHAIN_ID` | Chain ID for Ethereum mainnet, validated against the RPC response | No | Demo |
| `BRANDKLIPPAREN_MODEL_VERSION` | Version of the calibration artifact that the core loads under K-211 | No | All |
| `BRANDKLIPPAREN_MODEL_ARTIFACT_PATH` | Path inside the repo to `model/artifact-<version>.json` under A-20 | No | All |
| `BRANDKLIPPAREN_CLONE_INDEX_VERSION` | Version of the clone index under K-017 | No | All |
| `BRANDKLIPPAREN_extdecomp_DEADLINE_MS` | Time limit per decompilation under A-17 and I-11 | No | All |
| `BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB` | Memory limit per extdecomp worker under A-17 and I-11 | No | All |
| `BRANDKLIPPAREN_extdecomp_MAX_OUTPUT_BYTES` | Size limit for decompiled output under A-17 and I-11 | No | All |
| `BRANDKLIPPAREN_extdecomp_MAX_CONCURRENCY` | Number of parallel extdecomp workers under A-17 | No | Demo |
| `BRANDKLIPPAREN_extdecomp_BINARY_PATH` | Path to the decompiler executable: the pinned extdecomp binary in the demo per I-05, the fake worker script in tests | No | Local, demo |
| `BRANDKLIPPAREN_RPC_DEADLINE_MS` | Time limit per RPC call under A-17 | No | Demo |
| `BRANDKLIPPAREN_RPC_MAX_CONCURRENCY` | Parallel RPC calls under A-17 | No | Demo |
| `BRANDKLIPPAREN_RPC_RETRY_BUDGET` | Retries with backoff rate per RPC call under A-17 | No | Demo |
| `BRANDKLIPPAREN_RPC_MAX_RESPONSE_BYTES` | Size limit for RPC responses under A-17 | No | Demo |
| `BRANDKLIPPAREN_ASSESSMENT_DEADLINE_MS` | Time limit per assessment call under A-17, for both providers under I-13 | No | Demo |
| `BRANDKLIPPAREN_ASSESSMENT_MAX_INPUT_BYTES` | Input size limit per assessment call under A-17, for both providers | No | Demo |
| `BRANDKLIPPAREN_ASSESSMENT_MAX_OUTPUT_BYTES` | Output size limit per assessment call under A-17, for both providers | No | Demo |
| `BRANDKLIPPAREN_ASSESSMENT_MAX_CONCURRENCY` | Parallel assessment calls under A-17, for both providers | No | Demo |
| `BRANDKLIPPAREN_DEMO_PUBLIC_URL` | Canonical public demo URL that the README links under I-12 and I-15 | No | Demo |
| `BRANDKLIPPAREN_CACHE_DIR` | Directory or volume for cache per code hash under K-013 | No | Local, demo |
| `BRANDKLIPPAREN_API_KEY_PEPPER` | Secret component in the salted hashing of API keys under K-510 | Yes | Demo |
| `BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE` | Rate limit per API key under I-12 | No | Demo |
| `BRANDKLIPPAREN_QUOTA_PER_KEY_PER_DAY` | Daily quota per API key under I-12 | No | Demo |
| `BRANDKLIPPAREN_GLOBAL_RATE_PER_MINUTE` | Global rate limit for the demo under I-12 | No | Demo |
| `BRANDKLIPPAREN_BUDGET_DAILY_CAP_RPC_CALLS` | Daily cap for RPC calls in the demo under I-14 | No | Demo |
| `BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_RPC_CALLS` | Daily cap for RPC calls per API key under I-14 | No | Demo |
| `BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS` | Daily cap for assessment calls for the selected provider under I-14 | No | Demo |
| `BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_META` | Daily cap for Meta Model API assessment calls under I-14 | No | Demo with the Meta provider selected |
| `BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_hosted` | Daily cap for hosted open-weights assessment calls under I-14 and I-18 | No | Demo with the hosted provider selected |
| `BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_ASSESSMENT_CALLS` | Daily cap for assessment calls per API key under I-14, for both providers | No | Demo |
| `BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_META` | Daily cost cap for the Meta Model API provider under I-14 | No | Demo with the Meta provider selected |
| `BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_hosted` | Daily cost cap for the hosted provider under I-14 and I-18 | No | Demo with the hosted provider selected |
| `BRANDKLIPPAREN_ALARM_LEVELS_PERCENT` | Alarm levels in percent of the daily caps under I-14 | No | Demo |
| `BRANDKLIPPAREN_LOG_LEVEL` | Log level: `debug`, `info`, `warn` or `error` under I-10 | No | All |
| `BRANDKLIPPAREN_ASSESSMENT_PROVIDER` | Selected assessment provider under K-309: `meta-model-api` or `hosted-open-weights`; exactly one adapter is bound at startup per A-34 | No | Demo |
| `BRANDKLIPPAREN_ASSESSMENT_PROMPT_VERSION` | Prompt version for the Muse contract assessment; part of the cache key per K-305 and K-309 | No | Demo |
| `BRANDKLIPPAREN_ASSESSMENT_META_API_KEY` | Key for the Meta Model API (Muse Spark), server-side only under I-13 | Yes | Demo with the Meta provider selected |
| `BRANDKLIPPAREN_ASSESSMENT_META_MODEL_ID` | Model id for the Meta Model API provider, shown per assessment under K-305 | No | Demo with the Meta provider selected |
| `BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL` | Allowlisted endpoint for the Meta Model API, validated at startup under K-503 | No | Demo with the Meta provider selected |
| `BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY` | Key for hosted (Muse Spark Open), server-side only under I-13 and I-18 | Yes | Demo with the hosted provider selected |
| `BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID` | Model id for the hosted provider: `meta-models/muse-spark-open-1026` per K-309 | No | Demo with the hosted provider selected |
| `BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL` | Allowlisted endpoint for the hosted deployment, validated at startup under K-503 and I-18 | No | Demo with the hosted provider selected |
| `BRANDKLIPPAREN_ASSESSMENT_hosted_DEPLOYMENT_ID` | Deployment identifier for the hosted open-weights serving under I-18 | No | Demo with the hosted provider selected |
| `BRANDKLIPPAREN_INVESTIGATE_hosted_BASE_URL` | Allowlisted endpoint for the investigation deployment, validated at startup under K-503; unset leaves the loop answering not-configured | No | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_hosted_API_KEY` | Key for the investigation deployment (Muse Spark Open), server-side only under K-505 | Yes | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_hosted_MODEL_ID` | Model id for the investigation loop: `meta-models/muse-spark-open-1026` per K-036 | No | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_DEADLINE_MS` | Wall-clock budget per investigation under A-17 | No | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_MAX_INPUT_BYTES` | Input size budget per investigation call under A-17 | No | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_MAX_OUTPUT_BYTES` | Output size budget per investigation call under A-17 | No | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_MAX_STEPS` | Step budget per investigation under A-17 | No | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_MAX_TOKENS` | Token budget per investigation under A-17 | No | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_TOOL_TIMEOUT_MS` | Per-tool deadline per investigation under A-17 | No | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_PROMPT_VERSION` | Prompt version for the investigation cache key per K-036 | No | Demo with the investigation loop enabled |
| `BRANDKLIPPAREN_INVESTIGATE_DAILY_CAP_PER_KEY` | Daily cap for investigations per API key under I-14 | No | Demo with the investigation loop enabled |
| `ETHERSCAN_API_KEY` | Free Etherscan API key for the LP pairs feed logs source, server-side only under K-505 | No | Operator polling with the feed enabled |
| `BRANDKLIPPAREN_FEED_RPC_URL` | Optional JSON-RPC endpoint for the feed `eth_getLogs` fallback, server-side only under K-505 | No | Operator polling with the fallback enabled |
| `BK_WETH_ADDRESS` | Canonical WETH address used as the WETH quote side for the feed | No | Operator polling with the feed enabled |

The selected provider's variables are required in the demo per the
table; the other provider's key stays in the secret store for a
configuration switch. Ahead of an explicit assessment request, the
analysis path runs with zero assessment calls under I-16. The operations limits in the table are filled
with values in the versioned operations configuration under I-11, I-12
and I-14; the risk model's learned values live only in the calibration
artifact under K-210.

Acceptance: The startup test `k505_missing_variable_named_without_values`
requires that startup with a required variable removed produces a
startup error within seconds with the variable name in the error text;
the startup test `k505_keys_read_from_environment_at_start` requires
that keys are read from the environment at startup; the CI check
`i08_env_example_has_names_only` compares `.env.example` against the
schema and requires the same names with empty value fields; the
integration test
`k309_config_selects_exactly_one_assessment_adapter` runs startup with
each provider selection and requires exactly one bound adapter with
the selected provider and model id in the health response.

## 5. Secrets

**I-09 Secrets in the secret store with least privilege, rotation
and leak procedure.** The project stores every key and secret in the
platform secret store: the GitHub Actions secret store for CI and the
Modal secret store for the demo under I-11. The keys reach the runtime
only as environment variables at startup under I-08, and the repo carries
only variable names in `.env.example` under I-08 with the scanning
under I-02 as the check. Each new key is created in Jens
Abrahamsson's name for this project, with least privilege
for its task: read permission for RPC access, separate keys
per environment (local, CI and demo under I-07), and a dedicated key per
assessment provider (Meta Model API and hosted per K-309 and I-18).
Each provider key is scoped to its provider and model, stored in the
platform secret store, and rotated on the same schedule. Each key has a
record outside the repo with owner (Jens Abrahamsson), purpose, scope,
environment, creation date, expiry date and rotation date. Rotation
happens per the schedule in the record and always before the demo and
before publication under I-15, so each key the demo starts with
holds a valid expiry date after the assessment period. A leaked
or suspected leaked key is handled in exactly this order:

1. The key is blocked and revoked at the issuer.
2. A new key is created in Jens Abrahamsson's name for the project with
   the same least privilege.
3. The new key is placed in the platform secret store, and the service
   is rolled out so the next call uses the new key under
   K-510.
4. The health check under I-12 runs green on the new key.
5. The repo and the history are scanned with gitleaks under I-02, and
   the logs for the key's validity period are reviewed for usage.
6. The incident is documented in `docs/decisions/log.md` with date, the key's
   purpose, scope and steps taken, with the key value kept outside
   the record. (K-505, K-509, K-510, M-11)

Acceptance: The review `i09_each_key_has_owner_scope_rotation`
requires owner, purpose, scope and rotation date on every
key record outside the repo; the integration test
`k510_rotation_and_revocation_without_restart` requires that rotation
and revocation hold from the next call; the drill
`i09_leaked_key_drill_follows_steps` runs the leak procedure steps 1–6 on
a test key and requires a completed record in `docs/decisions/log.md` per
step; the CI check `k505_gitleaks_clean_on_repo_and_history`
requires zero hits after the procedure.

## 6. Logging

**I-10 Structured logging with field allowlist, redaction and
request ID.** The project logs in structured form as JSON through `pino`
under A-29, one record per event. Each call receives a request ID
at the boundary (`RequestId` under A-10) that follows the analysis through
the application service, the cache, the extdecomp worker and the
assessment call after an explicit request, and that is returned in every API
response under K-023. Each field in each log line belongs to the field
allowlist in the table; the schema for log records is versioned in the
repo and each field outside the list is stopped by the log schema before
output. (K-104, K-509, A-29, M-16)

| Field | Contents |
|---|---|
| `timestamp`, `level`, `service`, `environment` | Time, level (`debug`, `info`, `warn`, `error`), service name, environment under I-07 |
| `requestId` | Correlation ID for the whole analysis |
| `apiKeyId` | The key's ID from the hashed storage under K-510, as an identifier for consumption |
| `address`, `codeHash`, `skeletonHash` | Analysed address and its hash values |
| `blockNumber` | Block number for the on-chain reads under K-102 |
| `modelVersion`, `artifactChecksum`, `indexVersion`, `templateVersion` | Versions that make the analysis reproducible under K-102 |
| `stepDurationsMs`, `outcome` | Step times for the fast path and deep dive, and the typed outcome or error branch under A-15 |
| `rpcCallCount`, `assessmentCallCount`, `cacheHit` | Consumption per analysis under K-107 and cache outcome under K-013 |
| `assessmentProvider`, `assessmentModelId`, `promptVersion` | Selected provider, model id and prompt version per assessment under K-305 and K-309 |
| `decompilerVersion`, `explanationSchemaVersion` | Versions for extdecomp and the assessment schema under K-305 |

Redaction happens in the logging library configuration with named
paths (`req.headers.authorization`, `req.headers.*key*`,
`*.apiKey`, `*.rpcUrl` and the corresponding fields for both assessment
provider keys):
API keys, `Authorization` headers and other
authentication headers, RPC URLs with an embedded key, and both
assessment provider keys are replaced with a fixed redaction marker before output.
Timestamps are written in UTC, and the logs go to the process stdout
so the platform under I-11 collects them per container and day.
Prompts are logged as prompt version and evidence IDs under K-302, with
the prompt text kept outside the log. Errors are logged as a typed
error branch and machine-readable code under A-15 and A-18, with stack
traces only in local debugging at `debug` level and kept outside the demo
log extract. The log levels are used as follows: `debug` for step
details in local development, `info` for each completed analysis, `warn`
for typed error branches with continued operation (timeout in the deep
dive, a cache entry that is rejected) and `error` for errors that abort
the analysis or the startup.

Acceptance: The unit test `k509_log_fields_follow_allowlist` requires
that each emitted log record holds to the allowlist above;
the unit test `k509_key_like_strings_redacted_in_output` feeds
key-like strings, headers and key-carrying URLs through
every log path and requires the redaction marker in all output;
the unit test `k104_analysis_log_has_required_fields` requires
request ID, address, code hash, model version, step times and outcome
on every analysis log; the review
`k509_demo_log_output_reviewed_before_submission` reviews the
demo's log extract before submission against the same allowlist.

## 7. Demo operations

**I-11 Public demo on Modal with extdecomp in a sandbox.** The project
operates the public demo on Modal during the assessment period.
The choice is based on the shape of the workload: the demo is a CPU- and
RPC-bound analysis service with bursty, isolation-sensitive
decompilation and with the Muse contract assessment through the
selected provider under I-13 and I-18, so the platform's value for the
project is scaling to zero
between calls, sandbox execution per worker, the secret store and
HTTPS endpoints in the same platform. The partner credits are compared in
the table, and Modal is chosen for the demo application:

| Platform (credit) | Fit for the demo | Role in the project |
|---|---|---|
| Modal | Web endpoints, containers that scale to zero, sandboxes per worker, volumes and secret store in the same platform | Chosen platform for the public demo application under this rule |
| hosted | Serving of open-weight models with GPU inference as the core offering | Serves Muse Spark Open with model id `meta-models/muse-spark-open-1026` for the hosted assessment adapter under I-18 |
| Fireworks | Inference API for open models as the core offering | The project uses the Meta Model API and hosted per I-13 and I-18 for the assessment providers |

Brandklipparen serves its risk model as a frozen artifact in
the process under A-20 and delivers the Muse contract assessment
through the selected provider per K-309 (Meta Model API or hosted
open weights), so the demo application choice is decided by containers,
sandbox and operations in the same platform.
(K-008, K-402, K-501, A-17, A-20, A-27, M-01, M-02)

| Component | Runs as | Contents |
|---|---|---|
| Web UI | Static files that Modal serves on the same HTTPS domain as the API | Start page, token page and timeline under K-020–K-022, with the REST API as the only data source under A-04 |
| REST API and MCP server | Modal web endpoint, scalable container | Driving adapters over the same application service under K-027 |
| Application service and core | Same container as the API | `analyzeToken`, `resolveProxy`, `listJustDeployed` under A-02, with artifact and clone index loaded at startup |
| extdecomp worker | Modal sandbox, a dedicated process per decompilation | Pinned extdecomp under I-05 behind `DecompilerPort`; the sandbox holds bytecode as the only input flow, a read-only file system and outbound network disabled under M-01 |
| Cache and index | Modal volume | Cache entries per code hash and model version under K-013, clone index and calibration artifact as versioned files |
| Database for keys and consumption | Modal-managed storage behind the adapter | Salted key hashes, quotas and consumption per key under K-510 and I-14 |
| Assessment calls | Outbound HTTPS calls from the API container to the selected assessment provider (Meta Model API or hosted) | Solely after an explicit assessment request under I-13 and I-18 |
| RPC calls | Outbound HTTPS calls from the API container to allowlisted RPC hosts | Bytecode, storage and block number under K-001 |

Deployment of the demo happens from the CI job `build` under I-01 and
I-03 with the digest-pinned image under I-06, and each
deployment logs the image digest, model version and
artifact checksum under I-10. A deployment with a red health check
under I-12 is rolled back to the previous digest and
artifact version in the same run, so the demo URL under
`BRANDKLIPPAREN_DEMO_PUBLIC_URL` in I-08 keeps responding with the most
recent green version during the assessment period.

The operations limits for extdecomp and each external port are set from
the configuration under I-08 with A-17's fields per port: time
limit per call, size limit in and out, parallelism and
retry budget. The table below is operations configuration v1 for
the demo; each value change happens as a change to this file with a new
version, and the startup test under Acceptance compares the running
configuration against the table's version. The risk model's learned
values live only in the artifact under K-210.

| Limit (v1) | Configuration variable under I-08 | Holds for |
|---|---|---|
| Time limit per decompilation | `BRANDKLIPPAREN_extdecomp_DEADLINE_MS` | Every extdecomp run; exceeding the limit produces the error branch `timeout` under A-15 and the hard-to-analyse code signal under K-008 |
| Memory limit per worker | `BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB` | Every extdecomp sandbox; exceeding the limit produces the error branch `resource-limit` under A-15 |
| Output from decompilation | `BRANDKLIPPAREN_extdecomp_MAX_OUTPUT_BYTES` | stdout from extdecomp; exceeding the limit produces the error branch `output-too-large` under A-15 |
| Parallel workers | `BRANDKLIPPAREN_extdecomp_MAX_CONCURRENCY` | The demo environment; the analysis queues within its own time budget under K-101 |
| Time limit per RPC call | `BRANDKLIPPAREN_RPC_DEADLINE_MS` | Every RPC read; exceeding the limit produces the error branch `timeout` in `RpcPort` under A-15 |

Acceptance: The integration test
`k008_timeout_yields_hard_to_analyze_signal` requires that a
decompilation over the time limit produces the hard-to-analyse code
signal in the deep dive with the fast path's response intact;
the integration test `k501_pathological_input_isolates_to_its_analysis`
requires that parallel analyses continue during a pathological
run; the review `k008_limits_sourced_from_infra_config`
compares the running limits against table v1 in this rule;
the health check `k402_demo_serves_ui_rest_and_mcp` requires responses
from the web UI, REST API and MCP at the demo URL.

**I-12 HTTPS, health checks and rate limiting in the demo.**
The project exposes the demo only over HTTPS with the platform's
current TLS settings and a canonical demo URL
(`BRANDKLIPPAREN_DEMO_PUBLIC_URL` under I-08) that the README links
under I-15. The health check is publicly reachable at the path `/health`
and shows status per dependency (RPC, cache, extdecomp and the selected
assessment provider per K-309, with provider and model id) with model version and
artifact checksum, with secrets kept outside the response. Responses
from the demo carry the content security policy under K-507 on every
response, and the health check responds with the same version fields as
every API response under K-102, so the operator reads the running
version from `/health` before and after each deployment under I-11.
The call rate is limited per API key and globally, and a daily quota
holds per key; the limits are read from the configuration under I-08
and are summarised in the table. Exceeding a limit produces a
machine-readable error with the HTTP status for rate limiting exceeded
and a retry time under A-18. Expensive steps (extdecomp decompilation
and Muse contract assessment calls for either provider per K-309)
require a valid key with
remaining quota under K-504; cached responses are delivered within the
same rate limits and continue under the cost cap under I-14.
(K-024, K-102, K-104, K-402, K-504, K-507, A-18, M-08, M-09)

| Limit (v1) | Configuration variable under I-08 | Scope | On exceed |
|---|---|---|---|
| Rate per key per minute | `BRANDKLIPPAREN_RATE_LIMIT_PER_KEY_PER_MINUTE` | Each API key | Machine-readable error with retry time |
| Daily quota per key | `BRANDKLIPPAREN_QUOTA_PER_KEY_PER_DAY` | Each API key | Machine-readable error with retry time; expensive steps close for the key |
| Global rate per minute | `BRANDKLIPPAREN_GLOBAL_RATE_PER_MINUTE` | The whole demo environment | New analyses are rejected temporarily; cache hits keep responding |

Acceptance: The integration test
`k504_over_limit_returns_retryable_machine_error` requires a
machine-readable error with retry time on an exceeded limit;
the integration test `k504_expensive_steps_require_key_with_quota`
requires a valid key with remaining quota before each expensive step;
the load test `k504_limits_hold_under_overload_and_cache_serves`
requires that the limits hold under overload and that the cache
keeps responding; the integration test
`k402_public_health_check_reports_dependencies` requires public
health status per dependency with the model version in the response.

**I-13 Muse contract assessment is called server-side through the
selected provider.**
The project calls Muse only from the server through
`AssessmentModelPort` under A-05 and A-34. Muse is the product's
only AI model in the assessment. Configuration per I-08 selects exactly
one provider at startup: Meta Model API with Muse Spark through
`BRANDKLIPPAREN_ASSESSMENT_META_API_KEY`, or hosted open weights per
I-18 through `BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY`. Each key lives
in the platform secret store under I-09 and leaves the server only as
an authentication header to the selected provider's allowlisted
endpoint (`BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL` or
`BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL`), validated at startup
under K-503. Ahead of an explicit assessment request, each interface
shows the template text under K-301 and the analysis makes zero
assessment calls under I-16. After a request, the selected adapter
carries the closed evidence list under K-302, the response is validated
against the versioned assessment schema under K-305 with timeout and
input and output size limits per K-309, valid text is labelled with
provider and model id and cached per code hash, prompt version,
provider and model id under K-013, and each error branch produces the
template text under K-306 with the assessment field stating the
fallback. Both adapters are MVP per K-309; the demo default provider
is the open decision for Jens in section 13 of
`docs/requirements.md`, and the selected provider works in the demo in
either selection. (K-305, K-309, K-302, K-307, K-502, K-513, A-19,
A-34, M-03–M-07, M-20)

Acceptance: The integration test
`k305_no_assessment_call_until_user_requests_assessment` requires template
text in each interface and zero calls to `AssessmentModelPort` ahead
of a request, for each provider selection; the integration test
`k305_client_response_has_no_model_key` searches for key patterns for
both providers in each client response and requires zero hits;
the integration test
`k305_refined_text_cached_per_codehash_and_template_version`
requires that a cache hit with the full key per K-309 consumes zero new
assessment calls; the unit test
`k307_scores_and_evidence_identical_with_and_without_adapter`
requires bit-identical probabilities, scores, signals and evidence
with and without an assessment, for each adapter; the contract suite
`runAssessmentModelPortContract` is green against both adapters and
the fake per K-309.

**I-18 hosted deployment of the open-weight model.**
The project serves Muse Spark Open on hosted with model id
`meta-models/muse-spark-open-1026` for the hosted assessment adapter
per K-309. The deployment is configured through
`BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL`,
`BRANDKLIPPAREN_ASSESSMENT_hosted_MODEL_ID` and
`BRANDKLIPPAREN_ASSESSMENT_hosted_DEPLOYMENT_ID` under I-08, with the
key `BRANDKLIPPAREN_ASSESSMENT_hosted_API_KEY` in the platform secret
store under I-09. The deployment states model id, deployment id and
health in its operator view, scales within the cost cap per I-14, and
answers solely assessment requests from the demo server with the key
as a server-side header. Running on this deployment qualifies the
project for the bonus prize "Best Build on Meta Open Weight Models"
per K-309. The deterministic core runs in the demo application per
I-11 and makes zero calls to the deployment ahead of an explicit
assessment request. (K-305, K-309, K-402, K-513, A-34, M-09, M-20)

Acceptance: The integration test
`k309_hosted_adapter_uses_open_weights_model_id` requires model id
`meta-models/muse-spark-open-1026` and provider and model labelling on
each hosted assessment response; the contract suite
`runAssessmentModelPortContract` is green against the hosted adapter
over a recorded transport; the health check per I-12 shows the hosted
provider status with the deployment selected.

## 8. Costs

**I-14 Versioned cost caps with cache, alarms and ceiling.**
The project measures the cost per analysis in number of RPC calls and,
per assessment request, number of assessment calls and cost per
provider and model id separately under K-107 and K-309. Each analysis
sums its consumption per API key and writes
the sum to the log under I-10. The cache per code hash and
model version under K-013 reuses earlier responses, and the assessment
cache per code hash, prompt version, provider and model id reuses
assessment text, so a
cache hit consumes zero RPC calls and zero assessment calls and counts
as zero cost in each cap. Budget and cost ceilings are
configuration under I-08 with the values in table v1 below; each
value change happens as a change to this file with a new version.
Consumption is compared continuously against the ceilings, and the
alarms in the table fire at the alarm levels that
`BRANDKLIPPAREN_ALARM_LEVELS_PERCENT` states, always before the ceiling.
Each alarm is written as a structured `warn` record under I-10 with key
ID, consumption and remaining share, and the same levels are shown on
the health check under I-12, so the operator sees approaching ceilings
in the log and health response before the ceiling. On reaching the daily
ceiling, the service closes the expensive paths (new
extdecomp decompilations and assessment calls for the selected provider)
and keeps responding with
cache hits and the fast path's cached content, so the demo
stays reachable during the assessment period.
The measurement, the ceilings and the alarm levels hold for the demo
environment; local development and CI run against fixtures and consume
zero paid calls under I-07. (K-013, K-107, K-504, K-513, M-08, M-09)

| Cap (v1) | Configuration variable under I-08 | Scope | Enforced through |
|---|---|---|---|
| At most one assessment call per uncached request | Fixed rule in the assessment path per K-305 | Each assessment request, both providers | Caching per code hash, prompt version, provider and model id under K-013 and K-309, with call counting per request in the log under I-10 |
| Zero external calls on a cache hit | `CacheKey` under A-10 | Each cache hit | Cache lookup before RPC, extdecomp and assessment in the request path |
| Daily cap for RPC calls in the demo | `BRANDKLIPPAREN_BUDGET_DAILY_CAP_RPC_CALLS` | The whole demo environment | Consumption measurement per day; alarm at the configured alarm levels before the ceiling; expensive paths close at the ceiling |
| Daily cap for RPC calls per key | `BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_RPC_CALLS` | Each API key | Consumption measurement per key and day; the key's expensive steps close at the ceiling |
| Daily cap for assessment calls (selected provider) | `BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS` | The whole demo environment, selected provider | Consumption measurement per day; assessment calls close at the ceiling and the template text under K-301 keeps responding |
| Daily cap for Meta assessment calls and cost | `BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_META`, `BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_META` | Meta Model API provider | Per-provider measurement; alarm before the cap; assessment calls close at the cap |
| Daily cap for hosted assessment calls and cost | `BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_hosted`, `BRANDKLIPPAREN_ASSESSMENT_DAILY_COST_CAP_hosted` | hosted open-weights provider per I-18 | Per-provider measurement; alarm before the cap; assessment calls close at the cap |
| Daily cap for assessment calls per key | `BRANDKLIPPAREN_BUDGET_PER_KEY_DAILY_CAP_ASSESSMENT_CALLS` | Each API key, both providers | Consumption measurement per key, provider and day; the key's assessment steps close at the ceiling |
| At most one investigation per uncached request | Fixed rule in the investigation path per K-036 | Each investigation request | Caching per code hash, prompt version, provider and model id, with the trace replayed from the recorded-trace library |
| Daily cap for investigations per key | `BRANDKLIPPAREN_INVESTIGATE_DAILY_CAP_PER_KEY` | Each API key | Consumption measurement per key and day; the key's investigation steps close at the ceiling with a typed `budget-exhausted` outcome and the deterministic analysis standing |
| Alarm levels before the ceiling | `BRANDKLIPPAREN_ALARM_LEVELS_PERCENT` | Each daily cap above, for RPC and both assessment providers | Alarm to the operator at each passed level, with key ID, provider, consumption and remaining share in the alarm |

Costs for Modal, hosted, the RPC provider and the Meta Model API are
tracked per day and per provider during the assessment period against
the ceilings above, and
the consumption report per key and provider is saved with the day's logs
under I-10.

Acceptance: The integration test
`k013_cache_hit_skips_decompilation_and_external_calls` requires
zero external calls on a cache hit; the integration test
`k107_analysis_sums_rpc_and_assessment_calls` requires summed
consumption per analysis, key, provider and model id; the integration test
`k107_no_request_zero_assessment_calls_and_cost` requires zero
assessment calls and zero assessment cost ahead of an explicit request;
the integration test `k107_alarm_fires_before_cap` requires an alarm
before the ceiling at simulated consumption for RPC and for each
assessment provider; the integration test
`k513_cost_caps_and_alerts_apply_to_both_providers` requires per-provider
caps and alerts; the load test
`k504_limits_hold_under_overload_and_cache_serves` requires that
cached responses continue when the ceiling has closed the expensive paths.

## 9. Publication

**I-15 Checklist before publication of the repo.** The project makes
the repo public at submission when each item in the checklist is
green in the same run of the review script
`i15_publication_checklist`. The script runs each item as a
separate check with the result pass or fail per item
and writes the result to the change's review record.
(K-402, K-403, K-404, K-405, K-505, K-506)

1. Gitleaks over the full history is green under I-02, with zero
   hits on secrets and key patterns.
2. The licence lives in the repo and gives the jury the right to assess
   and reuse the project under K-403.
3. The README describes the product, the architecture with the hexagonal
   structure under A-01, the use of Muse as the build tool through
   Muse Code under section 9 of `docs/requirements.md`, the deterministic
   analysis under K-102, the Muse contract assessment per K-305 and
   K-309 with both providers and the run
   instructions for the demo locally.
4. The run instructions are verified from a clean clone on a
   second machine under K-403: installation from the lockfile,
   typed configuration under I-08 with the variable names from
   `.env.example`, and startup of web UI, REST API and
   MCP server produce green health checks.
5. The repo carries only relative paths inside the repo; the script
   searches for absolute paths and home directories in text files and
   requires zero hits.
6. The repo carries only invented example data; example addresses
   are written as `0x1234…`, and real key values, real
   wallets and internal addresses occur with zero hits
   in the script's searches.
7. The calibration artifact's checksum in `model/` is verified
   against the artifact under K-211, and the model card under K-208
   follows the same model version as the demo states under K-402.
8. The demo's log extract is reviewed against the field allowlist under
   I-10, and the threat model is reviewed in full under its
   section 1 with each H-xx linked to an M-xx.
9. The documents name Jens Abrahamsson as author.
10. The demo responds at the canonical URL in
    `BRANDKLIPPAREN_DEMO_PUBLIC_URL` under I-08 and I-12 with
    a green health check at `/health` and the same model version and
    artifact checksum as the submission under K-402.

Acceptance: The review test `i15_publication_checklist` runs
items 1–10 and requires ten passes before publication;
the review `k403_readme_covers_product_architecture_run`
requires the README to cover product, architecture and running;
the review
`k403_clean_clone_instructions_verified_on_second_machine`
requires a signed record from the second machine; the review
`k405_submission_reachable_before_deadline` requires a timestamped
check record before 5/11 2026 03:00 Swedish time.

## 10. Determinism and reproducible training

**I-16 Deterministic analysis and reproducible calibration in
CI.** The project holds the whole analysis deterministic and
the training chain reproducible, with the checks run in CI as
job 6 `determinism` under I-01. The analysis (detection, scores,
calibration and evidence) consists only of deterministic steps
and RPC reads; the same bytecode and the same block number produce
a bit-identical result with the same evidence in each run,
process and machine under K-102. Explanations are by default
template-based and deterministic under K-301. (K-102, K-209,
K-211, K-301, K-305, K-307, A-07, A-20, A-28)

The training chain in `offline/` under A-28 runs with locked seeds in
a versioned seed configuration in the repo, pinned
Python versions and pinned dependencies in the lockfile under I-04
and I-05 and the same data version on replay. The chain exports
the calibration artifact `model/artifact-<version>.json` with a
SHA-256 checksum over the artifact's canonical form under A-20;
the checksum is checked in to the repo together with the artifact,
the model card and the evaluation report, so the same data version and
the same seeds produce a bit-identical artifact with the same checksum
on retraining. Thresholds, weights and limits in the artifact
are learned and calibrated from data under K-210 and are reported in
the evaluation report under K-209.

The CI checks in job 6 run in this order on each change
that touches code, templates, artifact or fixtures:

1. The golden tests on frozen bytecode fixtures under I-06,
   with fixed expected serialised output per fixture under
   K-102.
2. The bit-identity check, which runs the same frozen selection in two
   separate processes and compares the serialised output
   byte for byte under K-102.
3. The retraining check on changes in `offline/` and
   `model/`, which trains twice from the same data version and
   the same locked seeds and compares the artifacts byte for byte
   including checksum under K-211.
4. The model-call check, which runs the analysis with a network fake
   and requires that outbound calls go only to the RPC port
   and that `AssessmentModelPort` receives zero calls ahead of an
   explicit assessment request, for each provider selection.

The assessment provider selection and keys are configuration under
I-08, I-13 and I-18: `BRANDKLIPPAREN_ASSESSMENT_PROVIDER` selects
exactly one adapter, and the selected provider's key is required in
the demo. The deterministic analysis path makes zero assessment calls;
the assessment happens solely after an explicit request, after the
computed result is frozen, and leaves scores and evidence
bit-identical under K-307. The deterministic core builds zero prompts
and receives zero model output per K-502.

Acceptance: The golden tests `k102_golden_fixtures_bit_identical`
require bit-identical serialised output per frozen fixture;
the integration test `k102_two_runs_across_processes_bit_identical`
requires byte-identical output between two processes; the review
`k102_cross_machine_replay_bit_identical` requires byte-identical
output on a second machine; the evaluation test
`k211_training_uses_locked_seeds` requires that the logged seeds
match the seed configuration;
the evaluation test
`k211_retraining_reproduces_artifact_bit_identical` requires
byte-identical artifacts including checksum on retraining;
the unit test `k211_wrong_checksum_rejected_before_analysis`
requires a typed error before the first analysis on a wrong checksum;
the integration test `k102_analysis_path_makes_no_model_calls`
requires zero calls to `AssessmentModelPort` ahead of an explicit
request; the evaluation test `k209_same_seed_and_data_give_same_report`
requires an equal report at equal seed and data version.

## 11. Updating the rules

**I-17 Changes to the operations configuration.** The project changes
operations limits, rate and quota values, cost ceilings, alarm levels,
configuration variables and the CI gate through a change to this
file with a new version on the affected table (v1, v2, …) in the same
change as code and tests. Each new I-rule receives the next free I-ID,
and each changed rule keeps its I-ID, so the references from
`docs/requirements.md`, `docs/architecture.md` and
`docs/threat-model.md` stay valid. New
configuration variables are added at the same time to the table in I-08
and to `.env.example`. (K-008, K-210, K-405)

Acceptance: The review `docs_referenced_ids_defined_in_owner_files`
requires a definition in this file per I-ID that the other documents
reference; the review `k008_limits_sourced_from_infra_config`
requires that the running operations values match the tables' current
version in this file.

## 12. Traceability

Each I-rule realises named requirements and countermeasures:

| Rule | K-IDs | A-IDs | M-IDs |
|---|---|---|---|
| I-01 | K-101, K-102, K-105, K-106, K-506 | A-06, A-21, A-22 | M-12 |
| I-02 | K-505 | — | M-11 |
| I-03 | K-506 | — | M-11, M-12 |
| I-04 | K-506 | A-29 | M-12 |
| I-05 | K-008, K-102, K-506 | A-27, A-29 | M-12 |
| I-06 | K-101, K-102, K-201, K-404 | A-24 | — |
| I-07 | K-102, K-402 | — | — |
| I-08 | K-008, K-503, K-505 | A-05, A-15 | M-07, M-11 |
| I-09 | K-505, K-509, K-510 | — | M-11 |
| I-10 | K-104, K-509 | A-10, A-29 | M-16 |
| I-11 | K-001, K-008, K-402, K-501 | A-02, A-04, A-17, A-20, A-27 | M-01, M-02 |
| I-12 | K-024, K-102, K-104, K-402, K-504, K-507 | A-18 | M-08, M-09 |
| I-13 | K-305, K-309, K-302, K-307, K-502, K-513 | A-05, A-19, A-34 | M-03, M-04, M-05, M-06, M-07, M-20 |
| I-18 | K-305, K-309, K-402, K-513 | A-34 | M-09, M-20 |
| I-14 | K-013, K-107, K-504, K-513 | A-10 | M-08, M-09 |
| I-15 | K-402, K-403, K-404, K-405, K-406, K-505, K-506 | A-01 | — |
| I-16 | K-102, K-209, K-211, K-301, K-305, K-307 | A-07, A-20, A-28 | — |
| I-17 | K-008, K-210, K-405 | — | — |

K-210 occurs in I-17 as a boundary: operations changes through
this file leave the risk model's learned values to the artifact
under K-210 and K-211.
