# How it was built

Brandklipparen was built by one person working with a team of
AI agents. This page says honestly who did what, how the work
was delegated and checked, and where the first approach failed.

## Who did what

- One person, the owner, set the goals and the boundaries.
- The owner made every product decision.
- AI agents did the implementation and the review.
- About 95 percent of the code was written by Meta's Muse
  models: `muse-spark-1.3` for most units, and larger Muse
  models for hard units.
- When the weekly Muse quota ran out on the final evening,
  other models finished the last units: merges, the copy pass
  and the docs.
- Independent models from other providers reviewed the work.
  They are not named here; the owner read their findings and
  decided what to act on.
- No agent decided the product. Agents proposed, built and
  checked; the owner decided.

## How the work was delegated

The build used the delegation approach described in
[jstack](https://github.com/jensabrahamsson/jstack):

- Each unit of work was given as a mandate with an end time.
- A durable written log recorded work and decisions, so no
  decision lived only in a chat window.
- Gates were bound to exact commits: a result counted only
  for the commit it was checked on.
- Decisions were made asynchronously. A blocked lane wrote
  down its question and kept going where it could.
- Builder agents worked in isolated git worktrees, up to
  five parallel lanes, each with its own end-to-end test port.
- Landing used a short lock: fetch, rebase, push, release.
  No long-lived tangle of branches waiting to merge.
- A memory watchdog paused lanes before the machine ran out
  of memory, instead of losing work to a crash.

## Gates before every push

Nothing was pushed on trust. Before every push, the tree had
to pass:

- Lint.
- Typecheck for the server and for the web app.
- An English-only check on tracked files.
- A vendor-name check: no AI vendor or product is named
  anywhere except Meta and the configured model id.
- Dependency rules between modules.
- A plugin audit.
- Unit tests and web tests.
- End-to-end browser tests.
- A secret scan.
- A blocklist push guard.
- An author identity check.

A red gate stopped the push. The fix landed first, then the
whole gate ran again on the new commit.

## Hard security rules

- Keys are only ever reached through `*_FILE` pointers: an
  environment variable names a file, and the program reads
  the key from that file.
- Keys never appear in prompts, logs or copy.
- Agents never read key files, environment files or the
  owner's private notes.
- Fixtures and tests use synthetic addresses only.

These rules were not guidelines. The checks above enforced
the parts that can be checked mechanically, and the mandate
for every unit repeated the rest.

## Measuring against reality

This is where the build learned its main lesson.

The detectors were first tuned on synthetic fixtures, and
they looked fine there. Measured on real tokens, they
missed much. Synthetic contracts are tidier than real ones.

So the team built labelled sets of real Ethereum tokens:

- A development set, labelled from verified source.
  Disputed labels were adjudicated by an independent model.
- A separate validation set, kept apart from tuning.
- A final test set, unseen until the end.

The blacklist detector shows why this mattered. After one
round of tuning it scored well on the development set and
poorly on unseen tokens: it had overfitted. It matched the
shape of a blacklist flag instead of asking whether the flag
actually stops a transfer.

The rework made the detector reason about the transfer path:
a blacklist only counts when the flag is read in that path
and can reach a revert. On 87 real tokens the result moved:

| Detector | Found | False alarms | Missed |
| --- | ---: | ---: | ---: |
| Blacklist, before the rework | 18 | 3 | 13 |
| Blacklist, after the rework | 28 | 0 | 3 |
| Pause, same 87 tokens | 29 | 1 | 3 |

Final test-set results: see [Calibration and limits](../README.md#calibration-and-limits).

## Lesson: the score must agree with the evidence

The calibrated model alone could not separate the classes well.
Before the floor, a token with a proven blacklist and pause
scored 29, Low.

The score must agree with its evidence, so the floor is applied
after the model. A proven power to stop holders selling or moving
tokens lifts an unrenounced owner to at least 60 (High). A proven
risky capability lifts it to at least 30 (Elevated). The floor
never lowers a score.

On 30 unseen tokens, every token with an active owner and a proven
blocking power scored High.

## The last days

Two days before the deadline the owner froze new features.
The remaining time went to accuracy, the core flow of
pasting an address and reading the result, the film and
the deploy. Freezing hurt; several good ideas were left
out. It was still the right call: a scanner that is wrong
on real contracts helps nobody.

## The film and the mascot

The narrator voice in the demo film is synthetic, not a
recorded person.

The mascot is a chess knight named Brandklipparen, after
the royal horse of Sweden's Charles XI and XII, a horse
that never flinched at fire. The tool is named for the same
reason: it stays calm and reads the contract while the
market is on fire.
