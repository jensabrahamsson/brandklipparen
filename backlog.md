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
| E-08 | Plugin architecture (design in `docs/adr-plugin-architecture.md`, P-xx) | K-028–K-031 (proposed), K-514, K-515 (proposed), K-102, K-210, K-305, K-309, K-032–K-033, K-516–K-517 (proposed, audit and PLUGIN.md) |

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

Cut order inside E-08, if time runs short: S-048, S-049, S-050, S-051
are Stretch and cut first, in that order. S-042–S-047 are the MVP of
this epic and ship as one sequence or not at all, so the registry never
stands beside a permanent legacy path (P-12). Inside the audit and
docs extension, S-058 is Stretch and cut first; S-052–S-057 are its
MVP and ship as one sequence, so no plugin is ever exposed without
validated docs and no AI report is ever shown without the
deterministic gate in front of it.

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
