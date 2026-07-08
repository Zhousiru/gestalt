import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const result = await runScenarioFixture("harness/fixtures/scenarios/model-e2e.json");

assertReplayRun(result);

const action = result.session.conversations[0]?.turns[0]?.proposedActions[0];

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.fixture.id,
      model: result.modelRequests[0]?.model ?? "mock",
      action: action?.toolName,
      requests: result.modelRequests.length,
      toolCalls: result.mockTools.calls.map((call) => call.toolName),
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);
