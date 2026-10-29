---
id: dev.brandklipparen.capability
kind: detector
version: 1.0.0
tags: [owner-powers, upgradeability]
audience: [holder, auditor]
severity: { min: low, max: high }
---
# PLUGIN.md: Capability detector (`dev.brandklipparen.capability`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-043).

## What it checks

Structural ERC-20 bytecode capabilities, one finding per capability key:

- `selfdestruct`: the contract can destroy itself and redirect funds.
- `delegatecall`: the contract can run foreign code in local storage context.
- `call`: the contract can forward calls to an outside contract.
- `storage-write`: the contract can write storage.

Detection fires solely on opcode presence in the reachable disassembly with
PUSH data skipped, so constants never count as opcodes. No count, share, or
size cutoff steers detection: one occurrence is enough. A CALL that pays
out to msg.sender stays silent: withdrawing is not an outside-contract
power.

## Why it matters to you

These capabilities decide what the owner can still do after you buy. A
selfdestruct or delegatecall capability can drain or redirect funds, and a
storage-write capability can change the rules under you.

## What it cannot tell you

Whether a detected capability is reachable, guarded by ownership checks,
or ever used. Presence is not reachability: dead code still counts.

## Evidence format

A list of findings with the namespaced id
`dev.brandklipparen.capability:<capability-key>`, a short English title,
selector evidence with the PC offset wherever derivable, and the payload
`{ "capability": "<key>" }`. The payload carries one field, `capability`,
and every finding carries at least one `evidence` entry with a `selector`.
Each evidence entry names the dispatcher function whose control-flow walk
reaches the opcode occurrence. An occurrence no unique function reaches
(dispatcher preamble, fallback, shared tails jumped into from several
bodies, dead code) is skipped, never guessed: a finding never cites a
selector the occurrence does not sit in. As a first-party detector, its
findings convert to calibrated signals through the versioned model
artifact, and the artifact sets their effective weight, which the plugin
list exposes per plugin.

## Who can activate it

The converted signal names the proven owner address as its changer only
when the ownership evidence plus the live owner word proves one. Code
without a proven controller carries changerless temporality: the text
says the code can activate the capability later but names no account.
The analysed contract address is never named as the changer.

## Limitations / false positives

The plugin sees opcodes, not intent: a capability in unreachable code, a
guarded admin function, or a standard proxy pattern still reports. A
finding never says the capability was used, only that the bytecode
contains it. A skipped preamble occurrence means the capability was seen
but could not be attributed, never that it is absent.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors and the disassembly itself through the shared domain helpers.

## Version and changelog

Version 1.0.0. Initial release.
