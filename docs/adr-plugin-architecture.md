# ADR: Plugin architecture for Brandklipparen

Author: Jens Abrahamsson.
Status: proposed, critically reviewed (see section 0). This document is
the design decision for a typed plugin architecture. Implementation
follows the stories in `backlog.md` (E-08) test-first per A-21. No plugin
code ships on the basis of this ADR alone.
Reading guide: requirements (K-IDs) are owned by `docs/requirements.md`,
architecture rules (A-xx) by `docs/architecture.md`, infrastructure rules
(I-xx) by `docs/infrastructure.md`, and threats with countermeasures
(H-xx, M-xx) by `docs/threat-model.md`. This ADR owns the plugin rules
(P-xx). Each P-rule is stated positively and gives the K-IDs it realises
or extends. Proposed new K-IDs are listed in section 10; they enter
`docs/requirements.md` in the first implementation story, in the same
change, per the cross-document check in section 12.3 there.

## 0. Architecture review (critical review outcome)

This section records a critical review against the product owner's bar
— perfect, smart, innovative — and the decisions it locked. The body
below is the reviewed design; where this section and an older paragraph
disagreed during the review, the body now carries the reviewed wording
and this section says what changed and why. No application code changed
in the review.

**Verdict: the design is ready for full implementation once the
follow-up stories in section 0.3 are scheduled.** Nothing in sections
1–14 blocks starting S-045 onward. The review found no reason to reopen
the core bets (static registration, weight 0, one registry, local-only
priorities). It found over-claimed invariants, one ghost type, two
ports too many, and a headline feature (P-25/P-26) that was not yet
implementable as written. All four are fixed in the body.

### 0.1 What the review cut (subtract before adding)

1. **Two AI presentation ports become one.** `PluginLayoutModelPort`,
   `LayoutSpec`, and `POST /v1/layout` are retired before implementation
   and folded into the single `PluginPersonalizeModelPort` /
   `PersonalizeSpec` / `POST /v1/personalize` (P-27, decided; former
   open decision 12 is closed). The deterministic layout (P-19, P-20)
   and the schema-driven panel (P-18) are untouched. Shipping a
   layout-only AI spec first and a ranking-plus-layout spec second
   would have meant two contracts, two contract suites, two caches,
   and a toggle migration for a throwaway shape. One spec was always
   the stated end state (P-27); the review deletes the intermediate.
2. **The detector input catalogue shrinks from seven facts to three**
   (section 3.2). The host today supplies `bytecode` (with `codeHash`),
   `cloneMatch`, and `decompilerCause`. Detectors derive selectors and
   disassembly deterministically from bytecode with the shared domain
   helpers — exactly as the landed detectors do. `selectors`,
   `disassembly`, `proxy`, `snippets`, and `measuredValues` leave the
   v1 catalogue: the host either does not compute them as detector
   facts (`proxy` shapes the analysed bytecode before detection;
   `snippets` belong to the deepening explanation) or the detector
   derives them purely (`selectors`, `disassembly`). A fact re-enters
   the catalogue only by ADR amendment with a host computation and a
   determinism proof. Fewer facts, fewer host–plugin mismatches.
3. **The invented severity scale goes.** `info` and `critical` in the
   P-15 frontmatter enum and in P-26 matched no domain type (`Severity`
   in A-12 is `low | medium | high`). The frontmatter range and the
   severity floor now use the domain scale only (floor: `high`). No
   exhaustive `switch` over `Severity` gains a branch by accident.
4. **Advisory severity on findings goes.** Section 4.1 promised an
   optional advisory severity/direction on `PluginFinding`; the landed
   type has neither, and nothing consumed them. They stay out. Display
   emphasis comes from the calibrated signal where one exists and from
   the plugin's declared frontmatter range otherwise (P-26). One fewer
   self-grading channel for a plugin to game (P-05).
5. **The repeated no-zod rationale is stated once** (section 3.3).
   P-14 and the former P-22/P-28 each re-argued it; they now point
   back. Same decision, a third of the text, no drift between copies.
6. **`docs.version` goes.** The manifest `docs` reference carried a
   document version that had to equal the manifest `version` — a stored
   duplicate whose only job was to be checked against its twin. The
   reference is now the fixed file name alone; the version lives in
   exactly two checked places (manifest `version`, frontmatter
   `version` plus changelog line, P-17). One less state to keep equal.

### 0.2 What the review tightened (illegal states, boundaries)

1. **Manifests are discriminated by kind** (section 3.1): detector and
   assessment manifests are different types with different `inputs`,
   `limits`, and `capabilities` shapes, so a detector carrying a
   deadline or an assessment declaring detector inputs is a type
   error, not a runtime surprise. Detector-forbidden capabilities
   (`needsNetwork`, `needsSecrets`) fail in the manifest smart
   constructor itself, not later in the registry.
2. **The registry holds entries, not two parallel structures**
   (section 6): one entry per plugin carrying its manifest and, for
   detectors, its `detect` function. A registered manifest without an
   implementation is unrepresentable; startup validates the entry set
   once. The landed split (manifest registry beside a separate
   executable map, with a per-analysis `invalid-output` for a missing
   implementation) is migration debt with an exit story (section 0.3).
3. **The host projects declared inputs** (section 3.2): a detector
   receives a frozen input holding only facts it declared; an
   undeclared fact is absent, so reading one is a defect the contract
   suite catches by running each detector on its projection alone.
   The landed single superset input (every detector sees
   `cloneMatch` and `decompilerCause`) is migration debt (section 0.3).
4. **Finding identity and evidence are re-proven at the boundary**
   (section 4.1): the registry checks the `<pluginId>:` prefix on every
   finding id, that `finding.pluginId` equals the manifest id, and
   re-parses each evidence entry through the domain `Evidence` smart
   constructor. A selector-shaped string is not evidence until the
   domain constructor accepts it (A-13). The landed boundary check
   (string presence only) is migration debt (section 0.3).
5. **Weight 0 is stated as three scoped invariants** (section 5.2)
   instead of one blanket claim. The blanket claim ("enabling a plugin
   changes no score") is false for the three built-in detectors today:
   they affect the score through host-owned converters, by design, to
   keep legacy scores bit-identical. The invariants now separate
   non-promoted plugins (true weight 0, property-tested), built-in
   converters (interim, host-owned, exit in S-047), and promotion
   (one artifact mapping after S-047).
6. **The audit report is a discriminated union** (section 12.1): a
   deterministic failure carries `ai: not-run` by construction, so the
   impossible report ("deterministic failed, AI advisory attached")
   cannot be built. Acceptance is a derived predicate (deterministic
   pass and recorded human review), never a stored flag an AI result
   could sit beside.
7. **`PersonalizeSpec` validation takes its request context**
   (section 14.5): "ranking names an absent plugin" is checkable only
   against the ids the request actually offered, so
   `parsePersonalizeSpec` receives the present section ids, present
   plugin ids, and the floored sets. Ranking and placements operate
   at two levels that cannot conflict (cards inside one section;
   sections on the page), and the renderer's apply algorithm is
   written out step by step (section 14.5). The headline is now
   implementable without inventing semantics mid-story.
8. **Frontmatter is first-class registry data** (sections 12.2, 12.3):
   the parsed, validated frontmatter travels in the registry record,
   and the P-25 matcher consumes that typed value — never raw
   markdown. The former "content or hash, decided in S-056" deferral
   is decided: frontmatter, section index, and capped markdown text.
9. **One registry view model, owned once** (section 6): a pure
   derivation in `src/plugins` produces the exposed plugin shape;
   REST serialises it, MCP wraps the same canonical bytes, and the web
   UI reads it only through REST. `enabled` and `active` are data
   supplied by the composition root, never literal types baked into
   the view (the in-flight exposure draft's `enabled: true` /
   `active: false` literals must not freeze; section 6 states the
   requirement, the code fix belongs to its owning slice).

### 0.3 Reality check against landed S-042–S-044, and follow-ups

Landed code was read, not changed. Agreements worth keeping: the
manifest smart constructor style (A-11), the closed schema keyword
subset with recursive validation, detector purity lint
(`src/plugins/**` under the `node:*`/globals ESLint block; the
dependency-cruiser rules `boundary-detector-plugins-pure` and
`boundary-plugins-via-registry` exist, scoped to `src/plugins` rather
than the `detectors/<name>/` path section 5.1 originally described),
static registration, and the three built-in detectors behind the
registry with host conversion to legacy signals.

Deliberate deviations, each with one follow-up story (backlog S-071):

| # | Deviation in landed code | Normative end state (this ADR) |
|---|---|---|
| D-1 | `DetectorInput` is one superset; every detector sees all facts; hard-to-analyze declares only `bytecode` but reads `decompilerCause` | Projection per declared inputs (3.2); `decompilerCause` joins the catalogue and the hard-to-analyze manifest declares it |
| D-2 | Flat `PluginManifest`/`PluginLimits`; detector-forbidden capabilities rejected only by the registry | Discriminated manifests; rejection in the smart constructor (3.1, 3.4) |
| D-3 | Manifest has no `docs` field; `PLUGIN.md` files carry pre-refinement headings and no frontmatter | `docs` reference (3.1) plus the refined P-15 contract, delivered by S-052/S-065 as already planned |
| D-4 | Boundary evidence check accepts any selector-shaped string; finding id prefix unchecked | Boundary re-parse through `Evidence`, prefix and plugin-id checks (4.1) |
| D-5 | Registry is manifests only; executable map is separate; missing implementation degrades per analysis; `DEFAULT_PLUGIN_REGISTRY` throws at module load; `wireAppServices` defaults the detector set | Registry entries (6); composition builds the registry and maps failure to a typed startup error; no load-time throw, no defaulted detector set |
| D-6 | Built-in findings reach the score through three host converters (catalogue, clone mapping, placeholder risk) | One artifact mapping in S-047 as already planned; converters labelled interim until then (5.2) |

### 0.4 Remaining risks (accepted, named)

- **In-process detectors stay trusted code** (section 5.4). Purity is
  enforced by types, lint, and contract tests, not by a sandbox. A
  malicious first-party detector is a code-review failure, not a
  contained runtime event. Worker isolation (S-050) remains the hard
  precondition for any unreviewed detector; the demo registers only
  reviewed detectors.
- **The keyword matcher will miss paraphrases** (P-25). That is the
  price of a deterministic, offline, explainable headline, and the
  page says so when nothing matches. The AI personalize mode is the
  pressure valve, Stretch and off by default.
- **The conservative card floor can over-promote** (P-26): a plugin
  whose declared range reaches `high` keeps its card floored even for
  a mild finding. Accepted: burial of critical evidence is the worse
  failure for this product, and the floor never hides anything.
- **Frontmatter honesty is partly human** (P-17). Deterministic checks
  catch structural drift; semantic drift relies on the advisory review
  plus human acceptance. A plugin that declares `honeypot` tags and
  detects nothing is caught by reviewers, not by types. The demo's
  plugins are first-party, so the exposure is small and stated.

### 0.5 Verdict

**READY FOR FULL IMPLEMENTATION.** Sections 1–14 as reviewed, with
the reconciliation story S-071 scheduled (section 0.3, D-1–D-6) and
the follow-on extensions in sections 12–14, may proceed to
implementation in backlog order. No open decision in section 11
blocks S-045 onward; decisions 5–12 keep their stated defaults until
Jens rules otherwise at the named checkpoints. This verdict does not
reopen the cuts in section 0.1: the retired layout-only port stays
retired (personalize-only, P-27), the detector catalogue stays at
three facts (section 3.2), and severity stays on the domain scale
(section 0.1). The sibling design for the runtime investigation loop
is `docs/adr-investigate-with-muse.md` (P-29 onward); its readiness
is stated there and does not change this verdict. The sibling design
for the own ERC-20-scoped EVM decompiler is
`docs/adr-evm-decompiler.md` (D-01 onward, a separate rule namespace);
it consumes this registry as a detector plugin and does not change
this verdict either.

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
| Plugin audit | Deterministic static checks first, then an optional advisory AI review through a dedicated audit port on the existing hosted open-weights transport. The AI result never approves a plugin and never affects scores or evidence (P-13, P-14). |
| Plugin documentation | Every plugin ships a required `PLUGIN.md` with a strict YAML frontmatter (`id`, `kind`, `version`, controlled-vocabulary `tags`, `audience`, severity range on the domain `low \| medium \| high` scale) and fixed plain-English sections, validated deterministically in CI and exposed read-only through REST, MCP, and the web UI with sanitized rendering (P-15 refined, P-16). The audit checks documented claims against the code (P-17). |
| Adaptive web UI (after plugin core) | Schema-driven rendering from each plugin's `outputSchema` through a fixed component library, a deterministic risk-adaptive layout, and a Simple / Expert toggle persisted locally (P-18–P-20). No per-plugin UI code. |
| Experimental AI presentation | One mode only: AI personalize (P-27). Off by default. Muse Spark Open returns one declarative ranking-plus-layout spec that only chooses, orders, and emphasises whitelisted sections and plugin cards. It never emits HTML, code, URLs, or styles and never changes scores, evidence, or finding text. Invalid or missing spec falls back to the deterministic baseline (P-25), then to the deterministic layout (P-19). The former separate AI layout mode is retired before implementation (section 0.1). |
| User-priority personalization — **demo headline innovation** | The UI shows what the **user** says matters to them. Priorities are free text stored locally only, matched deterministically to plugin frontmatter tags (no network), and only ever sent to a model when the user explicitly opts in to the single experimental AI personalize mode for that mapping call. Critical findings are never hidden and scores, evidence, and finding text never change (section 14, P-24–P-28). |

Note on status: story S-042 (plugin API, manifest validation, and the
empty static registry in `src/plugins/`) has landed. This update extends
the design only; it renumbers nothing in P-01–P-12, K-028–K-031, or
K-514–K-515, and adds its stories after S-051 (section 12.5).

Note on status (adaptive UI): S-042 and S-043 have landed and S-044 may
be in progress. Section 13 adds P-18–P-23 for an adaptive web UI that is
implemented after the plugin core. It renumbers nothing in P-01–P-17,
adds its stories after S-058 (section 13.6), and proposes K-034 and
K-518. The deterministic parts (P-18–P-20) are MVP for that follow-on
work; the AI layout mode (P-21) is experimental and Stretch.

Note on status (personalization): user-priority personalization is
the **demo's headline innovation**. Section 14 refines P-15 (strict
`PLUGIN.md` frontmatter and plain-English sections) and extends
P-18–P-23 with P-24–P-28. It renumbers nothing in P-01–P-23, S-042–S-064,
K-028–K-034, or K-514–K-518, and adds its stories after S-064
(section 14.7). The deterministic baseline (P-24–P-26) is MVP for the
demo; the unified AI personalize mode (P-27, P-28) is experimental,
off by default, and Stretch.

