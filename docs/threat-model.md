# Threat model: Brandklipparen

Author: Jens Abrahamsson.
Status: final version for the build 27/10–4/11 2026.
Reading guide: the requirements (K IDs) are owned by `docs/requirements.md`.
Architecture rules (A-xx) are in `docs/architecture.md`,
infrastructure rules (I-xx) and the versioned operational configuration
are in `docs/infrastructure.md`. This file owns the threats (H-xx) and
the countermeasures (M-xx). Every M-xx points to at least one K-5xx requirement in
`docs/requirements.md`, and every M-xx states a named test method.
ID scheme and concepts follow `docs/requirements.md`.
Example addresses are written as `0x1234…`.

## 1. Security modelling requirements

1. The threat model is updated in the same change as a new component, a new
   port or a new data flow. The change describes the component,
   its STRIDE rows, affected trust boundaries and new or
   affected H-xx/M-xx before merge.
2. The threat model is reviewed in full before the demo and before
   publication of the repo. The review checks that every H-xx
   has at least one M-xx with a K-5xx ID and a named test method, that every
   M-xx points to a K-5xx that exists in `docs/requirements.md`, and
   that the attack surface list in section 7 matches the built code.
3. Every threat (H-xx) has at least one countermeasure (M-xx). Every countermeasure
   states a description, a K-5xx ID and a test method with a named test,
   a named fuzz target or a named CI check.
4. New K-5xx IDs are added to the security section and the MVP table in
   `docs/requirements.md` in the same change, so the documents agree
   in both directions as per section 12.2 there.
5. Residual risks and assumptions in section 9 are read through at every
   review. A residual risk with a built countermeasure moves to an
   H-xx with an associated M-xx.
6. All countermeasures and rules in this file are phrased positively:
   every M-xx describes the built protection and its verification.

## 2. System overview and data flows

### 2.1 Components

The components follow the module boundaries in `docs/architecture.md`
(A-01, A-04, A-05). Driving adapters call the shared
application service; driven adapters each implement one port.

| Component | Module as per `docs/architecture.md` | Responsibility | Requirements |
|---|---|---|---|
| Web UI | `apps/web` | Static surface: search field, Just deployed list, token page and timeline. Talks to the core solely through the REST API's published schema and carries solely UI types. | K-020–K-022, K-027 |
| REST API | `interfaces/rest` | Versioned API under `/v1`: key check, schema validation, calls to the application service, schema-validated response and uniform error format. | K-023, K-024 |
| MCP server | `interfaces/mcp` | Reading tools over the same application service, with published input schemas. | K-025, K-026 |
| Application service | `application` | Exactly three services: `analyzeToken`, `resolveProxy` and `listJustDeployed`. Orchestrates ports, the key and quota step and the deepening. | K-027 |
| Domain core | `domain` | Pure functional core: types, proxy resolution, selector and pattern matching, signals, risk function, evidence, can't tell list and template-based explanations. The core performs zero I/O. | K-010–K-012, K-017, K-301 |
| RPC adapter | `adapters/rpc` behind `RpcPort` | Bytecode, storage, calls and block number against Ethereum mainnet via allowlisted RPC hosts. | K-001, K-016 |
| extdecomp worker | `adapters/extdecomp` behind `DecompilerPort` | Decompilation in its own isolated process per run, with bytecode as the sole input. | K-008 |
| Selector and clone adapters | `adapters/selectors`, `adapters/clones` behind `SelectorTablePort`, `CloneIndexPort` | Local, synchronous lookups: selector to name suggestion and risk relevance; code hash and skeleton hash matching against known templates. | K-009, K-017 |
| Cache adapter | `adapters/cache` behind `CachePort` | Reading and writing analysis results per code hash and model version. | K-013 |
| Model artifact adapter | `adapters/model` behind `ModelArtifactPort` | Loading and checksum verification of the frozen calibration artifact at startup. | K-011, K-210, K-211 |
| Muse assessment adapters | `adapters/assessment/metaModelApi` and `adapters/assessment/hostedOpenWeights` behind `AssessmentModelPort` | Free-text Muse contract assessment through the selected provider, solely server-side and solely on request: Meta Model API with Muse Spark, or hosted with Muse Spark Open (`meta-models/muse-spark-open-1026`). | K-305, K-309, K-502, K-513 |
| DeploymentFeed adapter | `adapters/feed` behind `DeploymentFeedPort` | Recently deployed tokens for the Just-deployed feed. | K-014, K-015 |
| Clock and configuration adapters | `adapters/clock`, `adapters/config` behind `ClockPort`, `ConfigPort` | Current time as a value to the core; validated operational configuration as a typed value at startup. | K-102, K-104 |
| Composition root | `composition` | The sole module that knows concrete adapter classes. Binds every port to exactly one adapter and hands a ready `AppServices` to the driving adapters. | K-027 |
| Offline chain | `offline/` (Python) | Dataset, training, calibration and evaluation with locked seeds. Delivers solely the versioned model artifact under `model/` to the runtime. | K-201–K-211 |
| Configuration and secrets | Platform secret store, environment variables as per I-08 and I-09 | Typed configuration validated at startup; keys solely as environment variables from the secret store. | K-505, K-510 |
| CI and supply chain | GitHub Actions gate as per I-01 | Locked dependencies, pinned tools and Actions, extdecomp binary with checksum, secret, vulnerability and licence scanning. | K-506 |

The ports are normative as per A-05: `RpcPort`, `DecompilerPort`,
`SelectorTablePort`, `CloneIndexPort`, `CachePort`, `AssessmentModelPort`,
`ModelArtifactPort`, `DeploymentFeedPort`, `ClockPort` and
`ConfigPort`. Every port file carries the interface, the error union as per A-15 and
the limits as per A-17. Every call carries a `CallContext` with
correlation ID, absolute deadline and block context.

### 2.2 Data flows

Flow IDs F-01–F-08 from the first draft are kept with the same
meaning. F-09–F-16 are added for flows the draft lacked:
artifact, feed, selector/clone, external calls behind the adapters,
configuration, time and the build chain.

```mermaid
flowchart TB
    USER["User, bot or MCP client"]
    WEB["apps/web: web UI"]
    REST["interfaces/rest: REST API /v1"]
    MCP["interfaces/mcp: MCP server"]
    APP["application: analyzeToken, resolveProxy, listJustDeployed"]
    CORE["domain: pure core"]
    RPCA["adapters/rpc"]
    HEIM["adapters/extdecomp: isolated worker"]
    SEL["adapters/selectors, adapters/clones"]
    CACHE["adapters/cache"]
    FEED["adapters/feed"]
    MODEL["adapters/model: artifact with checksum"]
    MUSEA["adapters/assessment: selected adapter"]
    CONF["ConfigPort, ClockPort, secret store"]
    LOGG["Structured logs, health check"]
    RPCN["Allowlisted RPC nodes, Ethereum mainnet"]
    META["Meta Model API: Muse Spark"]
    hosted["hosted: Muse Spark Open, meta-models/muse-spark-open-1026"]
    OFF["offline/: training and calibration"]
    CI["CI: build and deployment"]

    USER -->|F-01 address, API key in header| REST
    USER -->|F-01 address via web UI| WEB
    WEB -->|F-01 address, call against published schema| REST
    USER -->|F-02 tool call with address| MCP
    REST -->|F-03 validated address, key identity| APP
    MCP -->|F-03 validated address, key identity| APP
    APP --> CORE
    APP -->|F-04 address, slot, block via RpcPort| RPCA
    RPCA -->|F-13 bytecode, storage, block number| RPCN
    RPCN -->|F-13 RPC response| RPCA
    APP -->|F-05 bytecode via DecompilerPort| HEIM
    HEIM -->|F-05 decompiled functions and snippets| APP
    APP -->|F-11 selector, code hash, skeleton hash| SEL
    APP <-->|F-07 result per code hash and model version| CACHE
    APP -->|F-09 page size via DeploymentFeedPort| FEED
    FEED -->|F-09 recently deployed tokens| APP
    MODEL -->|F-10 verified artifact at startup| APP
    OFF -->|F-10 versioned artifact under model/| MODEL
    CONF -.->|F-14 typed configuration and time at startup and per call| APP
    APP -->|F-06 closed evidence list via AssessmentModelPort, solely on request| MUSEA
    MUSEA -->|F-12 assessment call to selected provider, server-side| META
    MUSEA -->|F-12 assessment call to selected provider, server-side| hosted
    META -->|F-12 validated assessment text with provider and model id| MUSEA
    hosted -->|F-12 validated assessment text with provider and model id| MUSEA
    APP -->|F-08 analysis log with allowlisted fields| LOGG
    CI -->|F-16 pinned artifacts, image and demo deployment| REST
    CI -->|F-16 pinned extdecomp binary| HEIM
```

| ID | Flow | Content | Crosses boundary |
|---|---|---|---|
| F-01 | Client → web UI and REST API; web UI → REST API | Contract address as `0x1234…`, filter and page size; API key in header to REST for API callers. The web UI calls the same API through the published schema and renders the response as text. | B1, B8 |
| F-02 | Client → MCP server | Tool call, in the MVP `assess_token` with an address parameter against the published input schema. | B1, B8 |
| F-03 | REST API and MCP server → application service | Validated `Address` as a typed domain value, key identity as hash ID and quota state. | B2 |
| F-04 | Application service ↔ RPC adapter via `RpcPort` | Address, slot and block number out; bytecode, storage words and call responses in, bound to block number. | B3, B6 |
| F-05 | Application service ↔ extdecomp worker via `DecompilerPort` | Bytecode out as the sole input; decompiled functions and snippets in under the output limit. | B4, B5 |
| F-06 | Application service ↔ selected Muse assessment adapter via `AssessmentModelPort` | Closed typed evidence list out; validated assessment text in with provider and model id. The flow is active solely on request as per section 6. | B3, B6 |
| F-07 | Application service ↔ cache via `CachePort` | Analysis result keyed on code hash and model version; assessment text keyed on code hash, prompt version, provider and model id. | B3, B6 |
| F-08 | Application service and adapters → logs and health check | Allowlisted fields as per I-10: request-id, address, code hash, versions, step times, outcome and consumption. Health status per dependency on `/health`. | B7, B8 |
| F-09 | Application service ↔ DeploymentFeed adapter via `DeploymentFeedPort` | Page size out; list of recently deployed tokens with address, block and deploy time in. | B3, B6 |
| F-10 | Offline chain → model artifact → application service via `ModelArtifactPort` | Versioned artifact with model version, checksum, training data version and explanation schema version; verified on loading before the first analysis. | B9 |
| F-11 | Application service ↔ selector and clone adapters | Selector out and name suggestion with risk relevance in; code hash and skeleton hash out and clone hit with index version in. Local and synchronous lookups. | B3 |
| F-12 | Selected Muse assessment adapter → selected provider (Meta Model API or hosted) | Closed evidence list out with the provider key as a server-side header to the selected allowlisted endpoint; validated assessment text in with provider and model id. Active solely on request as per section 6. | B5, B6 |
| F-13 | RPC adapter → RPC nodes | `eth_getCode`, `eth_getStorageAt`, `eth_call` and block number to allowlisted hosts with the provider key in URL or header. | B5, B6 |
| F-14 | Configuration, secrets and clock → composition root, application service and adapters | Typed operational configuration at startup, keys as environment variables from the secret store and current time as a `Timestamp` value per call. | B7 |
| F-15 | Application service → client via web UI, REST API and MCP server | Assessment with probabilities, grade, signals with evidence, can't tell list, template-based explanation and, on request, clearly marked Muse-refined text. The response side of F-01 and F-02. | B8 |
| F-16 | CI and build chain → running components and demo | Installed dependencies from lockfile, pinned extdecomp binary with verified checksum, digest-pinned image, model artifact and deployment to the demo. | B9 |

