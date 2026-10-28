# Backlog: Brandklipparen

Author: Jens Abrahamsson.
Build: 27 October–4 November 2026. Submission deadline: 5 November 2026, 03:00 Swedish time.
Theme: "Build for Your World". Core question: how far do you get with bytecode alone?

Requirements own the K-IDs in `docs/requirements.md`. Architecture rules
(A-xx) are in `docs/architecture.md`, infrastructure rules (I-xx) in
`docs/infrastructure.md`, and threats (H-xx) with mitigations (M-xx) in
`docs/threat-model.md`. Every story below points to at least one K-ID.
Every story is worked test-first: write the named test, watch it fail,
then implement (see A-21 in `docs/architecture.md`).

Priorities: **MVP** ships for the submission. **Stretch** ships only if
the MVP path is green. Low-priority Stretch is cut first (see Buffer).

## Parked after plugin core — do not start now

Plugin core finished in this session: **S-047** (calibration promotion,
D-6 closed), **S-052** (required `PLUGIN.md` plus deterministic
validator), **S-056** (plugin docs in REST and MCP). S-057 UI is skipped.
Everything below stays as designed but parked: keep the stories, do not
code them now.

| Parked group | Stories | Note |
|---|---|---|
| E-09 Investigate with Muse | S-072–S-077 | S-072–S-077 shipped (K-036, K-520 in `docs/requirements.md`); S-077 recorded-trace library and per-codehash cache with caps included |
| E-10 own EVM decompiler | S-078–S-085 | S-078–S-085 shipped green 28/10 (K-037, K-038, K-521 in `docs/requirements.md`): S-081 decompiler detector plugin consumed via REST/MCP/Expert UI at weight 0; S-083 opt-in display-only naming via `POST /v1/naming` with fake adapter; S-084 mutated-bytecode hardening property; S-085 artifact-weight proof; eval format and metrics in `docs/evm-decompiler.md` |
| Adaptive web UI | S-059–S-064 | S-059 done — schema-driven panel with fixed library and canonical-JSON fallback (K-034); S-060 done — deterministic risk-adaptive order with score pinned first (strip UX) and severity next (K-034); S-061 done — Simple/Expert toggle persisted locally with raw detail in Expert (K-034); S-062–S-064 retired per ADR 0.1, folded into S-068–S-070; 28/10 chain picker removed, mainnet-only badge (chainId 1, S-091) |
| User-priority personalization | S-065–S-070 | S-065 done — strict frontmatter with vocab/audience/severity validated in CI, 6 docs migrated (K-035); S-066 done — local-only priorities field with closed validation; S-067 done — deterministic matcher with floor (K-035); S-068 done — unified PersonalizeSpec with JSON Schema descriptor; S-069 done — single port, fake + hosted contracts, service, POST /v1/personalize (K-519); S-070 done — experimental AI toggle off by default with provider label, one-call mapping, deterministic fallback (K-519); 28/10 client spec validation moved to zod 3.25.76 pinned exact with whitelist tests, fallback unchanged |
| Plugin audit | S-053–S-055, S-058 | S-053–S-055 shipped green in this session (K-516 in `docs/requirements.md`); S-058 done — stored-report read view in REST and MCP, three states with provider/model, read-only |
| Registry leftovers | S-048–S-050 | S-048 shipped green in this session (per-plugin MCP tools); S-049 done — signed allowlist admission at build time (H-46/M-52); S-050 done — dedicated worker per untrusted detector run with typed timeout (H-47/M-53) |
| Later ideas | — | AI explain/chat/rug, REST streaming/snippet/calibration/deploy-time checks, UI P2 (just-deployed feed replaced by E-11) left for later; duplicate package.json `check` key verified single 28/10 (no duplicate present) |

## Pre-work

- [ ] Read the official hackathon rules when published and accept them.
- [ ] Create new API keys in Jens Abrahamsson's name for this project (RPC and any other provider keys; least privilege, per environment).
- [ ] Create the private repo under jensabrahamsson; make it public on 4/11 ahead of submission (K-403, K-406).
- [x] Knowledge note on bytecode scanning is done (`kunskap/bytecode-forskning.md`, `kunskap/relaterat-arbete.md`).
- [x] Design sketches and identity are done (25/10, DEXTools-inspired but better, horse identity; see `design/README.md`).
- [x] Architecture and MVP plan are done through `docs/requirements.md`, `docs/architecture.md`, `docs/infrastructure.md` and `docs/threat-model.md`.
- [x] No code before kickoff; 25–26/10 is documents and design only (K-404).

## Epics

| Epic | Name | K-IDs |
|---|---|---|
| E-01 | Foundation: repo, CI, deterministic typed core | K-027, K-102, K-105, K-106, K-505 |
| E-02 | Bytecode fetch and proxy resolution | K-001–K-007, K-013, K-014 |
| E-03 | Decompilation, signals and clone matching | K-008–K-010, K-015–K-017, K-501 |
| E-04 | Risk model, calibration and evaluation | K-011, K-201–K-211 |
| E-05 | Explanations and Muse contract assessment (high priority) | K-301–K-309, K-502, K-513 |
| E-06 | Interfaces: shared service, REST, MCP, web UI | K-020–K-027, K-101, K-103, K-104, K-107 |
| E-07 | Security, demo and submission | K-401–K-407, K-501–K-513 |
| E-08 | Plugin architecture (design in `docs/adr-plugin-architecture.md`, P-xx) | K-028–K-031 (proposed), K-514, K-515 (proposed), K-102, K-210, K-305, K-309, K-032–K-033, K-516–K-517 (proposed, audit and PLUGIN.md), K-034, K-518 (proposed, adaptive web UI), K-035, K-519 (proposed, user-priority personalization — demo headline innovation) |
| E-09 | Investigate with Muse: runtime agent loop on open weights (design in `docs/adr-investigate-with-muse.md`, P-29–P-38) | K-036 (proposed), K-520 (proposed), K-305, K-309, K-102, K-507, K-513 |
| E-10 | Own EVM decompiler, ERC-20 scoped (design in `docs/adr-evm-decompiler.md`, D-xx) | K-037 (proposed), K-038 (proposed), K-521 (proposed), K-008, K-010, K-102, K-501 |
| E-11 | New LP pairs feed on Ethereum mainnet (K-039) | K-039 (proposed), K-014, K-102, K-505 |

## Stories

### E-01 Foundation

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-001 | Repo skeleton and green CI gate | K-105, K-106 | MVP | `a06_deliberately_broken_boundary_fails_ci` and `k106_typecheck_blocks_on_error` fail on a deliberate break, then pass clean. |
| S-002 | Branded domain types with smart constructors | K-106 | MVP | `k106_invalid_states_fail_construction_or_compilation` covers each invariant on both sides of its boundary. |
| S-003 | Deterministic core and canonical serialization | K-102 | MVP | `k102_golden_fixtures_bit_identical` plus `k102_two_runs_across_processes_bit_identical` on frozen fixtures. |
| S-004 | Typed config and secret handling at startup | K-505, K-510 | MVP | `k505_missing_variable_named_without_values` and `k505_keys_read_from_environment_at_start`. |

