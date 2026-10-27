# ADR: Plugin architecture for Brandklipparen

Author: Jens Abrahamsson.
Status: proposed. This document is the design decision for a typed plugin
architecture. Implementation follows the stories in `backlog.md` (E-08)
test-first per A-21. No plugin code ships on the basis of this ADR alone.
Reading guide: requirements (K-IDs) are owned by `docs/requirements.md`,
architecture rules (A-xx) by `docs/architecture.md`, infrastructure rules
(I-xx) by `docs/infrastructure.md`, and threats with countermeasures
(H-xx, M-xx) by `docs/threat-model.md`. This ADR owns the plugin rules
(P-xx). Each P-rule is stated positively and gives the K-IDs it realises
or extends. Proposed new K-IDs are listed in section 10; they enter
`docs/requirements.md` in the first implementation story, in the same
change, per the cross-document check in section 12.3 there.

## 1. Context

Brandklipparen is a deterministic, bytecode-only ERC-20 rug-pull risk
analyzer: a pure typed core in `src/domain`, application services in
`src/application`, ports in `src/ports`, driven adapters in
`src/adapters`, driving adapters in `src/interfaces/rest` (Fastify `/v1`),
`src/interfaces/mcp`, and `apps/web`, wired by the single composition root
in `src/composition/root.ts` (A-01–A-05).

Three extension pressures exist today, each currently hand-wired:

1. Detectors. `detectCapabilities` in `src/domain/signals.ts`, clone
   matching through `cloneMatchSignal` in `src/domain/clones.ts`, and the
   hard-to-analyze fallback in `src/application/analyzeToken.ts` are called
   directly from `analyzeToken`. A new detector means editing the shared
   service, the canonical serializer, the REST schema, the MCP surface,
   and the web UI.
2. Assessments. The Muse contract assessment already sits behind
   `AssessmentModelPort` in `src/ports/assessmentModel.ts` with two
   adapters selected once in the composition root (A-34, K-305, K-309).
   That port is the proven shape for an opt-in, non-deterministic
   extension; it is not yet expressed as a reusable plugin kind.
3. Data sources. RPC, decompilation, cache, clone index, and feed access
   already sit behind ports (A-05). Each port carries its own error union
   (A-15), limits (A-17), and threat review.

The design goal is the smallest typed plugin architecture that lets
first-party and third-party-style detectors and assessment providers plug
in without forking the core, while every hard constraint in section 5
holds by construction and by CI enforcement, not by convention.

## 2. Decision summary

| Decision | Choice |
|---|---|
| Plugin kinds in v1 | Detector plugins and assessment plugins. Data-source plugins are excluded from v1 (section 4.3). |
| Registration | Static, compile-time registration in the composition root. No dynamic loading, no filesystem scan, no environment-named code path (P-07). |
| Contract | One typed manifest per plugin plus a kind-specific typed entry point, versioned by `PLUGIN_API_VERSION` (P-01, P-02). |
| Output schema | TypeScript types as the source of truth, with a JSON Schema (draft-07 subset) descriptor carried in the manifest for runtime validation and generic rendering. No new schema library (section 3.3). |
| Score influence | Plugin findings are reported with weight 0. A finding enters the score only after calibration names it in the versioned model artifact (P-05). |
| Registry exposure | One registry drives the REST plugin list and analysis output, the MCP tool surface, and the generic web UI panel (P-08–P-10). |
| Isolation | Detector plugins run in-process as trusted, pure, size-bounded functions in v1. Worker isolation is a precondition for any untrusted detector code (P-06). Assessment plugins keep the existing port limits, deadline, and cost caps. |

## 3. Typed plugin contract and manifest

### 3.1 The manifest

**P-01 Typed plugin manifest.** Each plugin carries one frozen manifest
value, validated at startup by a smart constructor in the same style as
A-10 and A-11. A manifest that fails validation is a typed startup error
naming the plugin id and the failed field, with values kept outside the
error text where they could carry secrets (K-505). The manifest fields
are normative:

