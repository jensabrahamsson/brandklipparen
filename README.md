# Brandklipparen

Bytecode-only, deterministic, calibrated ERC-20 rug-pull risk assessment with evidence behind every score.

## What it is

Brandklipparen assesses the rug-pull risk of ERC-20 tokens from contract
bytecode alone. Every score is shown together with the evidence that
produced it, so the result can be inspected and reproduced.

The same assessment is available through three interfaces:

- a web UI
- a REST API
- an MCP server

## Contract assessment with Muse

An optional add-on, "Contract assessment with Muse", provides a
plain-language explanation layer on top of the assessment. It is
offered separately from the score and never affects the score or
the evidence.

## Status

Work in progress during the hackathon. Interfaces and behaviour may
change as the project is built and evaluated.

## Documentation

- [Requirements](docs/requirements.md)
- [Architecture](docs/architecture.md)
- [Infrastructure](docs/infrastructure.md)
- [Threat model](docs/threat-model.md)

## License

Licensed under Apache-2.0. See LICENSE and NOTICE.
