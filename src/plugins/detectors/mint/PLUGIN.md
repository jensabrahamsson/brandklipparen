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

A privileged mint that grows supply and credits a balance. The scored
proof needs a caller-guarded writer that stores to a constant slot
with addition beside the store (the supply increase) and a mapping store
beside calldata in the same writer region (the balance credit keyed by
an address the caller chose), plus a transfer path that loads the same
slot beside addition arithmetic. The writer and the reader may share one
merged function, with distinct functions preferred when both prove the
same slot. One finding names the lowest provable slot.

When the scored proof finds nothing, the extended analysis re-runs the
search on the reachability v2 view and reports a weight-0 fact that
never counts in the score. The extended proof drops the transfer-path
read: the supply slot is the constant slot the `totalSupply()` region
loads, and the guard may be an owner check, a minter role-slot check
(`require(msg.sender == <slot>)`), or an auth-mapping check
(`require(wards[msg.sender] == 1)`). The payload names the guard kind
in `auth`, the credit recipient in `recipient` (`argument` for a
caller-chosen address, `stored` for a stored account such as the
owner), and whether a cap compare sits in the writer in `capped`.

## Why it matters to you

A privileged mint lets the owner create new tokens from nothing and sell
them into your position. The finding names the function that writes the
supply and the transfer function that reads it, so you can see both ends.

## What it cannot tell you

Whether the privileged function is still callable: ownership may be
renounced, the function may be unreachable, or the slot may track
something other than supply. A guarded write with no supply increase, no
balance credit, or no transfer read of the slot stays silent rather than
guessed, as does a fee, pause or limit pattern that shares the same
writer shape.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.mint:mint` (scored) or
`dev.brandklipparen.mint:mint-extended` (weight-0 fact), a short English
title, selector evidence with the PC offset wherever derivable, and a
payload holding `slot`. The scored payload carries `feature` and `slot`;
the extended payload carries `fact`, `slot`, `auth`, `recipient`,
`capped` and `proof: "extended"`. Every finding carries at least one
`evidence` entry with a `selector`. As a first-party detector, its
scored findings convert to calibrated signals through the versioned
model artifact, and the artifact sets their effective weight, which the
plugin list exposes per plugin. Extended facts never convert and stay
at weight 0.

## Limitations / false positives

The slot is resolved structurally: a push directly beside the access
counts as a constant slot, a hash in the short window counts as a
mapping slot, and anything else stays unknown. The arithmetic must sit
beside the loaded slot value (within a short window), not merely in the
same function. A mint through a hashed mapping slot, a credit the linear
scan does not recognise, or arithmetic the linear scan does not
recognise, stays silent. A finding never says the mint was used, only
that the bytecode proves the privileged path.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.

Specificity update: the proof now needs a supply increase (addition
beside the store) with a balance credit to a caller-chosen address, and
the transfer arithmetic must sit beside the loaded slot.