### E-02 Bytecode fetch and proxy resolution

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-005 | Fetch runtime bytecode for an address via RPC | K-001 | MVP | `k001_contract_address_returns_bytecode`; `k001_invalid_address_fails_before_rpc` counts zero RPC calls. |
| S-006 | Resolve EIP-1967 and UUPS proxies, report upgrade authority | K-002, K-005 | MVP | `k002_eip1967_returns_proxy_and_implementation` and `k005_uups_returns_implementation` (golden). |
| S-007 | Resolve EIP-1167 minimal proxies and EIP-7702 delegations | K-004, K-007 | MVP | `k004_eip1167_reads_embedded_target` and `k007_eip7702_follows_delegation` (golden). |
| S-008 | Resolve beacon proxies | K-003 | Stretch | `k003_beacon_returns_beacon_and_implementation` (contract). |
| S-009 | Resolve diamond (EIP-2535) facets | K-006 | Stretch | `k006_diamond_lists_facets_per_selector` (contract). |
| S-010 | Cache per code hash and just-deployed feed | K-013, K-014 | MVP | `k013_cache_hit_skips_decompilation_and_external_calls` and `k014_newest_token_first_with_block`. |

### E-03 Decompilation, signals and clone matching

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-011 | extdecomp adapter in an isolated sandbox worker | K-008, K-501 | MVP | `k008_timeout_yields_hard_to_analyze_signal` and `k501_pathological_input_isolates_to_its_analysis`. |
| S-012 | Selector and pattern extraction in the fast path | K-009 | MVP | `k009_every_selector_paired_or_marked_unknown` (property). |
| S-013 | Signals with evidence down to selector and PC offset | K-010, K-012 | MVP | `k010_signal_requires_selector_and_carries_offset_when_derivable`; a signal without evidence fails construction. |
| S-014 | Clone matching against known trap templates | K-017 | MVP | `k017_clone_hit_reports_similarity_group_and_count` (golden). |
| S-015 | Current storage values shown as "applies now" | K-016 | Stretch | `k016_value_carries_slot_block_and_time` (integration). |
| S-016 | Risk timeline since deploy | K-015 | Stretch | `k015_each_score_change_links_to_event` (e2e). |

### E-04 Risk model, calibration and evaluation

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-017 | Fresh public on-chain dataset with label policy | K-201, K-202 | MVP | `k201_each_datapoint_has_address_bytecode_block_source` and `k202_label_quality_spot_check_versioned`. |
| S-018 | Time-based and cluster-based splits | K-203, K-204 | MVP | `k203_test_split_strictly_after_training_split` and `k204_no_cluster_spans_splits`. |
| S-019 | Train, calibrate and freeze the versioned artifact | K-209, K-210, K-211 | MVP | `k211_retraining_reproduces_artifact_bit_identical` with locked seeds and checksum. |
| S-020 | Calibrated probabilities and 0–100 score from signals | K-011 | MVP | `k011_probabilities_in_unit_interval_and_integer_score` (property); weights load only from the artifact. |
| S-021 | Calibration and discrimination metrics with model card | K-205, K-206, K-208 | MVP | `k205_ece_per_class_on_both_splits` and `k206_auroc_prauc_per_class_on_both_splits`. |
| S-022 | Comparison against a simple baseline | K-207 | Stretch | `k207_comparison_uses_same_metrics_and_splits`. |

### E-05 Explanations and Muse contract assessment (high priority)

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-023 | Template-based deterministic explanations | K-301, K-302, K-303, K-304 | MVP | `k301_template_text_bit_identical_from_evidence` (golden); every claim links to a signal. |
| S-024 | Schema validation, template fallback, untrusted contract strings | K-306, K-307, K-308, K-502 | MVP | `k307_scores_and_evidence_identical_with_and_without_adapter` and `k308_hostile_strings_leave_explanation_structure_intact`. |
| S-025 | `AssessmentModelPort`, fake and composition-root provider selection | K-305, K-309 | MVP (high) | `k309_config_selects_exactly_one_assessment_adapter`; `runAssessmentModelPortContract` against the fake. |
| S-036 | Meta Model API adapter: Muse Spark assessment | K-305, K-309 | MVP (high) | `runAssessmentModelPortContract` against the Meta adapter over a recorded transport; `k305_assessment_logs_provider_and_model_id`. |
| S-037 | hosted open-weights adapter: Muse Spark Open, `meta-models/muse-spark-open-1026` | K-305, K-309 | MVP (high) | `runAssessmentModelPortContract` against the hosted adapter over a recorded transport; `k309_hosted_adapter_uses_open_weights_model_id`. |
| S-038 | Muse contract assessment in UI tab, REST endpoint and MCP tool, with cost limit, cache and provider labelling | K-305, K-309, K-513 | MVP (high) | `k305_assessment_works_in_demo_ui_rest_and_mcp`; `k305_no_assessment_call_until_user_requests_assessment`; `k305_daily_cost_cap_per_key_stops_assessment_calls` per provider; `k305_refined_text_cached_per_codehash_and_template_version` with the full cache key; `k513_tampered_or_oversize_provider_response_rejected`. |

The Muse contract assessment is MVP and high priority: judging
step 1 requires reasonable use of the Meta Model API or open-weight
models, and the assessment works in the demo. It runs solely on
request through the button or tab, the REST endpoint and the MCP tool.
It leaves scores and evidence unchanged, it is cached per code hash,
prompt version, provider and model id, it has cost limits, timeout
and input and output size limits with schema validation for both
providers, and its text is clearly marked as Muse-generated with
provider and model id, shown separately from the deterministic
result. Both adapters (Meta Model API and hosted open weights) are
MVP; Jens selects the demo default provider as the open decision in
section 13 of `docs/requirements.md`. Contract tests run the same
suite against both adapters and a fake. The template explanations
from S-023 are always shown. Running on open weights qualifies for
the bonus prize "Best Build on Meta Open Weight Models". Muse is
also the build tool through Muse Code: Muse Wonder for planning
and requirements and Muse Spark for code.

### E-06 Interfaces

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-026 | One shared application service for all interfaces | K-027 | MVP | `k027_same_inputs_same_outputs_across_interfaces` (property). |
| S-027 | Versioned REST API with schema, error format and API keys | K-023, K-024, K-504, K-510 | MVP | `k023_response_matches_published_schema` and `k024_missing_or_invalid_key_rejected_before_analysis`. |
| S-028 | Read-only MCP server over the same service | K-025, K-026, K-508 | MVP | `k025_assess_token_matches_rest_for_same_codehash` and `k026_tools_leave_state_unchanged`. |
| S-029 | Web UI: start page and token page | K-020, K-021, K-103, K-507 | MVP | `k021_fast_path_renders_before_deepening` (e2e); score shown as number and word. |
| S-030 | Web UI: timeline view | K-022 | Stretch | `k022_marker_matches_log_row` (e2e). |
| S-031 | Performance, observability and cost frames | K-101, K-104, K-107 | MVP | `k101_fast_path_p95_within_5s` on recorded fixtures; `k107_no_request_zero_assessment_calls_and_cost`. |

