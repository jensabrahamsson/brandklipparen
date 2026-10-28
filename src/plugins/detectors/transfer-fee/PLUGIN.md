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

A fee slot set by a privileged caller and used arithmetically in the
transfer path. The proof needs both at once: a caller-guarded function
that stores a constant slot, and the transfer path loading the same slot
beside multiply or divide arithmetic. One finding names the lowest
provable slot and reports the max-fee bound when the setter bounds it
with a constant compare, or an unknown bound when it does not.

## Why it matters to you

A fee on every transfer takes a cut of your sale, and a 100 percent fee
is a honeypot: you can buy but never sell for value. The finding names
the setter function and the transfer function it feeds, with the bound
the setter proves, so you can see the worst case.

## What it cannot tell you

The true maximum when the setter carries no constant compare: then the
bound is reported unknown rather than guessed. Whether the setter is
still callable, or whether the slot really is a fee, is also unproven.
A fee slot the transfer path never computes with, or fee arithmetic
with no privileged writer, stays silent rather than guessed.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.transfer-fee:transfer-fee`, a short English title,
selector evidence with the PC offset wherever derivable, and the payload
holding `feature`, `slot` and `maxFeeBasisPoints`. The payload carries
three fields, `feature`, `slot` and `maxFeeBasisPoints`, where a null
bound means the cap could not be determined, and every finding carries
at least one `evidence` entry with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

## Limitations / false positives

The bound is the largest sane constant in a bounding setter, capped at
one hundred percent: an exotic cap shape stays unknown. The fee shape is
resolved structurally: a direct constant slot read with multiply or
divide counts, anything else stays silent. A finding never says the fee
was charged, only that the bytecode proves the privileged path.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.