The fast path as per K-101 consists of F-01/F-02, F-03, F-04/F-13,
F-11, F-07 and F-15 with a template-based explanation from the core.
The deepening adds F-05. The Muse contract assessment is a separate
on-request delivery through F-06/F-12 beside the analysis response,
with provider and model id shown. The assessment leaves the fast
path's probabilities, grade, signals and evidence bit-identical
as per K-307.

## 3. Trust boundaries

The zones follow the components in section 2.1. Every flow in
section 2.2 that crosses a boundary B1–B9 has STRIDE rows in
section 4 and at least one H-xx in section 5.

```mermaid
flowchart LR
    subgraph Z0["Z0: untrusted client zone"]
        USER["User, bot, MCP client"]
    end
    subgraph Z1["Z1: public interfaces"]
        WEB["apps/web"]
        REST["interfaces/rest"]
        MCP["interfaces/mcp"]
        HEALTH["/health"]
    end
    subgraph Z2["Z2: trusted core"]
        APP["application"]
        CORE["domain: pure core"]
    end
    subgraph Z3["Z3: driven adapters and storage"]
        RPCA["adapters/rpc"]
        SEL["adapters/selectors, adapters/clones"]
        CACHE["adapters/cache"]
        FEED["adapters/feed"]
        MODEL["adapters/model"]
        CLOCK["adapters/clock, adapters/config"]
    end
    subgraph Z4["Z4: isolated decompilation"]
        HEIM["extdecomp worker: own process, sandbox"]
    end
    subgraph Z5["Z5: external services"]
        RPCN["Allowlisted RPC nodes"]
        META["Meta Model API"]
        hostedZ["hosted open weights"]
    end
    subgraph Z6["Z6: secrets, build and training"]
        SEC["Secret store and environment variables"]
        CI["CI gate and build chain"]
        OFF["offline/: training with locked seeds"]
    end
    USER --> Z1
    Z1 --> Z2
    Z2 --> Z3
    Z2 --> Z4
    Z3 --> Z5
    Z2 --> Z5
    Z6 -.->|F-14, F-16| Z1
    Z6 -.->|F-10, F-14, F-16| Z2
    Z6 -.->|F-16| Z4
```

| Boundary | Flows | What crosses the boundary | Conditions at passage |
|---|---|---|---|
| B1: Z0 → Z1 | F-01, F-02 | Address, filter, page size, API key in header, MCP tool call | Schema validation and key check before the first analysis step (M-08, M-10, M-15). |
| B2: Z1 → Z2 | F-03 | Validated address and key identity | Solely typed domain values through smart constructors as per A-11; raw text stays in the driving adapter (M-10, M-15). |
| B3: Z2 → Z3/Z4 | F-04, F-05, F-06, F-07, F-09, F-11 | Address and block to the RPC adapter, bytecode to extdecomp, evidence list to the selected Muse assessment adapter, keys to cache and feed and lookup values to the selector and clone adapters | Calls go solely through the ports as per A-05 with `CallContext`, deadline and limits as per A-17 (M-01, M-07, M-20). |
| B4: Z2 → Z4 | F-05 out | Bytecode as the sole input to the extdecomp worker | Bytecode is treated as hostile input; the worker runs in its own process with a time limit, a memory limit, outbound networking switched off and a read-only filesystem as per I-11 (M-01). |
| B5: Z3/Z2 → Z5 | F-12, F-13 | RPC calls to allowlisted nodes; assessment calls to the selected provider (Meta Model API or hosted) after an explicit request | Targets are fetched solely from validated configuration as per I-08, I-13 and I-18; server-side provider keys; a valid key with remaining quota before expensive steps (M-07, M-08, M-09, M-20). |
| B6: Z5/Z4/Z3 → Z2 | F-04 in, F-05 in, F-06 in, F-07 in, F-09 in, F-13 in | RPC responses, decompiled code, provider assessment output, cache entries, feed entries and lookup responses | Boundary validation at the boundary as per A-16, size limits as per A-17 and typed error branches as per A-15; provider and model identity is verified per M-20; contract strings pass `UntrustedText.quote` as per A-10 (M-02, M-05, M-14, M-20). |
| B7: Z6 → Z1/Z2 | F-08 out, F-14 in | Configuration and keys at startup; logs and health responses out | Keys are read solely from the environment at startup and are logged solely in redacted form; log fields follow the allowlist as per I-10 (M-11, M-16). |
| B8: Z1/Z2 → Z0 | F-15, the response side of F-01 and F-02 and F-08 | Assessment, evidence, explanations, MCP output and health status | Contract data and explanation text are rendered as text with a strict CSP in the web UI; MCP output is marked as untrusted data with a size limit (M-13, M-15). |
| B9: Z6 → Z2/Z4 | F-10, F-16 | Model artifact from the offline chain; dependencies, extdecomp binary, image and demo deployment from CI | The artifact checksum is verified on loading; dependencies are installed from lockfile, binary and image are pinned on checksum and digest respectively (M-12, M-17). |

## 4. STRIDE per component and data flow

Every table covers the component and its flows. Flow IDs in
parentheses state the flows in section 2.2. The letters stand for
S spoofing, T tampering, R repudiation, I information disclosure,
D denial of service and E elevation of privilege. Handling states
the governing countermeasure; the threats with full descriptions are in
section 5.

### 4.1 Web UI in `apps/web` (F-01 in via REST, F-15 out)

| Cat. | Threat | Handling |
|---|---|---|
| S | A mirror site impersonates the product and collects addresses or keys. | The demo is served solely over HTTPS on the canonical demo URL as per I-12, with recognisable identity as per `design/README.md` (H-07, M-13). |
| T | A manipulated client sends a crafted address or a crafted filter past client validation. | The server validates every value afresh at B1 and B2 through schemas and smart constructors (H-05, M-10). |
| R | A visitor disputes a shown assessment afterwards. | Every response carries block number, code hash, model version, artifact checksum, index version and template version as per K-102, so the assessment is recreated exactly (H-09, M-14). |
| I | Contract strings or explanation text execute as code in the visitor's browser and reach the page's data. | All contract data and all explanation text are rendered as escaped text with a strict CSP on every response (H-07, M-13). |
| D | A very large list or a very large response locks the browser. | The page size limit as per A-17 and the rate limits as per I-12 bound every response (H-04, M-08, M-09). |
| E | Client code reaches privileged paths or the model key. | The UI calls solely the published REST paths under `/v1`; the model key stays on the server as per I-13 (H-05, M-11). |

### 4.2 REST API in `interfaces/rest` (F-01, F-03, F-15)

| Cat. | Threat | Handling |
|---|---|---|
| S | A caller uses another caller's API key. | Keys are stored as a salted hash and compared in constant time; every call is logged with the key's hash ID (H-05, M-10). |
| T | A crafted or oversized request reaches the analysis with distorted fields. | Boundary validation and a size limit before analysis give a machine-readable error as per A-18 (H-05, M-10). |
| R | A caller disputes their consumption or a rejected call. | Every call is logged with request-id, key ID, address, code hash and typed outcome as per I-10 (H-10, M-16). |
| I | Error messages or responses leak internal details, key values or stack traces. | The uniform error format as per A-18 carries status, machine-readable code, message in English and request-id; logs are redacted as per I-10 (H-10, M-16). |
| D | A flood of expensive analyses consumes RPC quota and demo budget. | Rate per key per minute, daily quota per key and global rate as per I-12; expensive steps require a valid key with remaining quota; cache hits keep responding under the cost cap (H-04, M-08, M-09). |
| E | A caller with an invalid key reaches decompilation or a Muse contract assessment. | The key and quota step in the application service runs before every expensive step (H-04, M-08). |

### 4.3 MCP server in `interfaces/mcp` (F-02, F-03, F-15)

| Cat. | Threat | Handling |
|---|---|---|
| S | A hostile MCP client calls tools with a crafted address or a borrowed key. | The same address validation, key check and quota as REST before analysis (H-05, H-08, M-10, M-15). |
| T | An unknown tool or extra fields are injected into the tool list or the call. | The tool list is closed and versioned; the input schema is strict; unknown tools give a machine-readable error with the tool name (H-08, M-15). |
| R | A tool misuse is disputed afterwards. | Every tool call is logged with request-id, tool name, address and outcome as per I-10 (H-10, M-16). |
| I | Tool output is interpreted as an instruction by the client's model or leaks internal fields. | Output is marked as untrusted data, bounded in size and carries solely the assessment's published fields (H-08, M-15). |
| D | A client spams expensive tool calls and drains the quota. | Rate, quota and cost cap are shared with REST as per I-12 and I-14 (H-04, M-08, M-09). |
| E | A tool writes state, reads files or calls arbitrary URLs. | The tool registry contains solely reading tools over the application service; every new tool passes the security review as per K-026 before release (H-08, M-15). |

### 4.4 Application service and domain core (F-03 in, F-04–F-11 out)

| Cat. | Threat | Handling |
|---|---|---|
| S | An internal call forges key identity or block context. | Identity and block context are created at the boundary and carried as typed values in `CallContext` through the whole analysis as per A-05 and A-11 (H-05, M-10). |
| T | Unvalidated or distorted data reaches detection, scoring or explanation. | Every external value passes a boundary check and a smart constructor at the boundary as per A-16; a signal requires at least one piece of evidence as per A-13, so a signal with zero evidence is untypeable (H-01, H-09, M-02, M-14). |
| R | An analysis decision passes through the service with zero trace. | Request-id, block number, code hash, model version, artifact checksum and step times are logged per analysis as per K-104 and I-10 (H-10, M-16). |
| I | The core or the service leaks keys or secrets in errors or responses. | Keys live in the adapters and in the composition root; the core receives typed values through the ports, and errors carry typed error branches as per A-15 (H-10, M-16). |
| D | Pathological input binds the core in a long or large computation. | Time, size and concurrency limits per port as per A-17 bound every step; exceeding them gives a typed error or the hard-to-analyze code signal (H-01, M-01, M-02). |
| E | Explanation text or provider output steers probabilities, grade or signals. | The explanation chain is one-way as per A-19 and A-33: evidence goes in, text comes out, and the numbers are frozen before every assessment (H-02, M-06, M-20). |

### 4.5 RPC adapter and RPC nodes (F-04, F-13)

| Cat. | Threat | Handling |
|---|---|---|
| S | A response comes from a node outside the allowlist or from a forged endpoint. | Outbound calls go solely to hosts from the validated configuration as per I-08 over the platform's TLS (H-03, M-07). |
| T | A node responds with incorrect, stale or crafted bytecode, storage or block context. | Every response is schema-validated at the boundary, bound to block number in log and response, and deviating responses give a marked uncertainty flag (H-09, M-14). |
| R | A node or provider disputes a response that gave an incorrect assessment. | The log binds address, slot, block number, code hash and provider response to request-id as per I-10 (H-09, M-14). |
| I | The RPC key leaks in log, error or client response. | Key-bearing URLs and headers are redacted in the logging library configuration; the key lives in the secret store as per I-09 (H-05, H-10, M-11, M-16). |
| D | A node responds slowly, with oversized responses or with errors in series. | Time limit, response size limit and retry budget per call as per A-17 and I-11; cached responses continue during a provider outage (H-09, M-14). |
| E | A user address or parameter steers the network target towards an internal service. | User input becomes address values in the calls; targets are fetched solely from the configuration (H-03, M-07). |

### 4.6 extdecomp worker (F-05, F-16 in)

