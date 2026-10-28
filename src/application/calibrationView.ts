// Calibration read view over the loaded model artifact (S-098, K-205,
// K-210, K-211). Pure application helper: version, checksum and
// per-class metrics read from the frozen artifact. The REST route serves
// this snapshot; it never loads or writes the artifact.
import type { ModelArtifact } from "../domain/risk.ts";
import type { ArtifactChecksum as ArtifactChecksumType } from "../domain/types.ts";

export type CalibrationClassView = {
  readonly slope: number;
  readonly intercept: number;
  readonly scoreWeight: number;
};

export type CalibrationView = {
  readonly version: string;
  readonly checksum: string;
  readonly classes: {
    readonly "rug-pull": CalibrationClassView;
    readonly honeypot: CalibrationClassView;
    readonly "bot-pump": CalibrationClassView;
  };
};

// Read-only projection of the loaded artifact: per risk class the
// calibration slope and intercept beside the score weight, plus the
// artifact version and verified checksum. No port call happens here; the
// caller passes the already-loaded values.
export function calibrationViewOf(artifact: ModelArtifact, checksum: ArtifactChecksumType): CalibrationView {
  function classView(risk: "rug-pull" | "honeypot" | "bot-pump"): CalibrationClassView {
    return Object.freeze({
      slope: artifact.calibration[risk].slope,
      intercept: artifact.calibration[risk].intercept,
      scoreWeight: artifact.scoreWeights[risk],
    });
  }
  return Object.freeze({
    version: artifact.version as string,
    checksum: checksum as string,
    classes: Object.freeze({
      "rug-pull": classView("rug-pull"),
      honeypot: classView("honeypot"),
      "bot-pump": classView("bot-pump"),
    }),
  });
}