| Field | Type | Invariant |
|---|---|---|
| `id` | `PluginId` (branded string) | Lowercase dotted name, `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`, for example `dev.brandklipparen.capability`. Unique in the registry; the id namespaces every finding the plugin emits. |
| `version` | `PluginVersion` (semver) | Semver `MAJOR.MINOR.PATCH`, same form as `ModelVersion` in A-10. Carried in analysis output per registered plugin that ran (section 6). |
| `kind` | `"detector" \| "assessment"` | Closed union per A-12; a new kind gives a type error at every registry dispatch site until handled. |
| `apiVersion` | `PluginApiVersion` (semver) | The plugin API the plugin was built against. The core accepts exactly the supported range in P-02. |
| `displayName` | `string` | Short English name for the plugin list and the UI panel (K-108). Rendered as text only (K-507). |
| `description` | `string` | One or two English sentences. Rendered as text only. |
| `inputs` | `readonly PluginInputName[]` | Declared subset of the closed input catalogue in section 3.2. The host passes exactly the declared inputs and nothing else. |
| `outputSchema` | `JsonSchema` | JSON Schema descriptor for the plugin output, per section 3.3. Validated at startup and used for boundary validation and generic rendering. |
| `capabilities` | `PluginCapabilities` | Closed capability flags per section 3.4. Every capability the plugin needs is declared; undeclared capabilities are unrepresentable in the host call. |
| `limits` | `PluginLimits` | Per-plugin bounds: `maxFindings`, `maxEvidencePerFinding`, `maxOutputBytes`, and for assessment plugins `deadlineMs`, `maxBytesIn`, `maxBytesOut`, `maxConcurrency` mirroring A-17. Values arrive through typed configuration (I-08), never from the plugin at run time. |

**P-02 Versioned plugin API.** The core exports one constant,
`PLUGIN_API_VERSION`, starting at `1.0.0`. Compatibility follows semver
on the API, separately from any plugin's own `version`:

- A core minor release adds optional manifest fields, optional inputs, or
  optional output-schema keywords. Existing plugins keep running.
- A core major release may remove or rename fields, inputs, or finding
  shapes. The registry accepts a plugin whose `apiVersion` major equals
  the core major and whose minor is at most the core minor. Every other
  plugin is turned away at startup with a typed error naming the plugin
  id and both versions.
- The registry records `apiVersion` per plugin in the plugin list
  (section 6), so a mixed registry is visible before the first analysis.

### 3.2 Declared inputs: a closed catalogue

A detector plugin declares its inputs from a closed catalogue of facts
the host has already computed deterministically. The catalogue is a
discriminated union owned by the plugin API; a plugin receives one frozen
`DetectorInput` value holding exactly its declared facts:

| Input name | Value | Source today |
|---|---|---|
| `bytecode` | `Bytecode` with `CodeHash` | RPC fetch in `analyzeToken` (K-001) |
| `selectors` | Extracted selectors with name suggestions | `extractSelectors` in `src/domain/selectors.ts` (K-009) |
| `disassembly` | Linear opcode disassembly with PC offsets | `disassemble` in `src/domain/selectors.ts` |
| `proxy` | `ProxyResolution` | `resolveProxy` (K-002–K-007) |
| `cloneMatch` | `CloneMatch \| null` with index version | `CloneIndexPort` (K-017) |
| `snippets` | Decompiled snippets linked per selector, where the deepening produced them | `DecompilerPort` deepening (K-008) |
| `measuredValues` | Current storage values with slot, block, and time | K-016 readings, where they exist |

Facts arrive as parameters, frozen, exactly as shared read data does
today under A-08. A fact the registry cannot supply for a given analysis
(for example `snippets` before the deepening) is absent from the input
value; the plugin returns its findings from the facts present or returns
an empty list. Requesting an input outside the catalogue is
unrepresentable: the manifest type admits only catalogue names.

An assessment plugin declares no detector inputs. Its sole input is the
closed evidence list per K-302, delivered through the existing assessment
path (section 4.2).

### 3.3 Output schema: TypeScript types plus JSON Schema, no new library

The existing codebase validates boundaries with plain checks plus smart
constructors, publishes JSON Schema for the REST API in
`src/interfaces/rest/schema/v1.json` and for MCP tools in
`src/interfaces/mcp/tools.ts`, and carries no runtime schema library in
A-29: the REST adapter comment records that no schema library is needed
at runtime (A-16). A general schema library (for example zod) is a new
runtime dependency with its own versioning and supply-chain review under
K-506 and I-04, and it gives a second source of truth beside the
TypeScript types that A-26 and K-106 already enforce.

The plugin contract therefore follows the existing typed domain:

1. TypeScript types are normative. Each plugin kind has a typed output
   (section 4), and each plugin ships a typed `parse` or smart-constructor
   path for its own finding payloads, in the style of A-11.