Note on status (investigation): the runtime agent loop
"Investigate with Muse" is designed in the sibling ADR
`docs/adr-investigate-with-muse.md` (P-29 onward), linked here so
the plugin rules stay in one numbering. It consumes this registry;
it adds no plugin kind and no second registry.

Note on status (own decompiler): the ERC-20-scoped EVM decompiler
is designed in the sibling ADR `docs/adr-evm-decompiler.md` (D-01
onward, a separate rule namespace from P-xx). It ships as a
detector plugin through this registry; it adds no plugin kind, no
second registry, and no runtime dependency.

Note on status (critical review): section 0 records the review. It
closes former open decision 12 (one personalize port, decided),
retires the separate AI layout deliverables in P-21–P-23 before
implementation (the deterministic P-18–P-20 stand), narrows the
detector input catalogue (section 3.2), aligns severity to the domain
scale (P-15, P-26), and adds one reconciliation story (S-071) for the
landed-code deviations D-1–D-6. It renumbers no P-rule, story, or K-ID.

### 2.1 Alternatives for the load-bearing decisions

One serious alternative per major decision, why it loses today, and
what evidence would reopen it. Per-update alternative lists in
sections 10, 12.5, 13.6, and 14.7 stay as the detailed record; this
table is the load-bearing summary the review asked for.

| Decision (rule) | Serious alternative | Why rejected today | Reopen when |
|---|---|---|---|
| Two kinds: detector + assessment (4.1, 4.2) | A data-source kind (RPC/feed/chain plugins) beside them | Ports already are that extension point, each with its error union, limits, and threat rows; a manifest kind adds a weaker second contract and lets a manifest widen outbound flows (4.3) | Two or more shipped sources repeat the same shape behind different ports |
| Static compile-time registration (P-07) | Signed packages loaded at build or run time from an allowlist | Run-time loading breaks the locked supply chain and admits unreviewed code to a deterministic analyzer; build-time signed loading (S-049) keeps the chain but buys nothing while all plugins are first-party | A real external author needs to ship without a repo change |
| Detector weight 0 until artifact promotion (P-05) | Let a manifest declare a capped weight (for example max 5 points) so useful detectors score immediately | A plugin grading its own findings breaks the calibration separation (K-210); caps still need evaluation data to set, so the saving is illusory and the gaming channel is real | Never for self-declared weights; promotion speed is an offline-chain problem, not a manifest field |
| Static registration trust: in-process detectors (P-06) | Worker-isolate every detector from day one (extdecomp style) | Correct for untrusted code, costly for three reviewed first-party functions: process hops, serialisation of bytecode per detector, deadline tuning before any evidence a detector misbehaves | The first unreviewed detector registers (then it is a precondition, S-050, not a choice) |
| TS types + JSON Schema descriptor, no schema library (3.3) | zod (or similar) as single source of truth, deriving types and JSON Schema | New runtime dependency under K-506/I-04 plus a second idiom beside the repo's smart constructors; the closed shapes here are small and the dual representations are contract-tested against each other | A plugin shape outgrows plain checks (deep recursion, cross-field rules) in a shipped story |
| Separate audit port, shared transport (P-14) | Reuse `AssessmentModelPort` for audit calls | Inputs differ in kind (whole source files vs the closed K-302 evidence list), lifecycle differs (CI/operator vs on-request), and reuse would force source-file branches into the assessment contract suite and muddy the K-307 freeze proof. Sharing the hosted transport helper keeps the saving without the leak | The audit port's second method ever mirrors an assessment call shape-for-shape |
| One unified AI personalize mode (P-27) | Ship AI layout first, add a separate ranking mode later with a precedence rule | Two specs can disagree (ranking says A first, layout buries A), so the precedence rule becomes a third design; two ports, suites, caches, and toggles for one presentation concern | A caller needs layout with no priorities concept at all (none exists; the web UI is the only caller) |
| Local-only priorities (P-24) | Server profile per API key, synced across devices | Priorities are PII-ish free text; a profile adds storage, retention, log-scrubbing, and consent surface to save the user retyping one sentence. Local-only makes "never leaves the device" true by architecture (H-26) | The product gains accounts for an unrelated reason and users ask for sync |
| Deterministic matcher before any AI (P-25 before P-27) | AI-first mapping (model reads priorities, matcher as fallback) | The demo headline must work offline, free, and explainably ("Matched: honeypot, fees"); an AI-first headline fails closed to a worse demo without a key and cannot be golden-tested | The deterministic matcher measurably misses on real demo phrasings and the AI mode has shipped and proven stable |
| Severity floor by rule, not by user setting (P-26) | Let users collapse anything, with a warning banner | A warning is convention; a floor is construction. For a rug-pull tool, a buried `high` finding behind an unrelated priority is the failure the product exists to prevent | User research on the shipped demo shows the floor actively harming comprehension (then narrow the floor, never remove it) |
| `PLUGIN.md` in the plugin directory (P-15) | Registry metadata only (manifest fields, no document) | The doc carries the plain-English "why it matters to you" and the limitations a manifest cannot; frontmatter gives the matcher its closed, validated surface. Metadata-only would push prose into manifest strings with no claim checks (P-17) | A plugin kind appears whose honest doc fits in the manifest (none in v1) |

## 3. Typed plugin contract and manifest

### 3.1 The manifest

**P-01 Typed plugin manifest.** Each plugin carries one frozen manifest
value, validated at startup by a smart constructor in the same style as
A-10 and A-11. A manifest that fails validation is a typed startup error
naming the plugin id and the failed field, with values kept outside the
error text where they could carry secrets (K-505). The manifest is a
discriminated union on `kind` (A-12): the shared fields below come
first, then the kind-specific shapes for `inputs`, `limits`, and
`capabilities` in sections 3.2–3.4, so a state that mixes kinds (a
detector with a provider deadline, an assessment declaring detector
inputs) fails to typecheck instead of failing at run time. The landed
flat `PluginManifest`/`PluginLimits` type is deviation D-2 (section
0.3); the union below is the normative end state. The manifest fields
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
| `docs` | `PluginDocsRef` (`{ file: "PLUGIN.md" }`) | Reference to the required `PLUGIN.md` for this plugin (P-15): the fixed relative file name `PLUGIN.md` beside the manifest, and nothing else. The document version is the manifest `version` by definition, so no second version value exists to drift (review cut, section 0.1). No absolute path and no path outside the plugin directory is representable. Presence and content are validated deterministically by the docs validator (section 12.2); the registry itself stays free of filesystem access and receives the validated result as a value (section 6). |

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

### 3.2 Declared inputs: a closed catalogue of three host facts