### E-07 Security, demo and submission

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-032 | Security controls from the threat model | K-501–K-513 | MVP | The named test per M-xx in `docs/threat-model.md`, e.g. `k501_mutated_bytecode_yields_signal_or_typed_error` (fuzz) and `k513_tampered_or_oversize_provider_response_rejected`. |
| S-033 | Public demo deployment with health check | K-402, K-104 | MVP | `k402_demo_serves_ui_rest_and_mcp` and `k402_demo_shows_submission_model_version`. |
| S-034 | Demo video, 3 minutes on YouTube, live token, proxy case and working Muse contract assessment | K-401 | MVP | Review `k401_video_shows_deterministic_analysis` with timestamps; `k401_video_length_3_minutes`; `k401_video_linked_from_youtube`; `k401_video_shows_only_hackathon_work`. |
| S-035 | Public GitHub repo, clean-clone check and on-time submission | K-403, K-404, K-405, K-406 | MVP | Reviews `k403_clean_clone_instructions_verified_on_second_machine` and `k405_submission_reachable_before_deadline`. |
| S-039 | Write submission texts: "Describe your use of Meta products" and "Why are Meta's models important to your solution" | K-406 | MVP | Reviews `k406_describe_use_of_meta_products_written` and `k406_why_meta_models_important_written`, signed on 3/11. |
| S-040 | Submission package: track Indie Developer, problem statement Build for Your World, repo public, links resolve | K-403, K-405, K-406 | MVP | Reviews `k406_submission_track_indie_developer`, `k406_submission_problem_build_for_your_world` and `k406_submission_links_resolve` on 4/11. |
| S-041 | Live final preparation: runbook, rehearsal and fallbacks | K-407 | Stretch | Reviews `k407_live_final_runbook_rehearsed`, `k407_live_final_rehearsal_completed` and `k407_live_final_fallbacks_reachable`. |

### E-08 Plugin architecture

Design: `docs/adr-plugin-architecture.md` (P-01–P-12). Proposed K-IDs
K-028–K-031 and K-514–K-515 enter `docs/requirements.md` in S-042, in
the same change. Scheduling follows open decision 1 in the ADR: the
epic starts after the submission-critical path is green, unless Jens
moves S-042–S-044 into the 27/10–4/11 window at the 31/10 checkpoint.
No story in this epic leaves a dual path behind; each migration story
deletes its legacy path in the same story (P-12).

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-042 | Plugin API, manifest validation and static registry (empty) | K-028 (proposed), K-514 (proposed), K-106 | MVP | `registry_rejects_duplicate_ids_and_unsupported_api_versions` and `k514_registry_has_no_dynamic_loading` fail on a duplicate, an out-of-range `apiVersion` and a dynamic import, then pass clean; `k514_unregistered_plugin_never_runs` requires a plugin absent from the registry to be absent from output. |
| S-043 | Capability detector as first detector plugin, legacy direct call deleted | K-029 (proposed), K-010, K-102 | MVP | `runDetectorPluginContract` (determinism across two runs, schema agreement, evidence presence, unchanged inputs) red against the unwrapped detector, then green; golden fixtures stay bit-identical apart from the reviewed additive `pluginResults` field. |
| S-044 | Clone-match and hard-to-analyze detector plugins, inline wiring deleted | K-029 (proposed), K-017, K-008 | MVP | `k017_clone_hit_reports_similarity_group_and_count` and `k008_timeout_yields_hard_to_analyze_signal` pass through the registry path; a repo search for direct `cloneMatchSignal` calls outside plugin modules returns zero hits. |
| S-045 | Assessment adapters registered as assessment plugins, exactly one active | K-030 (proposed), K-305, K-309, K-307 | MVP | `runAssessmentModelPortContract` green against both registered plugins and the fake; `k309_config_selects_exactly_one_assessment_adapter` passes with selection by plugin id; `k307_scores_and_evidence_identical_with_and_without_adapter` stays green. |
| S-046 | Registry exposure: REST plugin list, MCP listing, generic web UI panel | K-031 (proposed), K-023, K-025, K-027, K-507 | MVP | `k031_plugin_list_matches_registry_in_rest_and_mcp` and `k027_same_inputs_same_outputs_across_interfaces` (extended to `pluginResults`); e2e `k515_plugin_strings_render_as_inert_text` and `plugin_findings_leave_probabilities_and_score_unchanged` (property). |
| S-047 | Calibration promotion: artifact-named plugin findings enter the score, legacy conversions deleted | K-029 (proposed), K-210, K-211, K-205, K-206 | MVP | `k210_plugin_weight_read_from_artifact_only` with two artifact versions (unnamed plugin at weight 0, named plugin calibrated); `k211_wrong_checksum_rejected_before_analysis` stays green; repo search confirms one conversion path through the artifact mapping. |
| S-048 | Per-plugin MCP tools generated from the registry | K-031 (proposed), K-025, K-026, K-508 | Stretch | `k026_new_tool_security_review_recorded` per generated tool; `k025_unknown_tool_returns_machine_readable_error` covers tools outside the startup registry snapshot. |
| S-049 | Signed allowlist distribution for separately published plugins | K-514 (proposed), K-506 | Stretch | `k514_unsigned_or_tampered_plugin_rejected_at_build` feeds an unsigned and a byte-changed plugin package and requires a build-time rejection before any import; requires its own threat-model change first. |
| S-050 | Worker isolation for untrusted detector plugins | K-515 (proposed), K-501, K-101 | Stretch | `k501_pathological_input_isolates_to_its_analysis` extended to a runaway detector plugin: parallel analyses continue and the plugin records a typed timeout outcome. Precondition for registering any unreviewed detector. |
| S-051 | Example plugin under `examples/plugins/` and "Writing a plugin" guide | K-028 (proposed), K-108 | Stretch | `example_plugin_registers_and_reports_weight_zero` runs the example detector on a frozen fixture through a local registry and requires a weight-0 finding in `pluginResults`, in `GET /v1/plugins`, and in the Plugins panel with no interface code changed. |

