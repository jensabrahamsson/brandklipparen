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

External calls reachable in the transfer path. One finding per call
kind present in a transfer region carries every call site of that kind
as selector evidence with PC offsets, with the best-effort target source
of the first site: an address loaded from storage, a pushed constant
address, an argument from calldata, or unknown when the window shows
none of these.

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

A list with at most one finding per call kind with the namespaced id
`dev.brandklipparen.transfer-hooks:call`,
`dev.brandklipparen.transfer-hooks:staticcall` or
`dev.brandklipparen.transfer-hooks:delegatecall`, each with a short
English title, selector evidence with the PC offset wherever derivable,
and the payload holding `feature`, `callKind` and `target`. The payload
carries three fields, `feature`, `callKind` and `target`, where the kind
and the target each name one of the listed outcomes, and every finding
carries at least one `evidence` entry with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

## Limitations / false positives

The target source is resolved structurally over a short window: a load
from storage wins over a pushed constant and calldata, and anything else
stays unknown. A call through a computed jump target stays unknown. A
finding never says the call was made, only that the bytecode proves the
transfer path reaches it.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.
