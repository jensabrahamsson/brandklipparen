// Shared validation of provider assessment output (K-305, K-309, K-513).
// Adapter-layer helper reused by the fake here and by the real adapters in
// later stories, so every provider proves the same outcomes in the shared
// contract suite. Pure function: no I/O, no network, no clock. Every
// rejection keeps the template text standing under K-306, and no message
// carries response content, so hostile strings never leak into logs.
import { err, ok } from "../../domain/result.ts";
import type { Result } from "../../domain/result.ts";
import type { NonEmpty } from "../../domain/evidence.ts";
import type { Claim as ClaimType } from "../../domain/explain.ts";
import type { MeasuredValue, Temporality } from "../../domain/signals.ts";
import {
  Address,
  BlockNumber,
  ExplanationSchemaVersion,
  PromptVersion,
  SignalId,
  Slot,
  StorageWord,
  Timestamp,
} from "../../domain/types.ts";
import type {
  ModelId as ModelIdType,
  PromptVersion as PromptVersionType,
  SignalId as SignalIdType,
} from "../../domain/types.ts";
import type {
  AssessmentInvalidStage,
  AssessmentModelError,
  AssessmentProvider,
  EvidenceList,
  MuseAssessment,
} from "../../ports/assessmentModel.ts";

export type AssessmentExpectation = {
  readonly provider: AssessmentProvider;
  readonly modelId: ModelIdType;
  readonly promptVersion: PromptVersionType;
  readonly maxOutputChars: number;
};

// Placeholder output limit for tests and offline use (K-306, K-309).
// Production passes the versioned operational value from
// BRANDKLIPPAREN_ASSESSMENT_MAX_OUTPUT_BYTES through
// resolveAssessmentOutputLimit at the composition root; the running
// boundary never invents a limit of its own.
export const DEFAULT_ASSESSMENT_MAX_OUTPUT_CHARS = 4000;

// Size limit for the assessment text from the validated configuration
// (A-17, I-14). An absent value keeps the placeholder default so unit
// tests and offline runs stay well-formed without a demo configuration.
export function resolveAssessmentOutputLimit(
  assessmentMaxOutputBytes?: number | undefined,
): number {
  if (assessmentMaxOutputBytes === undefined) {
    return DEFAULT_ASSESSMENT_MAX_OUTPUT_CHARS;
  }
  return assessmentMaxOutputBytes;
}

// Strict schema: exact key sets at every level, so unknown fields fail
// validation instead of passing silently (K-306, K-502, M-05).
const TOP_LEVEL_KEYS: readonly string[] = Object.freeze([
  "claims",
  "explanationVersion",
  "modelId",
  "promptVersion",
  "provider",
  "text",
]);

const CLAIM_KEYS: readonly string[] = Object.freeze(["signalLinks", "temporality", "text"]);

const CAN_CHANGE_KEYS: readonly string[] = Object.freeze(["changer", "kind"]);

const CAN_CHANGE_UNKNOWN_KEYS: readonly string[] = Object.freeze(["kind"]);

const APPLIES_NOW_KEYS: readonly string[] = Object.freeze([
  "at",
  "block",
  "kind",
  "measuredValue",
]);

const MEASURED_VALUE_KEYS: readonly string[] = Object.freeze(["at", "block", "slot", "value"]);

function hasExactlyKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length) {
    return false;
  }
  const wanted = expected.slice().sort();
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== wanted[index]) {
      return false;
    }
  }
  return true;
}

function invalid(
  message: string,
  path: string,
  check: string,
  stage: AssessmentInvalidStage,
): AssessmentModelError {
  return { kind: "invalid-output", message, detail: { stage, path, check } };
}

// Markup, script and link rule for assessment prose (S-136, K-502): the
// schema forbids HTML tags, script schemes and URLs in assessment text,
// so hostile strings can never travel into the UI. A bare `<` followed
// by a digit or a space is not markup and stays allowed.
function carriesMarkupOrUrl(text: string): boolean {
  return /<[a-zA-Z/!]/.test(text) || /javascript:/i.test(text) || /https?:\/\//i.test(text);
}

