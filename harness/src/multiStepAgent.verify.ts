import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const result = await runScenarioFixture(
  "harness/fixtures/scenarios/multi-step-agent-tools.json"
);

assertReplayRun(result);

const turn = result.session.conversations[0]?.turns[0];

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.fixture.id,
      actions: turn?.proposedActions.map((action) => action.toolName) ?? [],
      toolCalls: result.mockTools.calls.map((call) => call.toolName),
      modelRequests: result.modelRequests.length,
      modelResponses: result.modelExchanges.filter((exchange) => exchange.response)
        .length,
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);
