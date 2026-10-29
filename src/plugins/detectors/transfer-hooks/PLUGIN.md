---
id: dev.brandklipparen.transfer-hooks
kind: detector
version: 1.0.0
tags: [external-calls, honeypot, owner-powers]
audience: [holder, auditor]
severity: { min: low, max: high }
---
# PLUGIN.md: Transfer-hooks detector (`dev.brandklipparen.transfer-hooks`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

External calls reachable in the transfer path. One finding carries every
external CALL site in a transfer region as selector evidence with PC
offsets, with the best-effort target source of the first site: an
address loaded from storage, an argument from calldata, or unknown when
the window shows neither. Only the `call` kind to a non-constant,
non-caller target counts: static calls to precompiles (such as ecrecover
in permit) or balance lookups, delegatecalls, calls to hardcoded
constant addresses, and payouts to msg.sender never prove a hook.

## Why it matters to you

A transfer that calls out can run foreign logic on your sale: a hook
contract, an oracle, or a drain. The finding names the transfer function
and the call site, with where the target address comes from, so you can
see whether the destination is fixed or itself changeable.

## What it cannot tell you

What the called contract does: the bytecode proves the reachability and
the target source, not the callee behaviour. Whether the target address
in storage can still change is a separate owner-power question. A
transfer path with no external calls stays silent.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.transfer-hooks:call`, a short English title,
selector evidence with the PC offset wherever derivable, and the payload
holding `feature`, `callKind` and `target`. The payload carries three
fields, `feature`, `callKind` (always "call") and `target` (one of
"storage", "argument" or "unknown"), and every finding carries at least
one `evidence` entry with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

## Limitations / false positives

The target source is resolved structurally over a short window: msg.sender
(CALLER) in the window reads as a payout first, then a load from storage,
then a pushed constant and calldata, and anything else stays unknown. A
call through a computed jump target stays unknown. A finding never says
the call was made, only that the bytecode proves the transfer path
reaches it. Evidence names the function whose control-flow walk reaches
the site; sites no unique function reaches are skipped, never guessed to
a neighbouring function.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.

Specificity update: only external CALLs to non-constant targets prove
a hook; static calls, delegatecalls and constant-target calls stay
silent, and at most one finding is reported.