| Cat. | Threat | Handling |
|---|---|---|
| S | A replaced extdecomp binary runs in place of the pinned one. | The binary is pinned on exact version and SHA-256 checksum in the manifest as per I-05; the checksum is verified at build and before the first decompilation (H-06, M-12). |
| T | Distorted decompiled output reaches the core as evidence. | The output is schema-validated and size-bounded at the port boundary before the core (H-01, M-02). |
| R | A crash or timeout passes through the deepening unrecorded. | The worker logs code hash, decompiler version and typed outcome per run as per I-10 (H-01, M-01). |
| I | Bytecode or intermediate results leak to network or filesystem. | The worker runs with outbound networking switched off and a read-only filesystem; solely stdout under the output limit is read (H-01, M-01). |
| D | Hostile bytecode consumes CPU, memory, time or output in decompilation. | Own process per decompilation with a versioned time limit, memory limit and output limit as per I-11; exceeding them gives an error branch and the hard-to-analyze code signal, and parallel analyses continue (H-01, M-01, M-02). |
| E | Decompilation writes to the host or reaches the host's services. | Read-only filesystem, switched-off networking and bytecode as the sole input flow bound every run to its sandbox as per I-11 (H-01, M-01). |

### 4.7 Selector and clone adapters (F-11)

| Cat. | Threat | Handling |
|---|---|---|
| S | A foreign table or a foreign index impersonates the project's versioned data. | Table and index are loaded as versioned files from the repo; the index version is stated in every response as per K-017 (H-09, M-14). |
| T | A distorted table entry or index entry skews signals or clone hits. | Entries are validated on loading; a deviating index gives the `index-version-mismatch` error branch and an uncertainty flag in the response (H-09, M-14). |
| R | A clone hit is disputed afterwards. | The response states index version, template group and the count of earlier tokens in the group as per K-017 (H-09, M-14). |
| I | Lookups leak keys or internal paths. | Lookups are local and synchronous with typed values; responses carry solely selector info and clone hit (H-10, M-16). |
| D | A very large index or a pathological hash set binds the fast path. | The step target for selector extraction as per K-101 and the size limits as per A-17 bound every lookup (H-01, M-02). |
| E | A client writes directly into table or index. | The write path goes solely through the project's versioned files in the repo; the client reaches the adapters solely through the application service (H-09, M-14). |

### 4.8 Cache and storage (F-07)

| Cat. | Threat | Handling |
|---|---|---|
| S | A cache entry impersonates another model version or code hash. | The cache key is composed of code hash and model version as per A-10; an unknown version gives a fresh analysis (H-09, M-14). |
| T | A poisoned or corrupt entry is served as a valid assessment. | Every entry is verified against code hash and model version on reading; the `entry-corrupt` error branch gives a fresh analysis and a logged deviation (H-09, M-14). |
| R | An invalidation after a model change passes with zero trace. | A new model version keys new entries and leaves older entries unused; the version is logged per analysis as per K-013 and I-10 (H-09, M-14). |
| I | Cached assessments leak keys or caller identities between keys. | Entries carry solely the assessment's fields; consumption per key is stored separately under the key's hash ID (H-10, M-16). |
| D | Cache outage or cache errors bring down the demo under load. | A miss gives a fresh analysis within quota; cached responses continue under the cost cap as per I-14 (H-04, M-09). |
| E | A client writes directly to the cache. | The write path goes solely via the application service through `CachePort` (H-09, M-14). |

### 4.9 Model artifact and offline chain (F-10, F-16)

| Cat. | Threat | Handling |
|---|---|---|
| S | An artifact with a foreign origin impersonates the frozen calibration. | The artifact carries model version, training data version and SHA-256 checksum over its canonical form; the checksum is checked into the repo with the artifact as per A-20 and I-16 (H-11, M-17). |
| T | A replaced or changed artifact changes thresholds, weights and grades silently. | `ModelArtifactPort` verifies the checksum on loading; a wrong checksum or an unknown version gives a typed startup error before the first analysis (H-11, M-17). |
| R | An artifact change is disputed or passes untracked through a release. | Artifact, model card as per K-208 and evaluation report as per K-209 are versioned together in the repo; every response states artifact version and checksum (H-11, M-17). |
| I | Training data or artifact leaks secrets from the retrieval. | The dataset is built from fresh public on-chain data that the project itself retrieves; every data point carries address, bytecode, deploy block and label source as per K-201 (H-12, M-18). |
| D | A large or crafted artifact binds startup or analysis. | The artifact format is validated on loading against A-20; a crafted artifact gives the `artifact-malformed` error branch and a typed startup error (H-11, M-17). |
| E | The training chain writes into the runtime or changes a running artifact. | The offline chain delivers solely artifact files under `model/`; the runtime reads the artifact at startup through the port (H-11, H-12, M-17, M-18). |

### 4.10 Muse assessment adapters and both providers (F-06, F-12)

The table applies after an explicit assessment request with either
provider selected per K-309. Ahead of a request the flows F-06 and F-12
are closed. The deterministic core carries zero prompt injection
surface in every mode per section 6.

| Cat. | Threat | Handling |
|---|---|---|
| S | A response comes from an endpoint outside the allowlist or impersonates the selected provider or model. | Calls go solely to the selected provider's allowlisted endpoint in the configuration as per I-13 and I-18; provider and model id are verified, logged per assessment and travel with the response (H-02, H-14, M-07, M-20). |
| T | Contract strings, metadata or decompiled code steer the prompt as instruction for either provider. | The prompt carries a closed typed evidence list; contract strings are quoted as untrusted data with a length limit through `UntrustedText.quote`; calls are tool-free (H-02, M-03, M-04). |
| R | An incorrect assessment wording is disputed afterwards. | Prompt version, provider, model id and evidence IDs are logged as per I-10; the response carries prompt version, provider, model id and the Muse-generated marking (H-02, M-04, M-05, M-20). |
| I | Either provider key or prompt content leaks to client or log. | Both keys live in the secret store and leave the server solely as a header to the selected provider; prompts are logged as version and evidence IDs (H-05, H-10, M-11, M-16, M-20). |
| D | A slow or expensive provider response binds the assessment or the budget for either provider. | Time limit per call, at most one assessment call per uncached request, caching per code hash, prompt version, provider and model id and per-provider daily caps and alerts as per I-14; every error branch gives the template text (H-04, M-09, M-20). |
| E | Provider output steers probabilities, grade, signals or tools. | The output is validated against the versioned assessment schema as per K-305 with size limits and provider identity check; scores and evidence are frozen before the call and left bit-identical as per K-307 (H-02, H-14, M-05, M-06, M-20). |

### 4.11 DeploymentFeed adapter (F-09)

| Cat. | Threat | Handling |
|---|---|---|
| S | A feed entry impersonates a recently deployed token with a foreign address. | Every entry is validated against a schema with address, block and deploy time; the address is then analysed through the same path as a manually entered address (H-09, M-14). |
| T | A distorted feed entry skews the list's order or content. | Entries are schema-validated at the boundary; the `invalid-response` error branch gives the most recently known list with a timestamp as per A-15 (H-09, M-14). |
| R | A list row is disputed afterwards. | Every row carries deploy time and block number as per K-014 (H-09, M-14). |
| I | The feed leaks internal paths or keys in the list response. | The list response carries solely address, block, deploy time, grade and top signal as per K-014 (H-10, M-16). |
| D | A large or slow feed binds the start page. | The page size limit as per A-17 and the time limit per call as per A-17 bound every listing (H-04, M-08). |
| E | A client writes to the feed or steers its target. | The feed is read through the port from the project's own source; the client reaches it solely through `listJustDeployed` (H-03, M-07). |

### 4.12 Configuration, secrets and clock (F-14, F-08)

| Cat. | Threat | Handling |
|---|---|---|
| S | Example values or a foreign environment impersonate operational configuration. | `.env.example` carries solely variable names with empty value fields; the typed schema in I-08 is normative and is validated at startup (H-05, M-11). |
| T | A crafted environment variable steers RPC targets, model endpoint or limits. | The configuration is validated against the typed schema at startup; an invalid variable gives a startup error that names the variable with the values kept outside the error text (H-03, H-05, M-07, M-11). |
| R | A key leak or rotation is disputed afterwards. | Every key has an entry outside the repo with owner, purpose, scope and rotation date; leaks and rotations are documented in `beslut/logg.md` as per I-09 (H-05, M-11). |
| I | A secret is checked in, logged or reaches a client response. | Gitleaks runs in the pre-commit hook and in CI as per I-02; logs redact keys and headers as per I-10; client responses are searched for key patterns in tests (H-05, H-10, M-11, M-16). |
| D | A missing key or variable stops operation unrecorded. | The startup error names the variable within seconds; the health check shows status per dependency as per K-104 (H-05, M-11). |
| E | Broad permissions on a key give a foothold outside its task. | Every key is created in Jens Abrahamsson's name for the project with least privilege, read permission for RPC access and separate keys per environment as per I-09 (H-05, M-11). |

### 4.13 CI and supply chain (F-16)

| Cat. | Threat | Handling |
|---|---|---|
| S | A forged Action, base image or extdecomp binary impersonates the pinned one. | Actions are pinned on full commit SHA, images on digest and extdecomp on version with SHA-256 checksum as per I-03, I-05 and I-06 (H-06, M-12). |
| T | A crafted dependency, a lockfile or a build step changes running code. | Installation happens in locked mode from the lockfile; vulnerability scanning and licence checks against the allowlist block release as per I-04 (H-06, M-12). |
| R | A change is merged with zero traceable review. | A green gate as per I-01 with named jobs in a fixed order is required for merge; every job uploads its report as an artifact (H-06, M-12). |
| I | A CI secret leaks in build log or test output. | `GITHUB_TOKEN` has read permission by default and write permission per job solely for the resource the job writes; secrets are exposed solely to the jobs that name them, and analysis in tests runs against fakes (H-05, H-06, M-11, M-12). |
| D | A heavy or hanging build blocks releases during the hackathon. | Ephemeral runners, a time limit per job and a cancelling `concurrency` group per branch as per I-01; timing tests run against frozen fixtures with networking switched off (H-06, M-12). |
| E | A job writes outside its assigned resource. | Every workflow and every job declares an explicit `permissions` block as per I-03 (H-06, M-12). |

### 4.14 Plugin audit and plugin docs (F-17, F-18; design per ADR section 12)

| Cat. | Threat | Handling |
|---|---|---|
| S | A forged audit report or a foreign `PLUGIN.md` impersonates the reviewed plugin's record. | Reports and docs are keyed to plugin id, version, file hashes, prompt version, provider, and model id; docs join the registry only after deterministic validation (H-20, M-26). |
| T | Plugin source or `PLUGIN.md` text instructs the audit model to approve, suppress, or reformat findings. | The deterministic gate runs first; source and docs reach the model solely as quoted untrusted data in a tool-free call (H-17, M-23, M-24). |
| R | A clean AI report is later cited as the plugin's approval. | The report states `deterministic`, `ai: advisory`, and `human-review` as separate fields; acceptance is the deterministic pass plus the recorded human review (H-18, M-23). |
| I | The AI phase sends unpublished plugin source, neighbouring repo files, or secrets to the provider. | Opt-in per run, the exact file list shown before sending, plugin files only under size caps, hashes logged with content kept outside the log (H-19, M-25). |
| D | A large plugin or an oversize model response binds the audit or CI. | Per-file and total input caps, output size limits, deadline, and the typed `output-too-large` outcome with the deterministic result standing (H-20, M-26). |
| E | A schema-invalid model response, or raw HTML in `PLUGIN.md`, reaches a reviewer or a visitor's browser as trusted content. | Findings pass `parsePluginAuditReport` before display with raw invalid text discarded; docs render through a sanitizer with raw HTML as inert text under the strict CSP and as marked untrusted data through MCP (H-20, M-26, M-13, M-15). |

## 5. Threats with countermeasure, requirement ID and test

