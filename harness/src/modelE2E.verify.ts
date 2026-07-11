import assert from "node:assert/strict";
import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const result = await runScenarioFixture("harness/fixtures/scenarios/model-e2e.json");

assertReplayRun(result);
assert.equal(result.modelRequests[0]?.prompt?.id, "runtime.action.system");
assert.match(
  result.modelRequests[0]?.prompt?.contentHash ?? "",
  /^[a-f0-9]{16}$/
);
assert.match(
  result.modelRequests[0]?.prompt?.toolPromptHash ?? "",
  /^[a-f0-9]{16}$/
);
const modelSpan = result.traces[0]?.spans.find(
  (span) => span.name === "model.decide"
);
assert.equal(modelSpan?.attributes.promptId, "runtime.action.system");

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
