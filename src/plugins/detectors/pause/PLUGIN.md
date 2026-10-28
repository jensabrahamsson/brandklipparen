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
The proof needs both at once: a caller-guarded function that stores a
constant slot, and the transfer path loading the same slot beside a
compare and a conditional jump that can revert. One finding names the
lowest provable slot with its mode: a one-way enable reports
`trading-toggle`, a flag that also writes zero reports `pause`, and
anything else reports `unknown`.

## Why it matters to you

A pause switch lets the owner freeze every transfer, and a trading
toggle that never opens again locks the same door. The finding names the
setter function and the transfer function it gates, with the mode the
stores prove, so you can see whether the flag flips both ways.

## What it cannot tell you

Whether the setter is still callable, or whether the flag currently
blocks transfers: the bytecode proves the mechanism, not the live state.
An ungated flag, or a gate with no privileged writer, stays silent
rather than guessed.

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

## Limitations / false positives

The mode is resolved structurally: a zero write anywhere means the flag
flips both ways, a nonzero constant write with no zero write means a
one-way enable, and a computed value means unknown. A gate that blocks
without a constant slot read stays silent. A finding never says the flag
was set, only that the bytecode proves the privileged path.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.
