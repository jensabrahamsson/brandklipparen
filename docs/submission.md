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

We use the Meta Model API with model id muse-spark-1.3 for one optional feature. The contract assessment (K-305) runs only after the user asks for it, through a button or tab in the web UI, a REST endpoint, and an MCP tool. It receives only the closed evidence list from the deterministic analysis (K-302) and returns free text in a separate field, labelled with provider and model id. When configured, the Meta Model API assessment plugin is selected at startup (K-309); the health check shows provider and model id, and an unset selection leaves the feature disabled with zero provider calls. The same Meta Model API setup can map local priorities to a layout in the experimental personalize toggle, which stays off by default, states the one call before sending, and falls back to the deterministic match when output is missing or invalid. Template explanations stay default in every interface: pure functions of evidence and template version 1.0.0. The deterministic core (K-102) never depends on the model: 13 bytecode detector plugins registered in src/plugins/registry.ts plus 6 point-in-time on-chain signal modules under src/plugins/onchain/ (age, concentration, deployer, liquidity, LP, owner) feed one frozen analysis, and the same bytecode and block give bit-identical scores, signals, evidence, and template text. On-chain signals are weight 0 under the default artifact and never change the score. The registry holds 13 detectors and 3 assessment adapters; with the 6 on-chain modules plus the explain, personalize, and investigate services the codebase holds 25 plugin-shaped pieces. We built the project with Muse through Muse Code for implementation and reviews.

## 3. Why are Meta's models important to your solution

Fixed detectors report what the bytecode contains plus what the chain shows at the pinned block: selectors, offsets, and on-chain reads such as owner state, LP distribution, liquidity, concentration, deployer history, and age, with severity and direction. The model assessment reads that evidence as connected text. It can restate what a set of signals means together, in plain language, for readers who do not read bytecode. It also orders and emphasizes sections from local priorities, so the token page shows what the visitor asked about first while the severity floor keeps high findings visible. This matters because the score alone does not teach. A number with evidence links is complete but dense, and the template text is fixed per signal. The free-text layer gives one place where related findings are described together. The separation keeps this help honest. The model never changes score or evidence (K-307): numbers are computed and frozen before any assessment call, and the response with an assessment is bit-identical except for the new text field and label. Outputs are schema-validated with size, time, and cost limits, and invalid or oversize output is rejected with the template text standing (K-306). The product still works without the model: with no key the feature reports not-configured, makes zero calls, and every interface keeps score, evidence, and template text. Calibration is an honest baseline: artifact 1.0.1 remains the default with near-chance discrimination, so Low must not be read as safe; full test and holdout-v2 numbers are in docs/calibration/.

## 4. Short description and tagline

### Short description

Brandklipparen assesses ERC-20 rug-pull risk from contract bytecode plus point-in-time on-chain signals. It returns calibrated probabilities, a score from 0 to 100, and evidence with selectors, offsets, and on-chain reads, plus plain-language explanations. An optional contract assessment with muse-spark-1.3 through the Meta Model API reads the same evidence on request and never changes score or evidence.

### Tagline

Bytecode plus on-chain signals, with evidence behind every number.

## 5. Submission checklist (K-403..K-406)

- [ ] K-403: public repo with README, licence, and run instructions, verified from a clean clone on a second machine
- [ ] K-404: only work built during the hackathon window, with history and fresh fixtures checked
- [ ] K-405: submitted on time with repo, demo, video, and texts complete and reachable
- [ ] K-406: track Indie Developer, problem statement Build for Your World, both Meta texts, and resolving repo, demo, and video links
