# Brandklipparen: submission texts (draft)

## 1. Header block

- Project name: Brandklipparen
- Track: Indie Developer
- Problem statement: Build for Your World
- Public repo: <REPO_URL>
- Public demo: <DEMO_URL>
- Demo video (3 minutes): <VIDEO_URL>
- Model id for the Meta Model API assessment: muse-spark-1.3

## 2. Describe your use of Meta products

We use Meta models for two opt-in features. The contract assessment (K-305) runs only after the user asks for it, through a button or tab in the web UI, a REST endpoint, and an MCP tool. It receives only the closed evidence list from the deterministic analysis (K-302) and returns free text in a separate field, labelled with provider and model id. Configuration selects exactly one assessment adapter at startup (K-309): the Meta Model API with muse-spark-1.3, or the open-weights adapter running Muse Spark Open (meta-models/muse-spark-open-1026) on an open-weights deployment. The health check shows provider and model id, and an unset selection leaves the feature disabled with zero provider calls. The Investigate with Muse loop (K-036) runs Meta's open-weights model Muse Spark Open (meta-models/muse-spark-open-1026) on an open-weights deployment. It starts only on explicit request, after the deterministic analysis is computed and frozen. The model only proposes the next step, run one allowlisted read-only tool or conclude, and the typed runner validates and executes it over frozen facts with hard limits (at most 8 model steps, a token budget, a 60 s deadline with a 5 s per-tool timeout, size caps, and a per-key daily cap). Tools are registry-derived readers (one per registered detector plus frozen-fact readers) with no new chain reads. Output is a separate envelope with a step trace and a citation-checked narrative that drops uncited sentences. The loop never changes score, probabilities, signals, findings, or evidence (K-307). The deterministic core (K-102) never depends on the model: frozen bytecode analysis gives bit-identical scores, signals, evidence, and template text. We built the project with Muse through Muse Code.

## 3. Why are Meta's models important to your solution

Fixed detectors report what the bytecode contains plus what the chain shows at the pinned block: selectors, offsets, and on-chain reads such as owner state, LP distribution, liquidity, concentration, deployer history, and age, with severity and direction. The model assessment reads that evidence as connected text. It restates what a set of signals means together, in plain language, for readers who do not read bytecode. It also orders and emphasizes sections from local priorities, so the token page shows what the visitor asked about first while the severity floor keeps high findings visible. The Investigate with Muse loop adds the missing step-by-step view: it runs Muse Spark Open (meta-models/muse-spark-open-1026) on an open-weights deployment, only on explicit request and only over frozen facts, proposing one read-only registry tool at a time under hard limits (at most 8 steps, a token budget, a 60 s deadline, and a daily cap). The trace shows which tool ran, why the model chose it, and which evidence ids came back, beside the frozen result. This matters because the score alone does not teach. The free-text layer gives one place where related findings are described together, and the trace shows the reasoning path. The separation keeps this help honest. The model never changes score or evidence (K-307): numbers are computed and frozen before any model call, and the response with an assessment or investigation is bit-identical except for the new text field and label. Outputs are schema-validated with size, time, and cost limits, and invalid or oversize output is rejected with the template text standing (K-306). The product still works without the model: with no key each feature reports not-configured, makes zero calls, and every interface keeps score, evidence, and template text.

## 4. Short description and tagline

### Short description

Brandklipparen assesses ERC-20 rug-pull risk from contract bytecode plus point-in-time on-chain signals. It returns calibrated probabilities, a score from 0 to 100, and evidence with selectors, offsets, and on-chain reads, plus plain-language explanations. An optional contract assessment with muse-spark-1.3 through the Meta Model API reads the same evidence on request and never changes score or evidence. An opt-in investigation loop with Muse Spark Open can walk the same frozen evidence step by step and never changes score or evidence.

### Tagline

Bytecode plus on-chain signals, with evidence behind every number.

## 5. Submission checklist (K-403..K-406)

- [ ] K-403: public repo with README, licence, and run instructions, verified from a clean clone on a second machine
- [ ] K-404: only work built during the hackathon window, with history and fresh fixtures checked
- [ ] K-405: submitted on time with repo, demo, video, and texts complete and reachable
- [ ] K-406: track Indie Developer, problem statement Build for Your World, both Meta texts, and resolving repo, demo, and video links