Audit and PLUGIN.md extension (ADR section 12, P-13–P-17; threat
model H-17–H-20, M-23–M-26). S-042 has landed, so these stories are
numbered after S-051 and renumber nothing. Proposed K-IDs K-032,
K-033, K-516, and K-517 enter `docs/requirements.md` in their first
implementation story below, in the same change. The audit is a CLI
and CI step, not an analysis-path feature: deterministic checks gate
acceptance together with a recorded human review, and the AI review
is advisory only and never affects scores or evidence (P-13, P-14).

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-052 | Required `PLUGIN.md` per plugin: contract, manifest `docs` reference, deterministic validator, docs backfilled for registered and example plugins | K-032 (proposed), K-517 (proposed), K-108 | MVP | `k517_plugin_md_missing_or_mismatched_fails_deterministic_check` requires a named failure per missing file, missing section, undeclared documented input, and version mismatch, red against a plugin without `PLUGIN.md`, then green; `plugin_md_validator_accepts_compliant_plugin` passes a compliant fixture. |
| S-053 | Deterministic plugin audit: `plugin audit` CLI (deterministic mode), static checks, blocking CI job | K-516 (proposed), K-514, K-515 (proposed), K-501 | MVP | `k516_deterministic_audit_fails_forbidden_import_and_capability_mismatch` fails a fixture per forbidden import, capability mismatch, and determinism-lint hit, then passes a clean fixture; `k516_deterministic_failure_runs_zero_model_calls` (integration) requires zero fake-adapter calls on a deterministic failure. |
| S-054 | Advisory AI plugin audit: `PluginAuditModelPort`, fake adapter, hosted open-weights implementation, structured findings | K-516 (proposed), K-305, K-309, K-502, K-513 | MVP | `runPluginAuditModelPortContract` red against the fake, then green against the fake and the hosted adapter over a recorded transport (no network); `k516_audit_without_key_reports_not_configured_and_sends_nothing`, `k516_injection_in_source_or_docs_stays_quoted_data`, and `k517_schema_invalid_audit_output_discarded` cover the unconfigured, injection, and invalid-output branches; `k516_ai_findings_leave_scores_signals_and_evidence_unchanged` (property). |
| S-055 | Docs-versus-code checks: deterministic claim checks in the audit plus advisory `docs-drift` findings | K-517 (proposed), K-516 (proposed) | MVP | `k517_documented_inputs_and_version_checked_against_manifest` fails per drifted input, version, and backticked output field, then passes clean; `k517_docs_drift_reported_as_advisory_finding` requires a `docs-drift` finding from the fake adapter for a documented detection with no matching logic, with the deterministic result unchanged. |
| S-056 | Plugin docs exposure: `GET /v1/plugins/:id/docs` and the MCP docs resource from the one registry | K-033 (proposed), K-023, K-025, K-027, K-508 | MVP | `k033_plugin_docs_match_registry_in_rest_and_mcp` requires identical docs content and section list in REST and MCP for the same plugin; `k024_missing_or_invalid_key_rejected_before_analysis` extended to the docs route; `k025_unknown_tool_returns_machine_readable_error` pattern covers an unknown plugin id with the uniform not-found error. |
| S-057 | Web UI plugin Docs view: sanitized markdown rendering in the Plugins panel | K-033 (proposed), K-507, K-103, K-108 | MVP | `k517_plugin_docs_render_as_sanitized_markdown` (e2e) feeds a script-bearing `PLUGIN.md` and requires inert text, no raw-HTML execution, and the CSP header present; `k515_plugin_strings_render_as_inert_text` stays green. |
| S-058 | Read view of the last CI audit report per plugin in REST and MCP (no audit trigger) | K-516 (proposed), K-031 (proposed), K-026 | Stretch | `k516_last_audit_report_shown_as_advisory_with_provider_and_model` requires the report's three separate states (`deterministic`, `ai: advisory`, `human-review`), provider, and model id in REST and MCP; `k516_clean_ai_report_alone_registers_no_plugin` requires that the read view alone changes no registration, score, or evidence. |

Adaptive web UI extension (ADR section 13, P-18–P-23; threat model
H-21–H-25, M-27–M-31). These stories are implemented after the plugin
core: every story below depends on S-046 (registry exposure and the
generic Plugins panel), and the schema-driven panel in S-059 builds on
that panel rather than replacing it. S-042 and S-043 have landed and
S-044 may be in progress; no completed story is renumbered. Proposed
K-IDs K-034 and K-518 enter `docs/requirements.md` in their first
implementation story below, in the same change. S-059–S-061 are MVP
for this follow-on work; S-062–S-064 are Stretch (experimental AI
layout) and cut first.

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-059 | Schema-driven plugin panel: fixed component library renders every plugin output from its `outputSchema` (depends on S-046) | K-034 (proposed), K-031 (proposed), K-507, K-103 | MVP | `k034_every_output_schema_shape_renders_via_fixed_library` maps each subset shape (text, number, boolean, enum, list, nested object, evidence) to its library component, red against the S-046 panel, then green; `k034_unknown_schema_shape_falls_back_to_canonical_json_text` requires inert canonical JSON for an out-of-subset shape; `k515_plugin_strings_render_as_inert_text` stays green; a new example-shaped plugin fixture renders with no UI code changed. |
| S-060 | Risk-adaptive deterministic layout: pure section ordering over the frozen analysis (depends on S-059) | K-034 (proposed), K-102, K-103 | MVP | `k034_high_risk_orders_severe_evidence_first` and `k034_low_risk_shows_calm_summary_first` on frozen fixtures per band, red against the static order, then green; property `k034_same_analysis_same_layout_across_runs` requires an identical section plan per frozen analysis, with DOM order equal to visual order and no section hidden in any band. |
| S-061 | Simple / Expert mode toggle with locally persisted preference (depends on S-059) | K-034 (proposed), K-507, K-103 | MVP | `k034_invalid_stored_mode_falls_back_to_simple` seeds crafted and markup-bearing stored values and requires Simple; Playwright `k034_mode_toggle_persists_across_reload` toggles Expert, reloads, and requires Expert still applied; Playwright `k034_expert_mode_reveals_bytecode_selectors_raw_data` requires bytecode, selectors with PC offsets, and raw plugin payloads as inert text in Expert and absent in Simple, with scores and evidence unchanged. |
| S-062 | Layout spec contract: `LayoutSpec` types, JSON Schema descriptor, `parseLayoutSpec` smart constructor (depends on S-060) | K-034 (proposed), K-518 (proposed), K-506 | Stretch | `k518_layout_spec_rejects_html_code_url_style_fields` feeds specs carrying markup, code, URL, and style fields and requires `invalid-output` with no partial spec applied, red against an accepting parser, then green; `k518_layout_spec_agrees_with_json_schema_on_fixtures` checks types and descriptor against each other on frozen examples in both directions (unknown id, duplicate placement, missing `summary` or `score`, oversize each fail). No new runtime dependency: plain checks plus JSON Schema per ADR P-22. |
| S-063 | `PluginLayoutModelPort`: fake adapter, hosted Muse Spark Open implementation, `not configured` without key (depends on S-062) | K-518 (proposed), K-513, K-502, K-309 | Stretch | `runPluginLayoutModelPortContract` red against the fake, then green against the fake and the hosted adapter over a recorded transport (no network); `k518_layout_without_key_reports_not_configured_and_sends_nothing` requires the `not-configured` outcome and zero fake-adapter calls; `k518_injection_in_analysis_text_stays_quoted_data` feeds hide, invent, and restyle instructions in finding titles and requires quoted data with no non-spec result field. |
| S-064 | Experimental AI layout in the web UI: opt-in toggle, `Experimental AI layout` label, deterministic fallback (depends on S-063 and S-061) | K-034 (proposed), K-518 (proposed), K-507, K-103 | Stretch | Playwright `k518_invalid_or_missing_spec_falls_back_to_deterministic_layout` serves an invalid spec and a missing spec through the fake adapter and requires the deterministic layout with the fallback notice; Playwright `k518_ai_layout_toggle_off_by_default_and_labelled` requires the mode off on first visit and the experimental label with provider and model id while on; property `k518_ai_layout_leaves_scores_evidence_and_text_unchanged` requires bit-identical scores, evidence, and finding text with the AI layout on, off, invalid, and absent. All AI-layout tests use the fake adapter; no test reaches the network. |

