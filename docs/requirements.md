# Requirements document: Brandklipparen

Author: Jens Abrahamsson.
Status: final version for the build 27/10–4/11 2026.
Reading guide: this document, `docs/requirements.md`, owns the
requirements (K-IDs). Architecture rules (A-xx) live in
`docs/architecture.md`, infrastructure rules (I-xx)
in `docs/infrastructure.md`, and threats with countermeasures (H-xx,
M-xx) in `docs/threat-model.md`. Every story in `backlog.md` points to
at least one K-ID here. Background lives in `ide.md`,
`kunskap/bytecode-forskning.md`, `kunskap/relaterat-arbete.md` and
`design/README.md`.

Format per requirement: the heading gives the ID, name and priority.
The project sentence describes the behaviour positively. Each acceptance
criterion names its verification with a named test (English test name in
`monospace`) or a named measurement. Section 12 collects traceability.

## 1. Purpose

Brandklipparen answers the question "how far do you get with bytecode
alone". The product assesses the risk of newly deployed ERC-20 tokens on
Ethereum from the contract bytecode alone: rug pull, honeypot and
bot-pump.

The product delivers calibrated probabilities per risk type plus a
combined score 0–100, with evidence down to function selectors and
PC offsets where the offset is derivable. The plain-English explanations
in the UI are template-based and deterministic by default per K-301 and
describe capability per K-303. The Muse contract assessment per K-305
delivers, on request, a separate, clearly labelled free-text assessment
through the selected assessment provider per K-309. The whole analysis is
deterministic per K-102. The risk model's detection thresholds, weights
and limits are learned and calibrated from data and versioned in the
frozen calibration artifact per K-210 and K-211. This document states
the response-time figures in K-101 and leaves the model's thresholds,
weights and limits to the versioned model artifact per K-210.

## 2. Scope

The product covers:

- Analysis of EVM bytecode for a given token contract, with proxy
  resolution and assessment of the implementation per K-001–K-007.
- Calibrated probabilities with evidence, a can't-tell list per K-012
  and a timeline per K-015.
- Three interfaces to the same application service per K-027: web UI,
  REST API and MCP server, all in MVP per section 4.
- Template-based deterministic explanations, built solely from
  structured evidence from the core per K-301 and K-302, with the Muse
  contract assessment per K-305 and K-309 as a separate free-text
  assessment on request through the selected assessment provider.

The product answers questions that require data outside the contract
through the can't-tell list in K-012. The list states, per question,
which data source is required: liquidity locks, owner shares, wallet
clusters, team and intent belong there. The product's signals build on
bytecode, proxy and storage reads in the analysis path. The chain in MVP
is Ethereum mainnet only (chainId 1) per K-001; no multichain support
is planned. The product delivers assessments as
decision support; trading, alerts and transaction blocking live in the
user's own systems.

## 3. Glossary

- **Capability:** what the code lets someone do, for example "the owner
  can raise the sell fee". The product describes capability in every
  explanation.
- **Intent:** why someone wrote the code or plans an action. The product
  answers capability questions and routes intent questions to K-012.
- **Holds now:** a value or state measured at analysis time, for example
  "the sell fee is 5% today".
- **Can change:** a capability that an authorised actor can activate
  later, for example via an owner function or an upgrade.
- **Code risk:** the probability that the code enables a rug pull,
  honeypot or bot-pump. The product reports code risk as a probability
  and a score.
- **Selector:** the first four bytes of keccak256 of a function
  signature. The contract dispatches on selectors, so extraction happens
  from bytecode.
- **PC offset:** the program-counter position of an instruction in the
  bytecode. The offset points to where evidence lives.
- **Code hash:** keccak256 of the executable bytecode with CBOR metadata
  removed. An equal code hash gives a cache hit per K-013.
- **Skeleton hash:** a hash over the opcode sequence with PUSH operands
  and CBOR metadata masked. The hash captures "same template, new
  parameters" per K-017.
- **Proxy types:** EIP-1967 (logic and admin slot), beacon, EIP-1167
  minimal proxy, UUPS (ERC-1822), diamond (EIP-2535) and EIP-7702
  delegation. The assessment follows the implementation and the response
  shows both proxy and implementation.
- **Calibration:** adjustment of the model's raw scores so that among
  tokens with a stated probability of 0.8, about 80% are positive.
- **ECE (expected calibration error):** the average deviation between
  the stated probability and the observed share of positives, weighted
  over probability bins.
- **Brier score:** the mean of the squared errors between probability
  and outcome. The product reports the Brier score together with ECE
  per K-205.
- **Reliability diagram:** a diagram that plots the observed share of
  positives against the stated probability per bin.
- **AUROC / PR-AUC:** the area under the ROC curve and the
  precision-recall curve respectively. The measures measure ranking and
  complement the calibration measures in K-205.
- **False-alarm rate:** the share of harmless tokens that get flagged.
  Precision at a low false-alarm rate measures usefulness in practical
  operation.
- **Time-based split:** training data is older than test data. The split
  measures how the model holds up against new templates per K-203.
- **Cluster-based split:** clones and near-duplicates of bytecode (same
  code hash or skeleton hash) live in the same split per K-204.
  Training, calibration and test each hold every cluster entirely in
  one part.
- **Baseline:** a simple comparison model, for example logistic
  regression on opcode frequencies, per K-207.
- **Model card:** a versioned description of the model, data, date and
  known limitations per K-208.
- **Fast path:** the first delivery in an analysis: bytecode fetch,
  proxy resolution, selector and pattern extraction, clone matching,
  signals, probabilities and score, plus a template-based explanation
  per K-101. The fast path consists solely of deterministic steps and
  RPC reads per K-102.
- **Deepening:** the second delivery in the same analysis: internal
  decompiler snippets linked to signals, streamed to the interface
  after the fast path per K-101. The Muse contract assessment per
  K-305 is a separate on-request delivery outside the deterministic
  analysis path and outside the deepening.
- **Deterministic analysis:** the same bytecode and the same block
  number for on-chain reads give a bit-identical result with the same
  evidence per K-102.
- **Calibration artifact:** the frozen, versioned artifact with a
  checksum that carries the calibration model, thresholds, weights and
  limits per K-211.
- **Template-based explanation:** deterministic text built from the
  evidence with versioned templates per K-301. The text describes
  capability with the marker holds now or can change per K-303.
- **Muse contract assessment:** the MVP feature per K-305 and K-309.
  A button or tab in the web UI, a REST endpoint and an MCP tool deliver,
  on request, a free-text assessment through `AssessmentModelPort`,
  built solely on the closed evidence list per K-302. The assessment
  appears clearly separate from the deterministic score and evidence,
  carries a visible Muse-generated label with provider and model id,
  and leaves the score and evidence unchanged per K-307.
- **Assessment provider:** the selected provider behind
  `AssessmentModelPort` per K-309: Meta Model API with Muse Spark and the configured model id
  `muse-spark-1.3`. Configuration selects the provider, or `off`.
- **Prompt version:** the versioned identifier of the assessment prompt
  and evidence format. The assessment cache key carries code hash,
  prompt version, provider and model id per K-305 and K-309.
- **Operations configuration:** time, resource, rate and quota limits
  for operations, versioned in `docs/infrastructure.md`. Decompilation
  runs under the internal engine's own deterministic caps per K-008.
  The risk model's thresholds, weights and limits belong to the model
  artifact per K-210.

## 4. MVP vs stretch

MVP holds the build 27/10–4/11 with a solo developer. MVP contains the
fast path and the deepening per K-101, proxy resolution for the most
common types, signals, calibrated probabilities, a web UI with a start
page and a token page, a versioned REST API, an MCP server,
template-based deterministic explanations per K-301, plus demo and
submission. Muse contract assessment per K-305 and K-309 is MVP and
works in the demo: it runs on request through a button or tab in the
web UI, a REST endpoint and an MCP tool, it appears clearly separate
from the deterministic score and evidence with provider and model id
shown, and it leaves the score and evidence unchanged at all times.
The deterministic analysis path carries zero assessment calls until
the user requests an assessment. Both assessment adapters per K-309
are MVP; the demo default provider is an open decision for Jens per
section 13. All three
interfaces are MVP: the MCP server is a thin driving adapter over the
same application service as the web UI and REST API per K-027, so the
extra cost is the adapter and the schemas. Both the time-based split
(K-203) and the cluster-based split (K-204) are MVP, because the
product calls the probabilities calibrated once evaluation holds on
both splits. The discrimination measures in K-206 are MVP for the same
reason; the comparison against the baseline in K-207 is Stretch.
Stretch strengthens coverage and follow-up: beacon and diamond
resolution, timeline, current storage values and baseline comparison.

| Requirement | Priority | Rationale |
|---|---|---|
| K-001 Fetch bytecode via RPC | MVP | The basis of every analysis |
| K-002 EIP-1967 resolution | MVP | Most common proxy type; one slot read |
| K-003 Beacon resolution | Stretch | Less common type; two call steps |
| K-004 EIP-1167 resolution | MVP | Byte pattern gives the target directly |
| K-005 UUPS resolution | MVP | Shares slot with K-002 plus selector check |
| K-006 Diamond resolution | Stretch | Loupe calls against several facets |
| K-007 EIP-7702 resolution | MVP | Prefix check on EOA code |
| K-008 Decompilation with the internal engine | MVP | The deepening's core evidence per K-101 |
| K-009 Selector and pattern extraction | MVP | The fast path's first evidence cards |
| K-010 Signals with evidence | MVP | The product's core value |
| K-011 Probabilities and score | MVP | The demo delivers a number with evidence |
| K-012 Can't-tell list | MVP | Credibility at low cost |
| K-013 Cache per code hash | MVP | Response time and cost per K-101, K-107 |
| K-014 Just-deployed flow | MVP | The demo's main flow |
| K-039 New LP pairs feed on mainnet | MVP | Discovery only; never moves score or evidence |
| K-037 Own ERC-20 EVM decompiler | MVP | Deterministic token-scoped pipeline; the only decompiler in the product |
| K-038 Differential eval and naming overlay | MVP | Local-only harness; opt-in display-only names |
| K-521 Decompiler output safety | MVP | Resolve or record, never guess; labelled fallback |
| K-015 Timeline since deploy | Stretch | Builds on event index and re-evaluation |
| K-016 Current storage values | Stretch | Builds on slot identification first |
| K-017 Clone matching | MVP | Strong signal against template reuse at low cost |
| K-020 Web UI start page | MVP | The demo's entry point |
| K-021 Web UI token page | MVP | The demo's core |
| K-022 Web UI timeline | Stretch | Builds on K-015 |
| K-023 REST API schema and error format | MVP | Bot users need a published schema |
| K-024 REST API key access | MVP | Cost control per caller |
| K-025 MCP server tools | MVP | Thin driving adapter over K-027 gives the whole tool |
| K-026 MCP server read-only | MVP | Same adapter and schema work as K-025 |
| K-027 Shared application service | MVP | One service gives equal responses in three interfaces |
| K-028 Typed plugin manifest and static registry | MVP | One typed manifest per plugin and one validated static registry; M-21 |
| K-030 Assessment plugins behind AssessmentModelPort | MVP | Both assessment adapters registered as assessment plugins with exactly one active; selection by plugin id |
| K-101 Response time: fast path and deepening | MVP | Soft guide, not a gate; the goal is innovation, not latency |
| K-102 Deterministic analysis | MVP | Reproducibility is the product promise |
| K-103 Accessibility WCAG AA | MVP | Built-in accessibility from the first view |
| K-104 Observability | MVP | Debugging during the hackathon requires logs |
| K-105 Test coverage and TDD | MVP | Absolute requirement on the code |
| K-106 Typing | MVP | Absolute requirement on the code |
| K-107 Cost frames | MVP | Frames hold RPC cost per analysis; the analysis path carries zero model cost |
| K-108 English language | MVP | Jury reads public surfaces in English |
| K-201 Dataset | MVP | Fresh data is the basis for calibration |
| K-202 Label policy | MVP | The policy makes the dataset usable |
| K-203 Time-based split | MVP | The split measures resilience against new templates |
| K-204 Cluster-based split | MVP | The calibrated promise requires training and test on separate clusters |
| K-205 Calibration measures | MVP | The "calibrated" product promise requires reported measures |
| K-206 Discrimination measures | MVP | The calibrated promise requires ranking measures on the same splits |
| K-207 Baseline comparison | Stretch | Second training chain strengthens, after the calibration proof |
| K-208 Model card | MVP | Honesty about limits at low cost |
| K-209 Reproducible evaluation | MVP | One command gives the report behind K-205 and K-206 |
| K-210 Thresholds and weights versioned | MVP | Steering principle for the risk model from day one |
| K-211 Frozen calibration artifact | MVP | The same artifact gives the same score everywhere |
| K-301 Template-based deterministic explanation | MVP | The default explanation in every interface |
| K-302 Structured evidence only | MVP | The evidence list steers the explanation's content |
| K-303 Capability and holds-now / can-change | MVP | The product's language in every explanation |
| K-304 Claim links | MVP | Traceability is the core value |
| K-305 Muse contract assessment | MVP | Judging step 1 and the demo require a working on-request assessment, separate from the deterministic score and evidence |
| K-306 Validation and template text on assessment error | MVP | The token page always shows an explanation |
| K-307 One-way explanation chain | MVP | Score and evidence equal with and without the assessment |
| K-308 Contract strings untrusted | MVP | Security from day one |
| K-309 Assessment provider port with the Meta adapter | MVP | A swappable provider qualifies the project at judging step 1 with the provider; the adapter pass the same contract suite |
| K-401 Demo video | MVP | Submission requirement: 3 minutes on YouTube, hackathon work only |
| K-402 Public demo environment | MVP | Assessment uses a clickable demo |
| K-403 Public GitHub repo | MVP | Submission requirement |
| K-404 Built during the hackathon | MVP | Competition rule |
| K-405 Submission on time | MVP | Competition rule |
| K-406 Submission package: track, problem statement and texts | MVP | Submission requirement: Indie Developer, Build for Your World, and both Meta texts |
| K-407 Live final preparation | Stretch | Top 5 per track present live; preparation starts after submission and keeps the presentation ready |
| K-501 Hostile bytecode | MVP | Attack surface exists from the first call; M-01, M-02 |
| K-502 Prompt injection | MVP | Applies to the on-request Muse contract assessment with the provider; the deterministic core carries zero prompt injection surface; M-03–M-06, M-20 |
| K-513 Assessment provider response and key protection | MVP | The provider give validated, size-bounded responses with protected keys; M-11, M-20 |
| K-514 Plugin supply chain: static registration only | MVP | Reviewed source only, no dynamic or remote code loading; M-21 |
| K-503 SSRF | MVP | Address-driven fetch requires an allowlist from the start; M-07 |
| K-504 Rate limiting | MVP | Cost protection from day one; M-08, M-09 |
| K-505 Key handling | MVP | Keys in environment variables from the start; M-11 |
| K-506 Supply chain | MVP | Locked dependencies and licence check from the start; M-12 |
| K-507 XSS | MVP | The UI renders contract data directly; M-13 |
| K-508 MCP tool security | MVP | MCP is an MVP interface per K-025; M-15 |
| K-509 Redacted logging | MVP | Redacted logs from the start; M-16 |
| K-510 API key storage and life cycle | MVP | Hashing and rotation from the start; M-10, M-11 |
| K-511 External responses and cache verified | MVP | Verified responses give verified scores; M-14 |
| K-512 Determinism and artifact integrity protected | MVP | Determinism is the product promise; the artifact steers every score; M-17–M-19 |

