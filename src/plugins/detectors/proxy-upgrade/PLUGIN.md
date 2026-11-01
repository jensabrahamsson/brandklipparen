---
id: dev.brandklipparen.proxy-upgrade
kind: detector
version: 1.0.0
tags: [upgradeability, proxy, owner-powers]
audience: [holder, auditor]
severity: { min: medium, max: high }
---
# PLUGIN.md: Proxy-upgrade detector (`dev.brandklipparen.proxy-upgrade`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

Proxy upgradeability as a privileged capability, reusing the domain
proxy helpers. An upgrade entry behind a caller guard reports the UUPS
kind; a delegatecall-behind-storage region beside an upgrade entry
reports the EIP-1967 kind. One finding names the first provable shape
with the upgrade selector it proves.

## Why it matters to you

An upgradeable proxy can swap the token logic after you buy: today's
rules are not tomorrow's. The finding names the upgrade function and,
for the delegatecall shape, the forwarding call site, so you can see who
holds the upgrade path.

## What it cannot tell you

Who holds the upgrade path right now: the admin value lives in storage
and is read by the analysis service only where the port pattern reaches
it. An unguarded upgrade entry alone, or a delegatecall proxy with no
upgrade entry, stays silent rather than guessed.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.proxy-upgrade:proxy-upgrade`, a short English title,
selector evidence with the PC offset wherever derivable, and the payload
holding `feature`, `proxyKind` and `upgradeSelector`. The payload
carries three fields, `feature`, `proxyKind` and `upgradeSelector`,
where the kind names one of the two listed proxy shapes, and every
finding carries at least one `evidence` entry with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

## Limitations / false positives

The upgrade selectors derive from their public signatures through the
shared hash helper. Beacon and diamond shapes stay out of scope and
stay silent. A finding never says the proxy was upgraded, only that the
bytecode proves the upgrade path.

## Inputs

Declared inputs: `bytecode` (with its code hash) and `proxyFact`. The
plugin derives selectors and regions itself through the shared domain
helpers. When the scored path is silent and the proxy fact names an
EIP-1967, ZeppelinOS or UUPS proxy, it emits one weight-0 fact finding
that never converts to a signal and is labelled "not in score".

## Version and changelog

Version 1.0.0. Initial release.
