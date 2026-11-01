# ADR: Own EVM decompiler, ERC-20 scoped

Author: Jens Abrahamsson.
Status: proposed. Sibling to `docs/adr-plugin-architecture.md` (P-xx)
and `docs/adr-investigate-with-muse.md` (P-29 onward); this document
owns a separate rule namespace, D-01 onward, so the plugin rules stay
in one sequence and decompiler rules never collide with them.
Implementation follows the stories in `backlog.md` (epic E-10)
test-first per A-21. No application code ships on the basis of this
ADR alone.
Reading guide: requirements (K-IDs) are owned by
`docs/requirements.md`, architecture rules (A-xx) by
`docs/architecture.md`, infrastructure rules (I-xx) by
`docs/infrastructure.md`, and threats with countermeasures (H-xx,
M-xx) by `docs/threat-model.md`. This ADR owns D-01 onward. Proposed
new K-IDs are listed in section 9; they enter `docs/requirements.md`
in the first implementation story, in the same change.

## Decision update

The external comparison tool is removed: the product runs only the
internal decompiler (decompiler v2 with the v1 fallback) behind
`DecompilerPort`, with no external binary, worker process, or
decompiler variable in the operations configuration. The
hard-to-analyze signal now comes solely from the internal engine's
own limits (input and output byte caps, unresolved control flow).
The sections below stay as the historical record of the comparison
that motivated the promotion; `docs/eval-decompiler-results.md`
stays as the historical record of its runs.

## 1. Context, goal, and rule numbering

Brandklipparen's deepening today decompiles through extdecomp behind
`DecompilerPort` (`src/ports/decompiler.ts`): the application sends
bytecode and a code hash, the isolated worker adapter
(`src/adapters/extdecomp/extdecompAdapter.ts`, A-27, M-01, M-02)
returns functions linked to dispatcher selectors, and each snippet
joins signal evidence (K-008, K-010). That path stays. This ADR
designs a second, own decompiler whose only ambition is narrower
and therefore winnable:

**Goal: beat extdecomp on ERC-20 token contracts — not as a
general-purpose decompiler.** The product analyses newly deployed
ERC-20 tokens from bytecode alone. Token contracts share a small,
recurring shape (dispatcher, transfer and allowance logic, supply
and pause controls, owner gates), so a pipeline specialised for
that shape can be more correct, more complete, and more readable
on exactly the inputs the product sees, while honestly labelling
everything outside the shape. "Better" is defined only by the
metrics in section 2, measured only by the harness in section 7.
No claim in this ADR extends past ERC-20 token contracts.

Rule numbering, decided here: decompiler rules are **D-01, D-02,
…** in this document only. The P-xx sequence stays owned by the
plugin ADR and its investigate sibling (P-29–P-38); the next P-rule
is P-39 and is not used here. D-xx and P-xx never renumber each
other, and a citation always names its document by the rule prefix.

## 2. What "better" means: the metrics table

A comparison counts only on the frozen ERC-20 corpus in section 7,
per contract, for both decompilers, with the four metrics below.
The own pipeline wins a contract only when it is at least as good
on every metric and strictly better on at least one; the epic wins
when it wins the corpus median contract without losing any metric
on more than a stated minority of contracts. Thresholds are set
when the corpus is frozen in S-082, not in this ADR.

| # | Metric | Definition (per contract) | Why it decides "better" |
|---|---|---|---|
| 1 | Correct CFG / function boundaries | Share of dispatcher selectors whose entry block, reachable blocks, and exit blocks agree with the corpus ground truth (selector set from the dispatcher scan plus manually verified boundaries for the frozen fixtures) | A wrong boundary merges or splits functions, so every later stage reads the wrong code |
| 2 | Fewer unresolved jumps | Count of dynamic `JUMP`/`JUMPI` targets recorded as unresolved, lower is better; a guessed target counts as an error, not as resolved | Each unresolved jump is a region the structuring stage must label rather than read; guessing is strictly worse than labelling (D-03) |
| 3 | Readable pseudo-Solidity for token patterns | For each corpus token pattern present (transfer guard, allowance check, mint/burn, pause flag, owner gate), whether the emission names the pattern in the readable golden shape (section 5) instead of raw stack operations | The Expert reader and the detectors consume shapes, not stack traces; readability on token patterns is the product-facing win |
| 4 | Evidence mapped to exact bytecode offsets | Share of emitted items (functions, statements, pattern annotations) carrying the exact `[startPc, endPc)` range they were lifted from; the target is 100 % by construction (D-06), so this metric catches regressions rather than grading effort | The product's core promise (K-010) is that every claim is checkable against the bytecode; an item without a range breaks it |