## 5. Functional requirements (K-0xx)

### K-001 Fetch bytecode for an address (MVP)

The project fetches runtime bytecode for a given Ethereum address via
its own RPC connection and classifies the address as contract, EOA or
invalid. Scope is Ethereum mainnet only (chainId 1): no multichain
support is planned. The RPC configuration keeps its `chainId` field
for correctness and constrains it to 1; any remaining multichain-capable
code is flagged as a cleanup item in `backlog.md` and never exercised
in tests.

- A valid contract address such as `0x1234…` returns its bytecode.
  Verification: contract test `k001_contract_address_returns_bytecode`
  against a frozen fixture.
- An EOA returns an empty result with the reason "no contract".
  Verification: contract test `k001_eoa_returns_no_contract_reason`.
- The project validates the address format and returns a typed
  validation error before the first RPC call. Verification: unit test
  `k001_invalid_address_fails_before_rpc` with an RPC fake that counts
  calls to zero.
- Each fetch logs the block number, so the response is reproducible per
  K-102. Verification: integration test `k001_fetch_logs_block_number`.

### K-002 EIP-1967 proxy resolution (MVP)

The project reads the implementation slot and the admin slot per
EIP-1967 and fetches the implementation's bytecode for analysis.

- An EIP-1967 proxy returns the proxy and implementation address and
  code hash in the same response. Verification: golden test
  `k002_eip1967_returns_proxy_and_implementation`.
- The response shows the admin address with the type EOA, contract or
  zero address. Verification: unit test
  `k002_admin_classified_as_eoa_contract_or_zero`.
- An empty implementation slot returns the result "no EIP-1967 proxy".
  Verification: unit test `k002_empty_slot_means_no_eip1967_proxy`.
- The response states the upgrade authority: single key, contract or
  locked. Verification: golden test `k002_reports_who_can_upgrade`.

### K-003 Beacon proxy resolution (Stretch)

The project reads the beacon slot, calls the beacon contract's
`implementation()` and analyses the returned implementation.

- A beacon proxy returns the beacon address and implementation address
  with code hashes. Verification: contract test
  `k003_beacon_returns_beacon_and_implementation`.
- A beacon that stays silent returns a marked uncertainty flag in the
  response. Verification: contract test
  `k003_silent_beacon_sets_uncertainty_flag`.
- The response states who can change the beacon. Verification: unit
  test `k003_reports_who_can_change_beacon`.

### K-004 EIP-1167 minimal proxy (MVP)

The project recognises the EIP-1167 byte pattern and reads the embedded
target address from the code.

- A minimal proxy returns the target address and its code hash.
  Verification: golden test `k004_eip1167_reads_embedded_target`.
- The response states that the target is fixed, so the contract logic
  is locked. Verification: unit test `k004_target_marked_as_fixed`.
- Bytecode with a diverging pattern returns the result "no EIP-1167
  proxy". Verification: property test
  `k004_nonmatching_bytecode_means_no_eip1167_proxy`.

### K-005 UUPS resolution (MVP)

The project detects UUPS via the `proxiableUUID` selector and the
implementation slot, and checks the upgrade authority.

- A UUPS proxy returns the implementation address and code hash.
  Verification: golden test `k005_uups_returns_implementation`.
- The response states the upgrade function and the authorised caller.
  Verification: unit test `k005_reports_upgrade_function_and_caller`.
- An implementation with locked upgrade authority is marked as locked
  in the response. Verification: unit test
  `k005_locked_upgrade_marked_as_locked`.

### K-006 Diamond resolution (Stretch)

The project calls the diamond loupe functions, lists facets per
selector and analyses each facet.

- A diamond returns a facet list with address and code hash per
  selector range. Verification: contract test
  `k006_diamond_lists_facets_per_selector`.
- The response shows the Loupe address and the `diamondCut` authority
  with the authorised caller. Verification: unit test
  `k006_reports_diamondcut_authority`.
- A facet that stays silent is marked per facet, and the analysis of
  the remaining facets continues. Verification: contract test
  `k006_silent_facet_marked_and_analysis_continues`.

### K-007 EIP-7702 delegation (MVP)

The project recognises the `0xef0100` prefix on EOA code and follows
the delegation address.

- A delegated EOA returns the delegation address and its code hash.
  Verification: golden test `k007_eip7702_follows_delegation`.
- The response states that a new authorisation can change the
  delegation, that is "can change" per K-303. Verification: unit test
  `k007_delegation_marked_as_changeable`.
- Code with another prefix returns the result "no EIP-7702 delegation".
  Verification: property test
  `k007_other_prefix_means_no_eip7702_delegation`.

### K-008 Decompilation with the internal engine (MVP)

The project decompiles the implementation's bytecode with the internal
in-process engine in the deepening per K-101 and links the result to
the signals' evidence. The fast path delivers probabilities and score
ahead of the deepening.

- Successful decompilation returns readable functions linked to
  selectors. Verification: integration test
  `k008_internal_decompilation_links_snippets_to_evidence` against a
  frozen fixture.
- Input or output past the engine caps returns the hard-to-analyse
  finding as a display record, and unresolved control flow returns the
  signal "hard-to-analyse code" in the deepening; the fast path's
  response stands in both cases. Verification: integration tests
  `k008_internal_limits_yield_typed_finding_without_signal` and
  `k008_unresolved_control_flow_yields_hard_to_analyze_signal` with a
  pathological fixture.
- The engine caps are the deterministic bounds in
  `src/domain/decompileV2.ts` and `src/domain/evmSsa.ts` with the
  port-level input and output limits in
  `src/adapters/decompiler/internalDecompilerAdapter.ts`; no
  decompiler variable travels in the operations configuration.
- The risk model's detection thresholds, weights and limits are the
  learned set, and they are versioned solely per K-210. Verification:
  review `k008_learned_values_only_in_model_artifact`, which searches
  the operations configuration for model values and requires zero hits
  there.

### K-009 Selector and pattern extraction (MVP)

The project extracts all function selectors from the bytecode and
matches them against a local table of risk-relevant selectors and proxy
selectors. The extraction is part of the fast path per K-101.

- Each found selector is paired with a name suggestion and risk
  relevance. Verification: property test
  `k009_every_selector_paired_or_marked_unknown`.
- Unknown selectors are reported with the status unknown. Verification:
  unit test `k009_unknown_selector_reported_as_unknown`.
- The extraction holds its step target in K-101. Verification: timing
  test `k009_selector_extraction_within_step_budget` against frozen
  fixtures.

### K-010 Signals with evidence (MVP)

The project turns each finding into a signal with severity, direction
and evidence: selector, PC offset where the offset is derivable and,
after the deepening, a decompiled snippet.

- Each signal states a raising or lowering direction and the risk type
  it affects. Verification: unit test
  `k010_signal_states_direction_and_risk_type`.
- Each signal links to at least one selector, and the PC offset travels
  with it when the offset is derivable. Verification: unit test
  `k010_signal_requires_selector_and_carries_offset_when_derivable`,
  which builds signals via the smart constructor.
- Signals with a lowering direction appear in the same list as raising
  ones, so the score is traceable in both directions. Verification:
  e2e test `k010_lowering_signals_shown_with_raising_signals`.
- The constructor accepts at least one piece of evidence per signal, so
  each signal that reaches the risk model carries evidence.
  Verification: unit test `k010_signal_without_evidence_fails_construction`.

### K-011 Risk model with probabilities and score (MVP)

The project gives calibrated probabilities for rug pull, honeypot and
bot-pump plus a combined score 0–100 per analysed contract. The
probabilities are delivered in the fast path per K-101.

- The probabilities lie in [0, 1] and the score is an integer 0–100.
  Verification: property test
  `k011_probabilities_in_unit_interval_and_integer_score`.
- The response states the model version and the signals that contributed
  most in each direction. Verification: unit test
  `k011_response_names_model_version_and_top_contributors`.
- Equal code hash and model version give an equal response in every
  interface per K-027. Verification: property test
  `k011_same_codehash_and_model_give_same_response`.
- The model reads thresholds and weights from the versioned model
  artifact per K-210. Verification: unit test
  `k011_weights_loaded_from_versioned_artifact_only`, which runs the
  model with two artifact versions and requires responses that follow
  the artifact.

### K-012 Can't-tell list (MVP)

The project shows openly what bytecode analysis leaves open, the
can't tell questions: liquidity locks, dumping intent, intent behind
the code, external contracts awaiting analysis, plus team and wallet
clusters.

- The list appears on the token page and in the API response, in its
  own field separate from the score. Verification: e2e test
  `k012_cant_tell_list_shown_separate_from_score`.
- The list's content leaves the probabilities and score unchanged.
  Verification: unit test
  `k012_cant_tell_list_leaves_numbers_unchanged`, which compares
  responses with the list enabled and disabled in the test build.
- Each item states the data source required to settle the question.
  Verification: unit test `k012_each_item_names_required_data_source`.

### K-013 Cache per code hash (MVP)

The project caches analysis results per code hash and model version and
reuses them for all addresses with the same code.

- Equal code hash and model version give a cache hit, and the fast path
  responds directly from the cache. Verification: integration test
  `k013_cache_hit_skips_decompilation_and_external_calls` with fakes
  that count external calls to zero.
- A new model version gives new cache entries; older entries stay
  unused. Verification: integration test
  `k013_new_model_version_bypasses_old_entries`.
- A cache hit holds the response-time target for cache in K-101.
  Verification: timing test `k013_cache_hit_within_budget`.

### K-014 Just-deployed flow (MVP)

The project offers a flow that lists newly deployed tokens with a
combined score, partial probabilities and the most important signal in
plain text per row.

- The newest token sits at the top, with deploy time and block number
  per row. Verification: e2e test `k014_newest_token_first_with_block`.
- Each row links to the token page for the full analysis. Verification:
  e2e test `k014_row_links_to_token_page`.
- The filter chips for high risk, low risk and unverified contracts
  only update the list in the same view. Verification: e2e test
  `k014_filters_apply_without_reload_loss`.

### K-015 Timeline of risk since deploy (Stretch)

The project shows how the combined score and the partial probabilities
have changed since deploy, as a step curve with a linked event log.

- Each score change links to an event: new bytecode, changed storage
  or an upgrade. Verification: e2e test
  `k015_each_score_change_links_to_event`.
- The curve is drawn step-shaped at discrete events. Verification:
  e2e test `k015_curve_is_step_shaped`.
- The largest change receives a template-based explanation per K-301.
  Verification: e2e test `k015_largest_change_has_template_explanation`.

### K-016 Current storage values (Stretch)

The project reads current values for identified slots (fee, maxTx,
owner) with `eth_getStorageAt` and shows them as "holds now" per K-303.

- Each value is paired with slot, block number and measurement time.
  Verification: integration test `k016_value_carries_slot_block_and_time`.
- Values with an identified slot appear as measured facts; other slots
  are reported in the can't-tell list per K-012. Verification: unit
  test `k016_unidentified_slot_goes_to_cant_tell_list`.
- The values enter the signals as the current state with measurement
  time, separate from future capabilities per K-303. Verification:
  unit test `k016_values_enter_signals_as_measured_now`.

### K-017 Clone matching against known templates (MVP)

The project compares code hash and skeleton hash against an index of
known trap templates and reports similarity as a signal with evidence.
The matching is part of the fast path per K-101.

- A hit states the similarity share, template group and the number of
  earlier tokens in the group. Verification: golden test
  `k017_clone_hit_reports_similarity_group_and_count`.
- The hit is linked as evidence on the signal per K-010. Verification:
  unit test `k017_clone_hit_linked_as_signal_evidence`.
- The index version is stated in the response, so hits are reproducible
  per K-102. Verification: integration test
  `k017_response_names_index_version`.

### K-039 New LP pairs feed on Ethereum mainnet (MVP)

The feed discovers only new LP pairs and pools that receive liquidity
on Ethereum mainnet (chainId 1) and emits one candidate per pair:
`(chainId=1, tokenAddress, pool address or V4 poolId, blockNumber,
txHash, logIndex, dex)`. The feed never affects score or evidence;
source, latency and liquidity data is operational telemetry only.
Analysis pins `getCode` at the candidate block.

- Event topic0 values are pinned as constants and computed with
  `toEventSelector` (or a pure keccak) in a test: Uniswap V2 and clones
  `PairCreated(address,address,address,uint256)` =
  `0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9`,
  Uniswap V3 and clones
  `PoolCreated(address,address,uint24,int24,address)` =
  `0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118`,
  Uniswap V4 `Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)`
  on the PoolManager =
  `0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438`
  (pool id is bytes32; `hooks` passes as context to analysis, never as
  score input; native ETH is address zero, V4 only). Liquidity events:
  V2 `Mint(address,uint256,uint256)` or `Sync(uint112,uint112)` on the
  pair, V3 pool
  `Mint(address,address,int24,int24,uint128,uint256,uint256)` and V4
  `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)` with
  liquidity delta above zero filtered on topic1 equal to the pool id.
  Verification: unit test
  `k039_topic0_match_viem_selector_and_pinned_constants`.
