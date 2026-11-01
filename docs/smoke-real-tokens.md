# Real-token smoke and eval harness

Operator-run offline check over labelled tokens. The harness reads a JSON
fixture of labelled tokens, runs the full deterministic offline analysis
through the same application service the REST and MCP interfaces use, and
writes a Markdown report. The report names tokens by symbol only: addresses,
code hashes and bytecode never reach the report or stdout.

## Environment

| Variable         | Required | Meaning                                                        |
| ---------------- | -------- | -------------------------------------------------------------- |
| `BK_REAL_TOKENS` | yes      | Path to the JSON fixture. No default path exists in the repo.  |
| `BK_SMOKE_OUT`   | yes      | Path for the Markdown report. Inside the repo is refused.      |

With `BK_REAL_TOKENS` unset the run exits non-zero with a message and reads
nothing. With `BK_SMOKE_OUT` unset the run exits non-zero without writing.

Run from the repo root:

```sh
BK_REAL_TOKENS=/path/to/fixture.json BK_SMOKE_OUT=/path/to/report.md npm run smoke:real
```

## Fixture format

A JSON array of token entries:

```json
[
  {
    "address": "0x...",
    "symbol": "ABC",
    "name": "Example Token",
    "label": "legit",
    "labelSource": "manual review, March 2026",
    "block": 18000000,
    "codehash": "0x...",
    "bytecode": "0x...",
    "implementation": { "address": "0x...", "bytecode": "0x..." }
  }
]
```

`label` is one of `legit`, `rug`, `honeypot`, `scam` or `unknown`.
`implementation` is optional: when present (a proxy), the implementation
bytecode is analyzed and the report marks the token as a proxy. Entries
that fail validation are listed in the report and skipped; a bad row never
stops the run.

Optional label provenance: `labelSource` (free text, up to 4096
characters, so long list URLs validate), `labelNote` (free text, up to
4096 characters) and `labelBasis` (one of `dataset`, `incident-report` or
`token-list`). Provenance fields are validated but never printed: the
report stays symbols-only and every derived line passes through the same
sanitizer, so a long source URL cannot leak into the report or stdout.

## Analysis

Each token runs through `analyzeToken` with the frozen repo artifact, the
default detector set and a fixture-backed stub behind `RpcPort`. No
network, no RPC, no assessment providers and no language models are
involved. A per-token timeout of 30 seconds bounds each run; a crash in one
token is recorded and the run continues with the next. Decompilation
figures come solely from the internal pipeline: the selector count the
own pipeline found is recorded per token.

## Report

The report holds a per-token table (symbol, label, proxy, score, band, top
evidence, runtime, error), a confusion summary of legit versus bad tokens
(rug, honeypot and scam) with counts per band and the misses by symbol,
mean and median score per label, crashes and timeouts, total runtime and
the internal decompilation section. A short summary without addresses is
also printed to stdout.
