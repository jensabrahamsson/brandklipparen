# PLUGIN.md: Meta Model API assessment (`dev.brandklipparen.assessment.meta-model-api`)

Version 1.0.0. First-party assessment plugin for Brandklipparen (S-045).

## What it detects

An opt-in Muse contract assessment of the analysed token: a short
generated text beside the deterministic probabilities, score and evidence.
The text never changes scores, signals or evidence.

## Inputs

Declared inputs: none. The assessment reads the closed evidence list for
the analysed token at request time through the assessment service.

## Output

A labelled assessment field with provider and model id, cached per code
hash, prompt version, provider and model id under the daily cost cap.

## Limits

Provider deadline, input and output byte bounds and concurrency bound per
the assessment limits. Failures fall back to the template explanation.