- Factory and quote-token addresses are pinned in a constants module on
  mainnet with no live calls: Uniswap V2
  `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f`, Uniswap V3
  `0x1F98431c8aD98523631AE4a59f267346ea31F984`, Uniswap V4 PoolManager
  `0x000000000004444c5dc75cB358380D2e3dE08A90`, Sushi V2
  `0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac`, Sushi V3
  `0xbACEB8eC6b9355Dfc0269C18bac9d6E2Bdc29C4F`, Fraxswap V2 (optional, off
  by default)
  `0x43eC799eAdd63848443E2347C49f5f52e8Fe0F6f` (PancakeSwap V2/V3 stay out
  until their full 40-hex addresses are confirmed); quote tokens canonical WETH9 (address supplied by operator config `BK_WETH_ADDRESS`, not stored in the repo), USDC
  `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, USDT
  `0xdAC17F958D2ee523a2206206994597C13D831ec7`, DAI
  `0x6B175474E89094C44Da98b954EedeAC495271d0F` and ETH address zero (V4
  only). The new token is the side that is not a quote; both or neither
  sides a quote logs and skips. Verification: unit tests
  `k039_factories_match_mainnet_addresses_without_live_calls` and
  `k039_quote_tokens_identify_new_token_side`.
- The primary source is the Etherscan API V2 logs endpoint
  (`module=logs&action=getLogs`, chainid 1) with a free key from env
  `ETHERSCAN_API_KEY` (never in the repo; the adapter reports `not
  configured` without it). One factory address per call; a block range
  is polled about once a minute. Free tier 3 calls per second and 100k
  per day is enforced with a token bucket with backoff on rate-limit
  errors. An optional free JSON-RPC `eth_getLogs` adapter (env URL)
  serves as fallback behind the same port. Tests use a fake logs
  adapter with recorded fixtures; no live calls run in CI.
  Verification: unit tests
  `k039_etherscan_without_key_reports_not_configured_and_sends_nothing`,
  `k039_etherscan_polls_one_factory_per_call_with_token_bucket` and
  `k039_etherscan_backs_off_on_rate_limit`, plus
  `k039_rpc_fallback_returns_same_port_shape`.
- A token reaches analysis only after first liquidity: a pair created
  with liquidity in the same transaction (common for `addLiquidityETH`)
  passes on the same-transaction check first, else a pending queue with
  TTL holds the candidate. Idempotency uses the candidate key
  `(txHash, logIndex)`; the analysis cache stays deduped per
  `(chainId, codehash)` with one result per address pointing at it. Each
  poll re-reads the last two to three blocks, stores the block hash per
  candidate and marks `orphaned` on hash change. Verification: unit
  tests `k039_liquidity_gate_hands_to_analysis_only_after_first_liquidity`,
  `k039_same_tx_pair_plus_liquidity_passes_immediately`,
  `k039_pending_queue_expires_after_ttl`,
  `k039_candidate_key_dedupes_txhash_logindex` and
  `k039_reorg_marks_orphaned_on_blockhash_change`.

### K-028 Typed plugin manifest, versioned plugin API and static registry (MVP)

The project carries one typed manifest per plugin plus a versioned
plugin API, and one static registry validated at startup. Proposed in
`docs/adr-plugin-architecture.md` (P-01, P-02, P-07, P-08); this story
enters the ID with the implementation. The registry starts empty beside
the existing path, so analysis output stays unchanged until the S-043
migration.

- Each manifest carries a branded plugin id, a semver version, the
  closed kind `"detector" | "assessment"`, an apiVersion, display name,
  description, declared inputs from the closed catalogue, an output
  schema inside the supported keyword subset, closed capability flags
  and per-plugin limits, validated by a smart constructor.
  Verification: unit tests on the manifest constructors in
  `tests/unit/plugins/manifest.test.ts`.
- The core exports one `PLUGIN_API_VERSION` starting at `1.0.0`; the
  registry accepts a plugin whose apiVersion major equals the core
  major and whose minor is at most the core minor, and turns every
  other plugin away at startup with a typed error naming the plugin id
  and both versions. Verification: unit test
  `registry_rejects_duplicate_ids_and_unsupported_api_versions`.
- Duplicate plugin ids and capability violations give a typed startup
  error naming the plugin id. Registration is static and compile-time
  only: no dynamic loading and no unregistered plugin ever runs.
  Verification: unit tests `k514_registry_has_no_dynamic_loading` and
  `k514_unregistered_plugin_never_runs`.

### K-030 Assessment plugins behind AssessmentModelPort (MVP)

The assessment adapter registers as an assessment plugin with kind
`assessment`, wrapping its existing `AssessmentModelPort`
implementation. Proposed in `docs/adr-plugin-architecture.md` (P-04);
this story enters the ID with the implementation. The port, its error
union, its limits and the exactly-one rule (A-34) stay as they are.

- The Meta Model API adapter registers as
  `dev.brandklipparen.assessment.meta-model-api`. Its manifest
  declares no detector inputs and assessment defaults for capabilities
  and limits. Verification: unit test
  `exactly_one_assessment_plugin_registered_with_fixed_id`.
- Every registered assessment plugin resolves to an implementation that
  passes the shared contract suite over a recorded transport, and the
  fake passes the same suite. Verification: contract test
  `tests/contract/assessmentPlugins.contract.test.ts` with
  `runAssessmentModelPortContract` per registered plugin id.
- Validated configuration selects exactly one assessment plugin by
  plugin id; the binding carries the active plugin id and the
  composition root builds the single active adapter from the registered
  entry. Verification: integration tests
  `k309_config_selects_exactly_one_assessment_adapter` and
  `k309_config_selects_exactly_one_assessment_plugin_by_plugin_id`.
- Scores and evidence stay bit-identical with and without the
  assessment. Verification: `k307_scores_and_evidence_identical_with_and_without_adapter`
  stays green.

### K-032 Required PLUGIN.md per plugin (MVP)

Every plugin ships a required `PLUGIN.md` in English beside its manifest,
referenced through the manifest `docs` field holding the fixed file name
`PLUGIN.md`. Proposed in `docs/adr-plugin-architecture.md` (P-15); this
story enters the ID with the implementation.

- The manifest smart constructor turns a missing or renamed `docs`
  reference away with `invalid-plugin-docs`. Verification: unit test
  `manifest_requires_the_fixed_plugin_md_docs_reference`.
- The deterministic validator checks presence, the required sections in
  order (`What it detects`, `Inputs`, `Output`, `Limits`), the `## Inputs`
  names against the manifest inputs, and the version line against the
  manifest version, with one named failure per cause. Verification: unit
  tests `k517_plugin_md_missing_or_mismatched_fails_deterministic_check`
  and `plugin_md_validator_accepts_compliant_plugin`.

### K-517 Plugin documentation integrity (MVP)

Documented claims are checked against the manifest and the code.
Proposed in `docs/adr-plugin-architecture.md` (P-17); this story enters
the ID with the implementation.

- The deterministic layer fails a doc whose `## Inputs` names an input
  the manifest does not declare, misses a declared input, or carries a
  version line different from the manifest version. Verification: unit
  test `k517_plugin_md_missing_or_mismatched_fails_deterministic_check`.
- Registered and example `PLUGIN.md` files pass the validator.
  Verification: unit test
  `plugin_md_backfilled_docs_pass_for_registered_and_example_plugins`.

### K-035 User-priority personalization: local-only priorities and deterministic matching (MVP)

The token page shows what the user says matters to them. Priorities are
free text stored locally only, matched deterministically to plugin
frontmatter tags with no network, under a severity floor that keeps
critical evidence always visible. Proposed in
`docs/adr-plugin-architecture.md` (P-24–P-26); this story enters the ID
with the implementation. Presentation only: scores, evidence and finding
text never change.

- The `PLUGIN.md` frontmatter carries the closed-vocabulary `tags`,
  `audience` and severity range the matcher reads; the deterministic
  validator checks every field in CI with zero network calls, and the
  registered and example docs are migrated to the refined headings in
  the same change. Verification: unit tests
  `plugin_md_frontmatter_validator_accepts_compliant_plugin` and
  `k035_frontmatter_checked_in_ci_without_network`, plus the extended
  `k517_plugin_md_missing_or_mismatched_fails_deterministic_check`
  branches.
- The priorities field persists under one versioned `localStorage` key
  with closed-shape validation; clearing removes the key, and the text
  never reaches logs, cache keys or REST/MCP responses. Verification:
  unit test `k035_invalid_stored_priorities_treated_as_none`,
  Playwright test
  `k035_priorities_persist_across_reload_and_clear_removes_them` and
  integration test `k519_priorities_absent_from_logs_cache_and_responses`.
- The baseline matcher maps frozen priorities to frontmatter tags with
  one ordered id list and matched tags, with zero network calls and the
  severity floor keeping every `high` finding present and expanded.
  Verification: unit tests
  `k035_priorities_match_frontmatter_tags_deterministically` and
  `k519_priorities_never_sent_without_ai_opt_in`, property
  `k519_personalization_leaves_scores_evidence_and_text_unchanged` and
  Playwright test `k519_critical_finding_visible_with_unrelated_priorities`.

### K-519 Ask Muse about the token (MVP)

The token page offers one Ask field in the Muse console that answers the
visitor's question through `/v1/chat` (option A, owner decision on UI v2
§1.4). The AI ordering (`/v1/personalize`) is retired from the UI: plugin
order stays deterministic and the deterministic local match (K-035) only
highlights matching tiles. Scores, evidence and finding text never
change. Proposed in `docs/adr-plugin-architecture.md` (P-27, P-28); this
story enters the ID with the implementation. The fake adapter stands in
every test: no test reaches the network.

- `POST /v1/chat` runs the frozen analysis with the quoted question
  (500 chars max) and answers the checked-sentence envelope; any error
  kind means the deterministic explanation stands. Verification:
  integration tests on the route (ok, error envelope, not-configured,
  client error on empty or oversize question).
- The web Ask field persists under the priorities key (K-035), sends one
  explicit chat request per Ask press and none on Enter while empty, and
  typing highlights matching tiles through the local matcher with zero
  network. Verification: unit tests for the Ask field state, Playwright
  tests `k519_ask_sends_one_chat_request_per_press`,
  `k519_typing_highlights_tiles_without_network` and
  `k519_empty_ask_sends_nothing`.

## 6. Interfaces (K-0xx, continued)

Each interface is a driving adapter over the same application service
per K-027. The adapters validate input, call the service and format the
response; detection logic lives in the core.

### K-020 Web UI: start page (MVP)

The start page follows `design/skisser/01-startsida.svg`: a search field
for a contract address and the Just deployed list per K-014 below the
search field.

- A pasted valid address such as `0x1234…` leads to the token page, and
  an invalid address returns a validation error in the same view.
  Verification: e2e test
  `k020_pasted_address_opens_token_page_or_shows_error`.
- Each list row shows the combined score, the three partial
  probabilities with a mini bar and the most important signal in plain
  text. Verification: e2e test
  `k020_row_shows_score_probabilities_and_top_signal`.
- The filter chips per K-014 update the list in the same view.
  Verification: e2e test `k020_filter_chips_update_list_in_place`.
- Each score appears with a number and a word per K-103. Verification:
  e2e test `k020_score_shown_as_number_and_word`.

### K-021 Web UI: token page (MVP)

The token page follows `design/skisser/02-tokensida.svg`: combined score
at the top, three gauges, an expandable signal list, a Can't-tell panel
and a sidebar. The page shows the fast path first and streams the
deepening into the same page per K-101.

- The fast path fills score, gauges, signal list and template-based
  explanation as soon as it is ready, with placeholders for the
  deepening's parts. Verification: e2e test
  `k021_fast_path_renders_before_deepening` against a recorded fixture
  with a delayed decompiler.
- The deepening's content (internal decompiler snippets) streams into
  the placeholders in the same view, and score and probabilities stand
  during streaming. The Muse contract assessment per K-305 appears in
  its own tab or panel after the user's request, clearly separate from
  score, probabilities and evidence. Verification: e2e test
  `k021_deepening_streams_into_same_view`.
- The score appears as a ring 0–100 with one sentence on its meaning,
  the analysis time and a calibration line on earlier tokens in the
  same range. Verification: e2e test
  `k021_score_ring_with_meaning_time_and_calibration_line`.
- Each gauge shows probability, number of signals and one reason in
  plain text. Verification: e2e test
  `k021_gauge_shows_probability_count_and_reason`.
- Each expanded signal shows selectors with PC offset, a decompiled
  snippet with a highlighted line after the deepening and a template-based
  explanation per K-301, plus the buttons Copy evidence and
  Open in bytecode. The Muse contract assessment per K-305 and K-309
  has its own tab with provider and model id shown. Verification: e2e test
  `k021_expanded_signal_shows_full_evidence_chain`.
- The Can't-tell panel has a dashed border, is labelled as outside the
  score and leaves the score unchanged. Verification: e2e test
  `k021_cant_tell_panel_marked_outside_score`.
- The sidebar shows contract facts (proxy and implementation, code
  hash, model version), similar bytecode and example calls against the
  REST API and MCP. Verification: e2e test
  `k021_sidebar_shows_facts_similar_and_api_examples`.

### K-022 Web UI: timeline (Stretch)

The timeline view follows `design/skisser/03-tidslinje.svg`: a step
curve over the score, three small curves for the partial probabilities
and a linked event log per K-015.

- Each event marker in the curve matches a row in the log with source,
  change and new score. Verification: e2e test
  `k022_marker_matches_log_row`.
- The largest change shows a template-based explanation per K-301.
  Verification: e2e test `k022_largest_change_shows_explanation`.
- The view is reachable from the token page's mini graph and from the
  Just-deployed row. Verification: e2e test
  `k022_reachable_from_token_page_and_list`.

### K-023 REST API: versioning, schema and error format (MVP)

The project offers a versioned REST API. Responses are validated
against a published JSON schema and errors follow a uniform error
format.

- Each route lives under `/v1`, and breaking changes receive a new
  major version. Verification: schema-validation test
  `k023_all_routes_under_v1`.
- The response contains address, code hash, model version,
  probabilities, score, signals with evidence, can't-tell list,
  analysis time and deepening status per K-101. Verification:
  schema-validation test `k023_response_matches_published_schema`,
  which validates each response in the test suite against the schema
  in the repo.
- The Muse contract assessment per K-305 has its own REST endpoint
  under `/v1`. The response carries the assessment text in its own field
  with provider, model id and prompt version, separate from score and
  evidence. Verification: schema-validation test
  `k305_assessment_endpoint_matches_published_schema`.
- Errors return HTTP status, a machine-readable code, a readable
  message and a request ID. Verification: integration test
  `k023_error_shape_has_status_code_message_request_id`.

### K-024 REST API: key-based access (MVP)

The project protects the REST API with keys per caller and separate
quotas.

- Calls with a valid key in the header reach the analysis; calls with a
  missing or invalid key receive a machine-readable error before the
  first analysis step. Verification: integration test
  `k024_missing_or_invalid_key_rejected_before_analysis`.
- Each key has its own quota and its own consumption metering per
  K-107. Verification: integration test
  `k024_per_key_quota_and_metering`.
- Keys are created, blocked and rotated during operation, and the
  change applies from the next call. Verification: integration test
  `k024_key_lifecycle_applies_without_restart`.

### K-025 MCP server: tools (MVP)

The project offers an MCP server as a thin driving adapter over the
same application service as the web UI and REST API per K-027. The
tools format the service's responses into MCP responses.

- The tool `assess_token` takes a contract address and returns the same
  probabilities, score and evidence as the REST API for the same code
  hash and model version. Verification: integration test
  `k025_assess_token_matches_rest_for_same_codehash`.
- The tool list announces name, description and version per tool.
  Verification: integration test
  `k025_tool_list_announces_name_description_version`.
- The tool for Muse contract assessment per K-305 takes a contract
  address (or code hash) and returns the free-text assessment in its own
  field, labelled with provider and model id, with score and evidence
  unchanged. Verification: integration test
  `k305_assessment_tool_matches_rest_for_same_request`.
- A call to an unknown tool returns a machine-readable error with the
  tool name in the response. Verification: unit test
  `k025_unknown_tool_returns_machine_readable_error`.

### K-026 MCP server: input schema and read-only character (MVP)

The project validates MCP input against a published input schema. The
tools read analysis results and leave the chain and the project's data
in the same state after the call.

- The address parameter is validated before analysis, and an invalid
  address returns a validation error. Verification: unit test
  `k026_invalid_address_fails_schema_before_analysis`.
- The tools are read-only: each call leaves chain state and project
  data unchanged, apart from log and quota metering. Verification:
  unit test `k026_tools_leave_state_unchanged`, which compares state
  before and after each tool call in the test environment.
