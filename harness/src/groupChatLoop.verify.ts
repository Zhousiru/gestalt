import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const result = await runScenarioFixture(
  "harness/fixtures/scenarios/group-chat-loop-steer.json"
);

assertReplayRun(result);

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.fixture.id,
      events: result.session.conversations[0]?.events.length ?? 0,
      windows: result.session.conversations[0]?.windows.length ?? 0,
      turns: result.session.conversations[0]?.turns.length ?? 0,
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);