User-priority personalization extension (ADR section 14, P-15
refined and P-24–P-28; threat model H-26–H-30, M-32–M-36). This is
the **demo's headline innovation**: the token page shows what the
user says matters to them. S-042 and S-043 have landed and S-044
may be in progress; no completed story is renumbered, and these
stories are numbered after S-064. Proposed K-IDs K-035 and K-519
enter `docs/requirements.md` in their first implementation story
below, in the same change. S-065–S-067 (deterministic headline
path) are MVP for the demo; S-068–S-070 (unified AI personalize)
are Stretch and cut first. The AI stories unify with the P-21 AI
layout mode (one toggle, one spec family, one fallback per ADR
P-27) and never ship a second, competing AI toggle beside S-064.

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-065 | Strict `PLUGIN.md` frontmatter: YAML schema, controlled-vocabulary `tags`, `audience`, severity range, renamed plain-English sections, deterministic CI check (depends on S-052) | K-032 (proposed), K-035 (proposed), K-517 (proposed), K-108 | MVP | `k517_plugin_md_missing_or_mismatched_fails_deterministic_check` extended per missing frontmatter field, out-of-vocabulary tag, `topics` alias mismatch, severity `min` above `max`, and renamed/missing required section (red against a pre-refinement doc, then green); `plugin_md_frontmatter_validator_accepts_compliant_plugin` (unit) passes a compliant fixture; CI check `k035_frontmatter_checked_in_ci_without_network` requires the validator in the gate with zero network calls. Existing registered and example `PLUGIN.md` files are migrated to the refined headings in this story. |
| S-066 | User priorities field with local-only storage: versioned `localStorage` key, closed-shape validation, clear removes the key (depends on S-059) | K-035 (proposed), K-507, K-509 | MVP | `k035_invalid_stored_priorities_treated_as_none` seeds malformed, oversize (>500 chars), control-character, and markup-bearing stored values and requires no personalization with no stored string reaching the renderer as markup; Playwright `k035_priorities_persist_across_reload_and_clear_removes_them` saves priorities, reloads to the same value in the field, then clears and requires the standard order with the key removed; `k519_priorities_absent_from_logs_cache_and_responses` (integration) searches logs, cache keys, and REST/MCP responses for a canary priorities string and requires zero hits. |
| S-067 | Deterministic priority baseline: pure keyword/tag matcher over frontmatter, emphasis and ordering under the severity floor (depends on S-065 and S-066) | K-035 (proposed), K-102, K-103, K-507 | MVP | `k035_priorities_match_frontmatter_tags_deterministically` (unit) maps frozen priorities (including "I want to know if the owner can stop me selling" to `honeypot`/`transfer-limits`/`owner-powers` matches) and frozen frontmatter to one ordered id list with matched tags, red against an unranked panel, then green, with the same inputs giving the same output across runs; `k519_priorities_never_sent_without_ai_opt_in` (unit) counts network-fake calls during baseline matching and requires zero; property `k519_personalization_leaves_scores_evidence_and_text_unchanged` with the Playwright test `k519_critical_finding_visible_with_unrelated_priorities` requires every `high`/`critical` section present, expanded, and bit-identical with personalization on, off, and mismatched. |
| S-068 | Unified personalize spec contract: `PersonalizeSpec` types, JSON Schema descriptor, `parsePersonalizeSpec` smart constructor (depends on S-062 and S-067) | K-519 (proposed), K-035 (proposed), K-506 | Stretch | `k519_personalize_spec_rejects_html_ranking_and_floored_collapse` feeds specs carrying markup, code, URL, and style fields, unknown and duplicate plugin ids, rankings naming absent plugins, and a collapsed critical section and requires `invalid-output` with no partial spec applied, red against an accepting parser, then green; `k519_personalize_spec_agrees_with_json_schema_on_fixtures` checks types and descriptor against each other on frozen examples in both directions. No new runtime dependency: plain checks plus JSON Schema per ADR P-28 (no zod, same rationale as P-14/P-22). |
| S-069 | `PluginPersonalizeModelPort`: fake adapter, hosted Muse Spark Open implementation, `not configured` without key (depends on S-068; port-shape decision in ADR open decision 12 — extend `PluginLayoutModelPort` or add this sibling port) | K-519 (proposed), K-513, K-502, K-309 | Stretch | `runPluginPersonalizeModelPortContract` red against the fake, then green against the fake and the hosted adapter over a recorded transport (no network); `k519_personalize_without_key_reports_not_configured_and_sends_nothing` requires the `not-configured` outcome and zero fake-adapter calls with the deterministic baseline standing; `k519_injection_in_priorities_or_docs_stays_quoted_data` feeds hide, rank-first, invent, and restyle instructions in priorities and `PLUGIN.md` excerpts and requires quoted data with no non-spec result field. |
| S-070 | Experimental AI personalize in the web UI: single opt-in toggle replacing the layout-only toggle, `Experimental AI personalize` label, deterministic-baseline fallback (depends on S-069 and S-061) | K-035 (proposed), K-519 (proposed), K-507, K-103 | Stretch | Playwright `k519_invalid_or_missing_personalize_spec_falls_back_to_deterministic_baseline` serves an invalid spec and a missing spec through the fake adapter and requires the deterministic priority order with the fallback notice; Playwright `k519_ai_personalize_toggle_off_by_default_and_labelled` requires the mode off on first visit, the plain-English priorities-send notice before the first call (`k519_ai_personalize_toggle_states_priorities_send_before_first_call`), and the experimental label with provider and model id while on; property `k519_personalization_leaves_scores_evidence_and_text_unchanged` extended across AI on, off, invalid, and absent. All AI-personalize tests use the fake adapter; no test reaches the network. When S-070 ships, the S-064 layout-only toggle is replaced by this single toggle in the same story; when S-070 is cut, S-064 may still ship as designed. |

Reconciliation and investigation sequencing notes. Per ADR section
0.1 the layout-only spec and port (former S-062/S-063 deliverables)
are retired before implementation and folded into S-068/S-069; the
S-064 layout-only toggle is superseded by the single S-070 toggle
and never ships beside it. The deterministic adaptive stories
S-059–S-061 stand unchanged.

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-071 | Registry reconciliation with the reviewed ADR: input projection, discriminated manifests, boundary re-proof, registry entries (closes D-1–D-6 in ADR section 0.3; depends on S-044) | K-028 (proposed), K-029 (proposed), K-514 (proposed), K-515 (proposed), K-106 | MVP | `registry_projects_only_declared_inputs_per_detector` runs each detector on its projection alone and on the full-fact input and requires agreement, with the hard-to-analyze manifest declaring `decompilerCause` (D-1); `manifest_smart_constructor_rejects_detector_network_capability` requires construction failure for a detector manifest carrying `needsNetwork` or `needsSecrets` (D-2); `registry_reparses_evidence_and_checks_finding_identity` feeds a selector-shaped non-evidence string, a wrong `<pluginId>:` prefix, and a mismatched `pluginId` and requires `invalid-output` per case (D-4); `composition_builds_registry_entries_or_typed_startup_error` requires a manifest without an implementation to fail startup as a typed error (no module-load throw, no defaulted detector set; D-5); D-3 (registry `docs` reference plus refined `PLUGIN.md` contract) lands through S-052/S-065 as planned and D-6 (one artifact mapping, interim converters retired) lands through S-047 as planned, both verified by their owning stories. Golden fixtures stay bit-identical apart from the reviewed additive `pluginResults` field. |

