import {
  getDefaultEvalFixtures,
  runScenarioEval,
  type EvalRunResult
} from "./evalRunner";
import { parseEvalCliArguments } from "./evalModelConfig";

const cli = parseEvalCliArguments(process.argv.slice(2));
const fixturePaths =
  cli.fixturePaths.length > 0 ? cli.fixturePaths : getDefaultEvalFixtures();

const runs: EvalRunResult[] = [];

for (const fixturePath of fixturePaths) {
  const run = await runScenarioEval(fixturePath, {
    ...(cli.evalConfigPath ? { evalConfigPath: cli.evalConfigPath } : {})
  });
  runs.push(run);
  for (const result of run.results) {
    console.log(
      `${result.scenarioId}/${result.rubricId}: ${result.label} ${result.score.toFixed(
        2
      )} - ${result.summary}`
    );
  }
}

const failed = runs.flatMap((run) =>
  run.results.filter((result) => result.label === "fail")
);

if (failed.length > 0) {
  process.exitCode = 1;
}