Every threat states affected flows and boundaries. Every countermeasure states
a K-5xx ID and a named test method. Test names follow
`docs/requirements.md` where the requirement already names a governing test;
other names follow the same pattern and are included in the suite as per A-22.

### 5.1 Hostile bytecode and decompilation

**H-01 Decompilation DoS and resource exhaustion via hostile
bytecode (F-05, B4, B6).**
An attacker deploys a contract whose bytecode makes extdecomp or
the fast path's extraction consume a disproportionate amount of
CPU, memory, time or output: huge contracts up to
the operational limit for `Bytecode` as per A-10 and A-17, pathological
jump tables and control flows, deeply nested or obfuscated
structures as per `kunskap/bytecode-forskning.md` and output that
grows far beyond the input size. A successful exhaustion binds
the deepening and, with shared resources, parallel analyses during
the assessment period.

- M-01 Isolated extdecomp worker with hard resource limits:
  decompilation runs in its own process per run in a sandbox
  as per I-11 and A-27, with bytecode as the sole input flow,
  a versioned time limit per decompilation
  (`BRANDKLIPPAREN_extdecomp_DEADLINE_MS`), a versioned memory limit
  per worker (`BRANDKLIPPAREN_extdecomp_MAX_MEMORY_MB`),
  outbound networking switched off, a read-only filesystem and solely
  stdout under the output limit read back. Concurrency
  is bounded by `BRANDKLIPPAREN_extdecomp_MAX_CONCURRENCY`, so a
  pathological run occupies solely its own worker and its own
  time budget. Requirement: K-501. Test: the integration test
  `k501_pathological_input_isolates_to_its_analysis` requires that
  parallel analyses continue during a pathological run, and
  the integration test `k008_timeout_yields_hard_to_analyze_signal`
  requires that a run over the time limit gives the
  hard-to-analyze code signal in the deepening with the fast path's response
  intact.
- M-02 Size limits and typed outcomes for pathological structures
  in every analysis step: bytecode, RPC responses, decompiled output and
  cache entries are bounded by the fields `maxBytesIn`, `maxBytesOut` and
  `maxConcurrency` as per A-17; huge contracts, pathological
  jump tables and oversized decompiled output give the port's typed
  error branches `timeout`, `resource-limit`, `process-error`,
  `invalid-output` or `output-too-large` as per A-15 and
  are mapped to the hard-to-analyze code signal as per K-008. Every
  distorted bytecode gives, per analysis step, a signal or a typed
  error, so every run ends with a defined outcome.
  Requirement: K-501. Test: the fuzz target
  `k501_mutated_bytecode_yields_signal_or_typed_error` feeds
  distorted bytecode through every analysis step and requires a signal
  or a typed error per run; the property test in A-22 with the same
  invariant tests arbitrary distorted bytecode, and
  the contract suite `runDecompilerPortContract` tests successful
  decompilation and pathological timeout against fake and real adapter.

### 5.2 Determinism as a protected property

The deterministic core as per K-102 and A-07 is a
security property: the same bytecode and the same block number give a
bit-identical result with the same evidence in every run, process
and machine. Section 5.2 gathers the threats to the property. Section 6
describes the bounded Muse assessment surface. The deterministic
core has no prompt injection surface: the core builds zero prompts,
receives zero model output and makes zero LLM or model API calls, and
the analysis path makes zero assessment calls ahead of an explicit
request per K-102 and K-502.

**H-11 Manipulated or replaced calibration artifact (F-10, B9).**
A changed byte in the artifact, a replaced artifact file or an
artifact of unknown version changes detection thresholds, weights and
limits and thereby probabilities and grades for every analysis,
with deterministic behaviour kept per run.

- M-17 Checksum-verified and versioned artifact at startup:
  the artifact carries `modelVersion`, SHA-256 checksum over its
  canonical JSON form as per A-20 and A-32, training data version
  and explanation schema version. `ModelArtifactPort` verifies
  the checksum on loading before the first analysis; the branches
  `unknown-version`, `checksum-mismatch` and `artifact-malformed`
  as per A-15 give a typed startup error that states the most recently valid
  model version. Every response states model version and
  artifact checksum as per K-102, and every new model version
  keys new cache entries as per K-013. Requirement: K-512. Test:
  the unit test `k211_wrong_checksum_rejected_before_analysis`
  feeds in an artifact with a changed byte and requires a typed error
  before the first analysis; the integration test
  `k512_tampered_artifact_rejected_before_analysis` replaces
  the artifact file in a test environment and requires the same startup error, and
  the integration test `k211_response_names_artifact_version_and_checksum`
  requires version and checksum in every response.

**H-12 Poisoned or mislabelled training data (F-10, B9).**
Distorted, mislabelled or leaking data points in the dataset
skew learned thresholds and weights, inflate measured
accuracy through clone leakage between splits or move
calibration away from the base rate among new tokens.

- M-18 Provenance, label policy and leakage-free splits in
  the offline chain: every data point carries address, bytecode,
  deploy block and label source as per K-201; data version,
  retrieval date and block interval are logged and travel with
  the model card as per K-208; the label policy as per K-202
  defines every risk type and its negative class with a
  documented rule per known noise source; training, calibration
  and testing keep every cluster on code hash and skeleton hash fully
  in one split as per K-204, with a time-divided split as per K-203 as
  the second axis. The offline chain runs reproducibly as per K-209
  and exports solely the artifact to the runtime as per A-28.
  Requirement: K-512. Test: the review test
  `k201_each_datapoint_has_address_bytecode_block_source` requires
  provenance fields on every data point; the evaluation test
  `k204_no_cluster_spans_splits` fails the report at a
  shared cluster; the measurement
  `k202_label_quality_spot_check_versioned` reports
  label quality per data version, and the review
  `k512_training_data_provenance_checked` requires data version,
  label sources and split boundaries in the evaluation report before
  every artifact activation as per K-210.

**H-13 Non-deterministic dependencies and run variation
(F-10, F-14, F-16, B7, B9).**
A floating dependency version, an unlocked seed, system clock or
randomness in the core, platform-dependent floating-point order or a
non-canonical serialisation gives differing results for the same input
between runs, processes or machines and breaks the promise in
K-102, with every individual analysis appearing correct.

- M-19 Locked seeds, pinned dependencies and canonical determinism in
  the core: the training chain runs with locked seeds in a versioned
  seed configuration and pinned Python dependencies as per I-16;
  the TypeScript chain is installed from lockfile with a pinned runtime
  as per I-04 and I-05; the core reads time solely from the passed-in
  `Timestamp` parameter, takes randomness solely from a seeded
  generator as a parameter, sorts every collection on a stated
  key before serialisation, serialises with canonical JSON through
  `canonicalSerialize` and rounds `Probability` with fixed
  precision as per A-32. The boundary rule
  `boundary-domain-deterministic` as per A-06 guards the core's
  import graph in CI. Requirement: K-512. Test: the golden tests
  `k102_golden_fixtures_bit_identical` require bit-identical
  serialised output per frozen fixture; the integration test
  `k102_two_runs_across_processes_bit_identical` compares the output
  byte for byte between two processes; the evaluation test
  `k211_retraining_reproduces_artifact_bit_identical` requires
  byte-identical artifacts including checksum on retraining
  from the same data version and the same locked seeds; the CI check
  `a32_domain_has_no_clock_random_or_network` searches clock,
  randomness and network calls in `domain` and requires zero hits.

### 5.3 The Muse contract assessment with both providers

The section has its own heading because the surface is bounded to the
on-request assessment path. The full description of the request modes,
injection paths and cost protection is in section 6. The threats
below apply after an explicit assessment request, with either provider
selected per K-309. The deterministic core has no prompt injection
surface in every mode per section 6.1 and K-502.

**H-02 Prompt injection via contract data into Muse (F-06, F-12,
B3, B6).**
Token name, symbol, metadata, revert strings, function names or
decompiled code carry instruction-like text that tries to make
Muse depart from the evidence list, invent capabilities, downplay or
exaggerate a risk or phrase intent in place of capability, through
either provider per K-309.

- M-03 Closed typed evidence list with separate instruction and
  data fields: prompt construction receives the closed evidence list as per
  K-302 as the sole input source, with the system instruction in its own
  field and every evidence entry as typed data, for both providers.
  Raw bytecode stays in
  the analysis path. Requirement: K-502. Test: the unit test
  `k302_prompt_contains_closed_typed_evidence_list` requires a
  closed typed list as the sole input source against both adapters and
  the fake, and the unit test
  `k302_prompt_builder_accepts_evidence_only` requires that
  prompt construction receives evidence entries as its input.
- M-04 Quoted untrusted data with a length limit: every
  contract string and metadata string passes `UntrustedText.quote` as per A-10,
  capped at the length limit as per A-17, and is shown as a quotation in
  the explanation as per K-308, for both providers. The prompt is logged as prompt version,
  provider, model id and evidence IDs as per I-10. Requirement: K-502. Test: the unit test
  `k308_contract_strings_quoted_with_length_cap` requires quoting
  with a length limit in prompt and template construction; the unit test
  `k502_injection_strings_yield_at_most_one_quote` feeds
  injection strings in name, symbol, metadata and revert texts against
  both adapters and the fake and requires
  at most one quotation in the output with unchanged structure.
- M-05 Schema-validated structured output with template fallback:
  assessment text from either provider is validated against the versioned
  assessment schema as per K-305, which states claims,
  signal links, the markers holds now and can change and language.
  Claims with a missing or invalid signal link are removed in
  validation as per K-302 and K-304. Every schema breach, timeout,
  oversize response and error branch as per A-15 gives the template-based text as per
  K-306, so the token page always carries an explanation. Requirement: K-502, K-513.
  Test: the unit test `k305_schema_covers_claims_links_markers_language`
  requires the schema's fields for each adapter; the integration test
  `k305_invalid_output_routes_to_template` requires template text at
  schema breach for both adapters and the fake.
- M-06 One-way explanation chain with frozen numbers:
  probabilities, grade, signals and evidence are computed and frozen
  in the fast path before every assessment call as per A-19 and
  A-33; assessment calls are tool-free; provider output is parsed
  solely as assessment text against the schema in M-05 and leaves every
  numeric field bit-identical as per K-307. Requirement: K-502.
  Test: the unit test
  `k307_scores_and_evidence_identical_with_and_without_adapter`
  runs the same frozen analysis with and without an assessment request
  for each adapter and
  compares probabilities, grade, signals and evidence byte for
  byte; the unit test `k307_numbers_computed_before_assessment_call`
  requires computed numbers before the call, and
  the boundary guard test `k307_risk_model_inputs_exclude_assessment_output`
  requires that the risk model's input consists of signals and
  model artifact.

**H-14 Tampered or oversize assessment provider response, or wrong
provider identity (F-06, F-12, B5, B6).**
A response from either provider (Meta Model API or hosted) arrives
tampered in transit or at the provider, with a provider or model id
different from the selected configuration, malformed against the
assessment schema, or oversize beyond the output limit, and reaches
the user as a credible Muse assessment or binds the assessment path.

- M-20 Validated, size-bounded and identity-checked provider responses
  with protected keys for both providers: each adapter validates the
  response against the versioned assessment schema per K-305, enforces
  the input and output size limits and timeout per K-309 and A-17,
  verifies provider and model id against the selected configuration,
  and caches solely validated text per code hash, prompt version,
  provider and model id. A tampered, malformed, oversize or
  identity-mismatched response gives the `invalid-output`,
  `output-too-large` or `provider-mismatch` branch per A-15 and the
  template text per K-306, with score and evidence unchanged per
  K-307. Both provider keys live in the platform secret store per
  I-09, travel solely as server-side headers to the selected
  provider's allowlisted endpoint, and are redacted in logs per I-10.
  Requirement: K-513, K-502, K-505. Test: the integration test
  `k513_tampered_or_oversize_provider_response_rejected` feeds tampered,
  malformed, oversize and identity-mismatched responses through both
  adapters and the fake and requires template text with unchanged
  score and evidence; the contract tests in
  `runAssessmentModelPortContract` require the same outcomes per
  adapter; the integration test
  `k513_both_provider_keys_absent_from_client_and_logs` searches client
  responses and logs for both provider key patterns and requires zero
  hits.