- Each new tool passes a security review against K-508 before release.
  Verification: review `k026_new_tool_security_review_recorded`, which
  requires a completed review entry per tool in the tool list.

### K-027 Shared application service and response equality (MVP)

The project lets the web UI, REST API and MCP server call the same
application service in the core, with the same input and the same model
version.

- Equal code hash and model version give equal probabilities, score and
  signals in the three interfaces. Verification: property test
  `k027_same_inputs_same_outputs_across_interfaces` on a frozen sample
  of analysed contracts.
- Each interface receives its detection logic from the core via the
  service. Verification: boundary-guard test
  `k027_interfaces_contain_no_detection_logic` in CI per A-06 in
  `docs/architecture.md`.
- The service accepts typed domain values from each adapter, so
  validation happens once at the boundary. Verification: unit test
  `k027_service_accepts_typed_values_from_each_adapter`.

### K-033 Plugin docs exposure (MVP)

The validated `PLUGIN.md` record for one plugin is readable from the one
registry-adjacent value in REST and MCP. Proposed in
`docs/adr-plugin-architecture.md` (P-16); this story enters the ID with
the implementation.

- `GET /v1/plugins/:id/docs` returns the plugin id, version, section
  list and markdown behind the same API-key gate as the plugin list,
  with the uniform not-found error for an unknown id. Verification:
  integration test `k033_plugin_docs_match_registry_in_rest_and_mcp`.
- The `get_plugin_docs` MCP tool returns the byte-identical record from
  the same value, with a machine-readable error for an unknown plugin
  id. Verification: integration test
  `k033_plugin_docs_match_registry_in_rest_and_mcp`.

### K-034 Adaptive web UI: schema-driven rendering and deterministic layout (MVP)

The token page renders every plugin output from its `outputSchema`
through the fixed component library, orders sections deterministically
by risk band, and offers a Simple / Expert mode persisted locally.
Proposed in `docs/adr-plugin-architecture.md` (P-18–P-20); this story
enters the ID with the implementation. Presentation only: scores,
evidence and finding text never change.

- Every `outputSchema` shape in the documented subset (text, number,
  boolean, enum, list, nested object, evidence) renders through its
  library component with no per-plugin UI code; an out-of-subset shape
  falls back to canonical JSON as inert text. Verification: unit test
  `k034_every_output_schema_shape_renders_via_fixed_library` and
  `k034_unknown_schema_shape_falls_back_to_canonical_json_text`.
- Section order follows the frozen analysis: severe evidence first at
  high risk, a calm summary first at low risk, with the same plan for
  the same analysis and no section hidden in any band. Verification:
  unit tests `k034_high_risk_orders_severe_evidence_first`,
  `k034_low_risk_shows_calm_summary_first` and property
  `k034_same_analysis_same_layout_across_runs`.
- Simple is the default and shows summary, score, signals, findings and
  explanations; Expert additionally shows bytecode, selectors with PC
  offsets and raw plugin payloads as inert text. The preference persists
  in `localStorage` under one versioned key and never reaches the
  server. Verification: unit test
  `k034_invalid_stored_mode_falls_back_to_simple` and Playwright tests
  `k034_mode_toggle_persists_across_reload` and
  `k034_expert_mode_reveals_bytecode_selectors_raw_data`.

### K-036 Investigate with Muse: opt-in runtime agent loop (MVP)

The deterministic analysis computes first and freezes; only then, and
only on an explicit opt-in request, the Muse Spark model
(`muse-spark-1.3`) through the Meta Model API decides which
deterministic registry-derived tools to run next, step by step, and
drafts a narrative that cites the evidence it collected. Proposed in
`docs/adr-investigate-with-muse.md` (P-29–P-38); this story enters the
ID with the implementation. The loop never changes score,
probabilities, signals, findings or evidence.

- The investigation runs as an explicit typed state machine in the
  application layer; the model returns one closed decision value
  (`run-tool` or `conclude`) through `InvestigationModelPort`, and the
  runner validates it against the current node, the allowlist and the
  remaining budgets before any transition. A decision that does not fit
  ends in typed `invalid-decision` with the partial trace preserved,
  and every decision consumes one step. Verification: unit tests
  `k520_runner_rejects_disallowed_tool_and_consumes_the_step`,
  `k520_step_token_and_wallclock_limits_end_with_partial_trace` and
  `investigation_state_rejects_transition_after_done_or_failed`.
- Tools are read-only and derived from the registry: one
  `detector.<pluginId>` per registered detector over frozen facts plus
  the frozen-fact readers `evidence.list`, `analysis.summary` and
  `docs.plugin`. Hard limits (max steps, max tokens, wall-clock
  timeout, per-tool deadline) end the run with the partial trace
  preserved. Verification: unit test
  `k520_step_token_and_wallclock_limits_end_with_partial_trace`.
- The narrative passes a deterministic sentence-level `[E:<id>]`
  citation check: uncited or falsely cited sentences drop and count in
  `droppedClaims`, never trusted. Verification: unit tests
  `k520_citation_check_keeps_only_sentences_citing_collected_evidence`
  and `k520_zero_surviving_sentences_yields_empty_narrative_with_drop_count`.
- Without a Meta Model API key the investigation answers the typed outcome
  `investigation-not-configured` with zero provider calls and the
  deterministic analysis standing. Verification: integration test
  `k520_investigation_without_key_reports_not_configured_and_sends_nothing`
  and `k520_investigation_service_without_key_reports_not_configured`.
- REST (`POST /v1/investigate` plus the `GET
  /v1/investigate/events` step stream) and the `investigate_token` MCP
  tool return the same final trace and checked narrative for the same
  code hash; the web UI renders the live graph with one node per step
  and the checked narrative below it. Verification: integration tests
  `k036_investigate_matches_across_rest_and_mcp_for_same_codehash`,
  `k036_events_stream_emits_one_event_per_step_then_report`,
  `k026_investigate_tool_leaves_state_unchanged` and Playwright
  `k036_investigation_graph_renders_trace_steps_as_inert_text`,
  `k036_investigation_shows_not_configured_limit_and_failure_states`.
- A recorded-trace library covers each graph outcome (`done`,
  `step-limit`, `token-limit`, `tool-timeout`, `invalid-decision`) and
  replays bit-identical apart from `elapsedMs`. Investigation reports
  cache per code hash, prompt version, provider and model id: a cache
  hit makes zero new model calls, and an over-cap key ends with the
  typed `budget-exhausted` outcome with the deterministic analysis
  standing. Verification: integration tests
  `k036_recorded_trace_library_covers_each_graph_outcome`,
  `k036_investigation_cached_per_codehash_prompt_provider_and_model`
  and `k036_investigation_capped_key_makes_zero_calls`.

## 7. Non-functional requirements (K-1xx)

### K-101 Response time: fast path and deepening (MVP)

The product goal is innovation (agent loop over deterministic bytecode
analysis, plugin architecture, own decompiler), not low latency. The
targets below are soft operational guides and non-goals for release: a
miss never blocks release, and the timing tests remain as measurements.
The project delivers each analysis in two steps. The fast path
(bytecode fetch, proxy resolution, selector and pattern extraction,
clone matching, signals, probabilities and score, plus a template-based
explanation per K-301) appears first. The fast path consists solely of
deterministic steps and RPC reads per K-102 and carries zero assessment
calls. The deepening (internal snippets linked to signals) streams in
afterwards in the same response and the same view. The Muse contract
assessment per K-305 is a separate on-request delivery with its own
response. Time is measured
from receipt of a validated address. The targets hold at p95.

- Fast path, uncached address: p95 at most 5 seconds to displayed
  probabilities, score and signals. The target gives the demo promise
  "risk profile in a few seconds" in `ide.md`. Verification: timing
  test `k101_fast_path_p95_within_5s` against frozen fixtures, plus
  the measurement `k101_live_fast_path_p95` over logged analyses in
  the demo environment.
- Fast path, cache hit: p95 at most 2 seconds to the same content.
  Verification: timing test `k101_cached_fast_path_p95_within_2s`.
- Deepening: p95 at most 30 seconds from the fast path's delivery to
  internal snippets in place. On timeout or error per K-008 the
  template-based text per K-301 stands. Verification: timing test
  `k101_deepening_p95_within_30s_or_template` with a delayed fake for
  the decompiler, plus the measurement `k101_live_deepening_p95`
  in the demo environment.
- Muse contract assessment: the on-request assessment per K-305
  responds within the assessment timeout in the operations
  configuration per K-309; on timeout or validation error the template
  text per K-301 stands and the assessment field states the fallback.
  Verification: timing test `k305_assessment_within_timeout_or_template`
  with delayed fakes for the provider per K-309.
- Step targets within the fast path: selector extraction p95 at most
  1 second from received bytecode, and proxy resolution p95 at most
  3 seconds per address. Verification: timing tests
  `k101_selector_step_p95_within_1s` and
  `k101_proxy_step_p95_within_3s` against frozen fixtures.
- The fast path's response carries the deepening status (in progress,
  ready, or template text stands), so each interface shows the same
  state. Verification: integration test
  `k101_fast_response_carries_deepening_status` for REST and MCP, and
  the e2e test in K-021 for the web UI.
- The deepening leaves the fast path's probabilities, score, signals
  and evidence unchanged per K-307. Verification: unit test
  `k101_deepening_leaves_fast_path_numbers_unchanged`.
- The timing tests in CI run against recorded fixtures per A-24 in
  `docs/architecture.md`, so RPC variation stays outside the test
  measures; the live measurements above cover the total against
  Ethereum mainnet. Verification: review
  `k101_timing_tests_use_recorded_fixtures`.

### K-102 Deterministic analysis (MVP)

The project runs the whole analysis deterministically. The same
bytecode and the same block number for on-chain reads give a
bit-identical result with the same evidence: the same probabilities,
score, signals, evidence and template-based explanation text. The core
(detection, scoring, calibration and evidence) is purely deterministic
and consists solely of deterministic steps plus RPC reads. The analysis
path carries RPC reads as its network calls. The Muse contract
assessment per K-305 and K-309 runs solely after an explicit user
request, outside the deterministic analysis path, after the result is
computed and frozen, and leaves result and evidence unchanged per K-307.
The deterministic core carries zero prompt injection surface: the core
receives zero model output and builds zero prompts.

- Equal bytecode, block number, code hash, model version, calibration
  artifact per K-211 and template version give bit-identical serialised
  output. Verification: golden tests
  `k102_golden_fixtures_bit_identical` on frozen bytecode fixtures with
  fixed expected serialised output per fixture.
- Two runs of the same analysis give bit-identical serialised output,
  across processes and across machines alike. Verification:
  integration test `k102_two_runs_across_processes_bit_identical`,
  which runs the same frozen fixtures in two separate processes and
  compares the serialised output byte for byte, plus review
  `k102_cross_machine_replay_bit_identical`, which runs the same
  fixtures on a second machine and compares the output byte for byte.
- The analysis path carries RPC reads as its network calls.
  Verification: integration test
  `k102_analysis_path_makes_no_model_calls`, which runs the analysis
  with a network fake that counts each outgoing call and requires the
  calls to go solely to the RPC port and `AssessmentModelPort` to
  receive zero calls until an explicit assessment request.
- The response contains block number, code hash, model version, the
  calibration artifact's version and checksum, index version and
  template version. Verification: schema-validation test
  `k102_response_carries_reproduction_fields`.
- A reproduction test reruns a frozen sample of analyses and compares
  the responses exactly. Verification: integration test
  `k102_replay_reproduces_recorded_responses`.
- Equal address, block number, code hash and model version give
  bit-equal probabilities, score and signals. Verification: property
  test `k102_same_inputs_bit_identical_outputs`.

### K-103 Accessibility (MVP)

The project meets WCAG 2.2 AA in the web UI and carries information
with number, word and shape in combination.

- Risk badges show number and word together, for example `84 High`.
  Verification: e2e test `k103_risk_badge_shows_number_and_word`.
- Contrast, focus order and keyboard navigation pass automated AA
  checks and a manual review per release. Verification: review
  `k103_wcag_aa_checklist_per_release` with automated checks in CI and
  a signed manual entry.
- Tabular figures serve scores and percentages, so values stand still
  on update. Verification: e2e test
  `k103_tabular_figures_keep_values_aligned`.

### K-104 Observability (MVP)

The project logs in structured form per analysis per I-10 in
`docs/infrastructure.md` and measures health per step.

- Each analysis logs request ID, address, code hash, model version,
  step times for fast path and deepening, plus outcome. Verification:
  unit test `k104_analysis_log_has_required_fields`.
- Health checks show status for RPC, cache, the internal decompiler
  and the selected assessment provider per K-305 and K-309, with
  provider and model id. Verification: integration test
  `k104_health_reports_each_dependency_status`.
- Log fields follow the field allowlist in K-509. Verification: unit
  test `k509_log_fields_follow_allowlist`.

### K-105 Test coverage and TDD (MVP)

The project is developed test-first: each behaviour receives a failing
test ahead of the implementation, and the core holds measured coverage.

- Core line coverage is at least 90%, measured in CI at each change.
  Verification: CI measurement `k105_core_line_coverage_at_least_90`.
- Each K-requirement has at least one named test or named measurement
  per section 12. Verification: review
  `k105_traceability_matrix_complete`, which counts requirements with
  zero verification entries to zero.
- The coverage report is versioned per release. Verification: review
  `k105_coverage_report_versioned_per_release`.

### K-106 Typing (MVP)

The project uses strong typing across the codebase, and type checking
in CI reports zero type errors on the main branch.

- The functional core is fully typed and holds I/O types outside the
  domain modules via the ports. Verification: boundary-guard test
  `k106_core_has_no_io_types` per A-06.
- Type checking runs in CI and blocks merging on type errors.
  Verification: CI check `k106_typecheck_blocks_on_error`, which feeds
  a deliberate type error and requires a red gate.
- Domain types express invalid states as untypable where the type model
  carries it, for example signals with evidence per A-13.
  Verification: unit test
  `k106_invalid_states_fail_construction_or_compilation`.

### K-107 Cost frames (MVP)

The project measures cost per analysis in number of RPC calls and holds
consumption within the versioned frames in `docs/infrastructure.md`
(I-14). The deterministic analysis path carries zero assessment cost:
the analysis carries zero assessment calls per K-102. Assessment cost
arises solely after an explicit Muse contract assessment request per
K-305, for the selected provider per K-309, and that cost is measured
separately per request, per provider and per model id.

- Each analysis sums the number of RPC calls with cost per key. Each
  assessment request additionally sums the number of assessment calls
  and the cost per provider and model id separately. Verification:
  integration test `k107_analysis_sums_rpc_and_assessment_calls`.
- Ahead of an explicit assessment request, each analysis consumes zero
  assessment calls and zero assessment cost. Verification: integration
  test `k107_no_request_zero_assessment_calls_and_cost`, which runs the
  analysis ahead of a request and requires zero calls to
  `AssessmentModelPort` for the provider.