function recordOf(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function validateTemporality(raw: unknown, path: string): Result<Temporality, AssessmentModelError> {
  const record = recordOf(raw);
  if (record === null) {
    return err(
      invalid("assessment claim marker must be holds-now, can-change or can-change-unknown", path, "temporality-object", "schema"),
    );
  }
  if (record["kind"] === "can-change") {
    if (!hasExactlyKeys(record, CAN_CHANGE_KEYS)) {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          path,
          "temporality-keys",
          "schema",
        ),
      );
    }
    const changerRaw = record["changer"];
    if (typeof changerRaw !== "string") {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          `${path}.changer`,
          "changer-present",
          "schema",
        ),
      );
    }
    const changer = Address.parse(changerRaw);
    if (!changer.ok) {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          `${path}.changer`,
          "changer-address",
          "schema",
        ),
      );
    }
    return ok({ kind: "can-change", changer: changer.value });
  }
  if (record["kind"] === "can-change-unknown") {
    if (!hasExactlyKeys(record, CAN_CHANGE_UNKNOWN_KEYS)) {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          path,
          "temporality-keys",
          "schema",
        ),
      );
    }
    return ok({ kind: "can-change-unknown" });
  }
  if (record["kind"] === "applies-now") {
    if (!hasExactlyKeys(record, APPLIES_NOW_KEYS)) {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          path,
          "temporality-keys",
          "schema",
        ),
      );
    }
    const measuredRaw = recordOf(record["measuredValue"]);
    const blockRaw = record["block"];
    const atRaw = record["at"];
    if (measuredRaw === null) {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          `${path}.measuredValue`,
          "measured-value",
          "schema",
        ),
      );
    }
    if (!hasExactlyKeys(measuredRaw, MEASURED_VALUE_KEYS)) {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          `${path}.measuredValue`,
          "measured-value-keys",
          "schema",
        ),
      );
    }
    const valueRaw = measuredRaw["value"];
    const slotRaw = measuredRaw["slot"];
    const measuredBlockRaw = measuredRaw["block"];
    const measuredAtRaw = measuredRaw["at"];
    if (typeof valueRaw !== "string" || typeof slotRaw !== "string") {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          `${path}.measuredValue`,
          "measured-word",
          "schema",
        ),
      );
    }
    if (
      typeof measuredBlockRaw !== "number" ||
      typeof measuredAtRaw !== "number" ||
      typeof blockRaw !== "number" ||
      typeof atRaw !== "number"
    ) {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          path,
          "measured-block",
          "schema",
        ),
      );
    }
    const value = StorageWord.parse(valueRaw);
    const slot = Slot.parse(slotRaw);
    const measuredBlock = BlockNumber.of(measuredBlockRaw);
    const measuredAt = Timestamp.of(measuredAtRaw);
    const block = BlockNumber.of(blockRaw);
    const at = Timestamp.of(atRaw);
    if (!value.ok || !slot.ok || !measuredBlock.ok || !measuredAt.ok || !block.ok || !at.ok) {
      return err(
        invalid(
          "assessment claim marker must be holds-now, can-change or can-change-unknown",
          path,
          "measured-range",
          "schema",
        ),
      );
    }
    const measured: MeasuredValue = {
      value: value.value,
      slot: slot.value,
      block: measuredBlock.value,
      at: measuredAt.value,
    };
    return ok({ kind: "applies-now", measuredValue: measured, block: block.value, at: at.value });
  }
  return err(
    invalid(
      "assessment claim marker must be holds-now, can-change or can-change-unknown",
      path,
      "temporality-kind",
      "schema",
    ),
  );
}