Cost abuse against the same assessment path is handled by M-08 and
M-09 against H-04 in section 5.5, with per-provider daily caps and
alerts in I-14 as their own frames per K-513.

### 5.4 SSRF in address-driven retrieval

**H-03 Server-driven retrieval to an attacker-chosen target (F-04, F-09,
F-12, F-13, B5).**
A crafted address, a parameter or a crafted
configuration entry tricks the server into calling an internal service, a
metadata endpoint or an arbitrary external host, or into following
a redirect there.

- M-07 Allowlisted outbound targets from validated configuration:
  RPC hosts and both assessment provider endpoints are fetched solely from
  the environment variables `BRANDKLIPPAREN_RPC_URLS`,
  `BRANDKLIPPAREN_ASSESSMENT_META_BASE_URL` and
  `BRANDKLIPPAREN_ASSESSMENT_hosted_BASE_URL` as per I-08, I-13 and I-18, validated against
  the typed schema at startup and compared against the allowlist at
  every call. User input becomes address values, slot values and
  call data in the calls; targets are fetched solely from the configuration.
  Every call carries a time limit, size limits and
  a retry budget as per A-17. Requirement: K-503. Test:
  the unit test `k503_user_input_never_becomes_target_url`
  requires that targets are fetched from the configuration; the unit test
  `k503_crafted_inputs_stay_within_allowlist` feeds crafted
  addresses and URLs and requires calls solely to allowlisted
  hosts; the integration test `k503_targets_come_from_validated_config`
  requires a startup error at a target outside the allowlist.

### 5.5 API abuse, rate and costs

**H-04 Draining via expensive analysis paths (F-01, F-02, F-04, F-05,
F-06, F-12, F-13, B1, B5).**
A flood of calls, a rotation of addresses that hit the cache
rarely or repeated assessment requests consume RPC quota,
extdecomp capacity and the selected provider's budget for either
provider, so the demo responds slowly or reaches its
cost cap during the assessment period.

- M-08 Rate limits, daily quotas and key requirement before expensive steps:
  rate per API key per minute, daily quota per API key and
  global rate per minute are read from the configuration as per I-08
  with the values versioned in I-12. Exceeding them gives a
  machine-readable error with HTTP status for rate exceeded and
  retry time as per A-18. Expensive steps, namely
  extdecomp decompilation and Muse contract assessment calls for either
  provider,
  require a valid API key with remaining quota; the quota and
  rate step is shared by REST and MCP. Requirement: K-504. Test:
  the integration test `k504_over_limit_returns_retryable_machine_error`
  requires a machine-readable error with retry time when a limit is
  exceeded; the integration test
  `k504_expensive_steps_require_key_with_quota` requires a valid
  key with remaining quota before every expensive step; the load test
  `k504_limits_hold_under_overload_and_cache_serves` requires that
  the limits hold under overload.
- M-09 Cost cap, alarms and cache as cost protection for both
  providers: every
  analysis sums the count of RPC calls per key and, per assessment
  request, the count of assessment calls and cost per provider and
  model id separately as per K-107 and K-309. At most one
  assessment call per uncached request applies as a fixed rule; a
  cache hit consumes zero RPC calls and zero assessment calls.
  The daily caps for RPC calls in the demo, per key and per provider
  (Meta and hosted) are versioned in I-14 with alarm levels before
  each cap;
  every alarm is written as a structured `warn` entry with
  key ID, provider, consumption and remaining share. At the cap
  the service closes the expensive paths for that provider and keeps responding with
  cache hits and the fast path's cached content, so the demo
  stays reachable during the assessment period. Requirement: K-504, K-513. Test:
  the integration test `k013_cache_hit_skips_decompilation_and_external_calls`
  requires zero external calls at a cache hit; the integration test
  `k107_analysis_sums_rpc_and_assessment_calls` requires summed
  consumption per analysis, key, provider and model id; the integration test
  `k107_alarm_fires_before_cap` requires an alarm before the cap at
  simulated consumption for each provider; the integration test
  `k513_cost_caps_and_alerts_apply_to_both_providers` requires
  per-provider caps and alerts.

### 5.6 API keys and secrets

**H-05 Stolen, leaked or guessed API key (F-01, F-14, B1, B7).**
A key in a URL, a log, a client response or the repo, or a
key guessed through repeated attempts, gives access to expensive
paths under the stolen key's quota and consumption profile.

- M-10 Header transport, salted hash and constant-time comparison:
  API keys travel solely in the header; calls with the key in URL
  or body give a machine-readable error before analysis. The server
  stores solely a salted hash with the secret component
  `BRANDKLIPPAREN_API_KEY_PEPPER` as per I-08 and compares in
  constant time. A missing or invalid key is rejected before the first
  analysis step, and every call is logged with the key's hash ID.
  Requirement: K-510. Test: the unit test
  `k510_key_in_url_or_body_rejected` requires an error before analysis at
  a key in URL or body; the property test
  `k510_key_comparison_is_constant_time` tests the comparison over
  generated inputs; the integration test
  `k024_missing_or_invalid_key_rejected_before_analysis` requires
  rejection before analysis at a missing or invalid key.
- M-11 Lifecycle, secret store and secret-free history for all keys
  including both assessment provider keys:
  keys are created in Jens Abrahamsson's name for the project with
  least privilege and separate keys per environment and per assessment
  provider (Meta Model API and hosted), stored in
  the platform secret store and read solely as environment variables
  at startup as per I-08, I-09, I-13 and I-18. Each provider key travels
  solely as a server-side header to its provider's allowlisted endpoint
  and is redacted in logs per I-10. Creation, rotation and
  revocation apply from the next call; the leak routine in I-09
  blocks the key with the issuer first, creates a replacement,
  rolls it out, verifies the health check and documents
  the event in `beslut/logg.md` with the key value kept outside the entry.
  The repo and the history are scanned with gitleaks in the pre-commit hook
  and in CI as per I-02, and `.env.example` carries solely
  variable names. Requirement: K-505, K-510, K-513. Test: the CI check
  `k505_gitleaks_clean_on_repo_and_history` requires zero hits
  over the repo and the whole history; the startup test
  `k505_keys_read_from_environment_at_start` requires reading
  from the environment at startup; the integration test
  `k510_rotation_and_revocation_without_restart` requires that
  rotation and revocation apply from the next call; the drill
  `i09_leaked_key_drill_follows_steps` runs the leak routine step by
  step on a test key.

### 5.7 Supply chain

**H-06 Manipulated dependency, binary or build step (F-16, B9).**
A crafted dependency, a replaced extdecomp binary, a forged
Action or a base image with foreign content brings code into
the runtime, into decompilation or into the demo.

- M-12 Locked, pinned and scanned supply chain: dependencies
  are installed reproducibly in locked mode from the lockfile as per
  I-04 for the TypeScript chain and for the Python chain in `offline/`;
  every dependency's licence is checked against the allowlist in the repo;
  vulnerability scanning blocks release at a hit at the highest
  severity level; GitHub Actions are pinned on full commit SHA with
  an explicit minimum `permissions` block per job as per I-03;
  base images and container images are pinned on digest as per
  I-06; extdecomp is pinned on exact version and SHA-256 checksum
  in `tools/extdecomp/manifest.json` as per I-05, with the checksum
  verified in the build log and before the first decompilation;
  the SAST job in the gate as per I-01 turns red at a finding at the highest
  severity level. Requirement: K-506. Test: the CI check
  `k506_clean_clone_installs_from_lockfile` installs from
  the lockfile in a clean environment and requires bit-equal versions;
  the CI check `k506_license_allowlist_blocks_release` requires
  a green licence against the allowlist; the CI check
  `k506_pinning_and_vulnerability_scan_block_release` requires
  pinned references, a current lockfile and a stated version with
  checksum for extdecomp in the build log, and turns red at a
  changed byte in the binary; the CI check
  `i03_actions_pinned_and_least_privilege` requires a full
  commit SHA and an explicit permission block per job.

### 5.8 XSS in the web UI

**H-07 Script via contract data or explanation text in the UI
(F-01, F-15, B8).**
Token name, symbol, contract strings, decompiled code or
explanation text carry markup or script that executes in
the visitor's browser on the start page, token page or
timeline view.

- M-13 Text rendering with a strict CSP: every value from the contract
  or the explanation chain is rendered as escaped text in every view,
  so markup is shown as inert text. The content security policy
  is delivered with every response from the demo as per I-12 and K-507
  and allows solely the project's own script sources.
  Decompiled code is shown in monospace as text as per
  `design/README.md`. Requirement: K-507. Test: the e2e test
  `k507_script_bearing_data_renders_as_inert_text` feeds
  script-bearing contract data through every view and requires inert
  text; the integration test `k507_csp_header_present_on_responses`
  requires the policy on every response from the demo.

### 5.9 MCP tools

**H-08 Abused or misleading MCP tool (F-02, F-03,
F-15, B1, B2, B8).**
A tool receives crafted input, changes state, exposes
a write path or returns output that a client model interprets
as an instruction for further action.

- M-15 Reading tools with strict schemas and marked output:
  the tool registry contains solely reading tools over
  the application service; in the MVP `assess_token` is exposed as per
  K-025 and the registry is extended solely through the reviewed path
  below. Every tool validates input against its published
  input schema before analysis as per K-026; the tool list is closed
  and versioned, and calls to an unknown tool give a
  machine-readable error with the tool name. Output is marked as
  untrusted data in the tool response, bounded at
  the size limit as per A-17 and carries solely the assessment's
  published fields. Rate, quota and cost cap are shared with REST
  as per M-08 and M-09. Every tool leaves chain state and
  project data unchanged, apart from log and quota measurement,
  and every new tool passes the security review as per
  K-026 with a completed review entry before release.
  Requirement: K-508. Test: the unit test
  `k026_invalid_address_fails_schema_before_analysis` requires
  a validation error before analysis; the unit test
  `k026_tools_leave_state_unchanged` compares state before and
  after every tool call; the unit test
  `k025_unknown_tool_returns_machine_readable_error` requires an error
  with the tool name at an unknown tool; the review
  `k026_new_tool_security_review_recorded` requires a completed
  review entry per tool in the list.

### 5.10 Manipulated RPC responses, feed responses and cache poisoning

**H-09 Incorrect or manipulated response from node, feed or
cache (F-04, F-07, F-09, F-11, F-13, B3, B6).**
A node responds with distorted or stale bytecode or
storage, the feed delivers a crafted entry, or a poisoned
cache entry is served under a valid code hash, so an incorrect
assessment looks deterministic and credible to every following
caller with the same code.

- M-14 Schema-validated responses bound to block number and
  verified cache entries: every RPC response, feed response and
  lookup response is schema-validated at the boundary as per A-16 before
  the core; every analysis binds its on-chain readings to
  block number in log and response as per K-102, and deviating responses
  give a marked uncertainty flag in the analysis. Cache entries
  are keyed on code hash and model version and verified at
  reading against both; the `entry-corrupt` error branch gives a fresh analysis and
  a logged deviation. Cached responses continue during a
  provider outage, and the demo reads against several allowlisted
  hosts as per the configuration, so operation stays up during an
  outage at an individual host. Requirement: K-511. Test:
  the integration test `k511_manipulated_rpc_response_flagged`
  feeds a manipulated or stale response and requires an
  uncertainty flag; the integration test
  `k511_cache_entry_verified_on_read` requires verification against
  code hash and model version at every reading;
  the integration test `k511_cached_responses_served_during_provider_outage`
  requires cached responses during a provider outage;
  the contract suites `runRpcPortContract` and
  `runCachePortContract` test contract, EOA, invalid address
  and hit, miss and corrupt entry against fake and real adapter.