Two accounting rules keep the table honest. First, an unresolved
jump that the own pipeline labels and extdecomp guesses counts in
the own pipeline's favour on metric 2 only if the guess is wrong
against ground truth; a correct guess and a correct resolution tie.
Second, metric 3 is judged on the pattern inventory actually
present in each contract, so a purpose-built token cannot inflate
the score with patterns it never had.

## 3. Decision summary

| Decision | Choice |
|---|---|
| Scope | ERC-20 token contracts only; everything else decompiles without token annotations and without error (D-01) |
| Pipeline | Deterministic, pure, no network: existing disassembly → CFG with stack-value jump resolution → stack-to-SSA → structuring → pseudo-Solidity emitter (D-02–D-06) |
| Jump targets | Resolve only what stack-value analysis proves; record every other dynamic target as one unresolved jump, never guess (D-03) |
| Correctness anchor | fast-check property: lifting preserves semantics on a small EVM interpreter for straight-line code (D-04) |
| Exposure | One detector plugin through the existing registry; detectors and the Expert view, REST, and MCP consume the same output; weight 0 until the artifact names it (D-07, D-08) |
| Runtime relation | extdecomp stays the runtime `DecompilerPort` adapter in the deepening; the own pipeline is additive until a promotion story says otherwise (D-08) |
| Comparison | Dev/eval-only harness on local bytecode via `extdecomp_BIN`, expected version `0.9.1`; never a runtime dependency (D-09, D-10) |
| AI naming | Optional separate plugin: Muse Spark Open suggests names only, opt-in, display-only, never an analysis input (D-11) |

### 3.1 Alternatives for the load-bearing decisions

| Decision (rule) | Serious alternative | Why rejected today | Reopen when |
|---|---|---|---|
| Own specialised pipeline (D-02) | Tune or post-process extdecomp output (rename, reformat, patch boundaries) | Post-processing inherits every wrong boundary and guessed target underneath the formatting; the metrics in section 2 grade structure, not surface text | The harness shows extdecomp's structure already correct on the corpus and only its surface lacking |
| ERC-20 scope only (D-01) | General-purpose decompiler from day one | The general problem (arbitrary proxies, hand-written assembly, irreducible graphs everywhere) is the part with no demo payoff; the token shape is small enough to structure well and to golden-test | The corpus metrics saturate and a named non-token contract class matters to the product |
| Resolve-or-record, never guess (D-03) | Heuristic target guessing (nearest `JUMPDEST`, frequency priors) to cut the unresolved count | A guessed edge can delete a transfer guard from the structured output — a correctness failure dressed as a completeness win; metric 2 counts a wrong guess as an error | A heuristic proves sound on the corpus ground truth, i.e. it stops being a guess |
| New pure pipeline beside `DecompilerPort` (D-08) | Replace the extdecomp worker adapter behind `DecompilerPort` immediately | The port contract returns selector-linked snippets for the deepening today; swapping the implementation before the metrics exist risks the submission path for an unproven win | S-082 reports the epic win and a promotion story (S-085 path) is scheduled |
| AI suggests names only (D-11) | AI writes or repairs pseudo-Solidity | Generated code has no offset provenance, so metric 4 and the K-010 promise fail by construction; names are the one AI output that is checkable at a glance and discardable without loss | Never for emitted structure; naming stays an overlay |

## 4. The pipeline: five deterministic stages

