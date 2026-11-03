---
id: dev.brandklipparen.hard-to-analyze
kind: detector
version: 1.0.0
tags: [honeypot, owner-powers]
audience: [holder, auditor]
severity: { min: low, max: high }
---
# PLUGIN.md: Obfuscated code (`dev.brandklipparen.hard-to-analyze`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-044).

## What it checks

A failed decompilation: at most one finding per analysis, naming the cause
the host derived from the decompiler failure (`timeout`, `resource-limit`,
`decompiler-error` or `obfuscated-structure`).

## Why it matters to you

When the analyzer cannot read the contract, neither can you. An
`obfuscated-structure` cause can mean deliberate hiding, and any cause
means the rest of the page reasons from less evidence than usual.

## What it cannot tell you

What the unreadable part does. This finding marks a coverage gap, not a
risk: treat it as a reason to be careful, not as proof of danger.

## Evidence format

At most one finding with the namespaced id
`dev.brandklipparen.hard-to-analyze:<cause>`, a short English title, the
first dispatcher selector as `evidence`, and the payload with `cause`.
Every finding carries at least one `evidence` entry. As a first-party
detector, its findings convert to calibrated signals through the model
artifact's cause mapping, and the artifact sets their effective weight,
which the plugin list exposes per plugin.

## Limitations / false positives

Large or unusual-but-benign bytecode can time out or exhaust the worker
without hiding anything. The `cause` names the failure, never the intent
behind it.

## Inputs

Declared inputs: `bytecode` (with its code hash). The host-supplied
`decompilerCause` fact travels beside it: the cause the host derived from
the DecompilerPort failure, or null when decompilation succeeded or no
worker is bound. A null cause yields no findings, and bytecode without
selectors yields no findings, since a finding without evidence is
unrepresentable.

## Version and changelog

Version 1.0.0. Initial release.