- The per-key, per-feature daily caps are versioned in
  `docs/infrastructure.md`. Verification: integration test
  `k305_daily_cost_cap_per_key_stops_assessment_calls` and integration test
  `k036_investigation_capped_key_makes_zero_calls`.
- A cache hit consumes zero RPC calls and zero assessment calls.
  Verification: integration test
  `k013_cache_hit_skips_decompilation_and_external_calls`.

### K-108 English language (MVP)

The project presents the UI, API responses, error messages, MCP tool
descriptions, code, comments, commit messages and all public documents
in English.

- Each public surface uses English as its language. Verification:
  review `k108_public_surfaces_in_english`, which samples the UI, API
  responses, error messages, MCP tool descriptions, code, comments,
  commit messages and public documents and requires English throughout.
- A CI check or review step verifies the English language across the
  public surfaces before submission. Verification: CI check or review
  `k108_english_language_verified_before_submission`, which runs or is
  signed ahead of the submission per K-405.

## 8. Calibration and evaluation (K-2xx)

### K-201 Dataset of fresh public on-chain data (MVP)

The project builds the dataset from fresh public on-chain data that the
project itself fetches during the hackathon, with a versioned data
version per extraction.

- Each data point contains address, bytecode, deploy block and label
  source. Verification: review test
  `k201_each_datapoint_has_address_bytecode_block_source`.
- Data version, extraction date and block range are logged and travel
  with the model card per K-208. Verification: review
  `k201_dataversion_logged_and_on_model_card`.
- Licence and terms of use for each source are checked ahead of use and
  the entry is saved with the data version. Verification: review
  `k201_source_licenses_checked_before_use`.

### K-202 Label sources and label policy (MVP)

The project documents each label's source and the policy that settles
doubtful cases, per risk type.

- The policy defines rug pull, honeypot and bot-pump plus the negative
  class per risk type. Verification: review
  `k202_policy_defines_each_risk_and_negative_class`.
- Known noise sources, for example legitimate anti-bot protections with
  a trap-like shape, are handled with a documented rule in the policy.
  Verification: review `k202_known_noise_sources_have_documented_rule`.
- Label quality is measured with a spot check, and the result is
  versioned with the data version. Verification: measurement
  `k202_label_quality_spot_check_versioned`.

### K-203 Time-based split (MVP)

The project trains on older tokens and tests on newer ones, so the
evaluation measures resilience against new templates.

- The test split lies strictly later in time than the training split.
  Verification: evaluation test
  `k203_test_split_strictly_after_training_split`.
- The calibrator trains on its own part, separate from training and
  test data. Verification: evaluation test
  `k203_calibrator_uses_dedicated_split`.
- The split boundaries (block number and date) are versioned with the
  report per K-209. Verification: review
  `k203_split_boundaries_versioned_with_report`.

### K-204 Cluster-based split (MVP)

The project holds clones and near-duplicates of bytecode in the same
split throughout the evaluation. The split is MVP because the
calibrated promise holds once training, calibration and test stand on
separate clusters.

- Clusters build on code hash and skeleton-hash similarity across the
  dataset. Verification: evaluation test
  `k204_clusters_built_from_codehash_and_skeletonhash`.
- Each cluster lies entirely in one of training, calibration or test.
  Verification: evaluation test `k204_no_cluster_spans_splits`, which
  marks the report as failed on a shared cluster.
- Clustering method and similarity version are versioned with the
  report per K-209. Verification: review
  `k204_clustering_method_versioned_with_report`.

### K-205 Calibration measures per class (MVP)

The project reports ECE, Brier score and a reliability diagram per risk
type (rug pull, honeypot, bot-pump) in the evaluation report.

- ECE is computed per class on test data from the time-based split
  (K-203) and the cluster-based split (K-204), reported separately.
  Verification: evaluation test `k205_ece_per_class_on_both_splits`.
- The Brier score is reported together with ECE in the same table.
  Verification: evaluation test `k205_brier_reported_alongside_ece`.
- Reliability diagrams are published as images in the report per risk
  type. Verification: review
  `k205_reliability_diagram_in_report_per_class`.

### K-206 Discrimination measures per class (MVP)

The project reports AUROC, PR-AUC and precision at a low false-alarm
rate per risk type. The measures are MVP and are computed on the same
test data as K-205.

- AUROC and PR-AUC are computed per class on test data from K-203 and
  K-204, reported separately. Verification: evaluation test
  `k206_auroc_prauc_per_class_on_both_splits`.
- Precision is measured at the low false-alarm rate that the versioned
  model artifact states per K-210. Verification: evaluation test
  `k206_precision_at_versioned_low_false_alarm_level`.
- The results are compared against the previous model version in the
  report. Verification: review
  `k206_results_compared_to_previous_model_version`.

### K-207 Comparison against a simple baseline (Stretch)

The project compares the risk model against a simple baseline trained
on the same splits.

- The baseline is documented and simple, for example logistic
  regression on opcode frequencies. Verification: review
  `k207_baseline_documented_and_simple`.
- The comparison uses the same measures as K-205 and K-206 on the same
  splits. Verification: evaluation test
  `k207_comparison_uses_same_metrics_and_splits`.
- The project releases a new major version of the model when it beats
  the baseline on calibration per K-205. Verification: evaluation test
  `k207_release_gate_beats_baseline_calibration`.

### K-208 Model card with date, data version and limitations (MVP)

The project publishes a model card per model version with date, data
version, measures and known limitations.

- The card states training period, data version, splits (K-203, K-204)
  and the measures from K-205 and K-206. Verification: review test
  `k208_model_card_has_period_data_splits_metrics`.
- The card lists known limitations, for example coverage against the
  taxonomy in `kunskap/bytecode-forskning.md`. Verification: review
  `k208_model_card_lists_known_limitations`.
- The card is linked from the token page's calibration line and from
  the API response. Verification: e2e test
  `k208_model_card_linked_from_ui_and_api`.

### K-209 Reproducible evaluation and versioned report (MVP)

The project runs the whole evaluation as a reproducible command and
versions the report.

- One command recreates splits, trains, calibrates, measures and writes
  the report. Verification: evaluation test
  `k209_single_command_reproduces_evaluation`.
- The report contains date, data version, model version, seed and the
  measures from K-205 and K-206. Verification: review test
  `k209_report_has_date_data_model_seed_metrics`.
- Equal seed and data version give an equal report on rerun.
  Verification: evaluation test
  `k209_same_seed_and_data_give_same_report`.

### K-210 Learned thresholds, weights and limits (MVP)

The project learns and calibrates the risk model's detection
thresholds, weights and limits from data and versions them in the model
artifact. The scope is the risk model: decompilation runs under the
internal engine's deterministic caps per K-008, and rate and quota
limits belong to operations configuration in K-504.

- Each value in the artifact has version, training data and measurement
  method traceable in the report per K-209. Verification: review
  `k210_each_value_traces_to_data_and_method`.
- New values are activated after an approved evaluation per K-205 and
  K-206. Verification: evaluation test
  `k210_activation_requires_passing_evaluation`.
- The code reads the values from the artifact at runtime. Verification:
  CI check `k210_model_values_loaded_from_artifact`, which searches
  for hardcoded model values in the code and requires zero hits.
- The model values live in the artifact and are reported in the report
  per K-209. This document's concrete figures cover response times
  (K-101), coverage (K-105) and times (K-405). Verification: review
  `k210_documents_carry_no_model_threshold_values`.

### K-211 Frozen calibration artifact (MVP)

The project trains the calibration model offline with locked seeds and
freezes it as a versioned calibration artifact with a checksum. The
artifact carries the calibration model, detection thresholds, weights
and limits per K-210. The core loads solely artifacts with a correct
checksum. The same input and the same artifact version give exactly
the same output per K-102.

- Training runs offline with locked seeds, and seeds, data version and
  artifact version are logged with the artifact. Verification:
  evaluation test `k211_training_uses_locked_seeds`, which runs the
  training with the locked seeds and requires the logged seeds to match
  the versioned seed configuration.
- Training reproduces the artifact bit-identically from the same data
  version and the same seeds. Verification: evaluation test
  `k211_retraining_reproduces_artifact_bit_identical`, which trains
  twice from the same data version and seeds and compares the artifacts
  byte for byte including checksum.
- The artifact is versioned with a checksum, and each response states
  artifact version and checksum per K-102. Verification: integration
  test `k211_response_names_artifact_version_and_checksum`.
- The core loads solely artifacts with a correct checksum and returns a
  typed error on a wrong checksum, so analysis starts once a verified
  artifact is loaded. Verification: unit test
  `k211_wrong_checksum_rejected_before_analysis`, which feeds an
  artifact with a changed byte and requires a typed error ahead of the
  first analysis.

## 9. Explanations (K-3xx)

Explanations are template-based and deterministic by default per
K-301. Muse contract assessment per K-305 and K-309 is an MVP feature
that delivers a separate free-text assessment solely on request through
the selected assessment provider and leaves score and evidence
unchanged at all times. The project passes judging step 1 (pass/fail,
reasonable use of the Meta Model API models) through
K-305 and K-309 with the provider selected.

### Use of Muse

The project uses Muse as the build tool through Muse Code:
Muse Wonder for planning and requirements, and Muse Spark for code.
Muse builds the product during the hackathon; the runtime analysis is
deterministic per K-102 and carries zero LLM or model API calls.
Alongside it stands the runtime Muse contract assessment per K-305
and K-309, which delivers a free-text assessment on request through
`AssessmentModelPort`. The assessment leaves score and evidence
unchanged per K-307.

- The README describes the use of Muse as the build tool through
  Muse Code (Muse Wonder for planning and requirements; Muse Spark
  for code) and the deterministic analysis per K-102. Verification: review
  `ai_tools_readme_describes_build_use`, which checks that the README
  names the build tool, the deterministic analysis and the Muse
  contract assessment per K-305 and K-309.
- The demo shows the deterministic analysis with template-based
  explanations per K-401 as the main flow and the Muse contract
  assessment per K-305 as a working, separately labelled MVP feature on
  request. The demo also shows how Muse built the project.
  Verification: the review in K-401.

### K-301 Template-based deterministic explanation (MVP)

The project builds the plain-English explanations by default with
versioned templates from the structured evidence per K-302. The text
is deterministic: the same evidence and the same template version give
bit-identical text per K-102. Each explanation describes capability per
K-303, states whether something holds now or can change and links each
claim to evidence per K-304. The template-based explanation is
delivered in the fast path per K-101 and appears in web UI, REST API
and MCP with the same content.

- The same evidence and template version give bit-identical explanation
  text in every interface. Verification: golden tests
  `k301_template_text_bit_identical_from_evidence` on frozen evidence
  fixtures, plus property test
  `k301_same_evidence_same_text_across_interfaces`.
- Each explanation describes capability and carries the marker holds
  now or can change per capability per K-303. Verification: unit test
  `k301_each_explanation_describes_capability`.
- Each claim in the explanation links to at least one signal with
  evidence per K-304. Verification: property test
  `k301_every_claim_links_to_evidence`.
- The template version travels with the response in web UI, REST API
  and MCP, so the text is reproducible per K-102. Verification:
  schema-validation test `k301_response_carries_template_version`.
- The explanation builds solely from the evidence, so the same evidence
  gives the same text at each run. Verification: unit test
  `k301_explanation_built_deterministically_from_evidence`.

### K-302 Explanation builds on structured evidence (MVP)

The project builds each explanation solely on structured evidence from
the core: signals with selectors, PC offset where the offset is
derivable, decompiled snippets and current-state values per K-016
where they exist. The requirement covers the template text per K-301
and the Muse contract assessment per K-305.

- The template build and the prompt build accept a closed evidence list
  with typed entries as their sole input source. Verification: unit
  test `k302_prompt_contains_closed_typed_evidence_list`.
- Raw bytecode stays in the analysis path; the template and prompt
  build accept the evidence entries as their input. Verification: unit
  test `k302_prompt_builder_accepts_evidence_only`.
- Each claim in the response carries a signal link per K-304, and
  claims with a missing link are removed in validation ahead of
  display. Verification: unit test
  `k302_claim_without_evidence_link_removed_before_display`.

### K-303 Capability and holds-now or can-change (MVP)

The project gives each explanation capability language with the marker
"holds now" or "can change" per capability. The requirement covers the
template text per K-301 and the Muse contract assessment text per
K-305 to the same extent.

- The explanation uses active form and everyday words in plain English.
  Verification: review test `k303_explanation_uses_active_plain_english`.
- Each capability is marked with "holds now" (value and time travel
  with it) or "can change" (authorised changer travels with it).
  Verification: unit test `k303_each_capability_marked_now_or_changeable`.
- The output describes capability throughout the text. Verification:
  unit test `k303_output_screened_for_intent_phrasing`, which searches
  the output against a versioned list of intent phrasings and requires
  zero hits.

### K-304 Each claim links to a signal (MVP)

The project links each claim in the explanation to at least one signal
with a selector per K-010.

- The link appears in the UI and leads to the signal's evidence.
  Verification: e2e test `k304_claim_link_opens_signal_evidence`.
- Validation happens in the core ahead of display, and claims with an
  invalid signal link are removed there. Verification: unit test
  `k304_claim_with_invalid_link_removed_in_core`.
- Each displayed explanation has links on all claims. Verification:
  property test `k304_every_displayed_claim_has_valid_link`.

### K-305 Muse contract assessment (MVP)

The project offers "Muse contract assessment" as an MVP feature that
works in the demo: a button or tab in the web UI, a REST endpoint and
an MCP tool over the same application service. The feature delivers,
on request, a free-text assessment of the contract through the selected
assessment provider per K-309, called server-side per I-13 in
`docs/infrastructure.md`. The assessment builds solely on the closed
evidence list per K-302. The feature runs solely on request: ahead of
the request the deterministic analysis carries zero assessment calls.
The assessment appears clearly separate from the deterministic score,
probabilities and evidence, carries a visible Muse-generated label
with provider and model id, and leaves score, probabilities, signals
and evidence unchanged per K-307. The template-based explanations per
K-301 appear at all times. Cost limit, timeout, input size limit,
output size limit, schema validation and cache apply to the provider
per K-309: the cache key carries code hash, prompt version, provider
and model id.

- Ahead of the user's request, the feature carries zero assessment
  calls, and each interface shows the template text per K-301.
  Verification: integration test
  `k305_no_assessment_call_until_user_requests_assessment`, which opens the
  token page and requires zero calls to `AssessmentModelPort` ahead of
  the click or call, for each provider selection per K-309.
- The assessment works in the demo with the selected provider per
  K-309: one request through the button or tab, the REST endpoint and
  the MCP tool each return a free-text assessment. Verification: e2e
  test `k305_assessment_works_in_demo_ui_rest_and_mcp` against the
  demo configuration with a recorded provider fixture, plus the
  contract suite per K-309 for live provider selection.
- Muse is the product's only AI model in the assessment, and each
  assessment logs and shows provider and model id. Verification:
  integration test `k305_assessment_logs_provider_and_model_id`
  against a recorded fixture for each adapter per K-309.
