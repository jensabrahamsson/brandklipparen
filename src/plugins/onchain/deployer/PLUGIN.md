---
id: dev.brandklipparen.onchain-deployer
version: 1.0.0
tags: [supply]
audience: [holder, auditor]
severity: { min: low, max: medium }
---
# PLUGIN.md: On-chain deployer plugin (`dev.brandklipparen.onchain-deployer`)

Version 1.0.0. Chain-reading feature plugin for Brandklipparen (session A).

This plugin is not in the detector registry and never affects the score:
weight 0, not calibrated in the current artifact. It reports display data
only, identical for every analysis window of a token.

## What it checks

Provenance and timing: the deployment block found by binary search over
historical code reads, the deployer as the sender of the top-level
creation transaction at that block, and the blocks from deployment to T0.
A token created by a factory internally records the factory as the
creator and the deployer as can't tell unless provable.

## Why it matters to you

The deployer often keeps a share and the keys to the owner seat. A
factory-created token hides the human behind it, which changes who you
are trusting.

## What it cannot tell you

Internal factory creations name no deployer: the provenance says
factory-or-internal and the deployer is can't tell, never the factory
address. An unreadable receipt history is unknown, never a guessed
factory claim. T0 itself is reported by the timing record, not proven here.

## Evidence format

One provenance record with the deployment block, the deployer address or
can't tell, the provenance (`creation-tx`, `factory-or-internal` or
`unknown`) and the blocks from deployment to T0. No finding enters
scoring.

## Limitations / false positives

Only top-level creations prove a deployer; anything created by an
internal call stays can't tell. The binary search trusts archive reads;
an endpoint that cannot serve ancient blocks reports unknown.

## Inputs

Declared inputs: historical code reads for the binary search and the
block receipts at the deployment block. The drivers fetch them through
the chain port; the block arithmetic itself is pure and deterministic.

## Version and changelog

Version 1.0.0. Initial release. Weight 0, not calibrated.
