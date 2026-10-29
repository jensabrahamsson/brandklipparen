---
id: dev.brandklipparen.onchain-age
version: 1.0.0
tags: [supply]
audience: [holder, auditor]
severity: { min: low, max: medium }
---
# PLUGIN.md: On-chain age plugin (`dev.brandklipparen.onchain-age`)

Version 1.0.0. Chain-reading feature plugin for Brandklipparen (session A).

This plugin is not in the detector registry and never affects the score:
weight 0, not calibrated in the current artifact. It reports display data
only, computed point-in-time at the analysis block for training and at the
current block for serving.

## What it checks

Token age in blocks at the analysis block: the analysis block minus the
deployment block found by binary search. Age means age at the analysis
block, never age today.

## Why it matters to you

Brand-new tokens fail differently from established ones: age at the
analysis moment tells you which regime you are looking at. Old tokens
from a token list carry era confounding, which session B measures from
the recorded deployment and analysis blocks.

## What it cannot tell you

Age is a clock, not a verdict: old scams and young successes both exist.
An unreadable deployment block is can't tell, never zero. The absolute
block number is recorded for era analysis and is never a model feature.

## Evidence format

One age record with the deployment block, the analysis block and the
age in blocks. No finding enters scoring.

## Limitations / false positives

The deployment search trusts archive reads; an endpoint that cannot
serve ancient blocks reports can't tell. Redeployed proxies keep the
proxy age, not the implementation age.

## Inputs

Declared inputs: the deployment block and the analysis block. The
drivers resolve both through the chain port; the subtraction itself is
pure and deterministic.

## Version and changelog

Version 1.0.0. Initial release. Weight 0, not calibrated.