2. The manifest carries an `outputSchema` as a JSON Schema descriptor
   (the draft-07 subset already used in `v1.json` and in the MCP
   `JsonSchema` type). The descriptor exists for three consumers that
   types alone cannot serve: boundary validation of plugin output at
   run time, publication in the REST and MCP surfaces, and generic
   rendering in the web UI.
3. The host validates every plugin output against `outputSchema` at the
   registry boundary before the output reaches scoring, serialization,
   or rendering. Validation uses the same plain-check style as A-16,
   over the closed keyword subset the registry documents (`type`,
   `required`, `properties`, `items`, `enum`, `const`, `minimum`,
   `maximum`, `minItems`, `maxItems`, `minLength`, `maxLength`,
   `additionalProperties: false`). Output outside the subset or outside
   the schema gives the typed outcome `invalid-output` for that plugin
   (section 5.4) and leaves the rest of the analysis standing.
4. A contract test per plugin checks that the typed output and the
   `outputSchema` agree on frozen examples in both directions (valid
   output passes, each schema field removed or mistyped fails), so the
   two representations stay honest against each other, in the same spirit
   as the fake-versus-adapter contract suites in A-22.

### 3.4 Capabilities

`PluginCapabilities` is a closed record of booleans with a stated default
per kind. Capabilities gate what the host offers the plugin; they never
widen what the plugin can reach, because the plugin receives only values
(section 5.1).

| Capability | Detector default | Assessment default | Meaning |
|---|---|---|---|
| `needsNetwork` | `false`, and `true` is rejected at startup | `true` through its port only | Detector plugins hold zero network capability (P-03). Assessment plugins reach exactly their provider endpoint through `AssessmentModelPort` limits (A-17, I-13). |
| `needsSecrets` | `false`, rejected at startup | `false` in the manifest | Provider keys stay in the composition root and adapters (I-09); a plugin never receives a key value. |
| `affectsScore` | `false` | `false`, permanently | Read-only declaration of the P-05 state: `false` until the model artifact names the plugin (detectors), and always `false` for assessment plugins (K-307). Setting `true` in a manifest is display metadata only; scoring reads the artifact, never the manifest. |
| `runsInFastPath` | `true` | `false`, permanently | Detector plugins run inside the fast path budget (K-101). Assessment plugins run solely on request (K-305). |

## 4. Plugin kinds

### 4.1 Detector plugins

**P-03 Detector plugins are pure and deterministic.** A detector plugin
is a synchronous pure function from its frozen `DetectorInput` to a
frozen list of findings:

```ts
type DetectorPlugin = {
  readonly manifest: PluginManifest; // kind: "detector"
  readonly detect: (input: DetectorInput) => readonly PluginFinding[];
};
```

A finding carries: the namespaced finding id (`<pluginId>:<localId>`),
a short English title, an optional advisory severity and direction, at
least one evidence entry, and a kind-specific payload validated against
`outputSchema`. Evidence follows A-13: each finding requires a
`NonEmpty<Evidence>` where each entry carries a selector and a PC offset
where the offset is derivable (K-010). A finding without evidence fails
construction, exactly as a signal without evidence does today.

Detector plugins hold no port, no clock, no randomness, and no ambient
state. The host supplies time, block, and model values as input fields,
per A-32. Section 5.1 states the enforcement.

### 4.2 Assessment plugins

**P-04 Assessment plugins wrap `AssessmentModelPort`.** An assessment
plugin is an `AssessmentModelPort` implementation plus a manifest with
`kind: "assessment"`. The existing Meta Model API adapter and hosted
open-weights adapter become the first two assessment plugins by
registration; the port, its error union (A-15), its limits (A-17), the
contract suite `runAssessmentModelPortContract`, and the exactly-one
selection in the composition root (A-03, A-34) all stay as they are.

Assessment plugins inherit the standing rules unchanged:

- Opt-in and off by default: zero provider calls ahead of an explicit
  request through the web UI tab, the REST endpoint, or the MCP tool
  (K-305, K-102).
- Input is solely the closed evidence list (K-302); contract strings pass
  `UntrustedText.quote` (K-308, M-04).
- Output is schema-validated, size-bounded, and identity-checked with
  provider and model id (K-513, M-20); every error branch gives the
  template text (K-306).
- The deterministic result is computed and frozen before the call, and
  the assessment lands in a separate labelled field, so scores, signals,
  and evidence stay bit-identical with and without it (K-307, A-33).
- Caching per code hash, prompt version, provider, and model id, with the
  per-key daily cost cap (K-305, K-309, I-14).