**D-01 Scope is ERC-20 token contracts; out-of-scope input is a
normal result, never an error.** The pipeline accepts any runtime
bytecode the `Bytecode` type accepts. Token-pattern annotation
(section 5) applies only when the structured shape matches;
non-token input emits plain pseudo-Solidity with zero annotations.
No stage branches on a contract address, a name, or any off-chain
fact: bytecode in, structured text plus accounting out.

**D-02 Stage 1–2: existing disassembly into a CFG.** Stage 1 reuses
the landed linear sweep `disassemble` in
`src/domain/selectors.ts` unchanged — PUSH data is already skipped,
the CBOR footer is already cut through `stripCborFooter`, and a
truncated trailing PUSH already ends the sweep without throwing.
Stage 2 partitions the instruction stream into basic blocks with
leaders at the entry, at every proven jump target, and at every
fall-through after `JUMP`, `JUMPI`, and the halting opcodes, so
every swept instruction belongs to exactly one block. The CFG,
like every stage output, is a frozen value; equal bytecode gives
bit-identical output (K-102), verified by canonical serialisation
in the property in S-078.

```ts
type ByteRange = { readonly startPc: number; readonly endPc: number }; // [startPc, endPc)
type BasicBlock = {
  readonly range: ByteRange;
  readonly instructions: readonly Instruction[]; // from disassemble, PC order
  readonly successors: readonly BlockEdge[];
};
type BlockEdge =
  | { kind: "fall-through"; to: number }
  | { kind: "jump"; to: number }        // proven target, D-03
  | { kind: "conditional"; to: number; fallThrough: number };
```

**D-03 Stage 2 (cont.): jump-target resolution by stack-value
analysis — resolve or record, never guess.** A forward abstract
interpretation over the stack tracks, per stack slot, either one
proven constant (from `PUSHn` propagation through `DUP`/`SWAP` and
constant-foldable arithmetic) or "unknown". A `JUMP` or `JUMPI`
whose target slot is a proven constant in range and lands on a
`JUMPDEST` is a resolved edge carrying that PC. Every other dynamic
target is recorded as exactly one unresolved jump:

```ts
type UnresolvedJump = { readonly atPc: number; readonly range: ByteRange };
```

The unresolved list is part of the pipeline output, counted by
metric 2, and carried into structuring as labelled fallback
regions. A target is never inferred from proximity, frequency, or
the nearest `JUMPDEST`, and an unresolved jump is never silently
treated as fall-through or dropped. The dispatcher idioms the fast
path already recognises (`DUP1 PUSH4 <selector> EQ PUSHn <dest>
JUMPI` and its variant, `extractSelectors` in the same module) are
the first proven-constant source, so function entries agree with
the selector extraction by construction.

**D-04 Stage 3: stack-to-SSA lifting, semantics-preserving on
straight-line code.** Each block lifts to SSA form: every stack
value is named exactly once, stack operations become named
bindings in original order, side-effecting opcodes (`SSTORE`,
`MSTORE`, calls, `LOGn`, halting opcodes) keep their program order
as statements, and a block join with differing reaching definitions
introduces an explicit phi — the only place a value has two
sources, stated in the type rather than hidden in a merge
heuristic. Illegal states are unrepresentable across the pipeline:
a block without its range, an edge to a non-leader PC, an SSA value
with two non-phi definitions, and (from D-06) an emitted item
without a range each fail construction in the stage's smart
constructor, in the A-13/A-16 style.

The correctness anchor is a property, not a fixture set: generated
straight-line instruction sequences (no jumps, so no CFG question
is begged) run on a small test EVM interpreter and on the lifted
SSA form, and the two must agree on stack, memory, and storage
effects. The generator and interpreter live in the test tree only;
the property uses fast-check, already the repo's property library.
The v1 claim is scoped to straight-line code and stated as such —
structured regions inherit the CFG accounting in D-03 and the
golden fixtures in D-05, and the scope limit is recorded as a
residual risk in threat-model section 9.