### E-09 Investigate with Muse

Design: `docs/adr-investigate-with-muse.md` (P-29–P-38). Proposed
K-IDs K-036 and K-520 enter `docs/requirements.md` in S-072, in the
same change. Scheduling: immediately after registry exposure (S-046
green, with S-071 reconciliation landed or in flight) and before the
S-059 adaptive-UI queue when sequencing forces a choice (ADR section
1). S-072–S-076 are MVP for this epic and ship as one sequence or not
at all; S-077 is Stretch and cut first. If the submission-critical
path competes, it wins and E-09 slips as one sequence (S-072–S-076)
rather than shipping a partial loop (ADR section 10).

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-072 | Investigation types, trace, and deterministic citation checker: frozen `InvestigationState`, `InvestigationReport`, sentence-level `[E:<id>]` check with drop counting (ADR P-31, P-35) | K-036 (proposed), K-520 (proposed), K-102 | MVP | `k520_citation_check_keeps_only_sentences_citing_collected_evidence` requires a sentence citing only collected ids to survive, a sentence citing an uncollected id to drop, and an uncited factual sentence to drop, with `droppedClaims` counting each drop; `k520_zero_surviving_sentences_yields_empty_narrative_with_drop_count` requires an empty narrative (never a repaired substitute) when every sentence drops; `investigation_state_rejects_transition_after_done_or_failed` requires terminal states to have no outgoing transition in the type. |
| S-073 | `InvestigationModelPort`, fake adapter, and hosted Muse Spark Open adapter with `not configured` without a key (ADR P-29, P-30) | K-036 (proposed), K-520 (proposed), K-305, K-309, K-513 | MVP | `runInvestigationModelPortContract` red against the fake, then green against the fake and the hosted adapter over a recorded transport (zero network); `k520_investigation_without_key_reports_not_configured_and_sends_nothing` requires the `not-configured` outcome with zero fake-adapter calls and the deterministic analysis standing; `k513_investigation_provider_mismatch_rejected` requires a wrong provider or model id to give `provider-mismatch` with no decision applied. |
| S-074 | Graph runner, registry-derived tools, hard limits, and deterministic replay (ADR P-31, P-32, P-34, P-36) | K-036 (proposed), K-520 (proposed), K-102, K-307 | MVP | `k520_runner_rejects_disallowed_tool_and_consumes_the_step` feeds an unknown tool id, a tool call after `conclude`, and malformed args and requires `invalid-decision` with the partial trace preserved and the step consumed; `k520_step_token_and_wallclock_limits_end_with_partial_trace` requires step 9, spent token budget, and deadline expiry each to end in the typed limit outcome with limits recorded; `k520_recorded_investigation_replays_bit_identical` replays a recorded trace through the fake adapter and requires the replayed report to equal the recorded report apart from `elapsedMs`; property `k520_investigation_leaves_score_and_evidence_unchanged` requires bit-identical score, probabilities, signals, and evidence with the loop on, off, failed, and absent. |
| S-075 | REST and MCP exposure with the step-events stream (ADR P-37) | K-036 (proposed), K-023, K-025, K-027, K-508 | MVP | `k036_investigate_matches_across_rest_and_mcp_for_same_codehash` requires the same final trace and checked narrative from REST and MCP; `k036_events_stream_emits_one_event_per_step_then_report` requires one event per trace step in order then a final `report` event, with the deterministic analysis response unchanged whether or not an investigation runs; `k024_missing_or_invalid_key_rejected_before_analysis` extended to the investigate and events routes; `k026_investigate_tool_leaves_state_unchanged` requires the MCP tool to be read-only. |
| S-076 | Web UI live graph/timeline for the investigation (ADR P-37) | K-036 (proposed), K-507, K-103 | MVP | Playwright `k036_investigation_graph_renders_trace_steps_as_inert_text` requires one graph node per step (tool, rationale as inert text, evidence ids) updating from the events stream, with the checked narrative below it; Playwright `k036_investigation_shows_not_configured_limit_and_failure_states` requires the `not configured`, limit, and failure states shown as plainly as the assessment states, with script-bearing rationale and narrative inert under the strict CSP; when the events transport is absent the completed report from the POST response renders the same trace (ADR section 8 fallback). |
| S-077 | Recorded-trace library and investigation caching under the cost caps (ADR P-36, section 6) | K-036 (proposed), K-513, K-107 | Stretch | `k036_recorded_trace_library_covers_each_graph_outcome` requires recorded traces for the done, step-limit, token-limit, tool-timeout, and invalid-decision outcomes, each replaying bit-identical apart from `elapsedMs` through the fake adapter; `k036_investigation_cached_per_codehash_prompt_provider_and_model` requires a cache hit to make zero new model calls with the full key (code hash, prompt version, provider, model id) and a miss to make at most one investigation per uncached request under the per-provider daily caps (I-14). |

Cut order inside E-09, if time runs short: S-077 is Stretch and cut
first. S-072–S-076 ship as one sequence or not at all, so no partial
loop (a runner without citation checking, or exposure without the
runner) ever stands.

### E-10 Own EVM decompiler (ERC-20 scoped)