Exactly one assessment plugin is active at a time, selected by validated
configuration as today. The registry lists every registered assessment
plugin and marks the active one (section 6).

### 4.3 Data-source and chain adapters: excluded from v1

**Scope decision for this section. Data-source plugins are not a v1 plugin kind.**
RPC endpoints, price or metadata feeds, and chain adapters stay ports
with concrete adapters wired in the composition root. Three reasons,
each grounded in the current design:

1. The port is already the extension point. `RpcPort`, `DecompilerPort`,
   `CloneIndexPort`, `CachePort`, and `DeploymentFeedPort` each carry a
   typed interface, error union, and limits (A-05, A-15, A-17). A generic
   data-source manifest adds a second, weaker contract beside the port
   without removing any wiring.
2. Determinism is defined against fixed inputs. The core is a pure
   function of bytecode, on-chain readings at a fixed block, and the
   frozen artifact (A-07, K-102). A data source that can change its
   answers, rate limits, or schema at run time widens the input surface
   that golden tests must freeze (A-24) for no offsetting gain in v1.
3. Each data source carries its own threat review. Outbound targets are
   allowlisted from validated configuration (K-503, M-07), responses are
   schema-validated at the boundary (K-511, M-14), and a new source is a
   new component under section 1 of `docs/threat-model.md`. Folding
   sources into the plugin registry would let a manifest change quietly
   add an outbound flow.

The future path is stated so the exclusion is a deferral, not a dead end:
a new data source arrives as a new or existing port with its adapter,
its contract suite, and its threat-model rows, registered in the
composition root like every adapter today. If operational experience
later shows repeated source shapes, a data-source kind is designed as
its own ADR against that evidence.

## 5. Hard constraints and their enforcement

### 5.1 Determinism: pure detector plugins, enforced at the boundary

**P-03 holds through types first, lint second, and tests third:**

- By type: `detect` is synchronous and returns a value. The signature
  admits no `Promise`, no `CallContext`, no port, no callback, and no
  options bag through which I/O could be requested. Inputs are `readonly`
  and frozen at construction (A-09).
- By boundary lint: detector plugin modules live under
  `src/plugins/detectors/<name>/` and import solely the plugin API
  (`src/plugins/api/`) and `src/domain` types and pure functions. Two new
  dependency-cruiser rules join A-06 in `.dependency-cruiser.cjs`:
  `boundary-detector-plugins-pure` (detector modules reach no adapter,
  no interface, no composition module, and no `node:` module) and
  `boundary-plugins-via-registry` (only `src/plugins/registry.ts` and
  `src/composition` import concrete plugin modules). The ESLint blocks
  that already cover `src/domain` extend to detector modules:
  `no-restricted-imports` on `node:*` and `no-restricted-globals` on
  `process`, `fetch`, `XMLHttpRequest`, and `WebSocket`. A CI check in
  the style of `a32_domain_has_no_clock_random_or_network` searches
  detector modules for clock, randomness, and network identifiers and
  requires zero hits.
- By test: the registry contract suite runs each detector plugin twice
  on the same frozen input in one process and once in a second process,
  and requires bit-identical canonical output (the plugin-level form of
  `k102_two_runs_across_processes_bit_identical`). A property test feeds
  generated bytecode and requires that input values are unchanged after
  `detect` (A-09, A-22).

Assessment plugins sit outside the deterministic path by construction
(P-04), so their network access never reaches the core (A-33, section 6.1
of `docs/threat-model.md`).

### 5.2 Scores: weights come only from calibration

**P-05 Plugin findings carry weight 0 until calibrated.** The risk
function `score(signals, artifact)` in `src/domain/risk.ts` keeps its
current signature and its current input: calibrated `Signal` values and
the frozen artifact (A-19, K-210, K-211). Plugin findings travel in a
separate envelope field (section 6) and never enter that call. Three
consequences hold by construction:

1. A newly registered detector plugin changes no probability and no
   score on any input. The property test
   `plugin_findings_leave_probabilities_and_score_unchanged` compares
   the frozen analysis with each plugin enabled and disabled and
   requires bit-identical probabilities, score, and signals.
2. A plugin cannot raise its own influence. Advisory severity and
   direction in a finding are display values. The mapping from a plugin
   finding to risk, direction, and severity for scoring is read from the
   model artifact at promotion time, never from the manifest or the
   finding.