**D-05 Stage 4: structuring (if/loops) with an honest fallback.**
The structuring stage folds the CFG into nested regions: a
two-way `JUMPI` diamond whose arms rejoin becomes `if`/`if-else`,
a back-edge to a dominating header becomes a loop with its
condition at the header, and sequencing stays sequencing. A region
that matches no shape — an irreducible subgraph, an edge from an
unresolved jump (D-03), a jump into the middle of a region —
emits the labelled goto-form fallback for exactly that region,
with the surrounding structure intact. Nothing is dropped to make
the output prettier, and no region is mis-structured as a loop to
cut the fallback count: the fallback count, like the unresolved
count, is reported in the output.

**D-06 Stage 5: pseudo-Solidity emitter with exact offset mapping
on every item.** The emitter renders structured regions as readable
pseudo-Solidity: one function per dispatcher selector (named by
selector with its paired target, or marked unknown exactly as
`SelectorEntry` already distinguishes), named SSA bindings as
locals, and token patterns recognised on the structured shape —
transfer guard (balance/allowance check dominating a transfer),
allowance check, mint/burn (supply-changing `SSTORE` on the supply
slot shape), pause flag (a boolean storage gate dominating the
transfer path), owner gate — annotated in place. Every emitted
item carries its range by construction:

```ts
type EmittedItem = {
  readonly text: string;             // rendered as inert text, K-507
  readonly range: ByteRange;         // exact [startPc, endPc) it was lifted from
  readonly selector: SelectorType;   // the function it belongs to
};
```

An `EmittedItem` without a range cannot be constructed, so metric
4 holds at 100 % unless the type itself is changed. Offsets count
bytes in the original runtime bytecode through the same footer
rule as the sweep, so an Expert reader lands on the exact bytes
the existing evidence view (K-010) already names.

## 5. Simplest design and ports: what is new, what is reused

The new code is the smallest thing that can win the metrics: four
pure functions in `src/domain` beside `selectors.ts` (CFG build,
SSA lift, structuring, emission), each a total function of the
previous stage's frozen value, plus one detector plugin module.
No new port is added for the pipeline itself — a pure function
needs no port (A-05 governs external capabilities; the pipeline
has none: no I/O, no clock, no network, no configuration beyond the
existing per-port and manifest limits in A-17).

**D-07 Exposure is one detector plugin; every consumer reads the
same output.** The pipeline ships as a registered detector plugin
(plugin ADR P-01–P-08): its manifest declares only the `bytecode`
fact it reads (section 3.2 catalogue), its `detect` runs the five
stages on the frozen projection, and its findings carry the
emitted items, the unresolved-jump count, and the fallback count
under `pluginResults`, validated at the registry boundary like
every detector output (P-03, M-22). Detectors that want structured
facts (a honeypot detector reading "is there a transfer guard")
consume the plugin's structured output through the registry, and
the Expert view, REST, and MCP render the same emitted items from
the same response field — one output value, three surfaces, no
per-surface decompilation (K-027 discipline). All emitted text
renders as inert text under the strict CSP (K-507).

**D-08 Ports and the extdecomp worker adapter: additive, not a
swap.** The existing boundary stays exactly as designed:

| Surface | Today | Under this ADR |
|---|---|---|
| `DecompilerPort` (`src/ports/decompiler.ts`) | `decompile(bytecode, codeHash, ctx)` → selector-linked snippets; error union per A-15 | Unchanged. No new method, no new error branch |
| extdecomp worker adapter (`src/adapters/extdecomp/…` behind `DecompilerPort`) | Isolated process per run, bytecode as sole input, pinned binary from configuration (A-27, I-11, M-01) | Unchanged and still the runtime deepening path |
| Own pipeline (this ADR) | — | Pure domain functions plus one detector plugin; no port, no process, no binary |
| Investigation tools (P-32) | Detector tools re-run registered detectors on frozen projections | The decompiler detector is one more registry entry, so Investigate can run it like any detector, with no ADR change |

Promotion is a separate, later decision: only after the harness in
section 7 reports the epic win may a story propose serving the
deepening from the own pipeline (S-085 covers the scoring side;
serving snippets through `DecompilerPort` from the pipeline would
need its own story proving the snippet contract against the port's
contract suite). Until then, enabling, disabling, or timing out
the decompiler plugin leaves score, probabilities, signals, and
evidence bit-identical (weight 0 until the model artifact names
it, P-05) — the plugin is display and structured evidence only.