Design: `docs/adr-evm-decompiler.md` (D-01 onward; D-xx is a
separate rule namespace from the plugin P-xx sequence, see ADR
section 1). Proposed K-IDs K-037, K-038, and K-521 enter
`docs/requirements.md` in S-078, in the same change. Scheduling:
after the submission-critical path and after S-046 registry
exposure — the decompiler ships as a detector plugin and its output
is consumed through the existing interfaces, so the registry must
exist first. extdecomp stays the runtime `DecompilerPort` adapter
in the deepening until a story below explicitly promotes the own
pipeline; the eval harness is dev/eval only and never a runtime
dependency (ADR D-09, D-10). S-078–S-082 are MVP for this epic and
ship as one sequence; S-083–S-085 are Stretch and cut first, in that
order. Each slice below is independently pushable: it lands green
on its own named tests without requiring a later slice.

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-078 | Disassembly-to-CFG with stack-value jump-target resolution over the existing `disassemble` sweep (ADR D-02, D-03) | K-037 (proposed), K-102, K-501 | MVP | `d02_cfg_partitions_every_instruction_into_exactly_one_block` requires every swept instruction in exactly one basic block with leaders at entry, jump targets, and fall-throughs; `d03_stack_value_resolution_resolves_constant_and_dispatcher_jumps` requires PUSH-constant and dispatcher `EQ`/`JUMPI` targets resolved with bytecode offsets, and a data-dependent target recorded as one unresolved jump — never guessed, never dropped; property `d03_disassembly_to_cfg_is_deterministic` (fast-check) requires bit-identical CFG output for the same bytecode across runs. |
| S-079 | Stack-to-SSA lifting with semantics preservation on straight-line code (ADR D-04) | K-037 (proposed), K-102 | MVP | Property `d04_lifting_preserves_semantics_on_straight_line_code` (fast-check) runs generated straight-line instruction sequences on the small test EVM interpreter and on the lifted SSA form and requires identical stack, memory, and storage effects; `d04_ssa_names_every_stack_value_exactly_once` requires single assignment per lifted value with an explicit phi only at a join with differing reaching definitions. |
| S-080 | Structuring (if/loops) and ERC-20 pseudo-Solidity emitter with exact offset mapping (ADR D-05, D-06) | K-037 (proposed), K-010 | MVP | `d06_every_evidence_item_maps_to_exact_bytecode_offsets` requires each emitted function, statement, and token-pattern annotation to carry the exact `[startPc, endPc)` bytecode range it was lifted from, with no emitted item lacking a range; `d05_token_patterns_render_readable_pseudo_solidity` requires frozen ERC-20 fixtures (transfer guard, allowance check, mint/burn, pause flag) to emit the named readable shapes as golden output; `d05_unstructured_region_falls_back_to_labelled_goto_form` requires an irreducible region to emit the labelled fallback — never silently dropped, never mis-structured as a loop. |
| S-081 | Decompiler as a detector plugin: registry wiring, Expert/REST/MCP consumption, score-neutral output (ADR D-07, D-08) | K-037 (proposed), K-028 (proposed), K-031 (proposed), K-307 | MVP | `runDetectorPluginContract` green for the decompiler detector (determinism, schema agreement, evidence presence, unchanged inputs); `d07_decompiler_output_consumed_identically_in_rest_mcp_and_expert_ui` requires the same functions, offsets, and unresolved-jump count from REST, MCP, and the Expert view for the same code hash; property `d08_decompiler_findings_leave_score_and_evidence_unchanged` requires bit-identical score, probabilities, and signals with the plugin enabled, disabled, timed out, and absent (weight 0 until the artifact names it, P-05). |
| S-082 | extdecomp comparison harness: local-bytecode-only eval, frozen ERC-20 corpus, metrics table (ADR D-09, D-10) | K-038 (proposed), K-521 (proposed) | MVP | `d09_eval_runs_only_on_local_bytecode_without_network_or_llm_flags` requires the harness to invoke the binary named by `extdecomp_BIN` on local hex/file input only, with `HOME` set to a temp directory, and to fail on any RPC, target-address, or LLM/naming flag in the invocation; `d10_version_check_expects_extdecomp_0_9_1` requires `extdecomp --version` output to be checked against the pinned expected string `0.9.1` and a mismatch to fail the eval — never to install or upgrade anything; `d09_metrics_table_reports_all_four_metrics_per_contract` requires correct-CFG/function-boundary agreement, unresolved-jump count, token-pattern readability outcome, and offset-mapping completeness reported per corpus contract for both decompilers. The harness is dev/eval only: no test in the runtime suite reaches it, and the runtime suite passes with `extdecomp_BIN` unset. |
| S-083 | Optional AI naming plugin: Muse Spark Open suggests names only, opt-in, display-only (ADR D-11) | K-038 (proposed), K-519 (proposed), K-513 | Stretch | `runPluginPersonalizeModelPortContract`-style contract suite for the naming port (fake plus recorded hosted transport, zero network); `d11_naming_without_key_reports_not_configured_and_sends_nothing` requires the `not-configured` outcome with zero provider calls and the deterministic pseudo-Solidity standing; property `d11_suggested_names_never_affect_analysis` requires bit-identical CFG, SSA, emitted structure, score, and evidence with naming on, off, invalid, and absent — suggested names render only as a labelled display overlay. |
| S-084 | Corpus expansion and boundary hardening: pathological and non-ERC-20 inputs (ADR D-03, D-12) | K-037 (proposed), K-501 | Stretch | Fuzz target `d12_pathological_bytecode_yields_typed_outcome_or_labelled_fallback` feeds mutated bytecode and requires every run to end in a structured result, a labelled unstructured fallback, or a typed error — never a hang, a panic, or a guessed jump target, within the per-port limits (A-17); `d12_non_erc20_input_decompiles_without_token_annotations` requires a non-token fixture to emit plain pseudo-Solidity with zero token-pattern annotations and no error. |
| S-085 | Promotion readiness: calibrated detector promotion via the model artifact (ADR D-08) | K-038 (proposed), K-210, K-211 | Stretch | `k210_plugin_weight_read_from_artifact_only` extended to the decompiler plugin: weight 0 with an unnamed artifact, calibrated weight with a naming artifact, across two artifact versions; `k211_wrong_checksum_rejected_before_analysis` stays green. Ships only after S-047's single artifact mapping exists; until then the decompiler output stays display and evidence only. |

Cut order inside E-10, if time runs short: S-085, S-084, and S-083
are Stretch and cut first, in that order. S-078–S-082 ship as one
sequence, so the pipeline never stands half-lifted (CFG without
SSA, or emission without offset mapping).

### E-11 New LP pairs feed on Ethereum mainnet (K-039)

Scope: Ethereum mainnet only (chainId 1); no multichain support is
planned. The feed discovers only new LP pairs and pools that receive
liquidity and emits
`(chainId=1, tokenAddress, pool address or V4 poolId, blockNumber,
txHash, logIndex, dex)`. It never affects score or evidence;
source, latency and liquidity data is operational telemetry only.
Analysis pins `getCode` at the candidate block. Latency stays a soft
operational guide per K-101, not a release gate. Scheduling: E-11 runs
right after the remaining E-09 Investigate work, before plugin audit
leftovers, S-048–S-050, adaptive UI S-059–S-070 and the E-10 remainder.
`chainId` fields stay in code but are constrained to 1 where cheap;
S-091 tracks the remaining multichain cleanup. Quote-token allowlist note: WETH comes from env `BK_WETH_ADDRESS` ('WETH quote not configured' if unset); tests use a synthetic fixture address.

