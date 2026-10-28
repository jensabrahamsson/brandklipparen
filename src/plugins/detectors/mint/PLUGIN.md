---
id: dev.brandklipparen.mint
kind: detector
version: 1.0.0
tags: [mint, supply, owner-powers]
audience: [holder]
severity: { min: medium, max: high }
---
# PLUGIN.md: Mint detector (`dev.brandklipparen.mint`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

A privileged caller-gated write that grows a supply-like slot read in
the transfer path. The proof needs all three at once: a function guarded
by a caller check that stores to a constant slot, the transfer path
loading the same slot, and addition arithmetic beside the supply flow.
One finding names the lowest provable slot.

## Why it matters to you

A privileged mint lets the owner create new tokens from nothing and sell
them into your position. The finding names the function that writes the
supply and the transfer function that reads it, so you can see both ends.

## What it cannot tell you

Whether the privileged function is still callable: ownership may be
renounced, the function may be unreachable, or the slot may track
something other than supply. An unguarded write, or a guarded write to
a slot the transfer path never reads, stays silent rather than guessed.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.mint:mint`, a short English title, selector evidence
with the PC offset wherever derivable, and the payload holding `feature`
and `slot`. The payload carries two fields, `feature` and `slot`, and
every finding carries at least one `evidence` entry with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

## Limitations / false positives

The slot is resolved structurally: a direct constant store with no hash
mixing counts, anything else stays unknown. A mint through a hashed
mapping slot, or arithmetic the linear scan does not recognise, stays
silent. A finding never says the mint was used, only that the bytecode
proves the privileged path.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.
