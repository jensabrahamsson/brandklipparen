# PLUGIN.md: Hard-to-analyze detector (`dev.brandklipparen.hard-to-analyze`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-044).

## What it detects

A failed decompilation: at most one finding per analysis, naming the cause
the host derived from the decompiler failure (`timeout`, `resource-limit`,
`decompiler-error` or `obfuscated-structure`).

## Inputs

Declared inputs: `bytecode` (with its code hash). The host-supplied
`decompilerCause` fact travels beside it: the cause the host derived from
the DecompilerPort failure, or null when decompilation succeeded or no
worker is bound. A null cause yields no findings, and bytecode without
selectors yields no findings, since a finding without evidence is
unrepresentable.

## Output

At most one finding with the namespaced id
`dev.brandklipparen.hard-to-analyze:<cause>`, a short English title, the
first dispatcher selector as evidence, and the payload
`{ "cause": "<cause>" }`. Every finding carries at least one evidence
entry. Findings report at weight 0: the application service maps them to
calibrated signals through the frozen placeholder risk, and a finding
enters the score only after calibration names it.

## Limits

At most 1 finding, at most 8 evidence entries per finding, at most
32768 output bytes. The plugin is pure and synchronous: no network, no
secrets, no clock, no randomness.
