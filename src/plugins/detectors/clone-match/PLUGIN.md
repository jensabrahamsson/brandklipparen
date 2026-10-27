# PLUGIN.md: Clone-match detector (`dev.brandklipparen.clone-match`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-044).

## What it detects

A known trap-template hit from the clone index: at most one finding per
analysis, naming the matched template group with its similarity share and
prior count.

## Inputs

Declared inputs: `bytecode` (with its code hash) and `cloneMatch`. The host
looks the hit up through CloneIndexPort before detection runs and hands it
over as the `cloneMatch` fact; a miss or an index failure arrives as null
and yields no findings. The plugin derives the evidence selector itself
through the shared domain helper.

## Output

At most one finding with the namespaced id
`dev.brandklipparen.clone-match:<group>`, a short English title, the first
dispatcher selector as evidence with the PC offset wherever derivable, and
the payload `{ "similarity": <0-1>, "group": "<group>", "priorCount": <n> }`.
Every finding carries at least one evidence entry. Findings report at
weight 0: the application service maps them to calibrated signals through
the versioned clone mapping, and a finding enters the score only after
calibration names it.

## Limits

At most 1 finding, at most 8 evidence entries per finding, at most
32768 output bytes. The plugin is pure and synchronous: no network, no
secrets, no clock, no randomness.