| Story | Title | K-IDs | Priority | Test written first |
|---|---|---|---|---|
| S-086 | Feed constants: factories, quote tokens and topic0 values | K-039 (proposed) | MVP | `k039_topic0_match_viem_selector_and_pinned_constants` computes each topic0 with `toEventSelector` (or a pure keccak) and pins the V2 `PairCreated`, V3 `PoolCreated` and V4 `Initialize` constants; `k039_factories_match_mainnet_addresses_without_live_calls` asserts the seven factory addresses with no live calls; `k039_quote_tokens_identify_new_token_side` checks the new token is the non-quote side for WETH, USDC, USDT, DAI and V4 address zero. |
| S-087 | Etherscan logs source with token bucket and backoff | K-039 (proposed), K-505 | MVP | `k039_etherscan_without_key_reports_not_configured_and_sends_nothing` requires `not configured` with zero sends without `ETHERSCAN_API_KEY`; `k039_etherscan_polls_one_factory_per_call_with_token_bucket` polls one factory address per call over a block range about once a minute against a fake logs transport with recorded fixtures; `k039_etherscan_backs_off_on_rate_limit` requires backoff on rate-limit errors within 3 calls per second and 100k per day. No live calls run in CI. |
| S-088 | Optional JSON-RPC `eth_getLogs` fallback on the same port | K-039 (proposed) | MVP | `k039_rpc_fallback_without_url_reports_not_configured` requires `not configured` without the env URL; `k039_rpc_fallback_returns_same_port_shape` returns the same candidate shape as the Etherscan adapter through a fake transport. No live calls run in CI. |
| S-089 | Liquidity gate with same-transaction fast path and pending queue | K-039 (proposed) | MVP | `k039_liquidity_gate_hands_to_analysis_only_after_first_liquidity` holds a pair without liquidity; `k039_same_tx_pair_plus_liquidity_passes_immediately` passes pair creation with liquidity in the same transaction (the `addLiquidityETH` case) on the same-transaction check; `k039_pending_queue_expires_after_ttl` drops stale queued candidates after the TTL. V2 `Mint` or `Sync`, V3 pool `Mint` and V4 `ModifyLiquidity` with delta above zero filtered on topic1 equal to the pool id gate the handoff. |
| S-090 | Idempotency, reorg handling, quote rules and score neutrality | K-039 (proposed), K-102 | MVP | `k039_candidate_key_dedupes_txhash_logindex` dedupes on `(txHash, logIndex)`; `k039_reorg_marks_orphaned_on_blockhash_change` re-reads the last two to three blocks each poll, stores the block hash per candidate and marks `orphaned` on change; `k039_quote_both_or_neither_logs_and_skips` logs and skips when both or neither sides are quotes; `k039_v4_hooks_stay_context_never_score` passes V4 `hooks` as context only; property `k039_feed_leaves_score_and_evidence_unchanged` requires bit-identical score, probabilities, signals and evidence with the feed on, off or orphaned, and the analysis cache stays deduped per `(chainId, codehash)` with one result per address pointing at it. |
| S-091 | Mainnet-only chainId 1 cleanup | K-001 | MVP | `k001_chainid_constrained_to_mainnet` requires the RPC configuration to accept 1 and turn any other chain id away with a typed error; a repo search for multichain assumptions returns zero hits outside this story. |

E-11 status (28/10, all green): S-086 done — pinned factories, quote tokens and topic0 values with selector recomputation. S-087 done — Etherscan logs adapter with token bucket, daily budget and backoff, not-configured without key. S-088 done — JSON-RPC eth_getLogs fallback on the same port with identical candidate shape. S-089 done — liquidity gate with same-tx fast path and TTL pending queue. S-090 done — candidate-key dedupe, reorg orphaning, quote skips, V4 hooks as context, score-neutral by type plus property. S-091 done — chainId constrained to 1 with typed rejection and feed env wiring (`ETHERSCAN_API_KEY`, `BRANDKLIPPAREN_FEED_RPC_URL`, `BK_WETH_ADDRESS`). CLI `npm run feed:once` performs one poll and exits; design in `docs/lp-pairs-feed.md`, threats H-43–H-45 with M-49–M-51 in `docs/threat-model.md`.

Cut order inside E-08, if time runs short: S-048, S-049, S-050, S-051
are Stretch and cut first, in that order. S-042–S-047 are the MVP of
this epic and ship as one sequence or not at all, so the registry never
stands beside a permanent legacy path (P-12). Inside the audit and
docs extension, S-058 is Stretch and cut first; S-052–S-057 are its
MVP and ship as one sequence, so no plugin is ever exposed without
validated docs and no AI report is ever shown without the
deterministic gate in front of it. Inside the adaptive web UI
extension, S-064, S-063, and S-062 are Stretch and cut first, in that
order; S-059–S-061 ship as one sequence after S-046, so the panel is
never schema-driven without the deterministic layout and the mode
toggle in front of it. Inside the personalization extension,
S-070, S-069, and S-068 are Stretch and cut first, in that order;
S-065–S-067 ship as one sequence after S-052/S-059–S-061, so the
headline demo path is never personalization without validated
frontmatter, local-only storage, and the severity floor in front
of it. If S-070 ships it replaces the S-064 layout-only toggle
with the single `AI personalize (experimental)` toggle in the
same story; if S-070 is cut, S-064 stands as designed.

## Day-by-day plan, 27/10–4/11

Each day ends with a short evening report to Jens: what shipped, test
status, risks, and the plan for tomorrow.

| Date | Focus | Stories |
|---|---|---|
| 27/10 | Repo skeleton, CI gate, domain types with tests | S-001, S-002, S-004 |
| 28/10 | Bytecode fetch and proxy resolution (EIP-1967, UUPS, EIP-1167, EIP-7702) | S-005, S-006, S-007, S-010 |
| 29/10 | extdecomp adapter in sandbox, selector extraction, signals, clone matching | S-011, S-012, S-013, S-014 |
| 30/10 | Dataset, splits, risk model, calibration, frozen artifact, metrics | S-017, S-018, S-019, S-020, S-021 |
| 31/10 | Template explanations, fallback and untrusted-string handling; deterministic core hardened; `AssessmentModelPort` with fake and Meta Model API adapter (high priority) | S-023, S-024, S-003, S-025, S-036 |
| 1/11 | REST API, MCP server, shared service parity, performance and cost frames; hosted open-weights adapter and assessment in UI tab, REST and MCP with cost limit and cache (high priority) | S-026, S-027, S-028, S-031, S-037, S-038 |
| 2/11 | Web UI (start and token pages). **Write the demo video script (3 minutes).** Jens selects the demo default assessment provider ahead of the script. Stretch if green: S-008, S-009, S-015. | S-029 |
| 3/11 | Demo deployment on the public URL; **record the demo video (3 minutes, upload to YouTube)**; **write the submission texts "Describe your use of Meta products" and "Why are Meta's models important to your solution"**; fix only demo-blocking bugs | S-033, S-034, S-039 |
| 4/11 | Final security review against `docs/threat-model.md`, gitleaks over the full history, **make the repo public on 4/11 ahead of submission**, complete the submission package (track Indie Developer, problem statement Build for Your World), submit | S-032, S-035, S-040 |
| Night 4–5/11 | Submission by 5/11 03:00 Swedish time; verify public repo, demo URL and YouTube video are reachable ahead of the deadline | S-035, S-040 |
| After submission | Live final preparation as a stretch item: runbook, rehearsal and fallbacks, ready for the live final in the top 5 per track | S-041 |

Stretch order inside the plan: S-041 live final preparation, S-015,
S-008, S-009, S-016/S-030, S-022. Stretch work starts only when the MVP
stories for that day are green.

## Buffer and cut order

- Buffer is 4/11 daytime before the final review, plus the evening of
  3/11 after recording. No new features after the 3/11 recording.
- Cut first, in this order: S-022 baseline comparison, then
  S-016/S-030 timeline, then S-015 storage values, then S-008 beacon
  and S-009 diamond.
- Always keep: the deterministic core (S-003), proxy resolution for
  EIP-1967/UUPS/EIP-1167/EIP-7702 (S-006, S-007), signals with
  evidence (S-013), calibrated scores (S-020), template explanations
  (S-023), the Muse contract assessment with both providers
  (S-025, S-036, S-037, S-038), the three interfaces (S-026–S-029),
  security review and
  gitleaks (S-032), demo and submission (S-033–S-035, S-039, S-040).
- If calibration data runs short, ship the frozen artifact with the
  model card stating its limits (K-208) instead of adding features.
