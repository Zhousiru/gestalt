import assert from "node:assert/strict";
import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const fixturePath = "harness/fixtures/scenarios/group-chat-loop-steer.json";
const result = await runScenarioFixture(fixturePath);
assertReplayRun(result);

const agentExchanges = result.modelExchanges.filter(
  (exchange) => exchange.purpose === "agent_action"
);
const cacheReads = agentExchanges.map(
  (exchange) => exchange.response?.cacheUsage?.readTokens ?? 0
);
const cacheWrites = agentExchanges.map(
  (exchange) => exchange.response?.cacheUsage?.writeTokens ?? 0
);
const cancelledExchange = agentExchanges.find(
  (exchange) => exchange.status === "cancelled"
);
assert.ok(
  cancelledExchange,
  "the request interrupted after onStepStart must remain visible as cancelled"
);
assert.equal(
  cancelledExchange.response,
  undefined,
  "an attempt interrupted before onStepEnd must not invent a provider response"
);
assert.ok(
  agentExchanges.some((exchange) => exchange.status === "completed"),
  "the steered retry must complete"
);

const rollout = result.rollouts[0];
assert.ok(rollout, "the scenario must produce one rollout");
const cancelledGeneration = rollout.records.find(
  (record) =>
    record.type === "generation_completed" && record.status === "cancelled"
);
assert.equal(cancelledGeneration?.type, "generation_completed");
assert.deepEqual(cancelledGeneration.outputMessageIds, []);
const cancelledGenerationIndex = rollout.records.indexOf(cancelledGeneration);
const nextCommit = rollout.records
  .slice(cancelledGenerationIndex + 1)
  .find((record) => record.type === "message_committed");
assert.equal(nextCommit?.type, "message_committed");
assert.equal(
  nextCommit.previousStateHash,
  cancelledGeneration.inputStateHash,
  "a cancelled generation must not advance stateHash before the retry delta"
);
assert.notEqual(nextCommit.source, "assistant");
assert.notEqual(nextCommit.source, "tool");

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.fixture.id,
      requests: agentExchanges.length,
      statuses: agentExchanges.map((exchange) => exchange.status),
      sessionId: agentExchanges[0]?.request.sessionId,
      messageCounts: agentExchanges.map(
        (exchange) => exchange.request.messages.length
      ),
      cacheReadTokens: cacheReads,
      cacheWriteTokens: cacheWrites,
      cacheHitResponses: cacheReads.filter((tokens) => tokens > 0).length,
      totalCacheReadTokens: cacheReads.reduce(
        (total, tokens) => total + tokens,
        0
      ),
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);