- Assessment text is cached per code hash, prompt version, provider
  and model id per K-013 and K-309, so the same key gives the same
  cached text with zero new assessment calls. Verification: integration
  test `k305_refined_text_cached_per_codehash_and_template_version`,
  extended to require the full cache key per K-309.
- The assessment appears in its own field and with a visible label as
  Muse-generated in web UI, REST API and MCP, with provider and model
  id, clearly separate from the deterministic score, probabilities,
  evidence and template text. Verification: e2e test and
  schema-validation test `k305_refined_text_marked_in_ui_rest_and_mcp`.
- Cost stays within the per-key daily cap per K-107 and
  I-14 in `docs/infrastructure.md` for the provider: at most one
  assessment call per uncached request and
  template text standing when the cap is reached. Timeout and input
  and output size limits per K-309 apply to the provider. Contract
  strings pass as untrusted data per K-308 into the prompt.
  Verification: integration test
  `k305_daily_cost_cap_per_key_stops_assessment_calls` for each provider
  and unit test `k308_contract_strings_quoted_with_length_cap`.
- The client receives the assessment text and the provider key stays
  on the server. Verification: integration test
  `k305_client_response_has_no_model_key`, which searches each client
  response for key patterns for the provider and requires zero hits.
- The provider response is validated against a versioned schema ahead
  of display, with size limits per K-309 and K-513. The schema states
  claims, signal links, holds-now / can-change markers and language.
  Verification: unit test
  `k305_schema_covers_claims_links_markers_language` for each adapter.
- Output that passes the schema appears as the Muse contract
  assessment; output with a schema breach or oversize returns the
  template text per K-306. Verification: integration test
  `k305_invalid_output_routes_to_template` for each adapter and the
  fake.
- The schema and prompt are versioned, and prompt version, provider
  and model id travel with the response. Verification: integration test
  `k305_response_carries_explanation_schema_version` for each adapter.

### K-309 Assessment provider port with the Meta adapter (MVP)

The project delivers the Muse contract assessment through a swappable
provider behind `AssessmentModelPort` (A-33 and A-34 in
`docs/architecture.md`), with the MVP adapter selected by
configuration: Meta Model API with Muse Spark and the configured model id
`muse-spark-1.3`, or `off`. The adapter is MVP. The demo default provider is an open
decision for Jens per section 13; the selected provider works in the
demo per K-305 in either selection. Cost limit, timeout, input size
limit, output size limit, schema validation and cache per code hash,
prompt version, provider and model id apply to the adapter. Each
response carries provider and model id as its label.

- Configuration selects exactly one adapter at startup, and the health
  check per K-104 shows the selected provider and model id.
  Verification: integration test
  `k309_config_selects_exactly_one_assessment_adapter`, which starts
  the service with each selection and requires the selected adapter in
  the health response.
- The Meta Model API adapter delivers the assessment with Muse Spark.
  Verification: contract test in the shared suite
  `runAssessmentModelPortContract` against the Meta adapter over a
  recorded transport per A-34.
- The Meta Model API adapter delivers the assessment with Muse
  Spark, model id `muse-spark-1.3`, served through
  the Meta Model API per I-13 and I-18 in `docs/infrastructure.md`. Verification:
  contract test in the shared suite `runAssessmentModelPortContract`
  against the Meta Model API adapter over a recorded transport per A-34.
- Contract tests run the same suite against the adapter and a fake,
  with equal outcomes for success, timeout, rate limit, invalid output,
  oversize output and unavailable provider. Verification: contract suite
  `runAssessmentModelPortContract` green against the fake and the Meta
  adapter per A-34.
- Each adapter enforces the cost limit, timeout, input size limit and
  output size limit, validates the response against the versioned
  schema and uses the cache per code hash, prompt version, provider
  and model id. Verification: contract tests in
  `runAssessmentModelPortContract` for limits, validation and cache key
  per adapter, plus integration test
  `k309_both_adapters_enforce_limits_validation_and_cache`.
- Each response is labelled with provider and model id, and the label
  reaches web UI, REST API and MCP. Verification: integration test
  `k309_response_labelled_with_provider_and_model_id`.

### K-306 Validation and template text on assessment error (MVP)

The project shows the template-based explanation per K-301 by default
and keeps it when the selected assessment provider per K-305 and K-309
returns an error, times out, or gives output that breaches the schema
or the size limits, so the token page always carries an explanation.

- The template text builds deterministically from the same structured
  evidence as K-302. Verification: unit test
  `k306_template_built_deterministically_from_evidence`.
- The template text is labelled as template-based in the UI, and the
  Muse contract assessment is labelled per K-305 with provider and
  model id. Verification: e2e test
  `k306_template_marked_as_template_based`.
- The template text covers each signal type that the risk model gives.
  Verification: property test `k306_template_covers_every_signal_type`.

### K-307 One-way explanation chain (MVP)

The project holds the explanation chain one-way: evidence goes in,
text comes out, and score and evidence are computed in the fast path
ahead of each assessment request. The Muse contract assessment per
K-305 delivers a separate free-text field and changes zero deterministic
fields.

- Probabilities, score, signals and evidence are computed ahead of and
  independently of each assessment call. Verification: unit test
  `k307_numbers_computed_before_assessment_call`.
- Score and evidence are identical with and without the Muse contract
  assessment: the response ahead of an assessment request and the
  response with an assessment have bit-identical probabilities, score,
  signals and evidence; the assessment field and its provider and model
  label form the sole difference, for each provider per K-309.
  Verification: unit test
  `k307_scores_and_evidence_identical_with_and_without_adapter`, which
  runs the same frozen analysis with and without an assessment request
  for each adapter and compares all fields apart from the assessment
  field and label byte for byte.
- The response with the Muse contract assessment and the response with
  template text only have equal probabilities, score, signals and evidence per above.
  Verification: unit test
  `k307_response_identical_except_explanation_field`.
- The risk model accepts signals and model artifact as input per A-19
  in `docs/architecture.md`. Verification: boundary-guard test
  `k307_risk_model_inputs_exclude_assessment_output`.

### K-308 Contract strings as untrusted data (MVP)

The project treats strings from the contract (name, symbol, revert
texts, function names) as untrusted data in the explanation chain.

- The strings are enclosed as quoted data with a length cap in the
  template build and in the assessment prompt for the provider per
  K-305 and K-309. Verification: unit test
  `k308_contract_strings_quoted_with_length_cap`.
- The strings appear as quotes in the explanation. Verification: unit
  test `k308_contract_strings_shown_as_quotes`.
- Hostile strings leave the explanation's structure unchanged.
  Verification: unit test
  `k308_hostile_strings_leave_explanation_structure_intact`, which
  feeds injection strings in name, symbol and revert texts.

## 10. Demo and submission (K-4xx)

### K-401 Demo video 3 minutes on YouTube (MVP)

The project delivers a demo video of 3 minutes, linked from YouTube,
that shows the product live against Ethereum mainnet. The video shows
only work built during the hackathon per K-404.

- The video shows a real, newly deployed token: the address is pasted
  live in the demo, and the fast path's risk profile with score and
  partial probabilities appears within the target in K-101. The token's
  deploy time and block number appear on screen. Verification: review
  `k401_video_shows_live_newly_deployed_token` with timestamps in the
  checklist for pasting, deploy time and displayed risk profile.
- The video shows the deterministic analysis: the template-based
  explanation per K-301 appears with evidence links in the fast path
  per K-101. The video shows the Muse contract assessment per K-305
  and K-309 as a working MVP moment: one click on the button or tab
  gives a separate, clearly Muse-labelled free-text assessment with
  provider and model id shown, while score, probabilities and evidence
  stand unchanged. The video also shows how Muse built the project
  through Muse Code (Muse Wonder for planning and requirements;
  Muse Spark for code) per section 9.
  Verification: review `k401_video_shows_deterministic_analysis`, which
  requires a visible template-based explanation with evidence links, a
  visible Muse contract assessment with provider and model id per
  K-305 and K-309 and the Muse section with timestamps in the checklist.
- The video shows at least one proxy case where the assessment follows
  the implementation: proxy address and implementation address appear
  at the same time, and score and signals cover the implementation's
  code. Verification: review
  `k401_video_shows_proxy_following_implementation`.
- The video shows where the evidence points in the bytecode: an
  expanded signal shows selector and PC offset, and the decompiled
  snippet shows the highlighted line per K-021. Verification: review
  `k401_video_shows_selector_offset_and_highlighted_snippet`.
- The video holds the can't-tell panel per K-012. Verification: review
  `k401_video_shows_cant_tell_panel`.
- The video length measures 3 minutes and the submitted link resolves
  on YouTube. Verification: measurement
  `k401_video_length_3_minutes` on the YouTube video, plus review
  `k401_video_linked_from_youtube` with the YouTube link in the
  submission per K-406.
- The video shows only work built during the hackathon per K-404.
  Verification: review `k401_video_shows_only_hackathon_work`, which
  checks each shown feature against the hackathon build per K-404.

### K-402 Public demo environment (MVP)

The project operates a publicly reachable demo environment on Modal per
I-11 in `docs/infrastructure.md` during the assessment period.

- The environment responds on start page, token page, REST API and MCP
  per K-020, K-021, K-023 and K-025. Verification: health check
  `k402_demo_serves_ui_rest_and_mcp`.
- The environment runs the same model version as the submission and
  states it visibly in the UI and in the API response. Verification:
  integration test `k402_demo_shows_submission_model_version`.
- The health check per K-104 is publicly reachable and shows status for
  RPC, cache, the internal decompiler and the selected assessment
  provider per K-309 with provider and model id. Verification:
  integration test `k402_public_health_check_reports_dependencies`.
- The Muse contract assessment per K-305 works in the demo through
  the button or tab, the REST endpoint and the MCP tool with the
  selected provider. Verification: e2e test
  `k305_assessment_works_in_demo_ui_rest_and_mcp`.

### K-403 Public GitHub repo (MVP)

The project submits a public GitHub repo with README, licence and run
instructions per I-15 in `docs/infrastructure.md`. The repo is public
at submission per K-405 and K-406.

- The README describes the product, the architecture and local running
  of the demo. Verification: review
  `k403_readme_covers_product_architecture_run`.
- The licence gives the jury the right to assess and reuse the project.
  Verification: review `k403_license_allows_jury_use`.
- The run instructions are verified from a clean clone on a second
  machine ahead of submission. Verification: review
  `k403_clean_clone_instructions_verified_on_second_machine`.

### K-404 Built during the hackathon (MVP)

The project builds submitted code, data formats and names during the
hackathon 27/10–4/11 2026. The design sketches in `design/` are the
preparatory work from 25/10 per `docs/decisions/log.md`.

- The repo history shows each submitted file's creation within the
  period. Verification: review
  `k404_history_within_hackathon_window` over the repo log.
- Test data is fetched fresh from public on-chain sources during the
  hackathon and frozen with address, block number and code hash per
  A-24. Verification: review
  `k404_fixtures_fetched_fresh_with_provenance`.
- The repo becomes public at submission per K-403. Verification:
  review test `i15_publication_checklist` in `docs/infrastructure.md`.

### K-405 Submission on time (MVP)

The project is submitted by 5/11 2026 03:00 Swedish time at the latest.

- Public GitHub repo per K-403, demo environment per K-402 and the
  3-minute demo video on YouTube per K-401 are ready and reachable ahead
  of the deadline, with the submission package per K-406 complete.
  Verification: review
  `k405_submission_reachable_before_deadline` with a timestamped check
  entry.
- The final check goes through each MVP requirement in section 4 and
  requires a named test or named measurement per requirement per
  section 12. Verification: review
  `k105_traceability_matrix_complete`.

### K-406 Submission package: track, problem statement and texts (MVP)

The project submits with track Indie Developer and problem statement
Build for Your World. The submission carries the texts "Describe your
use of Meta products" and "Why are Meta's models important to your
solution", the public GitHub repo per K-403, the demo per K-402 and
the 3-minute demo video linked from YouTube per K-401.

- The submission selects track Indie Developer. Verification: review
  `k406_submission_track_indie_developer` on the submitted entry.
- The submission selects problem statement Build for Your World.
  Verification: review `k406_submission_problem_build_for_your_world`
  on the submitted entry.
- The text "Describe your use of Meta products" describes the Muse
  contract assessment per K-305 and K-309 with the provider, the
  deterministic core per K-102 and Muse as the build tool through
  Muse Code. Verification: review
  `k406_describe_use_of_meta_products_written`, signed ahead of
  submission.
- The text "Why are Meta's models important to your solution" describes
  the free-text contract assessment per K-305, the provider choice per
  K-309 and the separation from the deterministic score and evidence
  per K-307. Verification: review
  `k406_why_meta_models_important_written`, signed ahead of submission.
- The submission links the public GitHub repo, the demo and the
  3-minute YouTube video, and each link resolves. Verification: review
  `k406_submission_links_resolve` ahead of the deadline per K-405.

### K-407 Live final preparation (Stretch)

The project prepares for the live final: the top 5 per track present
live. Preparation covers a rehearsed live walkthrough of the demo per
K-402, the Muse contract assessment per K-305 with the selected
provider per K-309, and answers on impact, Meta AI tooling, demo and
technical depth per section 10.1.

- A live-final runbook with timings, roles, fallback steps and the
  demo script exists in the repo with relative paths. Verification:
  review `k407_live_final_runbook_rehearsed`, with a signed rehearsal
  entry.
- The rehearsal runs the demo, the assessment request and the
  deterministic replay per K-102 end to end within the runbook timing.
  Verification: review `k407_live_final_rehearsal_completed`.
- Fallback material (recorded 3-minute video per K-401, screenshots and
  cached assessments per K-305) is reachable during the live final.
  Verification: review `k407_live_final_fallbacks_reachable`.

### 10.1 Judging criteria mapped to requirements and demo moments

Judging step 1 is pass/fail: the project reasonably uses the Meta
Model API models. K-305 and K-309 pass step 1 with
the provider selected, and the demo shows the assessment working
per K-401 and K-402. The scored criteria map as follows.

| Criterion | Weight | Requirements | Demo moments |
|---|---|---|---|
| Impact | 30 % | K-010, K-011, K-012, K-014, K-020, K-021, K-402 | A newly deployed token receives a risk profile in seconds; the can't-tell panel shows the limits honestly |
| Use of Meta AI Tooling | 25 % | K-305, K-309, K-307, K-406 | One click gives the Muse contract assessment with provider and model id, separate from the deterministic score; the submission texts per K-406 describe the use |
| Demo | 25 % | K-401, K-402, K-403, K-404, K-406, K-407 | The 3-minute YouTube video shows a live token, a proxy case, evidence in bytecode and the assessment; the public demo and repo stay reachable |
| Technical Depth | 20 % | K-001–K-009, K-017, K-102, K-201–K-211, K-501–K-513 | Bytecode-only signals with selector and PC offset, calibrated probabilities, deterministic replay and the provider contract suite per K-309 |

Each criterion has at least one requirement and one demo moment, and
the live final per K-407 rehearses all four criteria.

## 11. Security requirements (K-5xx)

