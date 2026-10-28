---
id: dev.brandklipparen.sell-block
kind: detector
version: 1.0.0
tags: [honeypot, blacklist, owner-powers]
audience: [holder]
severity: { min: medium, max: high }
---
# PLUGIN.md: Sell-block detector (`dev.brandklipparen.sell-block`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

Sell-blocking honeypot branching in the transfer path. The proof needs
a caller-guarded writer storing a pair or router address to a constant
slot, and a transfer path that loads the same slot beside an equality
compare against the recipient, with calldata and a conditional jump that
can revert. An equality beside CALLER is access control, never a sell
branch. One finding names the first provable pair with its condition: a
mapping read beside the transfer reports `pair-mapping`, and no mapping
read reports `recipient-equals-stored`. A lone balance mapping read, an
equality with no stored address, or a stored address no privileged
writer controls never proves a sell block.

## Why it matters to you

A sell block lets you buy but never sell: the transfer succeeds one way
and reverts the other. The finding names the transfer function and the
compared storage reads, so you can see which stored address decides your
sale.

## What it cannot tell you

Which direction blocks: the bytecode proves a recipient-dependent
branch with a revert, not which side is the sell. An equality check
with no stored address, or with no privileged writer behind the stored
address, stays silent, since amount and allowance compares look the same
without it.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.sell-block:sell-block`, a short English title,
selector evidence with the PC offset wherever derivable, and the payload
holding `feature` and `condition`. The payload carries two fields,
`feature` and `condition`, where the condition names one of the two
listed outcomes, and every finding carries at least one `evidence` entry
with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

## Limitations / false positives

The branch is resolved structurally: the equality must sit beside the
loaded pair slot (within a short window) and away from CALLER, and a
privileged writer must store that slot. A fee that differs per
direction without a revert stays silent today. A finding never says
sales were blocked, only that the bytecode proves the branching shape.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.

Specificity update: the gated address needs a privileged writer, the
equality must sit beside the loaded slot, and caller-adjacent equality
(access control) no longer counts.