## 6. The optional AI naming plugin

**D-11 AI naming is a separate optional plugin: suggestions only,
opt-in, display-only, never an analysis input.** Beside the
deterministic plugin, a second plugin may ask Muse Spark Open
(`meta-models/muse-spark-open-1026`) on hosted, through a port in
the personalize family, for human-readable function and variable
names for the emitted items. Its discipline copies P-27/P-28 and
the investigation quoting rules:

- Off by default and `not configured` without a hosted key, with
  zero provider calls in that state; the deterministic emission
  stands untouched.
- Input is the emitted items as quoted untrusted data under caps;
  output is a closed name-suggestion list keyed by emitted-item
  range, validated by a plain-check smart constructor with its
  JSON Schema descriptor (no zod, plugin ADR section 3.3).
- Suggestions render only as a labelled overlay (`Suggested name
  (AI)`, with provider and model id) over the deterministic text.
  The suggestion type has no field the pipeline, registry,
  scoring, or evidence paths read, and a suggestion never renames
  the underlying item: the deterministic name and its bytecode
  range stay visible and authoritative.
- Every failure branch (invalid output, oversize, provider
  mismatch, timeout) discards the suggestions whole and keeps the
  deterministic emission, with the fallback stated on the page.

Naming is Stretch (S-083) and cuts before any pipeline story: the
epic wins or loses on deterministic output alone.

## 7. extdecomp comparison: eval rules (NORMATIVE)

The comparison harness exists to score section 2 on a frozen
ERC-20 corpus. It is dev/eval only. The rules below are normative
for every doc, script, and story that touches the harness; they
are product-owner rules, not implementation suggestions.

**D-09 Local bytecode only, isolated home, no network or model
flags.** The harness invokes the decompiler binary named by the
`extdecomp_BIN` environment variable (an absolute path supplied at
eval time) and nothing else — the binary's location on the
operator machine is operator-local and is recorded in no tracked
file; tracked files name only the `extdecomp_BIN` variable. The
harness:

- runs only on local bytecode, as `extdecomp decompile
  <hex-or-file>` over corpus hex strings or fixture files;
- never passes any RPC flag (`-r` or otherwise), any target
  address, or any network option of any kind;
- never passes any LLM or naming flag of any kind;
- sets `HOME` to a fresh temp directory for every harness run, so
  the binary picks up no operator configuration;
- never reads, prints, copies, or cites any operator configuration
  file, including the bifrost configuration — the harness neither
  needs it nor touches it, and the isolated `HOME` is the
  enforcement, not a courtesy;
- supplies every other harness input (corpus, ground truth,
  thresholds) from frozen files in the repo.

**D-10 Pinned expected version, checked — never installed.** The
version in use is **0.9.1** (via bifrost). The harness checks the
binary before scoring: it runs `extdecomp --version` and compares
the reported version against the pinned expected version string
`0.9.1`. A mismatch fails the eval with the expected and reported
strings named. The check is a comparison, not a remedy: no doc,
script, or story in this project records any install or upgrade
instruction for the binary, and the harness itself never installs,
upgrades, downloads, or modifies any binary. extdecomp is already
present on the operator machine; this project only ever points at
it through `extdecomp_BIN` at eval time.

extdecomp is never a runtime dependency under this ADR: the runtime
stays the pure pipeline of section 4 and the existing
`DecompilerPort` adapters as designed in section 5. The runtime
test suite passes with `extdecomp_BIN` unset, and no runtime test
reaches the harness. Threats and countermeasures are H-37 onward
in `docs/threat-model.md` (section 5.14, STRIDE in section 4.18).

**D-12 Bounds and honest outcomes for every input.** Every
pipeline stage runs under the A-17 limits carried by the detector
manifest (input bytes, instruction and block caps, output bytes),
and every input ends in exactly one of: a structured result, a
labelled unstructured fallback (D-05) with its counts, or a typed
error. A hang, a panic, a guessed target, or a silently dropped
region is a defect against this rule, exercised by the fuzz target
in S-084.

