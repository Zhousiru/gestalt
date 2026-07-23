import assert from "node:assert/strict";
import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const result = await runScenarioFixture(
  "harness/fixtures/scenarios/agent-browser-bash.json"
);

assertReplayRun(result);

const bashCalls = result.mockTools.calls.filter(
  (call) => call.toolName === "bash"
);
assert.equal(bashCalls.length, 1);
assert.deepEqual(bashCalls[0]?.params, {
  command: "agent-browser skills get core"
});

const completedToolNames = result.rollouts.flatMap((rollout) =>
  rollout.records
    .filter((record) => record.type === "tool_completed")
    .map((record) => record.toolName)
);
assert.ok(completedToolNames.includes("bash"));
assert.ok(completedToolNames.includes("send_group_message"));
assert.ok(
  !completedToolNames.includes("agent-browser"),
  "agent-browser must remain inside the outer bash trace"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.fixture.id,
      bashCommand: bashCalls[0]?.params,
      completedToolNames,
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);
