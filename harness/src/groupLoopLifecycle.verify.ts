import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const fixturePaths = [
  "harness/fixtures/scenarios/group-exit-idle-timeout.json",
  "harness/fixtures/scenarios/group-exit-say-nothing.json",
  "harness/fixtures/scenarios/group-exit-leave-tool.json"
];

const results = [];

for (const fixturePath of fixturePaths) {
  console.log(`running ${fixturePath}`);
  const result = await runScenarioFixture(fixturePath);
  assertReplayRun(result);
  results.push(result);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      scenarios: results.map((result) => {
        const conversation = result.session.conversations[0];
        return {
          id: result.fixture.id,
          events: conversation?.events.length ?? 0,
          windows:
            conversation?.windows.map((window) => ({
              reason: window.reason,
              eventSeqs: window.eventSeqs
            })) ?? [],
          turns: conversation?.turns.length ?? 0,
          loopExits:
            conversation?.loopExits.map((exit) => ({
              reason: exit.reason,
              turnIds: exit.turnIds
            })) ?? [],
          toolCalls: result.mockTools.calls.map((call) => call.toolName),
          artifacts: result.artifactPaths
        };
      })
    },
    null,
    2
  )
);