3. Promotion is a calibration event, not a code change alone. When
   evaluation per K-205 and K-206 supports a finding, the offline chain
   adds a calibrated entry naming the plugin id and finding shape to a
   new artifact version. The host then converts matching findings to
   `Signal` values through the artifact mapping ahead of `score`, with
   the artifact checksum and model version stated in the response as
   today (K-102). The plugin's `affectsScore` capability display flips
   only because the artifact names it; the artifact stays the sole
   source the code reads (K-210).

### 5.3 No dynamic loading of arbitrary code

**P-07 Registration is static and compile-time.** The registry is a
frozen array literal in `src/plugins/registry.ts`, assembled from static
imports, and handed to the composition root, which stays the single
module that knows concrete plugin and adapter classes (A-03). The
following are absent by design and guarded in review: no `import()` of a
computed specifier, no filesystem scan of a plugins directory, no plugin
path or name read from environment or configuration, and no code fetched
over the network. Configuration selects among already-registered plugins
(enable, disable, and the one active assessment plugin); configuration
never names code to load.

First-party and third-party-style plugins follow the same path: the
plugin ships as TypeScript source in this repo (section 8), is reviewed
like any change, is pinned by the lockfile supply chain (I-04, M-12), and
registers in the same array. A future signed-allowlist distribution,
where a separately published plugin package is admitted by signature and
checksum at build time and still imported statically, is a stretch item
(S-049) and requires its own threat-model change before any code. Runtime
admission of unsigned or remotely fetched code is a non-goal at every
stage.

### 5.4 Isolation, timeouts, and failure containment

**P-06 A failing plugin degrades to a typed plugin outcome, and the
analysis stands.** The registry wraps each detector call and records one
outcome per plugin per analysis:

| Outcome | Meaning | Effect on the analysis |
|---|---|---|
| `ok` | Findings validated against `outputSchema` and evidence rules | Findings join `pluginResults` (section 6) |
| `invalid-output` | Output fails schema, evidence, size, or count limits | The plugin contributes an empty finding list and a typed outcome entry; every other plugin and the core result stand |
| `threw` | The plugin raised instead of returning | The same containment as `invalid-output`, logged with plugin id, version, and request id (I-10); the raw exception text stays out of the response |
| `input-unavailable` | A declared input fact is absent and the plugin declares it required for any output | Empty finding list with the outcome recorded; used sparingly, since plugins return partial findings by default (section 3.2) |

Detector plugins run in-process in v1 under these bounds: input size is
already bounded by the `Bytecode` limit (A-17), and the host enforces
`maxFindings`, `maxEvidencePerFinding`, and `maxOutputBytes` on the
returned value before serialization. A synchronous pure function holds
no preemptive timeout in-process, and this ADR states that limit plainly:
v1 detector plugins are trusted code, reviewed and tested like core
code, and a runaway detector is a defect caught by the timing tests in
K-101 and the plugin contract suite. Any future detector that is not
reviewed first-party code moves behind a worker boundary with a deadline,
memory limit, and output limit in the extdecomp style (A-27, I-11, M-01)
before it is registered; that move is the stretch story S-050, and it is
a precondition for untrusted detectors, not an optimisation.

Assessment plugins keep the existing isolation shape: server-side calls
through the port with deadline, input and output size limits,
concurrency bound, cost cap, and template fallback on every error branch
(A-17, A-34, I-13, I-14).

### 5.5 Canonical serialization and golden stability

**P-11 Plugin output enters canonical serialization on stated keys.**
The envelope gains one field, `pluginResults`, serialized solely through
`canonicalSerialize` in `src/domain/serialize.ts` (A-32 point 5):

- `pluginResults` sorts by plugin id, then by finding id within a plugin.
- Each entry carries `pluginId`, `pluginVersion`, `apiVersion`,
  `outcome`, and `findings`; finding payload keys serialize in
  lexicographic order through the canonical path, and numbers follow the
  fixed-rounding rule (A-32 point 6) where a payload carries a
  probability-like value.
- The additive field is the only change to existing golden fixtures in
  the migration (section 7): probabilities, score, signals, evidence,
  explanation, and can't-tell bytes stay identical, and each changed
  golden file is reviewed as an additive change linked to its story, per
  A-22. The REST schema in `src/interfaces/rest/schema/v1.json` gains the
  field as an optional-to-required addition within `/v1` (additive, so
  no new major version per K-023), and the reproduction fields per
  K-102 stay as they are, with plugin versions recorded inside
  `pluginResults`.

