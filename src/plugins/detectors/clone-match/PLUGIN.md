---
id: dev.brandklipparen.clone-match
kind: detector
version: 1.0.0
tags: [honeypot]
audience: [holder, trader]
severity: { min: medium, max: high }
---
# PLUGIN.md: Clone-match (`dev.brandklipparen.clone-match`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-044).

## What it checks

A known trap-template hit from the clone index: at most one finding per
analysis, naming the matched template group with its similarity share and
prior count.

## Why it matters to you

Trap templates get reused. A bytecode match against a known honeypot
template means someone has run this exact trap before, so you can walk
away before it runs on you.

## What it cannot tell you

Whether this deployment behaves exactly like the matched template: a
high-similarity clone can still differ in the details that decide the
outcome. The match is a warning, not a verdict.

## Evidence format

At most one finding with the namespaced id
`dev.brandklipparen.clone-match:<group>`, a short English title, the first
dispatcher selector as `evidence` with the PC offset wherever derivable, and
the payload with `similarity`, `group`, and `priorCount`. Every finding
carries at least one `evidence` entry. As a first-party detector, its
findings convert to calibrated signals through the versioned clone
mapping in the model artifact, and the artifact sets their effective
weight, which the plugin list exposes per plugin.

## Limitations / false positives

A miss or an index failure yields no findings: silence means no match,
not safety. Common boilerplate (proxies, standard libraries) can
resemble a template without sharing its trap.

## Inputs

Declared inputs: `bytecode` (with its code hash) and `cloneMatch`. The host
looks the hit up through CloneIndexPort before detection runs and hands it
over as the `cloneMatch` fact; a miss or an index failure arrives as null
and yields no findings. The plugin derives the evidence selector itself
through the shared domain helper.

## Version and changelog

Version 1.0.0. Initial release.
