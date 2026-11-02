---
id: dev.brandklipparen.blacklist
kind: detector
version: 1.0.0
tags: [blacklist, honeypot, owner-powers]
audience: [holder]
severity: { min: medium, max: high }
---
# PLUGIN.md: Blacklist detector (`dev.brandklipparen.blacklist`)

Version 1.0.0. First-party detector plugin for Brandklipparen (S-115).

## What it checks

A transfer gate on a mapping entry that a privileged caller can set.
The proof needs both at once: the transfer path reads a mapping entry
beside an equality compare, or beside an ISZERO with no range compare
between the load and the gate, with a conditional jump that can revert;
and a caller-guarded function writes a mapping slot. The two may share
one merged function. One finding names the first provable pair. A plain
balance check or an allowance check never counts: both compile to a
range compare closed by ISZERO, which the ordered veto excludes.

## Why it matters to you

A privileged block list lets the owner stop your sale while letting
other transfers through. The finding names the function that writes the
entry and the transfer function that reads it, so you can see both ends.

## What it cannot tell you

Whether the gate is a block list or an allow list, whether the
privileged function is still callable, or which addresses are listed:
the bytecode proves the mechanism, not the policy. A gated read with no
privileged writer, or a privileged mapping write the transfer path never
reads, stays silent rather than guessed.

## Evidence format

A list with at most one finding with the namespaced id
`dev.brandklipparen.blacklist:blacklist`, a short English title,
selector evidence with the PC offset wherever derivable, and the payload
holding `feature`. The payload carries one field, `feature`, and every
finding carries at least one `evidence` entry with a `selector`.
As a first-party detector, its findings convert to calibrated signals
through the versioned model artifact, and the artifact sets their
effective weight, which the plugin list exposes per plugin.

When the scored proof above finds nothing, the detector re-runs a
tightened proof on the v2 reachability view (a shared
`_beforeTokenTransfer` helper joins every entry that reaches it) and
reports at most one weight-0 `fact` finding with the namespaced id
`dev.brandklipparen.blacklist:blacklist-extended` and the payload holding
`fact` and `proof: "extended"`. It never converts to a signal and never
enters the score; the UI labels it "not in score". The tightened proof
needs all of: the writer carries a caller check against the proven owner
slot (standard token entries such as transfer, approve, deposit or
withdraw never count, and neither does a function anyone can call);
the writer mapping and the gate mapping hash the same base slot through
the `keccak(key . baseSlot)` memory pattern (unknown on either side
stays silent); and the gate sits on a transfer/transferFrom path
whose blocked side reverts.

## Limitations / false positives

The mapping shape is resolved structurally: a hash-mixed access counts,
a direct constant slot read in the transfer path does not. The gate
compare must sit beside the loaded entry (within a short window), not
merely in the same function; a packed shift-and-mask read of a
bool-in-mapping entry may span more, proved separately with the same
base and a reverting jump. A gate that blocks by reverting with no
value compare, or by arithmetic instead of a compare, stays silent. A
finding never says the gate was used, only that the bytecode proves the
privileged path.

## Inputs

Declared inputs: `bytecode` (with its code hash). The plugin derives
selectors, regions and storage facts itself through the shared domain
helpers.

## Version and changelog

Version 1.0.0. Initial release.

Specificity update: the gate compare must sit beside the loaded entry,
and ISZERO gates with a range compare between the load and the gate
(balance and allowance checks) no longer count.

Extended analysis: when the scored proof finds nothing, the same proof
re-runs on the v2 reachability view with shared helpers included and
reports a weight-0 `fact` finding (`proof: "extended"`) that never
converts to a signal.

Precision update: the extended writer must prove a caller check against
the owner slot, standard token entries never count as writers, the
writer and gate mappings must share their base slot, and only a
reverting gate on the transfer path proper counts.

Follow-up: a packed shift-and-mask gate read that spans more than the
beside window proves as a fallback when it reads the written base and
its blocked side reverts; the beside-window proof keeps its load and
compare PCs wherever it already proves.

SCAN-1 precision: the beside-window extended gate now also needs the
reverting jump's own condition to read the written mapping entry. A
per-address mapping that only exempts its holder from fees, limits or
a trading flag branches around a revert on another value; that nearby
revert no longer proves a blacklist, while a gate that reverts on the
entry itself (one or both transfer parties) still proves.

SCAN-B precision: every extended gate proof now checks polarity: the
blocking side must be the side taken while the gated entry reads set.
A gate that reverts while its entry reads clear (an allowlist
requirement on an exemption or pair entry) never proves a list. The
extended proof also follows the transfer entry's internal-call body,
so a gate in a guard helper below the transfer update hook proves
the same way, and a list writer that loops over an array or delegates
to a helper, or whose caller guard sits in a shared modifier helper
or behind a second address seat, still counts as a writer.
