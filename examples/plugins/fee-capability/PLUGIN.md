# PLUGIN.md: fee-capability example detector

A third-party-style example detector for Brandklipparen (S-051). It shows
the smallest complete detector plugin: a manifest, a pure detect function,
and tests on frozen fixtures. It is a local fixture only and is never
registered in the production default registry.

- Id: `dev.brandklipparen.example-fee-capability`
- Kind: detector
- Version: 1.0.0
- Plugin API: 1.0.0

## What it detects

The detector reports fee-setting capability: the contract exposes a
public setter that lets the owner change a fee. It reads the declared
`bytecode` input, derives dispatcher selectors with the domain helper,
and reports one finding per known fee-setter selector:

- `setFee(uint256)` (`0x69fe0e2d`)
- `setTaxFeePercent(uint256)` (`0x061c82d0`)
- `setLiquidityFeePercent(uint256)` (`0x8ee88c53`)
- `setSellFee(uint256)` (`0x8b4cee08`)

## Inputs

Declared inputs: `bytecode`. Selectors are derived from the bytecode
with the domain selector helper; no network, clock, or configuration is
read. Every finding carries selector evidence with the PC offset where
the dispatcher pattern yields one.

## Output

One finding per matched selector, namespaced as
`dev.brandklipparen.example-fee-capability:<selector>` with payload
`{ selector, name }`. Bytecode without a known fee selector yields no
findings. Findings report at weight 0: they are display records only
until a calibrated model artifact names this plugin, so scores and
evidence stay unchanged.

## Limits

At most 8 findings, at most 8 evidence entries per finding, at most
8192 output bytes. Larger outputs degrade to the typed `invalid-output`
outcome for this plugin while the rest of the analysis stands.

## Layout

- `manifest.ts`: the frozen manifest value, validated by the
  `PluginManifest` smart constructor.
- `detect.ts`: the pure `detectFeeCapability` function.
- `detect.test.ts`: unit and golden tests on frozen bytecode fixtures,
  plus the shared detector contract suite.

## Registration

The example registers nowhere by default. To run it locally, build a
registry from its manifest beside the default detector set and hand the
set to the application service and the drivers:

```ts
const plugins = [...DEFAULT_DETECTOR_PLUGINS, { manifest: feeCapabilityManifest, detect: detectFeeCapability }];
const registry = buildPluginRegistry(plugins.map((plugin) => plugin.manifest));
const detectors = { registry, plugins: detectorPluginTable(plugins) };
```

The plugin then appears in `GET /v1/plugins`, in the `list_plugins`
MCP tool, under `pluginResults` in the analysis output, and in the web
Plugins panel, with no interface code changed.