// Every claim must link to at least one signal derived from the request
// evidence (K-304). Links outside that closed set fail validation, so a
// claim without an evidence link never reaches display.
export function validateAssessmentOutput(
  raw: unknown,
  evidence: EvidenceList,
  expected: AssessmentExpectation,
): Result<MuseAssessment, AssessmentModelError> {
  const record = recordOf(raw);
  if (record === null) {
    return err(invalid("assessment response must be an object", "(root)", "object-required", "schema"));
  }
  if (!hasExactlyKeys(record, TOP_LEVEL_KEYS)) {
    return err(invalid("assessment response carries unknown fields", "(root)", "exact-keys", "schema"));
  }
  if (record["provider"] !== expected.provider) {
    return err({
      kind: "provider-mismatch",
      message: "assessment provider label does not match the selected provider",
    });
  }
  if (record["modelId"] !== (expected.modelId as string)) {
    return err({
      kind: "provider-mismatch",
      message: "assessment model id does not match the selected model",
    });
  }
  const promptRaw = record["promptVersion"];
  if (
    typeof promptRaw !== "string" ||
    !PromptVersion.parse(promptRaw).ok ||
    promptRaw !== (expected.promptVersion as string)
  ) {
    return err(
      invalid(
        "assessment prompt version is missing or does not match",
        "promptVersion",
        "prompt-echo",
        "semantic",
      ),
    );
  }
  const explanationRaw = record["explanationVersion"];
  const explanationParsed =
    typeof explanationRaw === "string" ? ExplanationSchemaVersion.parse(explanationRaw) : null;
  if (explanationParsed === null || !explanationParsed.ok) {
    return err(
      invalid(
        "assessment explanation schema version is not valid semver",
        "explanationVersion",
        "semver",
        "schema",
      ),
    );
  }
  const textRaw = record["text"];
  if (typeof textRaw !== "string") {
    return err(invalid("assessment text must be a string", "text", "text-present", "schema"));
  }
  if (textRaw.length > expected.maxOutputChars) {
    return err({
      kind: "output-too-large",
      message: "assessment text exceeds the output size limit",
      limitChars: expected.maxOutputChars,
    });
  }
  if (carriesMarkupOrUrl(textRaw)) {
    return err(
      invalid("assessment text must not carry markup, scripts or links", "text", "no-markup", "schema"),
    );
  }
  const claimsRaw = record["claims"];
  if (!Array.isArray(claimsRaw)) {
    return err(invalid("assessment claims must be an array", "claims", "claims-array", "schema"));
  }

  const allowed: SignalIdType[] = [];
  for (const entry of evidence.evidence) {
    const id = SignalId.of(evidence.codeHash, entry.selector);
    if (!id.ok) {
      return err(invalid("assessment evidence carries an invalid signal link", "claims", "evidence-links", "semantic"));
    }
    allowed.push(id.value);
  }

  const claims: ClaimType[] = [];
  for (let index = 0; index < claimsRaw.length; index += 1) {
    const rawClaim: unknown = claimsRaw[index];
    const claimPath = `claims[${index}]`;
    const claimRecord = recordOf(rawClaim);
    if (claimRecord === null) {
      return err(invalid("assessment claim must be an object", claimPath, "claim-object", "schema"));
    }
    if (!hasExactlyKeys(claimRecord, CLAIM_KEYS)) {
      return err(invalid("assessment claim carries unknown fields", claimPath, "claim-keys", "schema"));
    }
    const claimText = claimRecord["text"];
    if (typeof claimText !== "string" || claimText.length === 0) {
      return err(
        invalid("assessment claim text must be a non-empty string", `${claimPath}.text`, "claim-text", "schema"),
      );
    }
    if (carriesMarkupOrUrl(claimText)) {
      return err(
        invalid(
          "assessment claim text must not carry markup, scripts or links",
          `${claimPath}.text`,
          "no-markup",
          "schema",
        ),
      );
    }
    const linksRaw = claimRecord["signalLinks"];
    if (!Array.isArray(linksRaw) || linksRaw.length === 0) {
      return err(
        invalid(
          "assessment claim must link to at least one signal",
          `${claimPath}.signalLinks`,
          "signal-links",
          "schema",
        ),
      );
    }
    const links: SignalIdType[] = [];
    for (let linkIndex = 0; linkIndex < linksRaw.length; linkIndex += 1) {
      const rawLink: unknown = linksRaw[linkIndex];
      if (typeof rawLink !== "string") {
        return err(
          invalid(
            "assessment signal link must be a string",
            `${claimPath}.signalLinks[${linkIndex}]`,
            "signal-link-type",
            "schema",
          ),
        );
      }
      const known = allowed.some((id) => (id as string) === rawLink);
      if (!known) {
        return err(
          invalid(
            "assessment claim links to an unknown signal",
            `${claimPath}.signalLinks`,
            "unknown-signal",
            "semantic",
          ),
        );
      }
      links.push(rawLink as SignalIdType);
    }
    const first = links[0];
    if (first === undefined) {
      return err(
        invalid(
          "assessment claim must link to at least one signal",
          `${claimPath}.signalLinks`,
          "signal-links",
          "schema",
        ),
      );
    }
    const temporality = validateTemporality(claimRecord["temporality"], `${claimPath}.temporality`);
    if (!temporality.ok) {
      return err(temporality.error);
    }
    claims.push(
      Object.freeze({
        text: claimText,
        signalLinks: Object.freeze([first, ...links.slice(1)]) as NonEmpty<SignalIdType>,
        temporality: temporality.value,
      }),
    );
  }

  return ok(
    Object.freeze({
      text: textRaw,
      claims: Object.freeze(claims),
      promptVersion: expected.promptVersion,
      provider: expected.provider,
      modelId: expected.modelId,
      explanationVersion: explanationParsed.value,
    }),
  );
}