Cache keys (K-013) gain the sorted set of enabled detector plugin ids
and versions beside code hash and model version, so enabling or upgrading
a plugin never serves findings computed without it; a new set keys new
entries while older entries stay unused, in the same pattern as a new
model version.

## 6. Registry and automatic exposure

**P-08 One registry, validated at startup.** `src/plugins/registry.ts`
exports a frozen `PluginRegistry` built once in the composition root:

1. Each manifest passes its smart constructor (P-01) and the API range
   check (P-02).
2. Duplicate plugin ids give a typed startup error naming the id.
3. Each `outputSchema` is checked against the supported keyword subset
   (section 3.3).
4. Detector capabilities are checked against the kind defaults
   (section 3.4); a detector declaring network or secrets is a startup
   error.
5. The validated registry is handed to the application service and to
   both driving adapters through `AppServices` construction (A-02, A-03),
   so REST, MCP, and the web UI read the same registry value.

The startup test in the style of
`a03_each_port_bound_to_exactly_one_adapter` gains a sibling:
`registry_rejects_duplicate_ids_and_unsupported_api_versions` runs the
builder against duplicate, out-of-range, and capability-violating
manifests and requires a typed startup error per case.

**P-09 REST exposure.** The REST adapter derives its plugin surface from
the registry at startup; no route is hand-written per plugin:

- `GET /v1/plugins` lists each registered plugin: id, version,
  apiVersion, kind, display name, description, declared inputs,
  capabilities, output schema, enabled state, and for detectors the
  calibrated state from the current artifact (`weight: 0` until named),
  and for assessment plugins the active marker. The route sits behind the
  same API-key gate as the analysis routes (K-024).
- `GET /v1/plugins/:id` returns the single manifest in the same shape, or
  the uniform not-found error (A-18).
- Detector invocation rides the existing analysis routes: `GET` and
  `POST /v1/analyze` run every enabled detector whose declared inputs are
  satisfiable and return findings under `pluginResults` in the assessed
  envelope. There is no per-plugin analyze route in v1, so one shared
  service keeps response equality across interfaces (K-027, A-02).
- Assessment invocation rides the existing assessment routes
  (`/v1/assessment`), which call the one active assessment plugin through
  the assessment service as today (K-305). The plugin list names the
  active plugin, so a caller discovers selection from the registry
  instead of a second route family.

**P-10 MCP and web UI exposure.**

- MCP: the tool list gains one registry-derived reading tool,
  `list_plugins`, returning the same manifest list as `GET /v1/plugins`
  in a text content block marked as data for the user (M-15). Detector
  findings ride the existing `assess_token` output under `pluginResults`,
  byte-identical to REST for the same code hash and model version
  (K-025, K-027), and the assessment field rides `request_assessment` as
  today. Per-plugin MCP tools (one generated tool per detector, with its
  input schema derived from the manifest) are a stretch item (S-048):
  the MVP server keeps a small closed tool list, and each generated tool
  still passes the K-026 security review before release, with the
  registry snapshot at startup as the reviewed list.
- Web UI: the token page gains a Plugins panel rendered generically from
  the registry response. The renderer maps the output-schema subset to
  presentational primitives only: text, number with tabular figures
  (K-103), boolean, enum badge, list, nested object, evidence link
  (selector and PC offset), and score-neutral severity word. Every plugin
  string renders as escaped text under the strict CSP (K-507, M-13);
  plugin-supplied markup, styles, scripts, and component names are
  unrepresentable in the schema subset, and unknown schema shapes fall
  back to canonical JSON rendered as text. No per-plugin UI code is
  written; a plugin that needs a shape outside the subset files a design
  change for the renderer, reviewed once for all plugins.

## 7. Migration: built-in detectors become plugins, then the legacy path is deleted

**P-12 Migration is sequenced so exactly one path exists at each step's
end, and the legacy path is deleted in the sequence, not left beside the
new one.** Each step is a backlog story (section 9) worked test-first
(A-21), and the deterministic core's golden fixtures stay green at every
step except for the reviewed additive `pluginResults` field.

