---
id: dev.brandklipparen.ownership
kind: detector
version: 1.0.0
tags: [owner-powers, supply]
audience: [holder, auditor]
severity: { min: low, max: high }
---
# PLUGIN.md: Ownership (`dev.brandklipparen.ownership`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

The owner slot, the privileged functions and the renounce path. The
owner slot is the lowest constant slot loaded beside a caller compare;
privileged functions are the caller-guarded regions; a renounce path is
any store of zero to the owner slot. One finding names the owner slot
with the privileged function count, and a second finding names the
renounce store when one exists.

## Why it matters to you

Every other owner power in this pack flows from the owner seat: who
holds it decides who can mint, block, tax or pause you. A renounce path
shows the seat can be given up. The findings name the functions that
check the seat, so you can count the powers behind it.

## What it cannot tell you

Who holds the seat right now: the live owner value is read by the
analysis service through the chain port after detection and shown beside
the finding when the analysis runs at a pinned block, and unknown
otherwise. Whether the slot really is an owner, rather than another
caller-checked role, is also unproven. Bytecode with no caller compare
stays silent rather than guessed.

## Evidence format

A list with at most two findings with the namespaced ids
`dev.brandklipparen.ownership:owner-slot` and
`dev.brandklipparen.ownership:renounce`, each with a short English
title, selector evidence with the PC offset wherever derivable, and the
payload holding `feature`, `slot` and `privilegedFunctions`. The payload
carries three fields, `feature`, `slot` and `privilegedFunctions`,
where the renounce finding carries no function count, and every finding
carries at least one `evidence` entry with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

## Limitations / false positives

The seat is resolved structurally: a constant slot beside a caller
compare counts, a role kept in a hashed mapping does not. A renounce
through an indirect write stays silent. A finding never says the seat
was used, only that the bytecode proves the guarded shape.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.