A detector plugin declares its inputs from a closed catalogue of facts
the host has already computed deterministically. The catalogue is
deliberately small (review cut, section 0.1): every fact the host
supplies is a fact the detector cannot derive purely itself.

| Input name | Value in `DetectorInput` | Source today |
|---|---|---|
| `bytecode` | `Bytecode` together with its `CodeHash` (`codeHash` field) | RPC fetch in `analyzeToken` (K-001) |
| `cloneMatch` | `CloneHit \| null` (null on a miss or an index failure) | Host lookup through `CloneIndexPort` (K-017) |
| `decompilerCause` | `HardToAnalyzeCause \| null` (null when decompilation succeeded or no worker is bound) | Host mapping of the `DecompilerPort` error union (K-008) |

Selectors and disassembly are not host facts: a detector derives them
from `bytecode` with the pure domain helpers (`extractSelectors`,
`disassemble` in `src/domain/selectors.ts`), exactly as the landed
detectors do, so the derivation is covered by the detector's own
determinism proof instead of a host–plugin agreement. `proxy` never
reaches a detector (proxy resolution shapes which bytecode is analysed,
section 7), `snippets` feed explanations, not findings, and
`measuredValues` has no detector consumer in v1. A fact re-enters this
catalogue only by ADR amendment naming its host computation, its
absence semantics, and its determinism proof.

Projection is normative: the host builds one frozen `DetectorInput`
per detector holding exactly the facts that detector declared. An
undeclared fact is absent (the field is missing, not nulled), so a
detector that reads one reads `undefined` and the registry contract
suite catches it by running each detector on its projection alone and
requiring the declared-input run and the full-fact run to agree where
they overlap (the detector must not secretly depend on a fact it did
not declare). A declared fact the host cannot supply for a given
analysis arrives as its stated null (`cloneMatch`, `decompilerCause`);
the plugin returns findings from the facts present or an empty list.
Requesting an input outside the catalogue is unrepresentable: the
manifest type admits only catalogue names. The landed single superset
input — every detector receives every fact, and the hard-to-analyze
detector reads `decompilerCause` while declaring only `bytecode` — is
deviation D-1 (section 0.3); its manifest declaration is corrected with
the projection.

An assessment plugin declares no detector inputs (`inputs: []` in its
manifest branch). Its sole input is the closed evidence list per K-302,
delivered through the existing assessment path (section 4.2).

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
   `additionalProperties: false`). Two honesty notes keep this from
   over-claiming: the `JsonSchema` type is a descriptor bag (any string
   key typechecks), so subset validity is a parse-time proof from the
   manifest smart constructor, not a compile-time one — a schema value
   that never passed `PluginManifest.parse` is not a schema; and every
   object subschema in a detector's finding schema must set
   `additionalProperties: false`, so an undeclared payload field is
   invalid output rather than ignored data. Output outside the subset
   or outside the schema gives the typed outcome `invalid-output` for
   that plugin (section 5.4) and leaves the rest of the analysis
   standing.
4. A contract test per plugin checks that the typed output and the
   `outputSchema` agree on frozen examples in both directions (valid
   output passes, each schema field removed or mistyped fails), so the
   two representations stay honest against each other, in the same spirit
   as the fake-versus-adapter contract suites in A-22.

### 3.4 Capabilities

Capabilities are part of the discriminated manifest (section 3.1), not
one flat record: each kind's manifest branch carries only the flags
that kind can meaningfully hold, with the stated default. Capabilities
gate what the host offers the plugin; they never widen what the plugin
can reach, because the plugin receives only values (section 5.1).
Detector-forbidden values fail in the manifest smart constructor
itself (deviation D-2 moves that check from the registry into the
constructor), so a detector manifest carrying `needsNetwork: true`
cannot be constructed, let alone registered. The registry re-checks
the same invariant as defence in depth over entries it did not parse
itself (section 6).

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
the emitting plugin's id, a short English title, at least one evidence
entry, and a kind-specific payload validated against `outputSchema`.
A finding carries no severity and no direction (review cut, section
0.1): emphasis comes from the host-converted calibrated signal where
one exists and from the plugin's declared frontmatter range otherwise
(P-26), never from a value the plugin grades itself with (P-05).
Evidence follows A-13: each finding requires a `NonEmpty<Evidence>`
where each entry carries a selector and a PC offset where the offset
is derivable (K-010). A finding without evidence fails construction,
exactly as a signal without evidence does today. The registry boundary
re-proves identity and evidence on every returned finding (deviation
D-4 closes the landed string-presence check): the id starts with
`<manifest.id>:`, `finding.pluginId` equals the manifest id, and each
evidence entry is re-parsed through the domain `Evidence` smart
constructor. Any failure is the typed outcome `invalid-output` for
that plugin (section 5.4); unproven evidence never reaches scoring,
serialisation, or rendering.

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
separate envelope field (section 6) and never enter that call. The
review splits the weight-0 claim into three scoped invariants, because
the blanket form ("enabling any plugin changes no score") is false for
the built-in detectors today and a test written against it would fail
honest code:

1. **Non-promoted plugins: true weight 0.** A registered detector the
   artifact does not name changes no probability and no score on any
   input. The property test
   `plugin_findings_leave_probabilities_and_score_unchanged` is scoped
   to such plugins: it compares the frozen analysis with the plugin
   enabled and disabled and requires bit-identical probabilities,
   score, and signals. Every new example or third-party-style detector
   ships under this invariant (S-051).
2. **Built-in detectors: interim host conversion (deviation D-6).**
   The three first-party detectors (capability, clone-match,
   hard-to-analyze) do affect today's score — through host-owned
   converters in `analyzeToken` (injected catalogue, clone mapping,
   placeholder risk) that reproduce the legacy signals bit-for-bit.
   The converters read calibration values only from host-injected
   artifact data and use the finding solely as an identity key
   (capability key, clone group, decompiler cause); no payload number,
   title, or plugin-declared value steers risk, direction, or severity.
   This is the one deliberate exception to invariant 1, it exists only
   to keep pre-plugin scores bit-identical during migration, and its
   exit is S-047: one artifact mapping replaces all three converters,
   after which invariant 1 covers every non-promoted plugin and
   invariant 3 covers the rest. Detector `PLUGIN.md` text that says
   findings "map to calibrated signals" describes this interim state
   and is corrected when S-047 lands.
3. **Promotion is a calibration event, not a code change alone.** When
   evaluation per K-205 and K-206 supports a finding, the offline chain
   adds a calibrated entry naming the plugin id and finding shape to a
   new artifact version. The host then converts matching findings to
   `Signal` values through the artifact mapping ahead of `score`, with
   the artifact checksum and model version stated in the response as
   today (K-102). The plugin's `affectsScore` capability display flips
   only because the artifact names it; the artifact stays the sole
   source the code reads (K-210). A plugin cannot raise its own
   influence at any stage: findings carry no severity or direction
   (section 4.1), and the mapping is read from the artifact, never
   from the manifest or the finding.

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

**P-08 One registry, validated at startup.** The registry is a set of
entries, not a manifest list beside a separate executable map
(deviation D-5). One entry per plugin:

```ts
type PluginRegistryEntry =
  | { manifest: DetectorManifest; detect: DetectorFn; docs: ValidatedPluginDocs }
  | { manifest: AssessmentManifest; docs: ValidatedPluginDocs };
type PluginRegistry = { entries: readonly PluginRegistryEntry[] }; // frozen, sorted by plugin id
```

A registered detector without its `detect` function is therefore
unrepresentable, and no per-analysis outcome exists for a missing
implementation: wiring mistakes fail at startup, where they belong.
Ownership is stated once here and nowhere contradicted:

| Concern | Owner | Never does |
|---|---|---|
| Manifest validity (fields, schema subset, kind shapes) | `PluginManifest.parse` smart constructor (P-01) | Read the filesystem; know other plugins |
| `PLUGIN.md` validity (frontmatter, sections, claim checks) | The docs validator module (P-15, P-17), run in CI and by the audit | Run inside the registry; serve unvalidated docs |
| Entry-set validity (unique ids, API range P-02, entry completeness) | `buildPluginRegistry(entries)` in `src/plugins/registry.ts`, returning `Result<PluginRegistry, PluginRegistryError>` | Import concrete plugin modules; execute at module load |
| Static catalogue (which plugins exist) | The frozen entry array literal assembled from static imports (P-07) | Read configuration, environment, or a directory |
| Enable/disable set, active assessment plugin | The composition root, from validated configuration (A-03), supplied to the view derivation below | Name code to load (P-07) |
| Exposed shape for REST/MCP/web | One pure view derivation in `src/plugins` from registry + composition-supplied `enabled`/`active`/`weight` data (P-09, P-10) | Read the scoring artifact per request; hold interface-specific variants |

`buildPluginRegistry` is called once by the composition root, which
maps its error to a typed startup error (A-15). Nothing in
`src/plugins` builds a registry at module load: the landed
`DEFAULT_PLUGIN_REGISTRY` load-time throw and the defaulted detector
set in `wireAppServices` are deviation D-5, because an import must
never fail a process the composition root has not yet validated, and a
defaulted parameter lets a caller forget to wire the real set. Tests
construct registries through the same builder with fixture entries.

The validated registry is handed to the application service and to
both driving adapters through `AppServices` construction (A-02, A-03),
so REST, MCP, and the web UI read the same registry value. The startup
test in the style of `a03_each_port_bound_to_exactly_one_adapter`
gains a sibling:
`registry_rejects_duplicate_ids_and_unsupported_api_versions` runs the
builder against duplicate, out-of-range, and capability-violating
entries and requires a typed startup error per case.

**P-09 REST exposure.** One registry view model serves every surface.
The view derivation (owner table in P-08) maps each registry entry
plus the composition-supplied selection data to one exposed shape:
`enabled` is a boolean computed from configuration, `active` (assessment
plugins) is a boolean computed from the composition selection, and
`weight` (detectors) is `0` until the current artifact names the plugin
(read once at startup from the loaded artifact, never per request).
None of the three is a literal type: a view that can only say
`enabled: true` or `active: false` has frozen today's empty selection
into the contract, and the S-046 exposure work must keep them data.
REST serialises the view, MCP wraps the same canonical bytes (P-10),
and the web UI consumes the REST JSON only — no interface imports the
registry, a detector module, or another interface's shape (K-027).
The REST adapter derives its plugin surface from the view at startup;
no route is hand-written per plugin:

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
  PLUGIN.md        # required plugin docs (P-15); replaces a free-form README for plugins
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
| K-032 | Required `PLUGIN.md` per plugin: fixed sections, deterministic presence and content validation (P-15) | MVP (for E-08 audit/docs) |
| K-033 | Plugin docs exposure: REST docs route, MCP docs resource, sanitized web UI docs view from one registry (P-16) | MVP (for E-08 audit/docs) |
| K-516 | Plugin audit: deterministic static gate plus optional advisory AI review; acceptance requires deterministic pass and human review (P-13, P-14) | MVP (for E-08 audit/docs) |
| K-517 | Plugin documentation integrity: documented claims checked against manifest and code, deterministically and by advisory review (P-17) | MVP (for E-08 audit/docs) |
| K-034 | Adaptive web UI: schema-driven plugin rendering, deterministic risk-adaptive layout, Simple / Expert modes (P-18–P-20) | MVP (for E-08 adaptive UI, after S-046) |
| K-518 | AI layout safety: whitelist declarative layout spec, presentation-only, deterministic fallback (P-21–P-23) | Stretch (for E-08 adaptive UI) |

