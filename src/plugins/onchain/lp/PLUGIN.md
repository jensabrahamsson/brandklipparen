---
id: dev.brandklipparen.onchain-lp
version: 1.0.0
tags: [liquidity]
audience: [holder, auditor]
severity: { min: low, max: high }
---
# PLUGIN.md: On-chain LP plugin (`dev.brandklipparen.onchain-lp`)

Version 1.0.0. Chain-reading feature plugin for Brandklipparen (session A).

This plugin is not in the detector registry and never affects the score:
weight 0, not calibrated in the current artifact. It reports display data
only, computed point-in-time at the analysis block for training and at the
current block for serving.

## What it checks

The LP supply buckets at the analysis block for V2-style pairs: the share
of LP supply that is burned (zero or dead address), held by a known locker
contract from the documented registry, held by the deployer or the owner,
or held by anyone else. Shares divide by the on-chain LP total supply.

## Why it matters to you

Burned or locker-held LP cannot be pulled: the team cannot drain the
pool. Deployer-held or owner-held LP can leave at any moment, which is
exactly the unlocked-liquidity rug.

## What it cannot tell you

V3 positions aggregate off-chain and are can't tell unless the driver
proves them, which it currently does not. A missing or zero LP supply, or
any failed balance read, is can't tell, never a zero share. Lockers
outside the small documented registry count as other, not as locked:
Team Finance and PinkLock stay can't-tell until their holding contracts
are proven from public docs.

## Evidence format

One bucket record with the pool kind, the five shares
(burned, locker, deployer, owner, other) and the can't-tell reason when
unknown. No finding enters scoring.

## Limitations / false positives

Only V2-style pairs bucket; newer pool kinds stay can't tell. The locker
registry is intentionally small: an unknown locker is other, and only the
registry entries count as locked. A locker that releases before the
analysis block still counts as locked at that block.

## Inputs

Declared inputs: the chain snapshot at the analysis block (LP total
supply and the holder balances for burn addresses, lockers, deployer and
owner). The drivers fetch the snapshot through the chain port; the
computation itself is pure and deterministic.

## Version and changelog

Version 1.0.0. Initial release. Weight 0, not calibrated.
