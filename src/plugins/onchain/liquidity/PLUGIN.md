---
id: dev.brandklipparen.onchain-liquidity
version: 1.0.0
tags: [liquidity]
audience: [holder, auditor]
severity: { min: low, max: medium }
---
# PLUGIN.md: On-chain liquidity plugin (`dev.brandklipparen.onchain-liquidity`)

Version 1.0.0. Chain-reading feature plugin for Brandklipparen (session A).

This plugin is not in the detector registry and never affects the score:
weight 0, not calibrated in the current artifact. It reports display data
only, computed point-in-time at the analysis block for training and at the
current block for serving.

## What it checks

Liquidity size in quote-asset terms at the analysis block for V2-style
pairs: WETH reserves in raw units, or stablecoin reserves as USD with a
WETH normalisation through the canonical WETH/USDC V2 reserves read at
the same block (documented deterministic conversion).

## Why it matters to you

Thin liquidity means your own trade moves the price and a modest sell
drains the pool. Size in quote terms is the number that tells you how
much can leave before the price breaks.

## What it cannot tell you

V3 pools stay can't tell: tick math is too costly to prove here. A
stablecoin quote normalises through one canonical pair, so a depegged
stable still reports at one dollar. Unreadable reserves are can't tell,
never zero.

## Evidence format

One size record with the quote asset, the raw quote amount, the WETH
amount when normalisable and the USD amount for stablecoins. No finding
enters scoring.

## Limitations / false positives

Only V2-style reserves size; newer pool kinds stay can't tell. The WETH
normalisation is approximate floating point for sizing, not accounting
precision. Single-sided or imbalanced pools report the quote side only.

## Inputs

Declared inputs: the chain snapshot at the analysis block (pool
reserves, token ordering and the canonical pair reserves for the
conversion). The drivers fetch the snapshot through the chain port; the
computation itself is pure and deterministic.

## Version and changelog

Version 1.0.0. Initial release. Weight 0, not calibrated.
