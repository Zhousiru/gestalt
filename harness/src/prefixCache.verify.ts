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

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.fixture.id,
      requests: agentExchanges.length,
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