Threat-model additions are drafted in `docs/threat-model.md` in this
change (H-15, H-16, M-21, M-22) against K-514 and K-515, and take effect
with the same review as this ADR. The audit and docs update adds
H-17–H-20 with M-23–M-26 against proposed K-516 and K-517 (and K-507
for docs rendering), drafted in section 5.12 of the threat model in
the same design update. Existing IDs are untouched: A-06 gains
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
5. Plugin audit gate placement. The default in P-13 is: deterministic
   audit failures block merge in CI, the AI review is a non-blocking
   advisory report, and a human reviewer records acceptance. Whether a
   recorded human acceptance becomes a required PR check (rather than
   review practice) is Jens's call before S-054 starts.
6. Audit provider scope. The default in P-14 sends plugin source solely
   to Muse Spark Open on hosted through the existing assessment
   provider path. Whether the Meta Model API adapter may also run audit
   reviews, and whether audit may run against plugins whose authors have
   not consented to source disclosure, is open; the default is hosted
   only, opt-in per run, with the source files listed before any send.
7. Docs endpoint scope. The default in P-16 exposes `PLUGIN.md` content
   read-only to the same API-key holders as `GET /v1/plugins`. Whether
   plugin docs become public on the demo (no key) is open; the default
   keeps the key gate.
8. AI layout on the demo. The default in P-21 keeps the experimental AI
   layout off by default for every visitor, enabled only by an explicit
   toggle in the token page. Whether the public demo enables it at all
   (it costs a provider call per uncached view) is Jens's call before
   S-064 starts; the default is demo-off, locally testable with a key.
9. Layout input text. The default in P-21 sends only closed layout
   facts (section ids, score band, severity counts, plugin outcomes)
   plus quoted finding titles under a length cap. Whether raw finding
   text beyond titles is ever layout input is open; the default is no.
10. Mode persistence scope. The default in P-20 persists Simple / Expert
    in `localStorage` on this device only. Whether the preference is
    also mirrored server-side per API key is open; the default is no
    server state for a presentation preference.
11. Priorities on the demo. The default in P-24 keeps priorities
    local-only with the deterministic baseline (P-25) as the demo
    path. Whether the public demo enables the AI personalize toggle
    at all (it sends the visitor's priorities text to hosted for
    that mapping call and costs a provider call per uncached view)
    is Jens's call before S-070 starts; the default is demo-off for
    the AI toggle, locally testable with a key, with the
    deterministic headline path on for every visitor.
12. Personalize port shape. The default in P-27 is one unified
    experimental mode with one spec. Whether the implementation
    extends `PluginLayoutModelPort` in place (renamed in effect to
    carry ranking plus layout) or adds the sibling
    `PluginPersonalizeModelPort`, and whether the REST shape is
    `POST /v1/personalize` or an extended `POST /v1/layout`, is
    decided in S-068 against the built P-21 code; either way the
    layout-only toggle in P-21 is never shipped beside it.

## 12. Plugin audit and required PLUGIN.md

This section adds P-13–P-17. It designs no runtime behaviour change for
analysis: the audit runs at plugin authoring, review, and CI time, and
the docs surfaces are read-only registry exposure. Neither feature
touches `score`, signals, or evidence (P-05, K-307, A-33).

### 12.1 Plugin audit: deterministic first, AI advisory second

**P-13 The plugin audit is a deterministic gate with an optional
advisory AI step, in that order.** A `plugin audit` step runs against
one plugin directory (CLI and CI job; section 12.4). It runs in two
phases, and the second phase never runs when the first fails:

1. Deterministic static checks over the plugin source and manifest.
   Each check is a plain, repeatable check with a named failure, in the
   same style as the CI checks in section 5.1. The check set is:
   - Forbidden imports: no network, filesystem, process, or evaluator
     access (`node:*`, `fetch`, `XMLHttpRequest`, `WebSocket`,
     `eval`, `Function`, dynamic `import()` of a computed specifier)
     in detector plugin modules, extending the boundary and ESLint
     rules in section 5.1 and M-21/M-22.
   - Capability mismatch: imports, declared inputs, and host-visible
     behaviour are compared against the manifest `capabilities`,
     `inputs`, and `limits` (P-01, section 3.4). A detector that
     declares no network capability and imports a network module fails,
     as does a manifest that declares a capability the code never uses
     where that mismatch hides a wider surface.
   - Determinism lint: no clock, randomness, or network identifiers in
     detector modules (the `a32_domain_has_no_clock_random_or_network`
     style check from section 5.1, applied to the plugin directory),
     and no ambient state reads.
   - Output-contract checks: the `outputSchema` stays inside the
     supported keyword subset (section 3.3), every finding shape
     carries evidence (A-13), and manifest limits are present.
   - `PLUGIN.md` checks from P-15 and the deterministic part of P-17.
   A deterministic failure is a typed audit outcome naming the check
   and the file. It blocks registration in CI and blocks merge for a
   plugin change; no AI result and no human note overrides it in the
   tool. A human may fix the code or, for a false positive in a check
   itself, change the check in a reviewed change — the audit records
   which of the two happened through the normal git history.
2. Optional AI review. Only after the deterministic phase passes, and
   only when the operator opts in for that run, the audit sends the
   plugin source, its manifest, and its `PLUGIN.md` to Muse Spark
   Open (`meta-models/muse-spark-open-1026`) on hosted for a
   vulnerability and semantic-drift review (P-14, P-17). Without a
   configured hosted key the AI phase reports the typed outcome
   `not configured` — the same posture as the assessment path, where
   an unconfigured provider answers `assessment-not-configured` and
   makes zero provider calls — and the deterministic result stands
   alone. The AI phase is never required for a deterministic pass.

Acceptance of a plugin is therefore: deterministic audit pass **plus**
a recorded human review. The report type makes the illegal
combinations unrepresentable instead of merely unlikely:

```ts
type PluginAuditReport =
  | { deterministic: { kind: "fail"; failures: readonly AuditFailure[] };
      ai: { kind: "not-run" }; humanReview: "recorded" | "missing" }
  | { deterministic: { kind: "pass" };
      ai: { kind: "advisory"; findings: readonly AuditFinding[]; provider: string; modelId: string }
        | { kind: "not-run" } | { kind: "not-configured" } | { kind: "invalid-output" };
      humanReview: "recorded" | "missing" };
// Acceptance is derived, never stored:
// isAccepted(r) = r.deterministic.kind === "pass" && r.humanReview === "recorded"
```

A deterministic failure carries `ai: not-run` by construction, so the
report "deterministic failed, AI looked anyway" cannot be built, and
no stored `accepted` flag exists for an AI result or a dashboard to
set. The audit tool prints the three states on separate lines
(`deterministic`, `ai`, `human-review`) so no single line can be read
as an approval on its own.

**P-14 AI audit findings are structured, schema-validated, and
advisory only.** The AI step reuses the existing assessment provider
machinery without reusing its contract:

- Transport and selection: the audit calls the hosted open-weights
  adapter through the same validated configuration, server-side key
  handling, deadline, size limits, concurrency bound, and cost caps
  as `AssessmentModelPort` (A-17, A-34, I-13, I-14, K-309). It does
  **not** reuse the K-302 closed evidence list or the K-305 assessment
  schema: plugin source is not contract evidence. The audit therefore
  gets its own small port, working title `PluginAuditModelPort`, with
  one method that takes the frozen audit input (plugin id, version,
  file list with per-file quoted content, prompt version) and returns
  a `Result<PluginAuditReport, PluginAuditModelError>` with the A-15
  error branches mirrored from `AssessmentModelError` (`timeout`,
  `rate-limited`, `invalid-output`, `output-too-large`,
  `provider-mismatch`, `unavailable`, plus `not-configured`). The
  hosted adapter implements it beside its `AssessmentModelPort`
  implementation, sharing transport code; the composition root wires
  it only when audit AI is configured. This keeps the assessment
  contract suite (`runAssessmentModelPortContract`) untouched and
  gives the audit its own contract suite,
  `runPluginAuditModelPortContract`, run against a fake adapter and
  the hosted adapter over a recorded transport, with zero network in
  tests — the same contract style as the existing assessment tests.
- Port boundaries, stated once for all three model ports. The repo
  ends with exactly three model ports over one shared hosted/Meta
  transport layer, and the table below is the whole sharing contract:

  | Port | Caller and lifecycle | Input (closed) | Output | Contract suite |
  |---|---|---|---|---|
  | `AssessmentModelPort` (existing) | On-request, per analysis (K-305) | K-302 closed evidence list | Free-text assessment, separate field (K-307) | `runAssessmentModelPortContract` (unchanged) |
  | `PluginAuditModelPort` (P-14) | Operator/CI, per plugin change | Quoted plugin source files + manifest + `PLUGIN.md` | Structured advisory findings | `runPluginAuditModelPortContract` |
  | `PluginPersonalizeModelPort` (P-27) | On-request, per token view, opt-in only | Quoted priorities + quoted frontmatter/excerpts + closed layout facts | `PersonalizeSpec` (ranking + placements) | `runPluginPersonalizeModelPortContract` |

  Shared (transport only): provider endpoint allowlist from validated
  configuration, server-side key handling, deadline/size/concurrency
  bounds, cost caps, provider/model identity checks. Never shared:
  prompt text, input shapes, output schemas, caching keys, and error
  semantics beyond the mirrored A-15 branch names. No port's output
  type is readable by another port's caller, and none is readable by
  scoring, the registry, or the analysis path. Detectors sit outside
  this table entirely: they hold no port (P-03), so "detector versus
  assessment" has a one-line answer — a detector is a pure function,
  an assessment is a port call, and no type converts one into the
  other.
