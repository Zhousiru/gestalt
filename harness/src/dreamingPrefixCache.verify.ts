import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const fixturePath =
  "harness/fixtures/scenarios/memory-injection-dreaming.json";
const result = await runScenarioFixture(fixturePath);
assertReplayRun(result);

const agentExchanges = result.modelExchanges.filter(
  (exchange) => exchange.purpose === "agent_action"
);
const dreamingExchanges = result.modelExchanges.filter(
  (exchange) => exchange.purpose === "dreaming"
);
const dreamingCacheReads = dreamingExchanges.map(
  (exchange) => exchange.response?.cacheUsage?.readTokens ?? 0
);

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.fixture.id,
      sessionId: agentExchanges[0]?.request.sessionId,
      agentRequests: agentExchanges.length,
      dreamingRequests: dreamingExchanges.length,
      lastAgentMessageCount:
        agentExchanges.at(-1)?.request.messages.length ?? 0,
      firstDreamingMessageCount:
        dreamingExchanges[0]?.request.messages.length ?? 0,
      dreamingTools: dreamingExchanges[0]?.request.tools ?? [],
      dreamingCacheReadTokens: dreamingCacheReads,
      dreamingCacheHitResponses: dreamingCacheReads.filter(
        (tokens) => tokens > 0
      ).length,
      totalDreamingCacheReadTokens: dreamingCacheReads.reduce(
        (total, tokens) => total + tokens,
        0
      ),
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);
