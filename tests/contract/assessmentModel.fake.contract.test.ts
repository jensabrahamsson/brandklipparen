// Contract suite against the deterministic fake (S-025, K-305, K-309).
// Runs the shared suite once per provider so both labels prove equal
// outcomes ahead of the real adapters in later stories.
import { FakeAssessmentModelAdapter } from "../fakes/fakeAssessmentModel.ts";
import type { AssessmentModelPort, AssessmentProvider } from "../../src/ports/assessmentModel.ts";
import type { AssessmentContractScenario } from "./assessmentModel.contract.ts";
import { runAssessmentModelPortContract } from "./assessmentModel.contract.ts";

function makeFake(
  provider: AssessmentProvider,
): (scenario: AssessmentContractScenario) => AssessmentModelPort {
  const modelId = "fake-meta-spark-1";
  return (scenario: AssessmentContractScenario) =>
    new FakeAssessmentModelAdapter({ provider, modelId, promptVersion: "1.0.0", scenario });
}

runAssessmentModelPortContract("fake meta-model-api", makeFake("meta-model-api"));