- Findings shape: each AI finding is a structured value, never free
  text alone: `severity` (closed enum `info|low|medium|high`),
  `location` (plugin-relative file plus line or section where the
  model can name one), `category` (closed enum covering at least
  forbidden-capability, injection-surface, determinism,
  evidence-integrity, docs-drift, and other), `rationale` (short
  English text, rendered as text only), and `confidence` where the
  schema requires it. The report also carries plugin id, plugin
  version, prompt version, provider, and model id, mirroring the
  provider labelling in K-305/K-513.
- Schema choice (explicit): TypeScript types are normative, with a
  JSON Schema descriptor (the draft-07 subset in section 3.3) carried
  beside them and a plain-check smart constructor,
  `parsePluginAuditReport`, in the style of A-10/A-11 and of
  `validateAssessmentOutput` in the assessment adapters. No schema
  library is added, for the single reason stated in section 3.3; that
  paragraph is the record and is not repeated per port.
- Validation and failure: every model response passes
  `parsePluginAuditReport` before any human sees it as findings.
  Schema-invalid, oversize, or identity-mismatched output gives the
  typed outcome `invalid-output` (or the matching A-15 branch), the
  raw model text is discarded rather than rendered, and the audit
  report states `ai: invalid-output` beside the standing
  deterministic result. No partial findings are salvaged from an
  invalid response.
- Advisory only, by construction: the audit report type has no field
  that the registry, scoring, or analysis path reads. AI findings
  never auto-approve a plugin, never register or unregister one,
  never enter `pluginResults`, and never affect scores, signals, or
  evidence (P-05, K-307). The report is an input to the human review
  in P-13, presented with its provider and model id and an explicit
  `advisory` label wherever it is shown (CLI output, CI artifact, and
  any later REST/MCP read view).
- Untrusted input handling: plugin source and `PLUGIN.md` content are
  untrusted input to the model, exactly as contract strings are on
  the assessment path (K-308, M-04). The audit prompt keeps the system
  instruction in its own field, passes each file as quoted data
  through `UntrustedText.quote` with a length cap per file and a
  total input cap, is tool-free, and instructs the model that file
  content is data to review, never instructions to follow. File
  content that asks the model to approve the plugin, hide a finding,
  or change the output shape is therefore data inside a quotation,
  and any response that follows it fails schema validation or is
  read by the human as a finding about the plugin, not as an
  instruction the tool obeyed.
- Disclosure: sending source to a provider is a deliberate, visible
  act. The audit lists the exact files it will send before sending
  (dry-run output in the CLI, a log line in CI), sends only the plugin
  directory's source, manifest, and `PLUGIN.md` (no repo-wide files,
  no configuration values, no secrets — the provider key travels only
  as the server-side header, as in M-20), and logs plugin id, file
  hashes, prompt version, provider, and model id, never file content
  (I-10). First-party plugin source is already in this repo; a future
  third-party-style plugin is sent only when its author opts in for
  that audit run.

### 12.2 Required PLUGIN.md per plugin

**P-15 Every plugin ships a required `PLUGIN.md` as part of its
contract (refined for personalization, section 14).** Each plugin
directory (first-party under `src/plugins/`, examples under
`examples/plugins/`) contains one `PLUGIN.md` in English beside its
manifest. The manifest references it through the `docs` field in
section 3.1. This refinement supersedes the earlier P-15 wording
where they differ: the headings `What it checks`, `Why it matters
to you`, and `Evidence format` replace `What it detects`,
`Why it matters`, and `Output and evidence`, and `Limitations /
false positives` merges the earlier `Limitations` and
`False positives`. `Inputs` and `Version and changelog` are retained
for the P-17 claim checks. The frontmatter and the controlled
vocabulary below are new and normative.

The file starts with a YAML frontmatter block. The frontmatter is
the machine-readable half of the doc: the deterministic baseline
in P-25 reads only this block, never the body text, to match user
priorities to plugins.

| Frontmatter field | Type | Invariant |
|---|---|---|
| `id` | string | Equals the manifest `id` (P-01) exactly. A mismatch is a deterministic failure. |
| `kind` | `"detector" \| "assessment"` | Equals the manifest `kind` exactly. |
| `version` | semver string | Equals the manifest `version` and the version line in `## Version and changelog` exactly. |
| `tags` | list of strings, 1–4 entries, no duplicates | Every entry is drawn from the controlled vocabulary below. `topics` is accepted only as a legacy alias: when present it must equal `tags` exactly, and new docs write `tags` only. A tag outside the vocabulary is a deterministic failure, never a free-text extension. |
| `audience` | list of strings, 1 or more, no duplicates | Every entry is drawn from the closed set `holder`, `trader`, `developer`, `auditor`, `all`. `all` stands alone when present. Audience is display metadata for ordering hints; it never gates visibility (P-26). |
| `severity` | mapping `{ min, max }` | Each value is the domain `Severity` from A-12 (`low \| medium \| high` — no second scale; the review removed the former `info`/`critical` values, section 0.1), with `min` at most `max` in that order (`low < medium < high`). This is the advisory severity range the plugin can emit; it is display metadata for the P-26 card floor and never feeds `score` (P-05). A range whose `max` is `high` marks the plugin's card as floored (P-26). |

Controlled vocabulary for `tags` (closed set; adding a tag is an
ADR change plus a CI vocabulary update in the same change, never a
per-plugin invention):

`owner-powers`, `honeypot`, `mint`, `fees`, `upgradeability`,
`liquidity`, `blacklist`, `pausing`, `transfer-limits`, `proxy`,
`supply`, `external-calls`.

The file then has these required sections, under these headings,
in this order, written in plain user-facing English — sentences a
token holder can act on, not detector internals:

1. `## What it checks` — the finding shapes the plugin emits, in
   plain English (supersedes `What it detects`).
2. `## Why it matters to you` — the risk or question each finding
   answers, phrased for the reader who holds or is about to buy the
   token (supersedes `Why it matters`).
3. `## What it cannot tell you` — the questions this plugin cannot
   answer from bytecode alone, linked in spirit to the can't-tell
   list (K-012). This section is new; it keeps a personalization
   highlight from reading as a completeness claim.
4. `## Evidence format` — the output shape against its
   `outputSchema` and how each finding carries evidence (A-13),
   with field names in the backtick form P-17 checks
   (supersedes `Output and evidence`).
5. `## Limitations / false positives` — what the plugin cannot see
   or decide, known false-positive shapes, and how a reader
   recognises them (merges `Limitations` and `False positives`).
6. `## Inputs` — the declared inputs it consumes (detectors: names
   from the closed catalogue in section 3.2; assessment plugins: the
   closed evidence list per K-302).
7. `## Version and changelog` — the current version, equal to the
   manifest `version` and the frontmatter `version`, and one line
   per released change.

Frontmatter syntax is a deliberately tiny subset, because the repo
carries no YAML library and adds none for this (section 3.3): flat
scalar fields (`id`, `kind`, `version`), one string list (`tags`,
`audience`; inline `[a, b]` or dash lines), and one flat mapping
(`severity: { min, max }`). The docs validator parses exactly that
subset with a hand-written, fail-closed parser: duplicate keys,
anchors, nested structures beyond the severity mapping, quoted
escapes, or any other YAML feature is a deterministic failure, never
a best-effort parse. Adding a YAML dependency to parse three field
shapes would fail the same supply-chain test as a schema library.

Deterministic validation, in CI and in the audit (P-13): the file
exists, is non-empty within a stated size cap, starts with a
frontmatter block that parses against the schema above (required
fields present, closed sets respected, `id`/`kind`/`version` equal
to the manifest), carries every required heading in order, the
`## Inputs` section names only inputs the manifest declares (and
names all of them), the version line equals the manifest `version`,
and the text is English-facing markdown with no embedded raw HTML
(P-16). A missing file, a missing section, an out-of-vocabulary
tag, or any failed check is a deterministic audit failure and, for
a registered plugin, a startup-adjacent build failure in CI — the
registry never serves a plugin whose docs fail validation, because
registration in CI runs the same check before merge. The check is a
named CI/audit check, not a runtime filesystem read in the registry
(section 3.1): the validator's output (`ValidatedPluginDocs`:
parsed frontmatter, section index, capped markdown text) is handed
to the registry builder as a value (section 6), and it is that
typed frontmatter — never raw markdown — that the P-25 matcher and
the P-27 request builder consume.

**P-17 The audit checks that PLUGIN.md claims match the code.** Two
layers, matching the two audit phases in P-13:

- Deterministic, where a claim is machine-checkable: declared inputs
  in `## Inputs` against manifest `inputs`; version string against
  manifest `version`; frontmatter `id`, `kind`, `version`, `tags`,
  `audience`, and `severity` against the manifest and the closed
  sets in P-15 (refined); finding ids and output fields named in
  `## Evidence format` against `outputSchema` property names
  where the doc uses the stated backtick form for field names;
  capability claims (for example "makes no network calls") against
  the forbidden-import check. A mismatch is a deterministic audit
  failure naming the section and the manifest field it disagrees
  with.
- Advisory, for semantic drift: the AI review in P-14 also receives
  the `PLUGIN.md` and reports, as `docs-drift` findings, claims the
  code does not support (a documented detection with no matching
  logic, a limitation the code contradicts, a false-positive note
  for a shape the code cannot emit). These findings are advisory
  like every AI finding: a human decides whether the doc or the code
  changes, and the deterministic layer keeps passing or failing on
  its own checks meanwhile. `PLUGIN.md` content reaches the model
  under the same untrusted-input handling as source (P-14): a doc
  that instructs the model to certify the plugin is quoted data, and
  the claim itself is a candidate `docs-drift` or injection finding
  for the human reviewer.

### 12.3 Exposing PLUGIN.md: REST, MCP, and web UI

**P-16 Plugin docs are exposed read-only through the same registry,
rendered safely.** The validated `PLUGIN.md` record joins the registry
entry per plugin as `ValidatedPluginDocs` (section 6): parsed
frontmatter, the validated section index, and the markdown text under
the P-15 size cap. The former "content or hash only, decided in
S-056" deferral is decided here (review, section 0.2): the matcher
(P-25) needs typed frontmatter and the Docs view needs text, so both
ship in the record from the first docs story; a hash alone would have
forced a second, unreviewed docs channel later. The three surfaces
derive from that one record (P-08–P-10):

- REST: `GET /v1/plugins/:id/docs` returns the plugin id, version,
  and the document (raw markdown plus the parsed section list) in the
  published `/v1` schema, behind the same API-key gate as
  `GET /v1/plugins` (K-024), with the uniform not-found error (A-18)
  for an unknown id. The route is read-only; there is no write or
  upload path for docs at any stage.
- MCP: the registry-derived surface gains a resource for plugin docs
  (working shape: resource URI `plugin://<pluginId>/docs`, with
  `list_plugins` naming the URI per plugin). Content is returned as a
  text block marked as untrusted data for the user (M-15), bounded by
  the same size cap as P-15. A tool form is added only if a caller
  needs it, through the K-026 review (open decision 3 applies).