| Step | Story | Change | Legacy deleted |
|---|---|---|---|
| 0 | S-042 | Plugin API types, manifest smart constructors, registry builder with startup validation, proposed K-IDs entered in `docs/requirements.md`, threat-model rows from section 10 merged. No behaviour change; the registry starts empty beside the existing path. | Nothing yet; the empty registry is the only addition. |
| 1 | S-043 | The capability detector becomes the detector plugin `dev.brandklipparen.capability`, wrapping the existing `detectCapabilities` logic moved behind `detect`. `analyzeToken` calls it through the registry. Its findings convert to today's `Signal` values through the existing catalogue path, so scores stay bit-identical; the plugin also reports findings with weight 0 in `pluginResults` during this step only as a shadow record checked equal to the converted signals in tests. | The direct `detectCapabilities` call in `analyzeToken` and the shadow comparison, once parity tests pass in the same story. |
| 2 | S-044 | Clone matching becomes `dev.brandklipparen.clone-match` over the `cloneMatch` input. The hard-to-analyze synthesis in `analyzeToken` becomes `dev.brandklipparen.hard-to-analyze`, fed by the deepening outcome as a declared host fact. | Direct `cloneMatchSignal` wiring and the inline fallback-signal construction in `analyzeToken`. |
| 3 | S-045 | The two assessment adapters register as assessment plugins (`dev.brandklipparen.assessment.meta-model-api`, `dev.brandklipparen.assessment.hosted-open-weights`) wrapping their existing `AssessmentModelPort` implementations. Composition still binds exactly one active adapter (A-34). | The provider-selection branches that name concrete adapters outside the registry registration; selection by configured plugin id replaces them in the same story. |
| 4 | S-046 | Registry exposure ships: `GET /v1/plugins`, `pluginResults` in the envelope and REST schema, the `list_plugins` MCP tool, and the generic Plugins panel in the web UI. | Hand-written per-detector rendering and any per-detector response shaping in the interfaces. |
| 5 | S-047 | Calibration promotion path: the offline chain can name a plugin finding in a new artifact version, and the host converts promoted findings to signals ahead of `score`. | The interim conversion special cases from steps 1–2; one conversion path through the artifact mapping remains. |
| 6 | S-047 (same story, final commit) | Callers in REST, MCP, and web UI read solely registry output. A repository search for the legacy detector entry points (`detectCapabilities`, `cloneMatchSignal` as direct service calls) returns hits only inside plugin modules and their tests. | Any remaining dual path. The migration ends here; running both paths past this step is a defect, not a phase. |

Proxy resolution, selector extraction, and template explanations stay
core domain functions, not plugins: proxy resolution selects which
bytecode is analysed (an input-shaping step with its own K-002–K-007
contracts), selector extraction is a shared fact every detector consumes,
and template explanations are the always-on deterministic text (K-301).
The plugin boundary is drawn at evidence-backed findings and at
assessments, where third-party-style variation is real.

## 8. Example plugin and the "Writing a plugin" guide

An example third-party-style detector lives under
`examples/plugins/fee-capability/` (added with implementation, story
S-051; this ADR fixes its shape):

```
examples/plugins/fee-capability/
  README.md        # what it detects, inputs used, example findings
  manifest.ts      # the frozen PluginManifest value
  detect.ts        # the pure detect function
  detect.test.ts   # unit and golden tests on frozen bytecode fixtures
```

The example detects fee-setting capability from declared `selectors` and
`disassembly` inputs and returns findings with selector and PC-offset
evidence. It imports solely the plugin API and domain types, registers
nowhere by default, and is wired in only by a reader following the guide
in a local build. `plugins/` at the repo root is reserved for first-party
plugins that graduate from examples; built-in plugins from section 7 live
under `src/plugins/` beside the registry.

The "Writing a plugin" section (for the repo README or
`docs/writing-a-plugin.md`, written in full with S-051) covers, in order:

1. Choose the kind: detector for evidence-backed findings from bytecode
   facts, assessment for an opt-in provider behind `AssessmentModelPort`.
2. Write the manifest first: id, version, apiVersion, declared inputs,
   output schema, capabilities, limits (P-01). The id namespaces every
   finding.
3. Implement `detect` as a pure function (detectors): frozen inputs in,
   frozen findings out, every finding with at least one evidence entry
   (P-03). Time, block, and model values arrive as input fields.
4. Test first: unit tests on frozen fixtures, the registry contract
   suite (determinism across two runs, output-schema agreement, evidence
   presence), and the weight-0 property (P-05).
5. Register statically in `src/plugins/registry.ts`, run the full gate
   (`typecheck`, boundaries, tests), and check the plugin appears in
   `GET /v1/plugins`, in `assess_token` output, and in the Plugins panel
   with no interface code changed.
