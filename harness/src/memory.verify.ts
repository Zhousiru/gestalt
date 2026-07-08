import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const fixturePaths = [
  "harness/fixtures/scenarios/memory-injection-dreaming.json",
  "harness/fixtures/scenarios/memory-correction-dreaming.json",
  "harness/fixtures/scenarios/memory-pruning-dreaming.json"
];

const scenarios = [];

for (const fixturePath of fixturePaths) {
  const result = await runScenarioFixture(fixturePath);
  assertReplayRun(result);

  const conversation = result.session.conversations[0];
  const turn = conversation?.turns[0];
  const dreamSpan = result.traces
    .flatMap((trace) => trace.spans)
    .find((span) => span.name === "dream.run");

  scenarios.push({
    id: result.fixture.id,
    events: conversation?.events.length ?? 0,
    turns: conversation?.turns.length ?? 0,
    action: turn?.proposedActions[0]?.toolName ?? "none",
    dreamStatus: dreamSpan?.attributes.dreamingStatus ?? "missing",
    dreamCommands: dreamSpan?.attributes.commandCount ?? 0,
    dreamChangedFiles: dreamSpan?.attributes.changedFiles ?? [],
    artifacts: result.artifactPaths
  });
}

console.log(JSON.stringify({ ok: true, scenarios }, null, 2));