- Web UI: the Plugins panel gains a Docs view per plugin that renders
  the markdown through a sanitizing renderer: markdown structure
  (headings, lists, code, emphasis, links with `rel="noopener"`) is
  rendered, raw HTML in the source is escaped and shown as inert
  text, scripts, styles, event handlers, and embedded frames are
  unrepresentable in the output, and every plugin string still
  renders as escaped text under the strict CSP (K-507, M-13). No new
  raw-HTML sink (`dangerouslySetInnerHTML` or equivalent) is
  introduced for plugin docs; if the renderer needs one internally,
  its input is the sanitizer's output and that change passes the
  K-507 review and the `k507`-style e2e test in S-057 before release.

### 12.4 CLI shape (outline only)

No code in this design turn. The intended shape, for S-052/S-053:

```text
plugin audit <plugin-dir> [--deterministic-only] [--with-ai]
                          [--format text|json] [--list-files]
plugin docs check <plugin-dir> [--format text|json]
```

- `plugin audit` runs the deterministic phase, prints one line per
  check (`pass`/`fail` with the file and field on failure), then the
  AI phase state (`advisory` with finding count, `not-run`,
  `not configured`, or `invalid-output`), then the human-review
  state. Exit code is non-zero exactly when the deterministic phase
  fails; the AI phase never changes the exit code. `--list-files`
  prints the exact files the AI phase would send and sends nothing.
- `plugin docs check` runs only the P-15/P-17 deterministic docs
  checks, for fast CI use on doc-only changes.
- CI runs `plugin audit` in deterministic mode as a blocking job for
  plugin changes and, where a hosted key is configured for the job,
  the AI phase as a non-blocking job that uploads the structured
  report as an artifact. An optional REST/MCP read view of the last
  CI audit report per plugin is a stretch item (S-058); triggering an
  audit over REST/MCP is out of scope, so the runtime gains no new
  expensive or source-disclosing path.

### 12.5 Stories and requirements added by this update

Stories S-052–S-058 are added under epic E-08 in `backlog.md`, after
S-051, test-first like every E-08 story. Proposed new K-IDs, entered
in `docs/requirements.md` by their first implementation story in the
same change (section 10 rule, threat-model section 1 point 4):

| Proposed ID | Title | Priority |
|---|---|---|
| K-032 | Required `PLUGIN.md` per plugin: fixed sections, deterministic presence and content validation | MVP (for E-08 audit/docs) |
| K-033 | Plugin docs exposure: REST docs route, MCP docs resource, sanitized web UI docs view from one registry | MVP (for E-08 audit/docs) |
| K-516 | Plugin audit: deterministic static gate plus optional advisory AI review; acceptance requires deterministic pass and human review | MVP (for E-08 audit/docs) |
| K-517 | Plugin documentation integrity: documented claims checked against manifest and code, deterministically and by advisory review | MVP (for E-08 audit/docs) |

Alternatives considered for this update and set aside:

- Zod (or another runtime schema library) for AI findings. Set aside
  in P-14: plain checks plus JSON Schema descriptors are the repo
  norm, and a new runtime dependency needs its own justification.
- Letting a clean AI review approve or register a plugin. Rejected:
  approval is deterministic checks plus human review (P-13); an
  advisory model result as a gate would make a non-deterministic,
  injection-exposed step load-bearing (H-18, M-23).
- Sending the whole repo, or tests and fixtures, to the model.
  Rejected in P-14: only the plugin's source, manifest, and
  `PLUGIN.md` are sent, listed in advance, under size caps.
- Rendering `PLUGIN.md` as raw HTML for fidelity. Rejected in P-16:
  docs are untrusted content in the visitor's browser (H-20, M-26);
  sanitized markdown with raw HTML as inert text keeps the K-507
  posture.
- A per-plugin docs route or UI component. Rejected for the same
  reason as in section 10: one registry-derived surface, reviewed
  once (P-16).

## 13. Adaptive web UI (after the plugin core)

This section adds P-18–P-23. It designs presentation only: no rule here
changes analysis, scoring, evidence, or finding text (P-05, K-307,
A-33). Implementation follows the plugin core — every story in
section 13.6 depends on S-046 (registry exposure: REST plugin list,
`pluginResults` in the envelope, and the generic Plugins panel) and
builds on the schema-driven panel that S-046 ships. The web UI today
is React in `apps/web` with an assessment tab on the token page,
text-only rendering under a strict CSP (K-507), and UI types that
mirror the published REST schema without importing core modules; the
adaptive UI keeps all three properties.

### 13.1 Schema-driven rendering through a fixed component library

**P-18 Plugin output is rendered generically from its declared
`outputSchema` through a fixed component library, so a new plugin
needs no UI code.** This extends the generic panel in P-10:

- The library is a closed set of presentational components owned by
  `apps/web` (working set: summary card, severity badge, evidence
  list with selector and PC offset, metric with tabular figures
  (K-103), text block, key-value list, nested object, list, and a
  canonical-JSON fallback). The set is versioned with the UI; adding
  a component is one reviewed renderer change for all plugins, never
  a per-plugin change.
- The renderer maps only the documented `outputSchema` keyword subset
  (section 3.3) to those components: `string` to text, `number` and
  `integer` to metric, `boolean` and `enum` to badge or text,
  `array` to list, `object` to key-value or nested object, with
  evidence-shaped entries to the evidence list. Component choice is a
  pure function of schema shape and value type.
- Plugin-supplied component names, markup, styles, scripts, URLs, and
  class names are unrepresentable: the schema subset carries no such
  field, and every plugin string renders as escaped text under the
  strict CSP (K-507, M-13). The existing static guard that bans HTML
  sinks in web sources (K-507) covers the new renderer unchanged.
- An unknown or out-of-subset schema shape falls back to canonical
  JSON rendered as text, exactly as P-10 states. A plugin that needs
  a shape outside the subset files a design change for the library,
  reviewed once for all plugins.

### 13.2 Risk-adaptive deterministic layout

**P-19 Section order and emphasis follow deterministic rules over the
frozen analysis, never a model.** A pure layout function in `apps/web`
takes only frozen, already-rendered facts — score and its word band,
per-risk probabilities, signal severities and directions, plugin
outcomes, and the can't-tell count — and returns an ordered section
plan for the token page:

- High risk (highest band): the most severe evidence-bearing sections
  come first (signals and plugin findings ordered by severity), then
  score and explanation, then summary detail.
- Low risk (lowest band): a calm summary comes first (score, word,
  one-line outcome), with evidence sections following in their
  standard order.
- Middle band: the standard order, unchanged from the static page.

The function recomputes nothing: it reads the frozen score, band, and
severities and never re-derives risk. The same analysis always yields
the same plan, in DOM order as well as visual order (K-103), so
keyboard and screen-reader order match what is seen. Reordering never
hides content: every section stays present and reachable in every
band; only order and visual emphasis change. This layout is the
default for every visitor and the fallback for P-21.

### 13.3 Simple / Expert mode

**P-20 A Simple / Expert toggle controls detail depth; the
preference is presentation state only, persisted locally.** Simple is
the default and shows summary, score, signals, plugin findings,
explanations, and the assessment tab as today. Expert additionally
shows what the response already carries: bytecode, selectors with PC
offsets, disassembly or decompiled snippets where present, and raw
plugin payloads as canonical JSON text. The toggle therefore reveals
or hides sections of the same frozen response; it triggers no new
analysis, no new fetch of analysis data, and no score or evidence
change.

Persistence: the preference is stored in `localStorage` under one
versioned key (`brandklipparen-ui-mode`, value `simple` or `expert`),
read once at start-up and validated against that closed union; any
other stored value is ignored and Simple applies. The value is never
sent to the server, never part of a cache key, and never logged. The
threat notes for this storage are in H-25 and M-31 of the threat
model: the stored value is a low-integrity local preference, so
tampering can at most flip the detail depth on that device, and the
closed-union read keeps a crafted value from reaching the renderer as
anything but `simple` or `expert`. Expert content is still contract
data and renders as escaped text under the CSP in both modes (K-507).

### 13.4 Experimental AI layout (off by default)

**P-21 An experimental AI layout mode may reorder and emphasise the
same sections from a declarative layout spec; it is off by default,
clearly labelled, and presentation-only.** The mode is Stretch. When
a visitor explicitly enables it on the token page, the web UI asks
the server for a layout spec for the current analysis; the server —
never the browser — calls Muse Spark Open
(`meta-models/muse-spark-open-1026`) on hosted through a new small
port, working title `PluginLayoutModelPort`, built in parallel to
`PluginAuditModelPort` (P-14) and reusing the hosted adapter's
transport, server-side key handling, deadline, size limits,
concurrency bound, and cost caps (A-17, I-13, I-14). It does not
reuse the K-302 evidence list or the K-305 assessment schema: layout
input is presentation facts, not contract evidence. Working REST
shape: `POST /v1/layout` behind the same API-key gate as the analysis
routes (K-024), returning the validated spec with provider and model
id, or the typed `layout-not-configured` outcome when no hosted key
is configured — the same posture as `assessment-not-configured`,
with zero provider calls. There is no MCP layout tool in v1; layout
is a web-UI presentation concern.

The port returns `Result<LayoutSpec, PluginLayoutModelError>` with
the A-15 branches mirrored from the audit port (`timeout`,
`rate-limited`, `invalid-output`, `output-too-large`,
`provider-mismatch`, `unavailable`, plus `not-configured`). Tests run
against a fake adapter with zero network, in the same contract style
as `runPluginAuditModelPortContract`: a `runPluginLayoutModelPortContract`
suite against the fake and the hosted adapter over a recorded
transport.

Hard bounds, by construction:

- The model returns only a declarative spec (P-22) that chooses,
  orders, and emphasises whitelisted section and component ids from
  the deterministic plan. It never emits HTML, code, URLs, styles,
  class names, or free text, and no field of the spec can carry them.
- The spec never changes scores, probabilities, signals, evidence, or
  the text of findings, explanations, or assessments. All content is
  rendered from the frozen analysis exactly as in P-18 and P-19;
  the spec can at most place and emphasise it, subject to P-23.
- Input to the model is untrusted. The layout prompt keeps its system
  instruction in its own field and passes only closed layout facts
  (present section ids, score band, severity counts, plugin ids and
  outcomes) plus finding titles quoted through `UntrustedText.quote`
  under a length cap, in a tool-free call (K-308, M-04 pattern).
  Analysis and plugin text that instructs the model to hide, invent,
  or restyle content is therefore quoted data; a response that
  follows it fails spec validation in P-22 or is visible to the
  visitor as an ordering choice over unchanged content.
