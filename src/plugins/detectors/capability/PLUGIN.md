# PLUGIN.md: Capability detector (`dev.brandklipparen.capability`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-043).

## What it detects

Structural ERC-20 bytecode capabilities, one finding per capability key:

- `selfdestruct`: the contract can destroy itself and redirect funds.
- `delegatecall`: the contract can run foreign code in local storage context.
- `call`: the contract can forward calls to an outside contract.
- `storage-write`: the contract can write storage.

Detection fires solely on opcode presence in the linear disassembly with
PUSH data skipped, so constants never count as opcodes. No count, share, or
size cutoff steers detection: one occurrence is enough.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors and the disassembly itself through the shared domain helpers.

## Output

A list of findings with the namespaced id
`dev.brandklipparen.capability:<capability-key>`, a short English title,
selector evidence with the PC offset wherever derivable, and the payload
`{ "capability": "<key>" }`. Every finding carries at least one evidence
entry. Findings report at weight 0: the application service maps them to
calibrated signals through the versioned model artifact, and a finding
enters the score only after calibration names it.

## Limits

At most 8 findings, at most 128 evidence entries per finding, at most
32768 output bytes. The plugin is pure and synchronous: no network, no
secrets, no clock, no randomness.