### 5.11 Log leakage

**H-10 Sensitive data in logs and error responses (F-08, B7, B8).**
API keys, `Authorization` headers, key-bearing RPC URLs,
the model key, prompt content or stack traces end up in
structured logs, in the demo log extract or in error responses read
by a wider audience than the operator.

- M-16 Field allowlist and redaction at every log level: logs
  are written in structured form as JSON through `pino` as per I-10, one entry
  per event, with solely the fields in the allowlist there: timestamp,
  level, service, environment, request-id, the key's hash ID, address,
  code hash, skeleton hash, block number, model and index versions,
  step times, typed outcome, consumption and cache outcome.
  Redaction in the logging library configuration replaces
  API keys, authentication headers, key-bearing URLs and
  the model key with a fixed redaction marker before printing,
  through named paths for header and key fields. Prompts
  are logged as prompt version and evidence IDs. Errors are logged as a typed
  error branch and machine-readable code; stack traces belong to local
  debugging at `debug` level and stay outside the demo log extract.
  The demo log extract is reviewed against the allowlist before submission.
  Requirement: K-509. Test: the unit test
  `k509_log_fields_follow_allowlist` requires allowlisted fields in
  every emitted entry; the unit test
  `k509_key_like_strings_redacted_in_output` feeds
  key-like strings, headers and key-bearing URLs
  through every log path and requires the redaction marker in all
  output; the unit test `k104_analysis_log_has_required_fields`
  requires request-id, address, code hash, model version, step times
  and outcome per analysis; the review
  `k509_demo_log_output_reviewed_before_submission` goes through
  the demo log extract before submission.

### 5.12 Plugin registry and plugin output (design per `docs/adr-plugin-architecture.md`)

The plugin architecture in `docs/adr-plugin-architecture.md` (P-xx) adds
one component, the static plugin registry in `src/plugins/registry.ts`,
and one response field, `pluginResults`. Registration is compile-time
only, detector plugins are pure functions over declared frozen facts,
assessment plugins stay behind `AssessmentModelPort`, and plugin
findings carry weight 0 until the versioned model artifact names them.
The K-IDs K-514 and K-515 below are proposed in the ADR and enter
`docs/requirements.md` with story S-042, in the same change, per
section 1 point 4 of this file.

The audit and docs update (ADR section 12, P-13–P-17) adds two further
surfaces inside this same section, so plugin threats stay in one
place: a `plugin audit` step (CLI and CI job, with an optional advisory
AI review through the hosted open-weights path) and a required
`PLUGIN.md` per plugin, exposed read-only through REST, MCP, and the
web UI. Two flows are named for these surfaces: F-17 (plugin source,
manifest, and `PLUGIN.md` from the operator or CI to the audit, and on
opt-in from the audit to the selected hosted endpoint and back),
crossing B9 and, for the provider leg, B5/B6; and F-18 (validated
`PLUGIN.md` content from the registry to REST, MCP, and web UI
callers), crossing B8. The K-IDs K-516 and K-517, and the functional
K-032 and K-033, are proposed in the ADR and enter
`docs/requirements.md` with their first implementation stories
(S-052–S-057), in the same change, per section 1 point 4.

**H-15 Plugin code admitted outside the reviewed supply chain
(registry, B9).**
A plugin loaded at run time from a directory, an environment-named path,
or a network source brings unreviewed code into the deterministic
analyzer, bypassing the locked, pinned, and scanned supply chain in
M-12 and the boundary rules in A-06.

- M-21 Static, compile-time registration of reviewed plugin source:
  the registry is a frozen array built from static imports in
  `src/plugins/registry.ts` and wired solely by the composition root
  per A-03. No dynamic import of a computed specifier, no filesystem
  scan, no plugin path from environment or configuration, and no code
  fetched over the network exists in the registry path. Configuration
  selects among already-registered plugins only. Any future
  separately distributed plugin enters by signature and checksum
  verification at build time with static import, under its own
  threat-model change. Requirement: K-514 (proposed), K-506. Test:
  the CI check `k514_registry_has_no_dynamic_loading` searches the
  registry and composition modules for dynamic import, filesystem
  scan, and environment-named module paths and requires zero hits;
  the unit test `k514_unregistered_plugin_never_runs` requires that a
  plugin absent from the registry array is absent from analysis
  output.

**H-16 Malicious or defective plugin output skews scores, breaks
determinism, or reaches the browser as markup (plugin output, B6, B8).**
A detector plugin that reads a clock, randomness, or the network, that
returns findings without evidence, that sizes its output to bind
serialization, or whose strings carry markup or instruction-like text
breaks K-102 bit-identity, steers the score around calibration, or
executes in a visitor's browser through the generic UI panel.

- M-22 Pure, bounded, schema-validated, weight-0 plugin output rendered
  as text: detector `detect` functions are synchronous and typed to
  receive solely frozen declared facts, enforced by the
  dependency-cruiser rules `boundary-detector-plugins-pure` and
  `boundary-plugins-via-registry` and the ESLint restrictions on
  `node:*`, clock, randomness, and network access in detector modules
  (P-03). The host validates every output against the manifest
  `outputSchema`, the evidence requirement per A-13, and the manifest
  limits (`maxFindings`, `maxEvidencePerFinding`, `maxOutputBytes`)
  before serialization; deviations give the typed outcome
  `invalid-output` for that plugin and leave the analysis standing.
  Findings enter `pluginResults` only, sorted by plugin id and finding
  id through `canonicalSerialize`, and enter `score` solely after a
  new model artifact version names the plugin (P-05, K-210). Every
  plugin string renders as escaped text under the strict CSP in the
  generic panel; plugin-supplied markup, styles, and scripts are
  unrepresentable in the output-schema subset (K-507, M-13).
  Requirement: K-515 (proposed), K-102, K-507. Test: the registry
  contract suite `runDetectorPluginContract` requires bit-identical
  canonical output across two runs, a typed `invalid-output` outcome
  on schema, evidence, and size violations, and unchanged inputs;
  the property test
  `plugin_findings_leave_probabilities_and_score_unchanged` requires
  bit-identical probabilities, score, and signals with each plugin
  enabled and disabled; the e2e test
  `k515_plugin_strings_render_as_inert_text` requires script-bearing
  plugin strings to render as inert text in the Plugins panel.

**H-17 Malicious plugin source or PLUGIN.md as prompt injection into
the plugin audit (F-17, B5, B6, B9).**
A plugin author writes source comments, string literals, or
`PLUGIN.md` text that instruct the audit model to approve the plugin,
suppress a vulnerability, invent a clean result, or change the
findings format. The audit prompt is the one place where deliberately
unreviewed code is placed in front of a model, so the injection
surface is wider than the closed evidence list in H-02: the input is
whole files, written by the party who benefits from a clean report.

- M-23 Deterministic-first audit gate with human acceptance: the
  audit runs its deterministic static checks (forbidden imports,
  capability mismatches against the manifest, determinism lint,
  output-contract and `PLUGIN.md` checks per ADR P-13) before any
  model call, and a deterministic failure ends the audit with no AI
  phase. Acceptance of a plugin requires the deterministic pass plus
  a recorded human review; the audit report states the three states
  separately (`deterministic`, `ai`, `human-review`), and no AI
  output registers, unregisters, or approves a plugin. Requirement:
  K-516 (proposed). Test: the integration test
  `k516_deterministic_failure_runs_zero_model_calls` feeds a plugin
  with a forbidden import and an opted-in AI phase and requires zero
  calls to the fake audit adapter; the unit test
  `k516_audit_report_states_deterministic_ai_and_human_states`
  requires the three separate states in every report shape.
- M-24 Injection-resistant audit prompt over quoted untrusted files:
  the audit prompt keeps its system instruction in its own field and
  passes plugin source, manifest, and `PLUGIN.md` solely as quoted
  data through `UntrustedText.quote` with a per-file length cap and a
  total input cap, in a tool-free call, with the instruction that
  file content is data to review and never instructions to follow
  (ADR P-14). A response that follows an embedded instruction either
  fails the findings schema in M-26 or is read by the human reviewer
  as a finding about the plugin. Requirement: K-516 (proposed),
  K-502. Test: the unit test
  `k516_injection_in_source_or_docs_stays_quoted_data` feeds source
  and `PLUGIN.md` fixtures carrying approval and suppression
  instructions through the fake audit adapter and requires the
  prompt to carry them as quoted data and the report to carry no
  approval state; the contract suite
  `runPluginAuditModelPortContract` requires the same quoting against
  the fake and the hosted adapter over a recorded transport, with
  zero network in tests.

**H-18 Advisory AI audit result treated as approval, or as score or
evidence input (F-17, B9).**
A clean or low-severity AI report is read — by a reviewer, a CI
dashboard, or later code — as an approval of the plugin, as a
substitute for the deterministic gate or the human review, or as an
input to scores, signals, or evidence. The failure is presentational
and architectural at once: the report looks like a verdict, and any
field the registry or scoring path can read becomes a path around
P-05 and K-307.

- M-23 (also against H-17) bounds the report's role: the audit report
  type carries the explicit `advisory` label with provider and model
  id wherever it is shown (CLI, CI artifact, and any later read view),
  has no field that the registry, `pluginResults`, scoring, or the
  analysis path reads, and its AI severity values are display values
  that no code maps to risk, direction, or weight. Requirement:
  K-516 (proposed), K-307. Test: the property test
  `k516_ai_findings_leave_scores_signals_and_evidence_unchanged`
  runs a frozen analysis with audit reports of every severity
  present and absent and requires bit-identical probabilities,
  score, signals, and evidence; the unit test
  `k516_clean_ai_report_alone_registers_no_plugin` requires that a
  plugin with a clean AI report and no deterministic pass or human
  record stays unregistered.

**H-19 Leakage of plugin source to the model provider (F-17, B5,
B6).**
The AI audit phase sends plugin source and `PLUGIN.md` content to
hosted. Source that an author has not published — a third-party-style
plugin under evaluation, or a future private plugin — leaves the
repo boundary to a provider whose retention the project does not
control, and a careless audit run could widen the send to repo files,
configuration values, or secrets that were never meant to leave.

- M-25 Opt-in, minimised, and logged source disclosure for the audit:
  the AI phase runs solely on explicit opt-in per audit run; without
  a configured hosted key it reports `not configured` and makes zero
  provider calls. Before any send, the audit lists the exact files it
  will send (the plugin directory's source, manifest, and `PLUGIN.md`
  only — no repo-wide files, no configuration values, no secrets; the
  provider key travels solely as the server-side header per M-20),
  enforces per-file and total size caps, and logs plugin id, file
  hashes, prompt version, provider, and model id with file content
  kept outside the log per I-10. Requirement: K-516 (proposed),
  K-505, K-513. Test: the unit test
  `k516_audit_without_key_reports_not_configured_and_sends_nothing`
  requires the `not-configured` outcome and zero calls against the
  fake; the integration test
  `k516_audit_sends_only_listed_plugin_files` captures the fake
  adapter's received file list for a plugin inside a repo tree with
  neighbouring secrets-shaped fixtures and requires exactly the
  listed plugin files with hashes matching the log line.

