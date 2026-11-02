---
id: dev.brandklipparen.pause
kind: detector
version: 1.0.0
tags: [pausing, honeypot, owner-powers]
audience: [holder]
severity: { min: medium, max: high }
---
# PLUGIN.md: Pause detector (`dev.brandklipparen.pause`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

A boolean flag set by a privileged caller that gates the transfer path.
The proof needs a caller-guarded writer storing a flag value (zero or a
small boolean constant) to a constant slot, and the transfer path
loading the same slot beside an equality compare, or beside an ISZERO
with no range compare between the load and the gate, plus a conditional
jump that can revert. The writer and the gate may share one merged
function. One finding names the lowest provable slot with its mode: a
one-way enable reports `trading-toggle`, a flag that also writes zero
reports `pause`, and anything else reports `unknown`.

## Why it matters to you

A pause switch lets the owner freeze every transfer, and a trading
toggle that never opens again locks the same door. The finding names the
setter function and the transfer function it gates, with the mode the
stores prove, so you can see whether the flag flips both ways.

## What it cannot tell you

Whether the setter is still callable, or whether the flag currently
blocks transfers: the bytecode proves the mechanism, not the live state.
An ungated flag, a gate with no privileged writer, an amount comparison,
or a computed rate or limit write that shares the setter shape, stays
silent rather than guessed.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.pause:pause`, a short English title, selector
evidence with the PC offset wherever derivable, and the payload holding
`feature`, `slot` and `mode`. The payload carries three fields,
`feature`, `slot` and `mode`, where the mode is one of the three named
outcomes, and every finding carries at least one `evidence` entry with
a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

When the scored proof above finds nothing, the detector re-runs a
tightened proof on the v2 reachability view (shared helpers included,
packed-bool writes in slot 0 resolved) and reports at most one weight-0
`fact` finding with the namespaced id
`dev.brandklipparen.pause:pause-extended` and the payload holding
`fact`, `slot`, `mode` and `proof: "extended"`. It never converts to a
signal and never enters the score; the UI labels it "not in score". The
tightened proof needs all of: the writer carries a caller check against
the proven owner slot (standard token entries never count); the gate
sits on a transfer/transferFrom path whose blocked side reverts;
and a packed writer must write the same slot and bit the gate reads —
including the old-solc shift built as `PUSH 0x02 PUSH k EXP` (2**k),
read back through DIV or SHR by the same shift with AND `0xff`, and
masked read-modify-write forms (`OR(AND(cur, NOT(mask)), 1 << k)`
setting the bit, `AND(OR(cur, mask), NOT(1 << k))` clearing it), which
resolve to the bit the trailing combining op decides.

## Limitations / false positives

The mode is resolved structurally: a zero write anywhere means the flag
flips both ways, a nonzero constant write with no zero write means a
one-way enable, and a computed value means unknown. A range compare
between the load and an ISZERO gate disqualifies the boolean reading, so
balance checks never count, while unrelated bounds elsewhere never veto
it. A setter that takes the flag as an argument is proven only in
extended analysis, and only when the stored value resolves to a
cleaned calldata bool (an `ISZERO ISZERO` normalization, an `AND 1`
mask, or an equality against 0 or 1); a raw calldata word proves no
boolean. A gate that blocks without a constant slot
read stays silent. A finding never says the flag was set, only that the
bytecode proves the privileged path.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.

Specificity update: the writer must store a flag value, the compare must
sit beside the loaded slot, and an ISZERO gate with a range compare
between the load and the gate no longer counts.

Extended analysis: when the scored proof finds nothing, the same proof
re-runs on the v2 reachability view with packed-bool writes resolved and
reports a weight-0 `fact` finding (`proof: "extended"`) that never
converts to a signal.

Precision update: the extended writer must prove a caller check against
the owner slot, only a reverting gate on the transfer path proper
counts, and a packed writer must write the same slot and bit the gate
reads (old-solc `PUSH 0x02 PUSH k EXP` shifts included).

Follow-up: masked read-modify-write stores prove the written bit too,
so a packed write with no constant beside the store still names its
candidate slot; a lone NOT-masked OR with no AND, or a write with no
shift idiom, still proves nothing.

SCAN-1 precision: the extended fact now reports only a flag that flips
both ways (`mode: pause`). A one-way enable (a nonzero write with no
zero write anywhere, such as a launch switch that only ever opens
trading) is a launch gate, not a freeze, so it stays silent in the
extended proof; the scored proof still names its `trading-toggle`
mode.

SCAN-P recall: the extended proof also proves a bool-argument setter
(one guarded entry storing the cleaned calldata bool writes both 0
and 1, so its mode is `pause`) and an early-return gate (the blocked
side halts before any store while the open side still reaches a
store). A raw calldata word, a fee-exempt mapping, and a one-way
enable still prove no pause.