## 8. Alternatives considered beyond section 3.1

- **Adopt a third-party decompiler library as a dependency.**
  Rejected: it would enter the locked supply chain (K-506, I-04)
  with a general-purpose scope the product does not need, and its
  output would still need the offset-mapping and plugin work that
  is most of this epic. Reopen if a library proves the section 2
  metrics on the frozen corpus and passes supply-chain review.
- **Skip SSA; structure directly from the stack CFG.** Rejected:
  token-pattern recognition (metric 3) reads named values and
  dominating checks; on a raw stack those patterns are
  order-sensitive stack archaeology in every detector. SSA is the
  cheapest normal form that makes patterns local. Reopen if a
  prototype structures the golden patterns without it.
- **Emit via the existing `CodeSnippet` evidence shape only.**
  Rejected as the whole design, kept as a consumer: snippets carry
  one selector and a line, but no per-statement range, so metric 4
  would be unrepresentable. Emitted items (D-06) carry the range;
  a snippet view can be derived for the deepening if a promotion
  story needs one.

## 9. Proposed requirements, stories, and open decisions

Proposed new K-IDs, entered in `docs/requirements.md` by their
first implementation story in the same change (threat-model
section 1, point 4):

| Proposed ID | Title | Priority |
|---|---|---|
| K-037 | Own EVM decompiler pipeline: deterministic CFG, SSA, structuring, and offset-mapped pseudo-Solidity for ERC-20 contracts (D-01–D-08, D-12) | MVP (for E-10, after S-046) |
| K-038 | extdecomp comparison on ERC-20: frozen corpus, four-metric table, local-only eval harness; optional AI naming overlay (D-09–D-11) | MVP harness / Stretch naming (for E-10) |
| K-521 | Decompiler safety: resolve-or-record jumps, interpreter-checked lifting, exact offset mapping, bounded pipeline, isolated eval harness (M-43–M-48) | MVP (for E-10) |

Stories (backlog epic E-10, test-first, each independently
pushable): S-078 CFG with stack-value resolution (MVP); S-079
stack-to-SSA with the interpreter property (MVP); S-080 structuring
and the offset-mapped emitter (MVP); S-081 detector-plugin wiring
with Expert/REST/MCP consumption (MVP); S-082 the extdecomp
comparison harness and metrics table (MVP); S-083 optional AI
naming (Stretch); S-084 corpus expansion and boundary hardening
(Stretch); S-085 promotion readiness through the model artifact
(Stretch). Named tests, dependencies, and cut order are in
`backlog.md`.

Open decisions for Jens (defaults chosen; none blocks S-078):

1. Corpus composition. Default: the frozen K-201 dataset's ERC-20
   contracts plus hand-verified token fixtures, split so no
   contract family appears on both sides of any ground-truth
   check. Jens confirms the corpus list when S-082 freezes it.
2. Win thresholds. Default: epic win = corpus-median win with no
   metric lost on more than a quarter of contracts (section 2).
   Set the exact minority bound with the corpus in S-082.
3. Promotion appetite. Default: the plugin stays display and
   evidence only through the submission; serving the deepening
   from the own pipeline is a post-submission story (section 5).
4. Naming in the demo. Default: naming ships dark (code present,
   toggle off) unless Jens enables it for the demo, as with the
   other opt-in AI surfaces.

## 10. Readiness

**READY FOR IMPLEMENTATION AFTER S-046 AND THE
SUBMISSION-CRITICAL PATH.** Epic E-10 may start once registry
exposure (S-046) is green — the plugin it ships through must exist
first — and once the submission-critical path no longer competes
for the same days; it never displaces that path. S-078 needs only
the landed `disassemble` sweep, so a prototype spike can run
earlier without committing the epic. Nothing in this ADR blocks
the plugin epic, the personalization headline, the Investigate
epic (E-09), or submission; if sequencing forces a choice, the
submission-critical path wins and E-10 slips as one sequence
(S-078–S-082) rather than shipping a half-lifted pipeline.