The requirements here are overarching. Threats (H-xx) and
countermeasures (M-xx) are owned by `docs/threat-model.md`. Each
requirement below states the M-xx that fulfils it, and each M-xx in
the threat model points back to its K-5xx requirement. Section 12
collects the whole linkage per requirement. The test method per M-xx
lives in the threat model; the criteria below name the governing test
per requirement.

### K-501 Hostile bytecode (MVP)

The project handles bytecode as hostile input in each step, with
deterministic caps, input and output size limits. Fulfilled by M-01
and M-02 against H-01 in `docs/threat-model.md`.

- Decompilation runs in-process under the engine's deterministic caps
  with port-level input and output limits per K-008. Verification:
  integration test `k501_pathological_input_stays_bounded_in_process`.
- Obfuscated or incomplete code returns the signal "hard-to-analyse
  code" per K-008 as the analysis outcome. Verification: fuzz test
  `k501_mutated_bytecode_yields_signal_or_typed_error`, which feeds
  mutated bytecode through each analysis step and requires a signal or
  a typed error per run.
- Parallel analyses continue during a pathological run. Verification:
  integration test `k501_pathological_input_isolates_to_its_analysis`.

### K-502 Prompt injection via contract data (MVP)

The project holds contract data and instructions separate in the
explanation chain. The deterministic core has no prompt injection
surface: the core builds zero prompts, receives zero model output and
makes zero LLM or model API calls per K-102. Prompt injection applies
to the on-request Muse contract assessment per K-305 through either
provider per K-309, where the assessment's structure is steered by the
evidence list per K-302. Fulfilled by M-03, M-04, M-05, M-06 and M-20
against H-02 and H-14 in `docs/threat-model.md`.

- Ahead of an assessment request, the analysis carries zero assessment
  calls, and the deterministic core's prompt injection surface stays
  absent. Verification: integration tests
  `k102_analysis_path_makes_no_model_calls` and
  `k305_no_assessment_call_until_user_requests_assessment`.
- The evidence list to Muse is strictly typed, with instruction and
  data in separate fields, for the provider. Verification: unit test
  `k302_prompt_contains_closed_typed_evidence_list` against both
  adapters and the fake per K-309.
- Injection strings in names, symbols, metadata and revert texts give at most one
  quote in the output and leave the structure unchanged, for the
  provider. Verification: unit test
  `k502_injection_strings_yield_at_most_one_quote` against the
  adapter and the fake per K-309.
- Score and evidence are computed ahead of the Muse call and are
  identical with and without the adapter per K-307. Verification: unit
  test `k307_scores_and_evidence_identical_with_and_without_adapter`.

### K-503 SSRF on address-driven fetch (MVP)

The project fetches solely from allowlisted hosts, and network targets
come from configuration. Fulfilled by M-07 against H-03 in
`docs/threat-model.md`.

- RPC targets and both assessment provider targets per K-309 are
  configured in the environment and validated at start per I-08 and
  I-13. Verification: integration test
  `k503_targets_come_from_validated_config` for each provider selection.
- User input becomes address values in the calls; targets come from
  configuration. Verification: unit test
  `k503_user_input_never_becomes_target_url`.
- Crafted addresses and URLs give calls solely to allowlisted hosts.
  Verification: unit test `k503_crafted_inputs_stay_within_allowlist`.

### K-504 API abuse and rate limiting (MVP)

The project limits call rate and quota per key and protects expensive
analysis paths with per-key, per-feature daily caps. Fulfilled by M-08 and M-09 against H-04
in `docs/threat-model.md`.

- The limits are versioned in `docs/infrastructure.md` (I-12, I-14),
  and excess returns a machine-readable error with retry time.
  Verification: integration test
  `k504_over_limit_returns_retryable_machine_error`.
- Expensive steps (decompilation and Muse contract assessment calls
  per K-305 for the provider per K-309) require a valid key with
  remaining quota and an unspent per-key daily cap per I-14.
  Verification: integration test
  `k504_expensive_steps_require_key_with_quota` for each provider.
- The limits hold under overload, and cached responses continue under
  the cost cap. Verification: load test
  `k504_limits_hold_under_overload_and_cache_serves`.

### K-505 Key handling (MVP)

The project stores keys and secrets in the platform secret store and
reads them via environment variables at start. Fulfilled by M-11
against H-05 in `docs/threat-model.md`; API key storage is detailed in
K-510.

- RPC keys, API keys and both assessment provider keys per K-309 are
  read from the environment at start per I-08, I-09 and I-13.
  Verification: start test
  `k505_keys_read_from_environment_at_start` for each provider key.
- A missing mandatory variable returns a start error that names the
  variable, with values outside the error text. Verification: start
  test `k505_missing_variable_named_without_values`.
- The repo and history are scanned for key patterns at each change per
  I-02. Verification: CI check `k505_gitleaks_clean_on_repo_and_history`.

### K-506 Supply chain (MVP)

The project builds on locked dependencies, pinned tools and checked
licences. Fulfilled by M-12 against H-06 in `docs/threat-model.md`.

- Dependencies install reproducibly from the lockfile per I-04.
  Verification: CI check `k506_clean_clone_installs_from_lockfile`.
- Licences are checked against the allowlist ahead of each release.
  Verification: CI check `k506_license_allowlist_blocks_release`.
- Known vulnerabilities in dependencies are scanned in CI and block
  release on a hit; Actions are pinned on SHA per I-03. Verification:
  CI check `k506_pinning_and_vulnerability_scan_block_release`.

### K-507 XSS in the web UI (MVP)

The project renders contract data and explanation text as text in the
UI, with a content security policy that allows solely the project's own
scripts. Fulfilled by M-13 against H-07 in `docs/threat-model.md`.

- Addresses, selectors, strings and explanation output render
  text-escaped in every view. Verification: e2e test
  `k507_script_bearing_data_renders_as_inert_text`.
- The content security policy is delivered with each response from the
  demo. Verification: integration test
  `k507_csp_header_present_on_responses`.

### K-508 MCP tool security (MVP)

The project exposes read-only MCP tools with published input schemas,
reviewed per tool ahead of release. Fulfilled by M-15 against H-08 in
`docs/threat-model.md`.

- Each tool validates input against its schema ahead of analysis per
  K-026. Verification: unit test
  `k026_invalid_address_fails_schema_before_analysis`.
- The tools leave state unchanged per K-026. Verification: unit test
  `k026_tools_leave_state_unchanged`.
- The tool list is closed and versioned; calls to unknown tools return
  a machine-readable error per K-025. Verification: unit test
  `k025_unknown_tool_returns_machine_readable_error`.
- Each new tool passes the review in K-026 ahead of release.
  Verification: review `k026_new_tool_security_review_recorded`.

### K-509 Redacted logging (MVP)

The project logs in structured form with request ID and redacts keys,
headers and model keys in every log line. Fulfilled by M-16 against
H-10 in `docs/threat-model.md`.

- Log fields follow a field allowlist, tested in test. Verification:
  unit test `k509_log_fields_follow_allowlist`.
- Key-like strings in input are redacted in log output. Verification:
  unit test `k509_key_like_strings_redacted_in_output`.
- The demo's log output is reviewed ahead of submission and shows
  solely allowlisted fields. Verification: review
  `k509_demo_log_output_reviewed_before_submission`.

### K-510 API key storage and life cycle (MVP)

The project stores API keys as a salted hash, receives them in a header
and handles creation, rotation and revocation during operation.
Fulfilled by M-10 and M-11 against H-05 in `docs/threat-model.md`.

- The key travels in the header; calls with the key in URL or body
  receive a machine-readable error ahead of analysis. Verification:
  unit test `k510_key_in_url_or_body_rejected`.
- Comparison against the hashed key happens in constant time.
  Verification: property test `k510_key_comparison_is_constant_time`.
- Rotation and revocation apply from the next call, and a blocked key
  is replaced with a new one per I-09. Verification: integration test
  `k510_rotation_and_revocation_without_restart`.

### K-511 External responses and cache verified (MVP)

The project validates RPC responses at the boundary, binds them to
block number and keys cache entries on code hash and model version.
Fulfilled by M-14 against H-09 in `docs/threat-model.md`.

- RPC responses are validated against a schema at the boundary, and
  diverging responses return a marked uncertainty flag in the analysis.
  Verification: integration test `k511_manipulated_rpc_response_flagged`.
- Cache entries are verified on read against code hash and model
  version, and the write path goes solely via the application service.
  Verification: integration test `k511_cache_entry_verified_on_read`.
- Cached responses continue when an RPC provider is down. Verification:
  integration test `k511_cached_responses_served_during_provider_outage`.

### K-512 Determinism and artifact integrity protected (MVP)

The project protects deterministic analysis per K-102 as a security
property: the calibration artifact is verified with a checksum on load,
training data carries provenance with leakage-free splits and the core
runs with locked seeds, pinned dependencies and canonical
serialisation. Fulfilled by M-17, M-18 and M-19 against H-11, H-12 and
H-13 in `docs/threat-model.md`.

- The artifact loads solely with a correct checksum per K-211, and an
  exchanged artifact file returns a typed start error ahead of the
  first analysis. Verification: integration test
  `k512_tampered_artifact_rejected_before_analysis`.
- Each data point in the training data carries address, bytecode,
  deploy block and label source per K-201, and the report ahead of each
  artifact activation reports data version, label sources and split
  boundaries. Verification: review
  `k512_training_data_provenance_checked`.
- The same input gives bit-identical output across runs and processes,
  and retraining from the same data version and the same locked seeds
  gives a byte-identical artifact including checksum. Verification:
  integration test `k102_two_runs_across_processes_bit_identical` and
  evaluation test `k211_retraining_reproduces_artifact_bit_identical`.

### K-513 Assessment provider response and key protection (MVP)

The project protects the Muse contract assessment for the provider
per K-309: provider responses are schema-validated and size-bounded,
provider and model identity are verified against the selected
configuration, cost abuse is capped per key, and the provider
keys stay server-side in the secret store. Fulfilled by M-11 and M-20
against H-05 and H-14 in `docs/threat-model.md`, with cost caps in
M-09 against H-04.

- A tampered, malformed or oversize provider response from either
  provider returns the template text per K-306 and leaves score and
  evidence unchanged per K-307. Verification: integration test
  `k513_tampered_or_oversize_provider_response_rejected` against both
  adapters and the fake.
- Each response carries the configured provider and model id; a
  response with a different provider or model id is rejected ahead of
  display. Verification: contract test in
  `runAssessmentModelPortContract` per adapter.
- Both provider keys are read from the secret store as environment
  variables, travel solely as server-side authentication headers to
  the selected provider, and appear with zero hits in client responses
  and logs. Verification: integration test
  `k513_both_provider_keys_absent_from_client_and_logs`.
- Cost abuse against the provider is bounded by the per-key daily
  caps, timeout and size limits per K-309 and I-14. Verification: integration test
  `k305_daily_cost_cap_per_key_stops_assessment_calls`.

### K-514 Plugin supply chain: static registration only (MVP)

The project admits plugin code solely as reviewed source in this repo,
registered statically at build time. Proposed in
`docs/adr-plugin-architecture.md` (P-07) and
`docs/threat-model.md` (H-15, M-21); this story enters the ID with the
implementation. Fulfilled by M-21 against H-15 in
`docs/threat-model.md`.

- The registry is a frozen array assembled from static values in
  `src/plugins/registry.ts` and handed to the composition root. No
  dynamic loading of a computed module path, no directory scan of a
  plugins folder, no plugin path from environment or configuration and
  no code fetched over the network exists in the registry path.
  Verification: CI check `k514_registry_has_no_dynamic_loading`,
  which searches the registry and composition modules and requires
  zero hits.
- A plugin absent from the registry array is absent from output and
  never invoked. Verification: unit test
  `k514_unregistered_plugin_never_runs`, which requires that an
  unregistered plugin id resolves to no plugin and no findings.

### K-516 Plugin audit: deterministic gate plus advisory AI review (MVP)

Every plugin passes a deterministic static audit before any advisory
AI review; acceptance requires the deterministic pass plus a recorded
human review. Proposed in `docs/adr-plugin-architecture.md` (P-13,
P-14) and `docs/threat-model.md` (H-17–H-20, M-23–M-26); this story
enters the ID with the implementation. The audit is a CLI and CI step,
not an analysis-path feature, and never affects scores or evidence.

- The deterministic phase checks forbidden imports, capability
  mismatches against the manifest, determinism lint, manifest limits
  and the `PLUGIN.md` checks, with one named failure per cause; any
  failure ends the audit with the AI phase not run and zero model
  calls, and blocks the CI gate. Verification: unit test
  `k516_deterministic_audit_fails_forbidden_import_and_capability_mismatch`,
  integration test `k516_deterministic_failure_runs_zero_model_calls`,
  and the CI step `npm run audit:plugins`.
- The optional AI phase sends the plugin source, manifest and
  `PLUGIN.md` solely as quoted data through `PluginAuditModelPort`
  to Muse Spark (`muse-spark-1.3`) through the Meta Model API,
  and validates every response with `parsePluginAuditReport` before
  any human sees it as findings. Without a key it reports
  `not-configured` with zero sends. Verification: contract suite
  `runPluginAuditModelPortContract` against the fake and the Meta Model API
  adapter over a recorded transport, unit tests
  `k516_audit_without_key_reports_not_configured_and_sends_nothing`,
  `k516_injection_in_source_or_docs_stays_quoted_data`,
  `k517_schema_invalid_audit_output_discarded` and integration test
  `k516_audit_sends_only_listed_plugin_files`.
- The report states the three states separately (`deterministic`,
  `ai: advisory`, `human-review`) with provider and model id, and
  carries no field the registry, scoring or analysis path reads.
  Verification: unit test
  `k516_audit_report_states_deterministic_ai_and_human_states` and
  property test
  `k516_ai_findings_leave_scores_signals_and_evidence_unchanged`.
- Documented inputs, version and backticked output fields are checked
  against the manifest deterministically, and semantic drift surfaces
  as advisory `docs-drift` findings. Verification: unit tests
  `k517_documented_inputs_and_version_checked_against_manifest` and
  `k517_docs_drift_reported_as_advisory_finding`.

### K-520 Investigation loop safety: one-way chain and validated citations (MVP)

The investigation loop is an investigation aid, never an analysis
input. Proposed in `docs/adr-investigate-with-muse.md` (P-33, P-35,
P-38); this story enters the ID with the implementation.

- The investigation reads a frozen copy of the analysis and writes
  only its own envelope: score, probabilities, signals and evidence
  stay bit-identical with the loop on, off, failed and absent.
  Verification: property test
  `k520_investigation_leaves_score_and_evidence_unchanged` and
  `k520_recorded_investigation_replays_bit_identical` (replay through
  the fake adapter, apart from `elapsedMs`).
- A wrong provider or model id gives `provider-mismatch` with no
  decision applied. Verification: `runInvestigationModelPortContract`
  error branch `k513_investigation_provider_mismatch_rejected`.
- All model input and output is untrusted data: on-chain strings and
  plugin text travel quoted, tool calls are validated, and narrative
  citations are re-checked deterministically with drops counted.
  Verification: unit tests
  `k520_citation_check_keeps_only_sentences_citing_collected_evidence`
  and the redacted-logging pattern of the Meta Model API adapters.

