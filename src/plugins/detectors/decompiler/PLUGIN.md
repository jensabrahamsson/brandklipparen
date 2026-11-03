---
id: dev.brandklipparen.decompiler
kind: detector
version: 1.0.0
tags: [external-calls]
audience: [holder, auditor]
severity: { min: low, max: medium }
---
# PLUGIN.md: Decompiler (`dev.brandklipparen.decompiler`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-081).

## What it checks

The own deterministic ERC-20 decompiler pipeline (disassembly to CFG,
stack-to-SSA lifting, structuring, pseudo-Solidity emission): one finding
per dispatcher function entry, carrying the function name, selector, entry
PC, exact bytecode range, token-pattern annotations, cause label and the
contract-wide unresolved-jump count.

## Why it matters to you

When the analyzer can show the reconstructed function beside its exact
bytecode range, you can check every claim against the bytes. The
annotations name the token shapes the pipeline recognised (for example a
guarded state update), and the cause label names the ones it left as a
labelled region instead of guessing.

## What it cannot tell you

The emission is a readable reconstruction, not the original source. A
function without a token-pattern annotation is plain pseudo-Solidity with
zero annotations, never a verdict. Suggested names from the optional
naming overlay are display only and never enter this finding.

## Evidence format

One finding per decompiled function with the namespaced id
`dev.brandklipparen.decompiler:<selector>`, a short English title, the
function selector as `evidence` with the entry PC as offset, and the
payload with `selector`, `name`, `entryPc`, `startPc`, `endPc`,
`annotations`, `cause` and `unresolvedJumps`. Every finding carries at
least one `evidence` entry. Findings report at weight 0: the application
service leaves score, probabilities and signals unchanged until the
calibration artifact names this plugin.

## Limitations / false positives

Bytecode without a dispatcher shape yields no findings, and an irreducible
region emits the labelled fallback form instead of a structured guess. The
unresolved-jump count names the regions the structuring stage labelled
rather than read; a high count means less of the contract was structured,
not more risk.

## Inputs

Declared inputs: `bytecode` (with its code hash). No other fact is read.

## Version and changelog

Version 1.0.0. Initial release.
