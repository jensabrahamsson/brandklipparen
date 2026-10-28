---
id: dev.brandklipparen.assessment.meta-model-api
kind: assessment
version: 1.0.0
tags: [owner-powers, honeypot, fees, upgradeability]
audience: [all]
severity: { min: low, max: high }
---
# PLUGIN.md: Meta Model API assessment (`dev.brandklipparen.assessment.meta-model-api`)

Version 1.0.0. First-party assessment plugin for Brandklipparen (S-045).

## What it checks

An opt-in Muse contract assessment of the analysed token: a short
generated text beside the deterministic probabilities, score and evidence.
The text never changes scores, signals or evidence.

## Why it matters to you

The deterministic page tells you what the bytecode contains; the
assessment reads like a second opinion in plain words, useful when the
signals alone do not answer whether you should buy.

## What it cannot tell you

Anything the bytecode cannot support. The assessment reasons from the
same closed evidence list as the page, so it cannot see off-chain facts
like who holds the liquidity or whether the team is real.

## Evidence format

A labelled assessment field with provider and model id, cached per code
hash, prompt version, provider and model id under the daily cost cap.
The finding text is display only: no score, probability, signal, or
`evidence` value ever changes under assessment.

## Limitations / false positives

A generated text can be vague or wrong: it is advisory, and the template
explanation stays the authority. Failures fall back to the template
explanation. Provider deadline, input and output byte bounds and the
concurrency bound cap every call per the assessment limits.

## Inputs

Declared inputs: none. The assessment reads the closed evidence list for
the analysed token at request time through the assessment service.

## Version and changelog

Version 1.0.0. Initial release.
