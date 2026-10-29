---
id: dev.brandklipparen.onchain-owner
version: 1.0.0
tags: [owner-powers]
audience: [holder, auditor]
severity: { min: medium, max: high }
---
# PLUGIN.md: On-chain owner plugin (`dev.brandklipparen.onchain-owner`)

Version 1.0.0. Chain-reading feature plugin for Brandklipparen (session A).

This plugin is not in the detector registry and never affects the score:
weight 0, not calibrated in the current artifact. It reports display data
only, computed point-in-time at the analysis block for training and at the
current block for serving.

## What it checks

The owner seat at the analysis block: the owner slot the ownership
detector proves from bytecode is read at the pinned block through the
chain port (falling back to the `owner()` answer when no slot is proven),
and the word is classified as renounced (zero or the dead address), an
externally owned account (no code), a contract (code present), or a Safe
multisig (a contract whose `masterCopy()` answer names a registered Safe
singleton). Anything unreadable is unknown.

## Why it matters to you

Every other owner power flows from this seat: who holds it decides who
can mint, block, tax or pause you. A renounced seat cannot come back, a
Safe seat needs several keys to move, and a single externally owned seat
can move at any moment.

## What it cannot tell you

Whether the seat was used, only who holds it at the analysis block. A
contract owner that is not a registered Safe singleton is reported as a
contract without further identification. When the slot proof and the
`owner()` answer are both missing, the status is can't tell, never
guessed. Training reads the seat at T0 + W; serving reads it now, which
is a different regime for a token analysed long after launch.

## Evidence format

One owner record with the status (`renounced`, `eoa`, `contract`,
`safe` or `unknown`), the owner address when known, the Safe singleton
when the seat is a Safe, and the can't-tell reason when unknown. No
finding enters scoring.

## Limitations / false positives

The slot proof comes from bytecode: a role kept in a hashed mapping is
not a proven slot. The Safe check names only registered singletons, so a
newer or custom multisig reports as a contract. Proxy owners resolve to
the proxy address, not the implementation owner.

## Inputs

Declared inputs: the chain snapshot at the analysis block (owner word,
code presence, `masterCopy()` answer). The drivers fetch the snapshot
through the chain port; the computation itself is pure and deterministic.

## Version and changelog

Version 1.0.0. Initial release. Weight 0, not calibrated.
