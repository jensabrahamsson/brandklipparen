---
id: dev.brandklipparen.example-fee-capability
kind: detector
version: 1.0.0
tags: [fees]
audience: [holder, trader]
severity: { min: low, max: medium }
---
# PLUGIN.md: fee-capability example detector

Version 1.0.0. A third-party-style example detector for Brandklipparen
(S-051). It shows the smallest complete detector plugin: a manifest, a
pure detect function, and tests on frozen fixtures. It is a local fixture
only and is never registered in the production default registry.

## What it checks

The detector reports fee-setting capability: the contract exposes a
public setter that lets the owner change a fee. It reads the declared
`bytecode` input, derives dispatcher selectors with the domain helper,
and reports one finding per known fee-setter selector:

- `setFee(uint256)` (`0x69fe0e2d`)
- `setTaxFeePercent(uint256)` (`0x061c82d0`)
- `setLiquidityFeePercent(uint256)` (`0x8ee88c53`)
- `setSellFee(uint256)` (`0x8b4cee08`)

## Why it matters to you

A fee the owner can raise is a tax on your exit. This detector names the
exact setter, so you can check whether the fee is fixed or changeable
before you buy.

## What it cannot tell you

The current fee value or whether the setter is guarded. The detector
reports the setter's presence from `bytecode` alone, never the live fee.

## Evidence format

One finding per matched selector, namespaced as
`dev.brandklipparen.example-fee-capability:<selector>` with payload
`{ selector, name }`. The payload carries `selector` and `name`, and every
finding carries selector `evidence` with the PC offset where the dispatcher
pattern yields one. Bytecode without a known fee selector yields no
findings. Findings report at weight 0: they are display records only
until a calibrated model artifact names this plugin, so scores and
evidence stay unchanged.

## Limitations / false positives

Only the four listed selectors match: an unknown fee setter stays silent.
A matched selector can sit in dead code, and presence never proves the
setter is callable.

## Inputs

Declared inputs: `bytecode`. Selectors are derived from the bytecode
with the domain selector helper; no network, clock, or configuration is
read. Every finding carries selector evidence with the PC offset where
the dispatcher pattern yields one.

## Version and changelog

Version 1.0.0. Initial release.

## Layout

- `manifest.ts`: the frozen manifest value, validated by the
  `PluginManifest` smart constructor.
- `detect.ts`: the pure `detectFeeCapability` function.
- `detect.test.ts`: unit and golden tests on frozen bytecode fixtures,
  plus the shared detector contract suite.

## Registration

The example registers nowhere by default. To run it locally, build a
registry from its manifest beside the default detector set and hand the
set to the application service and the drivers. The plugin then appears
in `GET /v1/plugins`, in the `list_plugins` MCP tool, under
`pluginResults` in the analysis output, and in the web Plugins panel,
with no interface code changed.
