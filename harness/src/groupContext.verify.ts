import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const result = await runScenarioFixture(
  "harness/fixtures/scenarios/group-context-history.json"
);

assertReplayRun(result);

const conversation = result.session.conversations[0];
const turn = conversation?.turns[0];

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.fixture.id,
      events: conversation?.events.length ?? 0,
      selfMessages:
        conversation?.events.filter(
          (record) =>
            record.event.type === "MessageReceived" &&
            record.event.sender.isSelf === true
        ).length ?? 0,
      actions: turn?.proposedActions.map((action) => action.toolName) ?? [],
      modelRequests: result.modelRequests.length,
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);