6. Scores: findings report at weight 0. A calibrated weight arrives only
   through a new model artifact version after evaluation (P-05,
   K-205–K-211); the guide states this expectation at the top, so no
   plugin author designs around self-declared severity.

## 9. Consequences

Positive:

- A new detector lands as one module, one manifest, one registry line,
  and its tests. REST listing, analysis output, MCP output, and the UI
  panel follow from the registry with no interface edits.
- Determinism, scoring integrity, and the assessment boundary keep their
  current proofs; the plugin rules reuse A-06, A-19, A-32, and A-34
  instead of adding parallel machinery.
- The exactly-one assessment provider rule (K-309) and the port contract
  suite survive unchanged under the assessment plugin kind.

Costs and limits, stated plainly:

- In-process detector execution trusts plugin code (section 5.4).
  Untrusted detectors wait for worker isolation (S-050).
- Generic UI rendering covers the documented schema subset. Rich
  per-plugin visualisation is out of scope; the fallback is readable
  canonical JSON as text.
- The additive `pluginResults` field changes the assessed envelope and
  cache keys once (section 5.5). Golden fixtures and the REST schema are
  updated in the same reviewed change.
- Data-source extensibility keeps its current cost: a new port, adapter,
  contract suite, and threat review per source (section 4.3).

## 10. Proposed requirements and threat-model updates

New K-IDs, proposed here and entered in `docs/requirements.md` by S-042
in the same change as their implementation stories begin:

| Proposed ID | Title | Priority |
|---|---|---|
| K-028 | Typed plugin manifest, versioned plugin API, and static registry validated at startup | MVP (for E-08) |
| K-029 | Detector plugins: pure, deterministic, evidence-backed findings at weight 0 until calibrated | MVP (for E-08) |
| K-030 | Assessment plugins behind `AssessmentModelPort`, opt-in, score-neutral | MVP (for E-08) |
| K-031 | Registry exposure: REST plugin list and analysis output, MCP listing and findings, generic web UI panel | MVP (for E-08) |
| K-514 | Plugin supply chain: static registration only, reviewed source, no dynamic or remote code loading | MVP (for E-08) |
| K-515 | Plugin output containment: schema validation, size and count bounds, text-only generic rendering | MVP (for E-08) |

Threat-model additions are drafted in `docs/threat-model.md` in this
change (H-15, H-16, M-21, M-22) against K-514 and K-515, and take effect
with the same review as this ADR. Existing IDs are untouched: A-06 gains
two rules, A-34 is realised by the assessment plugin kind, and no I-xx
value changes; new per-plugin limits join the typed configuration schema
(I-08) with their implementation stories.

Alternatives considered and set aside:

- Dynamic loading from a plugins directory or package registry at run
  time. Rejected: it breaks the static supply chain (M-12), admits
  unreviewed code to a deterministic analyzer, and needs a sandbox
  before it needs a loader (P-07).
- A schema library (zod) as the contract source of truth. Set aside in
  section 3.3: the repo's typed domain plus JSON Schema descriptors
  cover the need with no new runtime dependency.
- Per-plugin REST routes and per-plugin UI components. Rejected: they
  fork the shared-service equality proof (K-027) and grow the reviewed
  surface per plugin instead of once per registry.
- Letting plugin-declared severity feed `score` directly. Rejected in
  P-05: weights are calibration output (K-210), and a plugin that grades
  its own findings breaks that separation.

## 11. Open decisions

Defaults are chosen above so implementation can start. These decisions
remain with the product owner (Jens Abrahamsson) and are revisited at
the named points; none blocks S-042:

1. Hackathon timing for E-08. The plugin epic is scheduled after the
   submission-critical path in `backlog.md`; whether S-042–S-044 enter
   the 27/10–4/11 window or follow the submission is Jens's call at the
   31/10 checkpoint. The ADR is written so either timing keeps the
   submitted core unchanged in behaviour.
2. Signed third-party distribution. V1 registers reviewed source in this
   repo only. Whether a signed-package allowlist (S-049) is wanted at
   all, and who holds signing keys, is open; the default is no external
   distribution.
3. Per-plugin MCP tools. The default is the single `list_plugins` tool
   plus findings inside `assess_token` (S-048 as stretch). Generating one
   tool per detector is open pending a caller that needs direct plugin
   invocation.
4. Worker isolation for detectors. The default keeps trusted detectors
   in-process. Moving all detectors behind the worker boundary (S-050)
   is open pending a concrete untrusted-detector plan; it is mandatory
   before any such plugin registers, whichever way the default goes.
