import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateText, tool } from "ai";
import { z } from "zod";
import {
  loadEvalModelConfig,
  type EvalModelConfig
} from "./evalModelConfig";
import { runToolContractE2E } from "./toolContractRunner";
import {
  TOOL_CONTRACT_JUDGE_INSTRUCTIONS,
  TOOL_CONTRACT_JUDGE_TOOL_DESCRIPTION,
  TOOL_CONTRACT_RUBRIC
} from "./prompts";
import { writeArtifactJson } from "./artifactBinary";

interface JudgeResult {
  label: "pass" | "warn" | "fail";
  score: number;
  summary: string;
  reasoning: string;
  evidence: string[];
}

const JudgeResultSchema = z
  .object({
    label: z.enum(["pass", "warn", "fail"]),
    score: z.number().min(0).max(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    evidence: z.array(z.string()).default([])
  })
  .strict();

const result = await runToolContractE2E();
const input = {
  scenario: result.id,
  rubric: TOOL_CONTRACT_RUBRIC,
  evidence: {
    proposals: result.proposals,
    mockToolCalls: result.mockToolCalls,
    mockToolResults: result.mockToolResults,
    connectorResults: result.connectorResults,
    onebotApiCalls: result.onebotApiCalls,
    artifacts: result.artifactPaths
  }
};
const judgeConfig = await loadEvalModelConfig();
const judged = await judge(input, judgeConfig);
const paths = await writeEvalArtifacts(
  result.artifactPaths.report,
  input,
  judged,
  judgeConfig
);

console.log(
  JSON.stringify(
    {
      ok: judged.label !== "fail",
      scenario: result.id,
      label: judged.label,
      score: judged.score,
      summary: judged.summary,
      judgeModel: judgeConfig.modelName,
      judgeConfig: judgeConfig.configPath,
      judgeConfigVersion: judgeConfig.configVersion,
      artifacts: {
        ...result.artifactPaths,
        ...paths
      }
    },
    null,
    2
  )
);

if (judged.label === "fail") {
  process.exitCode = 1;
}

async function judge(
  input: unknown,
  config: EvalModelConfig
): Promise<JudgeResult> {
  const result = await generateText({
    model: config.languageModel,
    temperature: config.temperature,
    ...(config.providerOptions
      ? { providerOptions: config.providerOptions }
      : {}),
    timeout: {
      totalMs: config.timeoutMs
    },
    instructions: TOOL_CONTRACT_JUDGE_INSTRUCTIONS,
    prompt: JSON.stringify(input, null, 2),
    tools: {
      record_judgment: tool({
        description: TOOL_CONTRACT_JUDGE_TOOL_DESCRIPTION,
        inputSchema: JudgeResultSchema
      })
    }
  });

  const toolCall = result.toolCalls.find(
    (call) => call.toolName === "record_judgment"
  );
  if (!toolCall) {
    throw new Error(
      `Tool contract eval judge did not call record_judgment. Content preview: ${result.text.slice(
        0,
        300
      )}`
    );
  }
  return JudgeResultSchema.parse(toolCall.input);
}

async function writeEvalArtifacts(
  reportPath: string,
  input: unknown,
  result: JudgeResult,
  config: EvalModelConfig
): Promise<{ evalInputs: string; evalResults: string; evalReport: string }> {
  const artifactDir = path.dirname(reportPath);
  await mkdir(artifactDir, { recursive: true });
  const paths = {
    evalInputs: path.join(artifactDir, "eval-inputs.json"),
    evalResults: path.join(artifactDir, "eval-results.json"),
    evalReport: path.join(artifactDir, "eval-report.md")
  };
  await Promise.all([
    writeArtifactJson(paths.evalInputs, input),
    writeArtifactJson(paths.evalResults, {
      judge: summarizeJudgeConfig(config),
      result
    }),
    writeFile(
      paths.evalReport,
      [
        "# Tool Contract Eval",
        "",
        `- Label: ${result.label}`,
        `- Score: ${result.score}`,
        `- Judge model: ${config.modelName}`,
        `- Judge config: ${config.configPath}`,
        `- Judge config version: ${config.configVersion}`,
        "",
        result.summary,
        "",
        "## Reasoning",
        "",
        result.reasoning,
        "",
        "## Evidence",
        "",
        result.evidence.map((item) => `- ${item}`).join("\n") || "- none",
        ""
      ].join("\n"),
      "utf8"
    )
  ]);
  return paths;
}

function summarizeJudgeConfig(config: EvalModelConfig): Record<string, unknown> {
  return {
    model: config.modelName,
    configPath: config.configPath,
    configVersion: config.configVersion,
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    ...(config.thinking ? { thinking: config.thinking } : {})
  };
}
