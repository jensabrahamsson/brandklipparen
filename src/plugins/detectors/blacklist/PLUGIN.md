---
id: dev.brandklipparen.blacklist
kind: detector
version: 1.0.0
tags: [blacklist, honeypot, owner-powers]
audience: [holder]
severity: { min: medium, max: high }
---
# PLUGIN.md: Blacklist detector (`dev.brandklipparen.blacklist`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

A transfer gate on a mapping entry that a privileged caller can set.
The proof needs both at once: the transfer path reads a mapping entry
beside an equality compare, or beside an ISZERO with no range compare
between the load and the gate, with a conditional jump that can revert;
and a caller-guarded function writes a mapping slot. The two may share
one merged function. One finding names the first provable pair. A plain
balance check or an allowance check never counts: both compile to a
range compare closed by ISZERO, which the ordered veto excludes.

## Why it matters to you

A privileged block list lets the owner stop your sale while letting
other transfers through. The finding names the function that writes the
entry and the transfer function that reads it, so you can see both ends.

## What it cannot tell you

Whether the gate is a block list or an allow list, whether the
privileged function is still callable, or which addresses are listed:
the bytecode proves the mechanism, not the policy. A gated read with no
privileged writer, or a privileged mapping write the transfer path never
reads, stays silent rather than guessed.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.blacklist:blacklist`, a short English title,
selector evidence with the PC offset wherever derivable, and the payload
holding `feature`. The payload carries one field, `feature`, and every
finding carries at least one `evidence` entry with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

## Limitations / false positives

The mapping shape is resolved structurally: a hash-mixed access counts,
a direct constant slot read in the transfer path does not. The gate
compare must sit beside the loaded entry (within a short window), not
merely in the same function. A gate that blocks by reverting with no
value compare, or by arithmetic instead of a compare, stays silent. A
finding never says the gate was used, only that the bytecode proves the
privileged path.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.

Specificity update: the gate compare must sit beside the loaded entry,
and ISZERO gates with a range compare between the load and the gate
(balance and allowance checks) no longer count.
