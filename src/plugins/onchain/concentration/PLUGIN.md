---
id: dev.brandklipparen.onchain-concentration
version: 1.0.0
tags: [supply]
audience: [holder, auditor]
severity: { min: low, max: high }
---
# PLUGIN.md: On-chain concentration plugin (`dev.brandklipparen.onchain-concentration`)

Version 1.0.0. Chain-reading feature plugin for Brandklipparen (session A).

This plugin is not in the detector registry and never affects the score:
weight 0, not calibrated in the current artifact. It reports display data
only, computed point-in-time at the analysis block for training and at the
current block for serving.

## What it checks

Holder concentration from Transfer logs between deployment and the
analysis block: the deployer and owner share of total supply and the
top-1 and top-10 holder shares, all excluding the pool, the burn
addresses and the known lockers. Shares divide by the on-chain total
supply at the analysis block.

## Why it matters to you

A handful of wallets holding most of the supply can crash the price by
selling together, and a large deployer or owner share means one key
controls the market.

## What it cannot tell you

Exchange wallets look like whales without being the team. Beyond the
documented log cap the result is can't tell, never a truncated ranking;
a truncated scan is also can't tell. A missing or zero total supply is
can't tell. Training replays transfers up to T0 + W; serving replays up
to now, which is a different regime for a token analysed long after
launch.

## Evidence format

One concentration record with the deployer share, the owner share, the
top-1 and top-10 shares, the ranked holder count and the can't-tell
reason when unknown. No finding enters scoring.

## Limitations / false positives

Only Transfer logs rebuild balances: rebases and hidden mints outside
Transfer events are missed. Related wallets are not clustered, so one
owner split across wallets looks distributed. Dust balances below the
ranking still count as holders.

## Inputs

Declared inputs: the decoded Transfer logs from deployment to the
analysis block plus the on-chain total supply. The drivers fetch the logs
through the chain port; the computation itself is pure and deterministic.

## Version and changelog

Version 1.0.0. Initial release. Weight 0, not calibrated.