### K-037 Own ERC-20 EVM decompiler (MVP)

The own pipeline decompiles ERC-20 token contracts deterministically:
existing disassembly into a CFG with stack-value jump-target resolution,
stack-to-SSA lifting, structuring into if/loops with a labelled
goto-form fallback, and a pseudo-Solidity emitter with exact bytecode
offsets. Proposed in `docs/adr-evm-decompiler.md` (D-01–D-08); this
story enters the ID with the implementation. The pipeline ships as the
detector plugin `dev.brandklipparen.decompiler`, consumed through the
shared service in REST, MCP and the Expert view at weight 0 until the
calibration artifact names it.

- Disassembly partitions every swept instruction into exactly one basic
  block, and dispatcher jumps resolve from proven constants only.
  Verification: unit tests `k521_lift_partitions_blocks_with_validated_jump_targets`,
  `k521_dispatch_coverage_on_erc20_fixture` and
  `k522_function_entries_cover_sixteen_valid_cases`.
- Lifting is semantics-preserving on straight-line code and names every
  stack value exactly once. Verification: unit tests
  `k524_store_and_return_operands_follow_pop_order` and the
  `d12_pathological_bytecode_yields_typed_outcome_or_labelled_fallback`
  property over mutated bytecode.
- Structuring renders token patterns as readable pseudo-Solidity with
  every item carrying its exact `[startPc, endPc)` range; irreducible
  regions emit the labelled fallback. Verification: unit tests
  `k524_three_published_case_fixtures_render_expected_pseudo_solidity_and_docs_snippet`,
  `d07_decompiler_output_consumed_identically_in_rest_mcp_and_expert_ui`
  (payload ranges equal the lifted ranges) and the
  `d12_pathological_bytecode_yields_typed_outcome_or_labelled_fallback`
  property (every emitted range stays inside its function range).
- The detector plugin exposes the same functions, offsets and
  unresolved-jump count in REST, MCP and the Expert view, and score,
  probabilities and signals stay bit-identical with the plugin enabled,
  disabled and absent. Verification: contract
  `runDetectorPluginContract` for the decompiler plugin and unit tests
  `d07_decompiler_output_consumed_identically_in_rest_mcp_and_expert_ui`
  and `d08_decompiler_findings_leave_score_and_evidence_unchanged`.

### K-038 Internal eval and naming overlay (MVP)

The dev/eval-only harness evaluates the internal pipeline on the
frozen ERC-20 corpus over local bytecode only, and suggested function
names arrive solely through an opt-in display-only overlay. Proposed
in `docs/adr-evm-decompiler.md` (D-09–D-11, with the comparison path
retired by the Decision update); this story enters the ID with the
implementation.

- The harness runs the internal pipeline over the frozen corpus files
  and reports the four metrics (CFG/function boundaries, unresolved
  jumps, token-pattern readability, offset mapping) per corpus
  contract. Verification: unit tests
  `d09_eval_runs_internal_only_over_local_corpus` and
  `d09_metrics_table_reports_all_four_metrics_per_contract`.
- The naming overlay suggests display names only, behind an explicit
  opt-in, validated whole and rendered as a labelled overlay; without a
  wired port it answers `not-configured` with zero provider calls.
  Verification: unit tests
  `d11_naming_without_key_reports_not_configured_and_sends_nothing` and
  property `d11_suggested_names_never_affect_analysis`, plus the
  `POST /v1/naming` route tests.

### K-521 Decompiler output safety (MVP)

Decompiler output is safe by construction: a jump target is resolved
only from proven stack values and otherwise recorded as one unresolved
jump — never guessed, never dropped — and out-of-scope input is a
normal result with zero token-pattern annotations, never an error.
Proposed in `docs/adr-evm-decompiler.md` (D-01, D-03, D-12); this story
enters the ID with the implementation.

- Mutated bytecode ends in a structured result, a labelled fallback or
  a typed error within the per-port limits; non-token input emits plain
  pseudo-Solidity. Verification: property tests
  `d12_pathological_bytecode_yields_typed_outcome_or_labelled_fallback`
  and `d12_non_erc20_input_decompiles_without_token_annotations`.

## 12. Traceability

### 12.1 Requirement to named test or measurement

Test types: unit (one module's logic), property (generative
invariants), golden (fixed expected output for fixed input), contract
(one port against a recorded fixture), integration (several adapters or
external fakes), e2e (the whole flow in a running environment), timing
(response time against frozen fixtures), evaluation (measures on a
dataset per K-2xx), review (automated check or signed manual entry).
The table names the governing test per requirement; sections 5–11 name
the test per acceptance criterion.

| Requirement | Governing test or measurement |
|---|---|
| K-001 | `k001_contract_address_returns_bytecode` (contract) |
| K-002 | `k002_eip1967_returns_proxy_and_implementation` (golden) |
| K-003 | `k003_beacon_returns_beacon_and_implementation` (contract) |
| K-004 | `k004_eip1167_reads_embedded_target` (golden) |
| K-005 | `k005_uups_returns_implementation` (golden) |
| K-006 | `k006_diamond_lists_facets_per_selector` (contract) |
| K-007 | `k007_eip7702_follows_delegation` (golden) |
| K-008 | `k008_unresolved_control_flow_yields_hard_to_analyze_signal` (integration) |
| K-009 | `k009_every_selector_paired_or_marked_unknown` (property) |
| K-010 | `k010_signal_requires_selector_and_carries_offset_when_derivable` (unit) |
| K-011 | `k011_probabilities_in_unit_interval_and_integer_score` (property) |
| K-012 | `k012_cant_tell_list_shown_separate_from_score` (e2e) |
| K-013 | `k013_cache_hit_skips_decompilation_and_external_calls` (integration) |
| K-014 | `k014_newest_token_first_with_block` (e2e) |
| K-015 | `k015_each_score_change_links_to_event` (e2e) |
| K-016 | `k016_value_carries_slot_block_and_time` (integration) |
| K-017 | `k017_clone_hit_reports_similarity_group_and_count` (golden) |
| K-039 | `k039_liquidity_gate_hands_to_analysis_only_after_first_liquidity` (unit) |
| K-020 | `k020_pasted_address_opens_token_page_or_shows_error` (e2e) |
| K-021 | `k021_fast_path_renders_before_deepening` (e2e) |
| K-022 | `k022_marker_matches_log_row` (e2e) |
| K-023 | `k023_response_matches_published_schema` (schema validation) |
| K-024 | `k024_missing_or_invalid_key_rejected_before_analysis` (integration) |
| K-025 | `k025_assess_token_matches_rest_for_same_codehash` (integration) |
| K-026 | `k026_tools_leave_state_unchanged` (unit) |
| K-027 | `k027_same_inputs_same_outputs_across_interfaces` (property) |
| K-028 | `registry_rejects_duplicate_ids_and_unsupported_api_versions` (unit) |
| K-030 | `runAssessmentModelPortContract` per registered assessment plugin (contract) |
| K-032 | `k517_plugin_md_missing_or_mismatched_fails_deterministic_check` (unit) |
| K-033 | `k033_plugin_docs_match_registry_in_rest_and_mcp` (integration) |
| K-035 | `k035_priorities_match_frontmatter_tags_deterministically` (unit, web) |
| K-519 | `k519_ask_sends_one_chat_request_per_press` (Playwright, web) |
| K-034 | `k034_every_output_schema_shape_renders_via_fixed_library` (unit, web) |
| K-036 | `k036_investigate_matches_across_rest_and_mcp_for_same_codehash` (integration) |
| K-517 | `k517_plugin_md_missing_or_mismatched_fails_deterministic_check` (unit) |
| K-101 | `k101_fast_path_p95_within_5s` (timing) |
| K-102 | `k102_golden_fixtures_bit_identical` (golden) |
| K-103 | `k103_wcag_aa_checklist_per_release` (review) |
| K-104 | `k104_health_reports_each_dependency_status` (integration) |
| K-105 | `k105_core_line_coverage_at_least_90` (CI measurement) |
| K-106 | `k106_typecheck_blocks_on_error` (CI check) |
| K-107 | `k107_no_request_zero_assessment_calls_and_cost` (integration) |
| K-108 | `k108_english_language_verified_before_submission` (CI check or review) |
| K-201 | `k201_each_datapoint_has_address_bytecode_block_source` (review) |
| K-202 | `k202_label_quality_spot_check_versioned` (measurement) |
| K-203 | `k203_test_split_strictly_after_training_split` (evaluation) |
| K-204 | `k204_no_cluster_spans_splits` (evaluation) |
| K-205 | `k205_ece_per_class_on_both_splits` (evaluation) |
| K-206 | `k206_auroc_prauc_per_class_on_both_splits` (evaluation) |
| K-207 | `k207_release_gate_beats_baseline_calibration` (evaluation) |
| K-208 | `k208_model_card_has_period_data_splits_metrics` (review) |
| K-209 | `k209_single_command_reproduces_evaluation` (evaluation) |
| K-210 | `k210_model_values_loaded_from_artifact` (CI check) |
| K-211 | `k211_retraining_reproduces_artifact_bit_identical` (evaluation) |
| K-301 | `k301_template_text_bit_identical_from_evidence` (golden) |
| K-302 | `k302_prompt_contains_closed_typed_evidence_list` (unit) |
| K-303 | `k303_each_capability_marked_now_or_changeable` (unit) |
| K-304 | `k304_every_displayed_claim_has_valid_link` (property) |
| K-305 | `k305_assessment_works_in_demo_ui_rest_and_mcp` (e2e) |
| K-309 | `runAssessmentModelPortContract` (contract, adapter and fake) |
| K-306 | `k306_template_built_deterministically_from_evidence` (unit) |
| K-307 | `k307_scores_and_evidence_identical_with_and_without_adapter` (unit) |
| K-308 | `k308_hostile_strings_leave_explanation_structure_intact` (unit) |
| K-401 | `k401_video_shows_deterministic_analysis` (review) |
| K-402 | `k402_demo_serves_ui_rest_and_mcp` (health check) |
| K-403 | `k403_clean_clone_instructions_verified_on_second_machine` (review) |
| K-404 | `k404_history_within_hackathon_window` (review) |
| K-405 | `k405_submission_reachable_before_deadline` (review) |
| K-406 | `k406_submission_links_resolve` (review) |
| K-407 | `k407_live_final_runbook_rehearsed` (review) |
| K-501 | `k501_mutated_bytecode_yields_signal_or_typed_error` (fuzz) |
| K-502 | `k502_injection_strings_yield_at_most_one_quote` (unit) |
| K-503 | `k503_crafted_inputs_stay_within_allowlist` (unit) |
| K-504 | `k504_limits_hold_under_overload_and_cache_serves` (load test) |
| K-505 | `k505_gitleaks_clean_on_repo_and_history` (CI check) |
| K-506 | `k506_pinning_and_vulnerability_scan_block_release` (CI check) |
| K-507 | `k507_script_bearing_data_renders_as_inert_text` (e2e) |
| K-508 | `k026_new_tool_security_review_recorded` (review) |
| K-509 | `k509_key_like_strings_redacted_in_output` (unit) |
| K-510 | `k510_rotation_and_revocation_without_restart` (integration) |
| K-511 | `k511_manipulated_rpc_response_flagged` (integration) |
| K-512 | `k512_tampered_artifact_rejected_before_analysis` (integration) |
| K-513 | `k513_tampered_or_oversize_provider_response_rejected` (integration) |
| K-514 | `k514_registry_has_no_dynamic_loading` (CI check) |
| K-516 | `k516_deterministic_audit_fails_forbidden_import_and_capability_mismatch` (unit) |
| K-520 | `k520_investigation_leaves_score_and_evidence_unchanged` (property) |
| K-037 | `d07_decompiler_output_consumed_identically_in_rest_mcp_and_expert_ui` (unit) |
| K-038 | `d09_eval_runs_internal_only_over_local_corpus` (unit) |
| K-521 | `d12_pathological_bytecode_yields_typed_outcome_or_labelled_fallback` (property) |

### 12.2 Security requirements to threats and countermeasures

The linkage below is complete in both directions against
`docs/threat-model.md`: each K-5xx has its M-xx, and each M-xx in the
threat model (M-01–M-21) appears in the table. M-22 maps to the
proposed K-515, which enters this document with its implementation
story, so the row is added then.

| Requirement | Threat | Fulfilled by |
|---|---|---|
| K-501 | H-01 | M-01, M-02 |
| K-502 | H-02, H-14 | M-03, M-04, M-05, M-06, M-20 |
| K-503 | H-03 | M-07 |
| K-504 | H-04 | M-08, M-09 |
| K-505 | H-05, H-14 | M-11, M-20 |
| K-506 | H-06 | M-12 |
| K-507 | H-07 | M-13 |
| K-508 | H-08 | M-15 |
| K-509 | H-10 | M-16 |
| K-510 | H-05 | M-10, M-11 |
| K-511 | H-09 | M-14 |
| K-512 | H-11, H-12, H-13 | M-17, M-18, M-19 |
| K-513 | H-14, H-04, H-05 | M-20, M-09, M-11 |
| K-514 | H-15 | M-21 |

M-06 points in the threat model also to K-307. The requirement lives in
section 9 and is measured with
`k307_scores_and_evidence_identical_with_and_without_adapter`.

### 12.3 Cross-document reference check

The project holds the ID spaces separate per owning document: K-xx
here, A-xx in `docs/architecture.md`, I-xx in
`docs/infrastructure.md`, plus H-xx and M-xx in `docs/threat-model.md`.

- Each K-ID mentioned in `docs/architecture.md`,
  `docs/infrastructure.md` and `docs/threat-model.md` has its definition
  in sections 4–12 here. Verification: review
  `docs_k_ids_referenced_elsewhere_are_defined_here`, which extracts
  the K-IDs from the three files and requires one heading per ID here.
- Each A-xx, I-xx, H-xx and M-xx mentioned here has its definition in
  the owning file. Verification: review
  `docs_referenced_ids_defined_in_owner_files`, which extracts the IDs
  from this document and requires one definition per ID in the
  respective owning file.
- The reviews run at each document change during the hackathon, so the
  ID spaces stay consistent. Verification: the reviews above are part
  of the final check per K-405.

## 13. Open decisions

One open decision remains for Jens: the demo default assessment
provider per K-309. The adapter is MVP and works in the demo
per K-305: Meta Model API with Muse Spark, model id `muse-spark-1.3`.
Jens selects the demo default ahead of the 2/11 demo script
in `backlog.md`; the adapter stays selectable by configuration
and green in the contract suite per K-309. The Muse contract
assessment per K-305 is MVP and works in the demo in either selection:
it runs solely on request via button or tab, REST endpoint and MCP
tool, appears clearly separate from the deterministic score and
evidence with provider and model id, is cached per code hash, prompt
version, provider and model id, stays within the cost limits per
K-309 and leaves score and evidence unchanged at all times. The demo
video per K-401 shows it as a working moment after the deterministic
analysis. The template-based explanations per K-301 are the ones that
appear at all times.