- Cost and caching mirror the assessment path: at most one layout
  call per uncached analysis view, cached per code hash, layout
  prompt version, provider, and model id, under the per-provider
  daily caps in I-14. The deterministic page renders first; an AI
  layout, when it arrives, only re-places sections.

### 13.5 Layout spec contract: types plus JSON Schema, no new library

**P-22 The layout spec is a closed typed value validated by plain
checks plus a JSON Schema descriptor; no schema library is added.**
Following section 3.3 and P-14:

- TypeScript types are normative. Working shape:
  `LayoutSpec` carries a spec version and a bounded list of
  placements; each placement names one `sectionId` from a closed
  whitelist enum (the sections the deterministic plan can emit, for
  example `summary`, `score`, `signals`, `plugin-findings`,
  `evidence`, `cant-tell`, `assessment`, `expert-detail`), an
  `emphasis` from `normal | high | low`, and an optional `collapsed`
  flag for sections the deterministic plan marks collapsible.
  `summary` and `score` are always present, never collapsible, and
  keep their content in every spec.
- A JSON Schema descriptor (the draft-07 subset in section 3.3,
  `additionalProperties: false`) is carried beside the types and
  published with the REST schema, and a plain-check smart
  constructor, `parseLayoutSpec`, validates every model response
  before the UI applies it — in the style of `parsePluginAuditReport`
  and `validateAssessmentOutput`. Unknown section ids, duplicate
  placements, placements for absent sections, missing required
  sections, oversize specs, and any field outside the descriptor
  give the typed `invalid-output` outcome and the whole spec is
  discarded; no partial spec is applied.
- **No zod.** Zod is not a dependency in this repo; runtime validation
  is plain checks plus smart constructors (A-16), JSON Schema
  descriptors already exist for REST and MCP, and `ajv` is a
  test-only devDependency. Adding zod solely for the layout spec
  would add a runtime dependency under K-506 and I-04 supply-chain
  review and a second source of truth beside the TypeScript types,
  for a small closed spec shape the existing style already covers.
  The product request's mention of zod is therefore met with the
  repo's established equivalent, and this paragraph is the record of
  that choice. A contract test checks that the typed spec and the
  descriptor agree on frozen examples in both directions.

**P-23 Any invalid, missing, or unavailable AI layout falls back to
the deterministic layout, and the AI layout is never an authority
over content.** Every port error branch, a schema-invalid spec, an
identity-mismatched response, and the `not-configured` outcome leave
the P-19 deterministic plan standing, with a short notice that the
deterministic layout is shown. While an AI layout is applied, the
page carries the label `Experimental AI layout` with provider and
model id, beside — never instead of — the unchanged deterministic
content. No code path reads the spec as evidence: the spec type has
no field the analysis, scoring, registry, or assessment paths can
consume, and the property test in S-064 requires bit-identical
scores, evidence, and finding text with the AI layout on, off,
invalid, and absent.

### 13.6 Stories and requirements added by this update

Stories S-059–S-064 are added under epic E-08 in `backlog.md`, after
S-058, test-first like every E-08 story. S-059–S-061 (deterministic
adaptive UI) are MVP for this follow-on work; S-062–S-064 (AI layout)
are Stretch and cut first. Every story depends on S-046; S-060 and
later also on the stories named in `backlog.md`. Proposed new K-IDs,
entered in `docs/requirements.md` by their first implementation story
in the same change (section 10 rule, threat-model section 1 point 4):

| Proposed ID | Title | Priority |
|---|---|---|
| K-034 | Adaptive web UI: schema-driven plugin rendering, deterministic risk-adaptive layout, Simple / Expert modes | MVP (for E-08 adaptive UI, after S-046) |
| K-518 | AI layout safety: whitelist declarative layout spec, presentation-only, deterministic fallback | Stretch (for E-08 adaptive UI) |

Alternatives considered for this update and set aside:

- Per-plugin UI components or a plugin-supplied component name in the
  schema. Rejected in P-18 for the same reason as in section 10: one
  fixed library, reviewed once, keeps plugin markup unrepresentable.
- Letting the AI layout emit HTML, CSS, or component code for richer
  pages. Rejected in P-21 and P-22: a declarative whitelist spec over
  frozen content keeps the K-507 posture and makes fallback total.
- Zod for the layout spec. Set aside in P-22: plain checks plus a
  JSON Schema descriptor are the repo norm, and a new runtime
  dependency needs its own justification against K-506 and I-04.
- A browser-direct call to the provider for layout. Rejected: the
  provider key stays server-side (I-09, I-13), and the server call
  keeps caps, caching, and identity checks in one place.
- An MCP layout tool. Deferred: layout is web-UI presentation; an
  MCP caller that needs ordering can read the same frozen fields and
  order locally. A tool is added only through the K-026 review if a
  caller appears.

## 14. User-priority personalization — the demo headline innovation

User-priority personalization is the **demo's headline innovation**:
the token page shows what the **user** says matters to them, in the
user's own words, ahead of what a generic risk order would surface.
A visitor who writes "I want to know if the owner can stop me
selling" sees the honeypot, transfer-limit, and owner-power findings
emphasised first; a visitor who writes nothing sees the existing
deterministic page unchanged. This section refines P-15 (above) and
extends P-18–P-23 with P-24–P-28. It changes presentation emphasis
only: no rule here changes analysis, scoring, evidence, or finding
text (P-05, K-307, A-33), and the hard floor in P-26 binds every
layer, including the AI mode.

How the layers compose is stated once here and nowhere contradicted
later in this section. The token page is built in this order:

1. The frozen analysis and the fixed component library (P-18)
   produce every section and every string.
2. The severity floor (P-26) pins high-severity and critical
   evidence in place: always present, always visible, never
   collapsed by any layout.
3. Personalization — deterministic first (P-25), AI only on opt-in
   (P-27) — orders and emphasises the remaining sections and plugin
   cards.
4. The P-19 risk-adaptive order is the order step 3 starts from,
   and the fallback when personalization has nothing to say.
5. Simple / Expert (P-20) controls detail depth orthogonally: it
   reveals or hides detail sections of the same frozen response and
   never interacts with ranking.

Precedence, highest first: **severity floor (P-26) > valid AI
personalize spec (P-27, only when the user opted in) >
deterministic priority baseline (P-25) > P-19 risk-adaptive layout
> static order**. At most one personalized order is applied at a
time; the layers never merge two orderings section by section.

### 14.1 User priorities: local-only personal data

