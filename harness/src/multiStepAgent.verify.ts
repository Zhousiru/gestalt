import assert from "node:assert/strict";
import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const result = await runScenarioFixture(
  "harness/fixtures/scenarios/multi-step-agent-tools.json"
);

assertReplayRun(result);

const records = result.rollouts[0]?.records ?? [];
const initializedIndex = records.findIndex(
  (record) => record.type === "model_session_initialized"
);
const initialUserIndex = records.findIndex(
  (record) =>
    record.type === "message_committed" && record.source === "user"
);
const firstToolIndex = records.findIndex(
  (record) => record.type === "tool_completed"
);
const firstGenerationIndex = records.findIndex(
  (record) => record.type === "generation_completed"
);
assert.ok(initializedIndex > 0, "rollout must initialize after rollout_started");
assert.ok(
  initialUserIndex > initializedIndex,
  "initial model input must be committed after model session initialization"
);
assert.ok(
  firstToolIndex > initialUserIndex,
  "model session and input must be durable before an inline tool can complete"
);
assert.ok(
  firstGenerationIndex > firstToolIndex,
  "generation completion must follow tools executed inside that model step"
);

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
