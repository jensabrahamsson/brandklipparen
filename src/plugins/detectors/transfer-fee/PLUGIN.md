---
id: dev.brandklipparen.transfer-fee
kind: detector
version: 1.0.0
tags: [fees, honeypot, owner-powers]
audience: [holder]
severity: { min: low, max: high }
---
# PLUGIN.md: Transfer-fee detector (`dev.brandklipparen.transfer-fee`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

A fee rate set by a privileged caller and deducted in the transfer path.
The proof needs a caller-guarded writer storing a caller-chosen rate (a
computed, non-constant value) to a constant slot, and the transfer path
loading the same slot beside multiply or divide arithmetic (the rate
application) with a subtraction in the region (the deduction from the
transfer amount). The writer and the reader may share one merged
function. One finding names the lowest provable slot and reports the
max-fee bound when the setter bounds it with a constant compare, or an
unknown bound when it does not.

When the scored proof finds nothing, the extended analysis re-runs the
search on the reachability v2 view and reports a weight-0 fact that
never counts in the score. The extended proof resolves the rate slot
through swaps and stack shuffles the scored beside window cannot see,
or through a transfer condition that multiplies or divides the loaded
slot far from its load, and it reports the rate slot with the cap slot
when a second guarded slot clamps the fee. Fee arithmetic with no
privileged writer, or a hardcoded constant rate, stays silent.

## Why it matters to you

A fee on every transfer takes a cut of your sale, and a 100 percent fee
is a honeypot: you can buy but never sell for value. The finding names
the setter function and the transfer function it feeds, with the bound
the setter proves, so you can see the worst case.

## What it cannot tell you

The true maximum when the setter carries no constant compare: then the
bound is reported unknown rather than guessed. Whether the setter is
still callable, or whether the slot really is a fee, is also unproven.
A fee slot the transfer path never computes with beside the loaded slot,
a hardcoded constant rate no caller can change, or fee arithmetic with
no privileged writer, stays silent rather than guessed.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.transfer-fee:transfer-fee` (scored) or
`dev.brandklipparen.transfer-fee:transfer-fee-extended` (weight-0
fact), a short English title, selector evidence with the PC offset
wherever derivable, and a payload holding `slot`. The scored payload
carries `feature`, `slot` and `maxFeeBasisPoints`, where a null bound
means the cap could not be determined; the extended payload carries
`fact`, `slot`, `capSlot` and `proof: "extended"`, where a null cap
slot means no second guarded slot clamps the fee. Every finding carries
at least one `evidence` entry with a `selector`.
As a first-party detector, its scored findings convert to calibrated
signals through the versioned model artifact, and the artifact sets
their effective weight, which the plugin list exposes per plugin.
Extended facts never convert and stay at weight 0.

## Limitations / false positives

The bound is the largest sane constant in a bounding setter, capped at
one hundred percent: an exotic cap shape stays unknown. The fee shape is
resolved structurally: the rate computation must sit beside the loaded
slot value (within a short window), not merely in the same function, and
the writer must store a caller-chosen value. A fee through a hashed
mapping slot, or a rate the linear scan does not recognise, stays
silent. A finding never says the fee was charged, only that the bytecode
proves the privileged path.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.

Specificity update: the writer must store a caller-chosen rate and the
rate arithmetic must sit beside the loaded slot, with a subtraction for
the deduction.