**P-24 User priorities are stated in the user's own words, stored
locally only, and never become a server-side profile.** The token
page (and, where space allows, the start page) offers one free-text
field — working label "What matters to you?" — with examples in the
placeholder text drawn from the controlled vocabulary in human
words (for example "Can the owner stop me selling? Can fees
change? Can more tokens be minted?").

- Storage: the text is stored in `localStorage` under one
  versioned key, `brandklipparen-user-priorities:v1`, as a small
  JSON value `{ "version": 1, "text": "<priorities>" }`. It is read
  once at start-up and on edit, in `apps/web` only. There is no
  server-side profile: no REST field, no MCP field, no database row,
  no cache key, and no log field ever carries the priorities text.
  Clearing the field removes the key.
- Validation on read and on write: the stored value must parse as
  that exact shape with `version: 1`; `text` is trimmed, capped at
  500 characters, and rejected to empty (no personalization) when it
  exceeds the cap, carries control characters, or fails to parse.
  Any other stored shape is ignored and treated as "no priorities
  stated", in the same closed-read posture as the mode preference
  in P-20. The text is rendered only as the visitor's own input
  value and as escaped text if echoed in a label; it never reaches
  a raw-HTML sink (K-507).
- Leaving the device: in the deterministic baseline (P-25) the text
  never leaves the device at all — matching is client-side and
  makes zero network calls. The sole exception is P-27: when, and
  only when, the user explicitly enables the experimental AI
  personalize mode for that mapping call, the current priorities
  text is sent once, server-side, to the model as quoted untrusted
  data (P-27) so it can be mapped to plugin ids. The toggle copy
  states this before the first AI call in plain English ("Your
  priorities text is sent to the AI provider for this mapping
  only"). Turning the toggle off stops all further sends; no
  history of priorities is sent. Priorities are PII-ish local data
  (threat model H-26): a user may paste health, wealth, or identity
  context into the field, so minimisation is by architecture, not
  by policy text.

### 14.2 Deterministic baseline: keyword and tag matching

**P-25 A pure, testable keyword/tag match over `PLUGIN.md`
frontmatter reorders and highlights sections deterministically,
with no network.** This is the default personalization for every
visitor who states priorities, and the fallback for P-27.

- Input: the validated priorities text (P-24) and, per registered
  plugin, the validated frontmatter `tags` list (P-15 refined) plus
  the plugin id. The function reads frontmatter only — never the
  `PLUGIN.md` body, never finding text, never the network.
- Matching: the text is lower-cased and tokenised on non-letter
  boundaries. A versioned keyword table in `apps/web` maps word
  stems to controlled-vocabulary tags; the working table is:

  | User words (stemmed) | Tag |
  |---|---|
  | sell, sold, exit, stuck, trap, honeypot | `honeypot` |
  | stop, block, freeze, prevent (near sell/transfer/trade) | `honeypot`, `transfer-limits` |
  | owner, admin, creator, control, power | `owner-powers` |
  | fee, fees, tax, charge, cost (on buy/sell) | `fees` |
  | upgrade, change the contract, replace, proxy | `upgradeability`, `proxy` |
  | liquidity, pool, locked, withdraw (liquidity) | `liquidity` |
  | blacklist, blocked list, banned, whitelist | `blacklist` |
  | pause, paused, halt, emergency stop | `pausing` |
  | limit, cap, max (on transfer/trade/sell) | `transfer-limits` |
  | mint, minted, more tokens, supply, inflation, print | `mint`, `supply` |
  | external, call, oracle, dependency | `external-calls` |

  A plugin matches when any of its frontmatter `tags` is hit by
  the table. Each match is scored by the number of distinct tags
  hit, then by the plugin's frontmatter `severity.max` as a
  tie-break display value only. The table is a closed, versioned
  constant reviewed with this ADR; stemming or entries never come
  from plugin or user data.
- Output: an ordered plugin id list, a per-plugin matched-tag list
  (shown to the user as "Matched: honeypot, fees" so the emphasis
  is explainable), and a highlight set. Matched plugin cards and
  their sections are emphasised and moved ahead of unmatched ones
  within the order the severity floor (P-26) leaves free; DOM order
  equals visual order (K-103). No section is hidden, removed, or
  reworded; unmatched content keeps its P-19 order after the
  matched block. The same priorities and the same registry always
  give the same output: the function is a pure function in
  `apps/web`, unit-tested on frozen fixtures with zero network
  fakes counted.
- Explainability: when personalization is active the page states
  "Ordered by what matters to you" with the matched tags per card
  and a one-click return to the standard order. When no tag matches,
  the page states that no plugin matched the stated priorities and
  shows the standard (P-19) order — it never invents a match.

### 14.3 The severity floor and content integrity

**P-26 Personalization never hides high-severity or critical
findings, and never changes scores, evidence, or finding text.**
This is a hard floor, normative over P-19, P-25, and P-27:

- Critical evidence is always visible. Every finding or signal
  whose frozen severity is `high` or `critical` — and the `summary`
  and `score` sections in every case — stays present, expanded (not
  collapsed), and reachable in DOM order in every layout:
  deterministic, priority-ordered, and AI-ordered alike. A
  personalization spec that would place a floored section below
  the fold is not rejected for that alone; the renderer clamps the
  floored sections ahead of all non-floored sections and applies
  the personalized order only to the rest. A spec that marks a
  floored section collapsed or absent is invalid as a whole
  (P-28).
- No score, probability, signal, evidence entry, or finding,
  explanation, or assessment text ever changes under
  personalization. Ordering and emphasis metadata are the only
  outputs. The property tests in section 14.7 require bit-identical
  scores, evidence, and finding text with personalization off,
  deterministic, AI, invalid, and absent.
- `PLUGIN.md` claims never become findings. A doc that says its
  plugin "covers honeypots" only contributes frontmatter `tags`
  to matching; the finding itself still comes from the detector
  with evidence (A-13, P-03, P-17).

### 14.4 One unified experimental AI mode: "AI personalize"

**P-27 The optional AI mode is one unified experimental "AI
personalize" mode — not two competing AI modes. It extends the
P-21 AI layout mode; it does not sit beside it.** Earlier wording
in P-21 that describes a layout-only AI mode is refined here:
there is a single toggle, a single port, a single spec family,
and a single fallback. The working toggle label is
`AI personalize (experimental)`; while an AI spec is applied the
page carries the label `Experimental AI personalize` with provider
and model id. The mode is OFF by default for every visitor.

- What it does: when the user enables the toggle for the current
  token view, the web UI sends the server the code hash, the
  closed layout facts P-21 already defines, and — only for this
  call — the current priorities text (P-24). The server calls Muse
  Spark Open (`meta-models/muse-spark-open-1026`) on hosted, which
  maps the free-text priorities to plugin ids using the plugins'
  `PLUGIN.md` frontmatter and the `What it checks` /
  `Why it matters to you` sections as quoted reference data, and
  returns one declarative ranking-plus-layout spec (P-28): an
  ordered plugin ranking and section placements from the same
  whitelist family as `LayoutSpec`. Ranking and layout therefore
  always agree, because one spec carries both; there is no
  separate ranking call and no precedence fight between two model
  answers. Documented precedence is the list in the section
  preamble: a valid AI spec outranks the deterministic baseline
  for ordering only, and both sit under the P-26 floor.
- Port shape: one small port, working title
  `PluginPersonalizeModelPort`, built in parallel to
  `PluginLayoutModelPort` (P-21) and `PluginAuditModelPort` (P-14)
  and reusing the hosted adapter's transport, server-side key
  handling, deadline, size limits, concurrency bound, and cost
  caps (A-17, I-13, I-14). It returns
  `Result<PersonalizeSpec, PluginPersonalizeModelError>` with the
  A-15 branches mirrored from the layout port (`timeout`,
  `rate-limited`, `invalid-output`, `output-too-large`,
  `provider-mismatch`, `unavailable`, plus `not-configured`).
  Without a configured hosted key it reports `not configured`
  with zero provider calls — the assessment posture (K-305) —
  and the deterministic baseline (P-25) stands. Whether the
  implementation extends `PluginLayoutModelPort` in place or adds
  this sibling port is decided in its first story (section 14.7,
  open decision 12); the contract that matters — one toggle, one
  spec, one fallback — holds either way. REST working shape:
  `POST /v1/personalize` behind the same API-key gate as the
  analysis routes (K-024). There is no MCP personalize tool in v1.
- Untrusted input, by construction: user priorities and `PLUGIN.md`
  content are untrusted model input. The prompt keeps its system
  instruction in its own field and passes the priorities text and
  the per-plugin frontmatter plus section excerpts solely as quoted
  data through `UntrustedText.quote` under per-item and total
  length caps, in a tool-free call (K-308, M-04 pattern, extended
  in M-33). Text that instructs the model to hide critical
  evidence, invent a plugin, change a score, or emit markup is
  therefore data inside a quotation; a response that follows it
  fails spec validation (P-28) or amounts to an ordering choice
  over unchanged, floored content (P-26).
- Cost and caching mirror the layout path: at most one AI
  personalize call per uncached token view, cached per code hash,
  personalize prompt version, provider, and model id — never per
  priorities text, so a cache entry never becomes a priorities
  store — under the per-provider daily caps in I-14. The
  deterministic personalized page renders first; an AI order, when
  it arrives and validates, only re-places sections. Every error
  branch falls back to P-25, then to P-19 (P-28).

### 14.5 Personalization spec contract: types plus JSON Schema, no zod

**P-28 The AI personalize output is a closed typed spec validated
by plain checks plus a JSON Schema descriptor; no schema library
is added.** This follows section 3.3, P-14, and P-22 exactly:

- TypeScript types are normative. Working shape:
  `PersonalizeSpec` carries a spec version, a bounded
  `pluginRanking` (an ordered list of registered plugin ids, each
  at most once, drawn only from the ids in the request), and the
  P-22 `placements` list (whitelisted `sectionId`, closed
  `emphasis` enum, optional `collapsed` for collapsible sections
  only). It carries no free text, no HTML, no code, no URLs, no
  styles, and no score or severity value; `summary` and `score`
  are always present and never collapsible, and no placement may
  collapse or omit a P-26 floored section.
- A JSON Schema descriptor (the draft-07 subset in section 3.3,
  `additionalProperties: false`) is carried beside the types and
  published with the REST schema, and a plain-check smart
  constructor, `parsePersonalizeSpec`, validates every model
  response before the UI applies it — in the style of
  `parseLayoutSpec` and `parsePluginAuditReport`. Unknown or
  duplicate plugin ids, rankings naming plugins absent from the
  request, unknown section ids, duplicate placements, oversize
  specs, any field outside the descriptor, and any collapse of a
  floored section give the typed `invalid-output` outcome and the
  whole spec is discarded; no partial spec is applied.
- **No zod**, for the same reason as P-14 and P-22: zod is not a
  dependency in this repo; runtime validation is plain checks plus
  smart constructors (A-16), JSON Schema descriptors already exist
  for REST and MCP, and `ajv` is a test-only devDependency. Adding
  zod solely for the personalize spec would add a runtime
  dependency under K-506 and I-04 supply-chain review and a second
  source of truth beside the TypeScript types, for a small closed
  spec shape the existing style already covers. A contract test
  checks that the typed spec and the descriptor agree on frozen
  examples in both directions.
- Fallback is total (extends P-23): every port error branch, a
  schema-invalid spec, an identity-mismatched response, and the
  `not-configured` outcome leave the deterministic baseline (P-25)
  standing — or the P-19 layout when no priorities are stated —
  with a short notice that the deterministic order is shown. No
  code path reads the spec as evidence: the spec type has no field
  the analysis, scoring, registry, or assessment paths can consume.

### 14.6 Relation to the adaptive UI (P-18–P-23), stated plainly

| Existing rule | Relation under personalization |
|---|---|
| P-18 fixed component library | Unchanged. Personalization reorders the sections the library already rendered; it adds no component and no per-plugin UI code. |
| P-19 deterministic risk-adaptive layout | Becomes the base order and the fallback. It is no longer the outermost ordering when priorities match; its band rules still produce the order P-25 and P-27 start from. |
| P-20 Simple / Expert | Orthogonal and unchanged. Mode controls detail depth; priorities control emphasis. Both may be active at once with no shared state beyond the page. |
| P-21 AI layout mode | Superseded as a separate mode. Its port, transport, caps, and whitelist discipline carry into the unified AI personalize mode (P-27); a layout-only toggle is never shipped beside it. |
| P-22 `LayoutSpec` contract | Extended, not replaced. `PersonalizeSpec` reuses the placement shape and adds `pluginRanking`; the no-zod rationale and smart-constructor validation carry over verbatim. |
| P-23 deterministic fallback | Extended. The fallback chain is now AI spec → deterministic priority baseline → P-19 layout, each step total. |

### 14.7 Stories and requirements added by this update

Stories S-065–S-070 are added under epic E-08 in `backlog.md`,
after S-064, test-first like every E-08 story. S-065–S-067
(deterministic headline path) are MVP for the demo; S-068–S-070
(unified AI personalize) are Stretch and cut first. Every story
depends on the stories named in `backlog.md`; the MVP path needs
S-046 and S-059–S-061 standing. Proposed new K-IDs, entered in
`docs/requirements.md` by their first implementation story in the
same change (section 10 rule, threat-model section 1 point 4):

| Proposed ID | Title | Priority |
|---|---|---|
| K-035 | User-priority personalization: local-only priorities, deterministic frontmatter matching, severity floor (P-24–P-26, P-15 refined) | MVP (demo headline innovation) |
| K-519 | AI personalize safety: quoted untrusted priorities and docs, whitelist ranking-plus-layout spec, deterministic fallback (P-27, P-28) | Stretch (experimental) |

Alternatives considered for this update and set aside:

- Two separate AI modes (a ranking mode and the P-21 layout mode)
  with a documented precedence between them. Set aside in P-27: one
  toggle, one port, and one spec that carries ranking and layout
  together is the smaller coherent design, and it removes the
  failure where a ranking says one thing and a layout another.
- A server-side priorities profile per API key, so priorities
  follow the user across devices. Rejected in P-24: priorities are
  PII-ish free text, the demo needs no account, and local-only
  storage keeps the "never leaves the device" claim true by
  architecture (H-26).
- Matching priorities against `PLUGIN.md` body text or finding
  text. Rejected in P-25: frontmatter tags are the closed,
  validated, explainable surface; body text is prose that would
  make matches untestable and injection-sensitive.
- Zod for the personalize spec or the frontmatter schema. Set
  aside in P-28 for the P-14/P-22 reason: plain checks plus JSON
  Schema descriptors are the repo norm, and a new runtime
  dependency needs its own justification against K-506 and I-04.
- Hiding unmatched or low-priority sections to "focus" the page.
  Rejected in P-26: focus is achieved by order and emphasis; the
  floor keeps critical evidence always visible and every section
  reachable.