**H-20 Schema-invalid audit output, or PLUGIN.md rendered as markup
or read as instruction (F-17, F-18, B6, B8).**
Two untrusted outputs meet here. First, a tampered, malformed,
oversize, or identity-mismatched response from the audit provider is
presented as structured findings, so invented severities or locations
reach a reviewer with the model's authority. Second, `PLUGIN.md` is
author-controlled markdown: rendered as raw HTML it executes script
in a visitor's browser through the Docs view, and returned through
MCP it is read by a client model as instruction rather than data.
A missing or drifted `PLUGIN.md` is the quieter form of the same
threat: docs that claim inputs, detections, or limitations the code
does not have mislead reviewers and users about what a finding means.

- M-26 Schema-validated audit findings and sanitized, checked plugin
  docs: every audit model response passes the plain-check smart
  constructor `parsePluginAuditReport` against the TypeScript
  findings type and its JSON Schema descriptor (ADR P-14, no new
  schema library) before any finding is shown; schema-invalid,
  oversize, or identity-mismatched output gives the typed
  `invalid-output` outcome, the raw model text is discarded, and the
  deterministic audit result stands. `PLUGIN.md` presence, required
  sections, declared inputs, and version are validated
  deterministically before exposure (ADR P-15), documented claims
  are checked against manifest and code deterministically where
  machine-checkable and by the advisory review for semantic drift
  (ADR P-17), and the exposed document renders through a sanitizing
  markdown renderer with raw HTML as inert text under the strict CSP
  in the web UI (K-507, M-13) and as a marked untrusted text block
  with a size cap through MCP (M-15). Requirement: K-517 (proposed),
  K-516 (proposed), K-507, K-508. Test: the unit test
  `k517_schema_invalid_audit_output_discarded` feeds malformed,
  oversize, and identity-mismatched responses through the fake and
  requires the `invalid-output` outcome with zero findings shown and
  the deterministic result unchanged; the unit test
  `k517_plugin_md_missing_or_mismatched_fails_deterministic_check`
  requires a named failure for a missing file, a missing section, an
  undeclared documented input, and a version mismatch; the e2e test
  `k517_plugin_docs_render_as_sanitized_markdown` feeds a
  script-bearing `PLUGIN.md` through the Docs view and requires
  inert text with the CSP header present.

## 6. Muse contract assessment: bounded MVP feature with both providers

The MVP feature is the button or tab "Muse contract assessment" in
the web UI, with the REST endpoint and the MCP tool over the same
application service. The feature delivers a free-text assessment
through the selected provider per K-309: Meta Model API with Muse
Spark through `adapters/assessment/metaModelApi`, or hosted with Muse
Spark Open (`meta-models/muse-spark-open-1026`) through
`adapters/assessment/hostedOpenWeights`, both behind
`AssessmentModelPort` and built solely on the closed
evidence list as per K-302. The feature follows K-305, K-309, I-13
and I-18.
The template-based explanations as per K-301 are the standard in every
interface and are always shown.

### 6.1 The deterministic core has no prompt injection surface

The deterministic core has no prompt injection surface, in every mode.
The statement holds explicitly:

- The analysis path makes zero calls to `AssessmentModelPort` and zero
  calls to LLM or model APIs ahead of an explicit assessment request.
  The fast path and the deepening consist
  of deterministic steps and RPC readings as per K-102, with
  extdecomp snippets as the deepening's sole addition.
- The core receives contract strings solely as typed values through
  `UntrustedText.quote` for quoting in template text and UI. The strings
  pass solely deterministic templates as per K-301, so
  instruction-like text in name, symbol, metadata,
  revert strings or decompiled code is rendered as quotation and
  text. The prompt concept lives solely in the assessment path outside
  the core.
- The core builds zero prompts and receives zero model output, so
  prompt injection reaches the core through zero paths: H-02 and the
  countermeasures M-03–M-06 and M-20 govern the assessment path after
  a request, with the core outside that path. Verification runs through
  the integration test `k102_analysis_path_makes_no_model_calls`,
  which runs the analysis with a network fake that counts every outbound
  call and requires that the calls go solely to the RPC port and
  that `AssessmentModelPort` receives zero calls ahead of a request,
  for each provider selection, and through
  the integration test `k305_no_assessment_call_until_user_requests_assessment`,
  which requires template text in every interface and zero calls to
  `AssessmentModelPort` ahead of the request.
- Muse as the build tool through Muse Code belongs to the build
  as per section 9 in `docs/requirements.md` and is included in
  the build surface in section 4.13, with the runtime analysis path kept
  separate from the build surface.

The threat model applies to the assessment path after a request with
either provider selected; H-02 and H-14 are active on that path, with
the deterministic core outside it at all times.

### 6.2 On-request assessment with either provider: injection paths

After an explicit request, the assessment runs solely through the
button or tab, the REST endpoint or the MCP tool, with the selected
provider per K-309. The injection paths
into the prompt are exhaustively these, each handled by
M-03–M-06 and M-20 against H-02 and H-14 for both providers:

| Path | Carrier into the prompt | Handling |
|---|---|---|
| Token name and symbol | Strings from the contract's metadata and storage reading | Quoted untrusted data with a length limit through `UntrustedText.quote` (M-04); shown at most as a quotation (K-308). |
| Revert strings and error messages | Strings extracted from bytecode and decompiled code | The same quoting and length limit (M-04); the response structure is governed by the evidence list (M-03). |
| Function names and selector suggestions | Name suggestions from the local selector table linked to selectors in the bytecode | Typed evidence entries with selector as key; the name suggestion travels as a quoted field in the entry (M-03, M-04). |
| Decompiled code | Snippets from extdecomp linked to signals after the deepening | The snippet travels with the evidence entry as quoted data with a size limit; raw bytecode stays in the analysis path as per K-302 (M-03, M-04). |
| Current values and capabilities | Measured values as per K-016 and permissions from proxy resolution | Typed fields in the evidence entry with value, slot, block and point in time and authorised changer respectively as per K-303 (M-03). |

Every path meets the same protections in series for both providers: the closed typed
evidence list in M-03 keeps instruction and data in separate fields,
quoting in M-04 keeps the strings as data, schema validation
in M-05 keeps the response within claims with valid signal links and
the markers holds now and can change, the one-way chain
in M-06 keeps probabilities, grade, signals and evidence frozen
before the call, and identity, size and schema checks in M-20 keep
tampered or oversize provider responses at the template text. A successful injection thereby reaches at most
the wording in a response that is validated, marked and cached as per
section 6.3, with the template text as the outcome at every deviation.

### 6.3 Marking, caching and cost protection for both providers

- Marking: assessment text is clearly marked as Muse-generated in
  web UI, REST API and MCP, with its own field, provider and model id
  and a visible
  marking separate from the template text and from the deterministic
  score and evidence. Test: the e2e and schema validation test
  `k305_refined_text_marked_in_ui_rest_and_mcp` requires marking,
  provider and model id and its own field in every interface (M-05, M-20, K-502, K-513).
- Caching: assessment text is cached per code hash, prompt version,
  provider and model id
  as per K-305 and K-309, so the same cache key gives the same
  cached text with zero new assessment calls. A cache hit
  consumes zero RPC calls and zero assessment calls as per I-14.
  Test: the integration test
  `k305_refined_text_cached_per_codehash_and_template_version`
  requires zero new calls at a cache hit with the full key (M-09, K-504).
- Cost limit for both providers: at most one assessment call per
  uncached request
  applies as a fixed rule; every request sums its assessment calls and
  cost per provider and model id as per K-107; the per-provider daily
  caps `BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_META` and
  `BRANDKLIPPAREN_BUDGET_DAILY_CAP_ASSESSMENT_CALLS_hosted` with the
  cost caps per I-14
  close the assessment calls at the cap, with an alarm before each cap, and
  the template text keeps responding. Rate per key, daily quota per
  key and global rate as per M-08 apply to the assessment path to
  the same extent as to the analysis path. Test:
  the integration test `k107_no_request_zero_assessment_calls_and_cost`
  requires zero assessment calls and zero assessment cost ahead of an
  explicit request; the integration test `k107_alarm_fires_before_cap`
  requires an alarm before the cap at simulated consumption for each
  provider; the integration test
  `k513_cost_caps_and_alerts_apply_to_both_providers` requires
  per-provider caps and alerts (M-08, M-09,
  K-504, K-513).
- Key protection for both providers: both provider keys live in the
  platform secret store,
  leave the server solely as an authentication header to the
  selected provider's allowlisted endpoint and appear in client
  responses and logs with zero
  hits. Test: the integration test
  `k305_client_response_has_no_model_key` searches for key patterns for
  both providers in
  every client response and requires zero hits; the integration test
  `k513_both_provider_keys_absent_from_client_and_logs` covers logs
  (M-11, M-20, K-505, K-513).
- Provider response protection: tampered, malformed, oversize or
  identity-mismatched responses from either provider give the template
  text per M-20. Test: the integration test
  `k513_tampered_or_oversize_provider_response_rejected` against both
  adapters and the fake (M-20, K-513).
- Fallback: every error branch in `AssessmentModelPort` as per A-15, namely
  `timeout`, `rate-limited`, `invalid-output`, `output-too-large`,
  `provider-mismatch` and `unavailable`,
  gives the template-based text as per K-306 within the assessment
  time target as per K-101. Test: the timing test
  `k305_assessment_within_timeout_or_template` tests the target with
  delayed fakes for both providers (M-05, M-20, K-502, K-513).

## 7. Attack surface list

The list covers every entry point to running code, to storage and
to the build chain. The limitations state the governing boundary;
the values are versioned in `docs/infrastructure.md` as per I-11, I-12 and
I-14, and the risk model's learned values live solely in the artifact
as per K-210.

