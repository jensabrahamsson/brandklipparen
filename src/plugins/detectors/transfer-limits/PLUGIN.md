---
id: dev.brandklipparen.transfer-limits
kind: detector
version: 1.0.0
tags: [transfer-limits, honeypot, owner-powers]
audience: [holder]
severity: { min: low, max: high }
---
# PLUGIN.md: Transfer-limits detector (`dev.brandklipparen.transfer-limits`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

Max-tx and max-wallet limits set by a privileged caller and compared in
the transfer path. The proof needs both at once: a caller-guarded
function that stores a constant limit slot, and the transfer path
loading the same slot beside a less than or greater than compare. One
finding names the lowest provable slot with its kind: a compare against
a balance mapping lookup reports `max-wallet`, a compare against a
calldata value with no mapping read reports `max-tx`, and anything else
reports `unknown`.

## Why it matters to you

A max-tx limit caps how much you can sell at once, and a max-wallet
limit caps how much you can hold: both let the owner shape the market
against you. The finding names the setter function and the transfer
function it constrains, with the kind the reads prove.

## What it cannot tell you

The live limit value: the bytecode proves the mechanism, not the number
in storage. Whether the setter is still callable is also unproven. A
compare with no privileged writer, or a privileged write the transfer
path never compares against, stays silent rather than guessed.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.transfer-limits:transfer-limits`, a short English
title, selector evidence with the PC offset wherever derivable, and the
payload holding `feature`, `slot` and `limitKind`. The payload carries
three fields, `feature`, `slot` and `limitKind`, where the kind is one
of the three named outcomes, and every finding carries at least one
`evidence` entry with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

## Limitations / false positives

The kind is resolved structurally: a mapping read beside the compare
means a balance lookup, calldata with no mapping read means an amount,
and anything else means unknown. A limit enforced by arithmetic instead
of a compare stays silent. A finding never says the limit was enforced,
only that the bytecode proves the privileged path.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.