| Entry point | Authentication | Input | Limitations |
|---|---|---|---|
| REST: analysis paths under `/v1` for `analyzeToken` and `resolveProxy` | API key in header, salted hash as per M-10 | Contract address as `0x1234…`, validated before analysis | Rate per key per minute, daily quota per key, global rate; size limit on the request; expensive steps require a key with remaining quota (M-08). |
| REST: Just-deployed list for `listJustDeployed` | API key in header | Filters for high risk, low risk and unverified contracts only, and page size | The same rate and quota as the analysis path; page size limit as per A-17 (M-08). |
| REST and web UI: health check `/health` | Open read status | Zero input | The response carries status per dependency, model version and artifact checksum with secrets kept outside the response as per I-12. |
| Web UI: search field, list view, token page and timeline | Open surface that calls the REST API through the published schema | Pasted address, filter, page choices | Client validation with server validation at B1 and B2 in every call; responses are rendered as text with a strict CSP (M-13); page size limit per response. |
| MCP: the `assess_token` tool | API key as per the MCP transport with the same quota as REST | Address parameter against the published strict input schema | The same rate, quota and cost cap as REST; output is marked as untrusted data with a size limit (M-15). |
| MCP: tool list and tool discovery | API key as per the MCP transport | Zero address input | Closed versioned list; unknown tools give a machine-readable error with the tool name (M-15). |
| Muse contract assessment: button or tab, REST endpoint and MCP tool | API key with remaining quota; solely on request with the selected provider per K-309 | Code hash and evidence list for an already analysed contract | At most one assessment call per uncached request; cache per code hash, prompt version, provider and model id; per-provider daily caps and cost caps; timeout and input and output size limits (M-08, M-09, M-20). |
| extdecomp worker via `DecompilerPort` | Internal port; calls solely from the application service | Bytecode as the sole input | Own process per run; time limit, memory limit and output limit; outbound networking switched off; read-only filesystem; concurrency cap (M-01, M-02). |
| RPC responses via `RpcPort` | Provider key in URL or header at an allowlisted host | Bytecode, storage words, call responses and block number | Schema validation at the boundary; time limit, response size limit and retry budget per call; uncertainty flag at deviation (M-14). |
| Cache via `CachePort` | Internal port; write path solely via the application service | Analysis results per code hash and model version | Verification at reading against code hash and model version; a new model version keys new entries (M-14). |
| Model artifact via `ModelArtifactPort` | File from the repo under `model/`, checked in with checksum | Artifact with model version, checksum and training data version | Checksum verification on loading before the first analysis; typed startup error at deviation (M-17). |
| DeploymentFeed via `DeploymentFeedPort` | Internal port from the project's own source | Recently deployed tokens with address, block and deploy time | Schema validation per entry; page size limit and time limit per call (M-14). |
| Configuration and secrets at startup | Platform secret store; operator access outside the repo | Prefixed environment variables as per I-08, keys as environment variables | Typed validation at startup; a startup error names the variable with the values kept outside the error text; `.env.example` carries solely names (M-11). |
| Logs and health responses out | Operator access to the platform log extract; open health status | Allowlisted log fields out; status per dependency out | Field allowlist and redaction as per I-10 at every log level (M-16). |
| CI: push, pull request and release | GitHub permission with least privilege per job as per I-03 | Code, lockfiles, fixtures and artifacts | Green gate with eleven named blocking jobs as per I-01; pinned Actions on SHA, images on digest and extdecomp on checksum; gitleaks, vulnerability and licence checks (M-12). |
| Offline chain: dataset and training | Operator access outside the repo; run during the hackathon | Fresh public on-chain data with address, bytecode, deploy block and label source | Provenance per data point, label policy, time- and cluster-divided splits, locked seeds and a reproducible command; export solely as artifact under `model/` (M-18, M-19). |
| Plugin registry and `pluginResults` (design per `docs/adr-plugin-architecture.md`) | Internal; registration solely at build time from reviewed source in the repo | Frozen manifests and declared deterministic facts in; validated findings out under `pluginResults` | Static compile-time registration with startup manifest, API-version, and capability validation; output schema, evidence, count, and size bounds; weight 0 until the artifact names the plugin; text-only generic rendering (M-21, M-22). |
| Plugin audit: CLI and CI job (design per ADR P-13, P-14) | Operator or CI identity; AI phase solely on opt-in with a configured hosted key | Plugin source, manifest, and `PLUGIN.md` from one plugin directory in; deterministic check results and, on opt-in, structured advisory findings out | Deterministic checks run first and block on failure; the AI phase sends solely the listed plugin files, quoted as untrusted data under size caps, tool-free; findings are schema-validated and advisory only; without a key the AI phase reports `not configured` with zero provider calls (M-23–M-25). |
| Plugin docs: `PLUGIN.md` via REST, MCP, and web UI (design per ADR P-15, P-16) | API key in header for REST and MCP as per the plugin list; web UI through the REST API | Plugin id in; validated markdown with its section list out | Read-only; presence and required sections validated deterministically before exposure; markdown rendered through a sanitizer with raw HTML as inert text under the strict CSP (M-26, M-13). |

## 8. Top 5 threats for the public demo

The ranking weighs likelihood times impact for a public
demo during the assessment period 4–8/11 2026, with the demo open to
arbitrary addresses such as `0x1234…` and with the Muse contract
assessment available on request through the selected provider. The scale is low, medium or high per factor;
the product of the factors governs the order and equal products are separated
by the width of the exposed surface.

| Rank | Threat | Likelihood | Impact | Product | Rationale |
|---|---|---|---|---|---|
| 1 | H-01 Decompilation DoS and resource exhaustion | High | High | Highest | Every submitted address reaches extdecomp in the deepening from the first call, and pathological bytecode is free to deploy. A successful exhaustion ahead of the sandbox binds workers, delays the deepening for parallel assessors and hits the demo during its most visible window. The sandbox in M-01 with time, memory and output limits is operation's most important boundary. |
| 2 | H-04 Draining via expensive analysis paths | High | High | Highest | The demo is public and every uncached analysis costs RPC calls and a extdecomp run. A single actor with address rotation reaches the cost cap or the global rate and degrades response times for the jury. Rate, quota, cap and cache in M-08 and M-09 keep the demo reachable with cached responses. |
| 3 | H-07 Script via contract data in the UI | Medium | High | High | Token names, symbols and strings are attacker-controlled on every token page and in every list row, so a single shown token reaches every visitor's browser. A successful script runs in the product's own view during the assessment and harms trust in every shown figure. Text rendering and strict CSP in M-13 keep the data inert in every view. |
| 4 | H-09 Manipulated RPC responses and cache poisoning | Medium | High | High | Incorrect bytecode or storage from a node, or a poisoned entry under a valid code hash, gives an incorrect assessment that looks deterministic and is reused for every following caller with the same code. Schema validation, block binding and verified cache entries in M-14 make the deviation visible as an uncertainty flag. |
| 5 | H-05 Stolen, leaked or guessed API key | Medium | Medium | Medium | A leaked key amplifies H-04 under the key's own quota and is hard to detect afterwards in a public demo with many callers. Hashed storage, header transport, constant-time comparison and revocation from the next call in M-10 and M-11 bound the theft surface and the damage per key. |

H-02 prompt injection and H-14 provider response tampering stand
outside the list as assessment-path threats: the deterministic core
has no prompt injection surface as per section 6.1, and the assessment
path runs solely after an explicit request. On that path H-02 reaches
the assessment wording at most, with M-03–M-06 and M-20, marking,
caching and schema validation as per section 6 as the governing
protections for both providers. H-11 artifact manipulation carries the highest impact per
hit and the lowest likelihood through the repo's and the gate's protections, and
therefore stands as the first threat outside the list.

## 9. Residual risks and assumptions

Residual risks, each read through at every review as per
section 1:

- Intent requires data outside the bytecode. An
  assessment with low code risk means the analysis found few
  dangerous capabilities in the code; the actor's intent belongs to
  the can't tell list as per K-012.
- Liquidity locks, ownership shares, dumping, team and
  wallet clusters lie outside the contract and are reported in
  the can't tell list as per K-012 with the data source
  required per item, separate from the grade.
- An RPC provider that responds consistently, in the right format and with
  plausible values passes the schema validation in M-14. The protection
  makes deviating formats and stale responses visible; the honesty of
  well-formed responses rests on the assumption below.
- Obfuscation that decompiles with valid form and changed
  semantics gives missed signals. The response carries an uncertainty flag and
  the hard-to-analyze code signal where the structure deviates, as per
  `kunskap/bytecode-forskning.md`.
- Muse phrases with a wrong nuance within a valid schema from
  either provider. Signal links as per K-304, provider and model
  marking per K-305 and the template text as a comparison keep every claim
  checkable against the evidence.
- A vulnerability in a pinned dependency or in the extdecomp binary
  is detected through the vulnerability scanning in M-12 and through alarms in
  operation. Between publication and scanning the protection rests on
  the sandbox in M-01 and the limits in M-02.
- Keys in the hands of an authorised operator and the platform's
  own access to the secret store are handled by the platform
  permission model as per I-09.

Assumptions, each verified as far as the review reaches:

- A majority of the allowlisted RPC nodes respond honestly on
  Ethereum mainnet, and responses are bound to block number as per
  K-102 so every assessment is recreated.
- Each assessment provider (Meta Model API and hosted) responds as
  per its documented schema from the demo after a request, and every
  deviation gives the template text as per K-306 and M-20.
- The platform secret store, TLS, container isolation and
  sandbox execution on Modal work as per I-11.
- The platform system clock keeps log times, rate limits
  and rotation dates in I-09 and I-12 in the right order.
- The review before demo and publication as per I-15 reads the
  built code against this file, so every H-xx, M-xx and every row
  in the attack surface list matches running components.

## 10. Traceability

The table gathers every countermeasure with its K-5xx requirement and its
governing test method. The link in the opposite direction, from every
K-5xx to its threats and countermeasures, is in section 12.2 in
`docs/requirements.md`.

| Countermeasure | Threat | K-5xx | Governing test method |
|---|---|---|---|
| M-01 Isolated extdecomp worker | H-01 | K-501 | `k501_pathological_input_isolates_to_its_analysis` (integration) |
| M-02 Size limits and typed outcomes | H-01 | K-501 | `k501_mutated_bytecode_yields_signal_or_typed_error` (fuzz) |
| M-03 Closed typed evidence list | H-02 | K-502 | `k302_prompt_contains_closed_typed_evidence_list` (unit) |
| M-04 Quoted untrusted data | H-02 | K-502 | `k502_injection_strings_yield_at_most_one_quote` (unit) |
| M-05 Schema-validated output with template fallback | H-02 | K-502 | `k305_invalid_output_routes_to_template` (integration) |
| M-06 One-way explanation chain | H-02 | K-502 | `k307_scores_and_evidence_identical_with_and_without_adapter` (unit) |
| M-07 Allowlisted outbound targets | H-03 | K-503 | `k503_crafted_inputs_stay_within_allowlist` (unit) |
| M-08 Rate limits and quotas | H-04 | K-504 | `k504_limits_hold_under_overload_and_cache_serves` (load test) |
| M-09 Cost cap, alarms and cache for both providers | H-04 | K-504, K-513 | `k513_cost_caps_and_alerts_apply_to_both_providers` (integration) |
| M-10 Header transport and hashed comparison | H-05 | K-510 | `k510_key_comparison_is_constant_time` (property) |
| M-11 Lifecycle and secret-free history for all keys | H-05 | K-505, K-510, K-513 | `k505_gitleaks_clean_on_repo_and_history` (CI check) |
| M-12 Locked and scanned supply chain | H-06 | K-506 | `k506_pinning_and_vulnerability_scan_block_release` (CI check) |
| M-13 Text rendering with strict CSP | H-07 | K-507 | `k507_script_bearing_data_renders_as_inert_text` (e2e) |
| M-14 Validated responses and verified cache | H-09 | K-511 | `k511_manipulated_rpc_response_flagged` (integration) |
| M-15 Reading MCP tools with marked output | H-08 | K-508 | `k026_tools_leave_state_unchanged` (unit) |
| M-16 Field allowlist and redacted logs | H-10 | K-509 | `k509_key_like_strings_redacted_in_output` (unit) |
| M-17 Checksum-verified artifact | H-11 | K-512 | `k512_tampered_artifact_rejected_before_analysis` (integration) |
| M-18 Provenance and leakage-free splits | H-12 | K-512 | `k512_training_data_provenance_checked` (review) |
| M-19 Locked seeds and canonical determinism | H-13 | K-512 | `k102_two_runs_across_processes_bit_identical` (integration) |
| M-20 Validated, size-bounded, identity-checked provider responses | H-14, H-02 | K-513, K-502, K-505 | `k513_tampered_or_oversize_provider_response_rejected` (integration) |
| M-21 Static, compile-time registration of reviewed plugin source | H-15 | K-514 (proposed), K-506 | `k514_registry_has_no_dynamic_loading` (CI check) |
| M-22 Pure, bounded, schema-validated, weight-0 plugin output rendered as text | H-16 | K-515 (proposed), K-102, K-507 | `runDetectorPluginContract` (contract) |
| M-23 Deterministic-first audit gate with human acceptance | H-17, H-18 | K-516 (proposed), K-307 | `k516_deterministic_failure_runs_zero_model_calls` (integration) |
| M-24 Injection-resistant audit prompt over quoted untrusted files | H-17 | K-516 (proposed), K-502 | `k516_injection_in_source_or_docs_stays_quoted_data` (unit) |
| M-25 Opt-in, minimised, and logged source disclosure for the audit | H-19 | K-516 (proposed), K-505, K-513 | `k516_audit_sends_only_listed_plugin_files` (integration) |
| M-26 Schema-validated audit findings and sanitized, checked plugin docs | H-20 | K-517 (proposed), K-516 (proposed), K-507, K-508 | `k517_plugin_docs_render_as_sanitized_markdown` (e2e) |

Every row in the table is included in the suite or the gate as per A-22
and I-01. A change that activates a new component, port or
a new data flow updates the table in the same change as per
section 1.





